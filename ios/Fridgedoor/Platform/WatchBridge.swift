import Foundation
import FridgedoorKit
import WatchConnectivity

/// Keeps the Apple Watch app current and carries out what it asks. The watch holds
/// no credential and never talks to the server: it shows the `WatchPayload` sent
/// here (latest wins, delivered in the background) and asks this app to act with a
/// `WatchCommand`. The system wakes this app in the background for those.
@MainActor
final class WatchBridge: NSObject {
    static let shared = WatchBridge()

    private var lastSent: WatchPayload?
    /// The brief and questions fetched here when the app's UI isn't running.
    private var fetched: (daily: DailyView?, clarifications: [Clarification], at: Date)?
    private var latest: PlatformData?
    /// The last ready brief, kept while the server rebuilds it (after a decision, say),
    /// when it briefly answers with a placeholder that has no decisions.
    private var lastReadyDaily: DailyView?

    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }
    private var watchReady: Bool {
        guard let session else { return false }
        return session.activationState == .activated && session.isPaired && session.isWatchAppInstalled
    }

    func activate() {
        guard let session, session.delegate == nil else { return }
        session.delegate = self
        session.activate()
    }

    /// Sends the watch the latest payload, if a watch app is installed. Uses the
    /// running app's brief and questions; otherwise fetches them, at most every 15
    /// minutes. `force` resends even when nothing changed.
    func update(_ data: PlatformData, client: PlannerClient?, force: Bool = false) async {
        latest = data
        guard watchReady else { return }
        var daily = data.daily
        var clarifications = data.clarifications
        if daily == nil || clarifications == nil, let client {
            if fetched.map({ Date.now.timeIntervalSince($0.at) > 15 * 60 }) ?? true {
                async let overview = try? client.dailyOverview()
                async let questions = try? client.clarifications()
                let (newOverview, newQuestions) = await (overview, questions)
                fetched = (newOverview ?? fetched?.daily, newQuestions ?? fetched?.clarifications ?? [], .now)
            }
            daily = daily ?? fetched?.daily
            clarifications = clarifications ?? fetched?.clarifications
        }
        if daily?.errorCode == "DAILY_OVERVIEW_UPDATING" {
            daily = lastReadyDaily ?? daily
        } else if daily?.state == "ready" {
            lastReadyDaily = daily
        } else if daily != nil {
            lastReadyDaily = nil
        }
        send(WatchPayload(snapshot: data.snapshot(), daily: daily, clarifications: clarifications ?? [], plans: data.plans, googleReady: data.googleReady), force: force)
    }

    /// Signed out: the watch forgets everything it was sent.
    func clear() {
        lastSent = nil; fetched = nil; latest = nil; lastReadyDaily = nil
        guard watchReady else { return }
        try? session?.updateApplicationContext(["signedOut": true])
    }

    private func send(_ payload: WatchPayload, force: Bool) {
        // Polling runs often while work is pending; resend only what changed, or
        // every 15 minutes so the watch's "Updated" time stays honest.
        let age = lastSent.map { payload.snapshot.generatedAt.timeIntervalSince($0.snapshot.generatedAt) } ?? .infinity
        let changed = !payload.sameContent(as: lastSent)
        guard force || changed || age > 15 * 60, let session, let data = try? payload.encoded() else { return }
        do {
            try session.updateApplicationContext([WatchPayload.contextKey: data])
            // With the complication on the watch face, this wakes the watch to update it
            // (about 50 a day); the application context alone waits for the app.
            if changed, session.isComplicationEnabled, session.remainingComplicationUserInfoTransfers > 0 {
                session.transferCurrentComplicationUserInfo([WatchPayload.contextKey: data])
            }
            lastSent = payload
        } catch {
            // Not delivered (e.g. the watch app was just removed); the next sync retries.
        }
    }

    private func perform(_ command: WatchCommand) async -> WatchReply {
        guard let client = await PlatformSession.client() else { return WatchReply(error: "Open Fridgedoor on your iPhone and sign in.") }
        do {
            switch command {
            case let .decide(planId, choice):
                let plan = try await client.plan(planId)
                if plan.isOpenSuggestion, plan.calendarAction == nil {
                    _ = try await client.decide(plan: plan.id, expectedRevision: plan.revision, choice: choice.rawValue)
                }
            case let .answer(questionId, text, revision):
                _ = try await client.answerClarification(questionId, text: text, expectedRevision: revision)
            case let .dismiss(questionId, revision):
                _ = try await client.dismissClarification(questionId, expectedRevision: revision)
            case .refresh:
                break
            }
        } catch let error as PlannerError where error.isStale {
            // Decided elsewhere first (the iPhone, the web, someone else): just catch up.
            await refresh(client)
            return .ok
        } catch {
            return WatchReply(error: (error as? PlannerError)?.userMessage ?? "Something went wrong. Try again in Fridgedoor.")
        }
        await refresh(client)
        return .ok
    }

    /// Refreshes everything and sends the watch the result straight away.
    private func refresh(_ client: PlannerClient) async {
        fetched = nil
        if let store = PlatformSession.store {
            await store.refresh([.plans, .agenda, .todos, .groceries, .reminders, .dailyOverview, .clarifications])
            await PlatformSync.waitForIdle()
        } else {
            await PlatformSync.refreshAll()
        }
        if let latest { await update(latest, client: client, force: true) }
    }

    /// Sends the next sync in full. With the app's UI running, that's now (no network);
    /// otherwise the next sync or watch request sends it.
    private func resend(fetchIfNeeded: Bool = false) {
        lastSent = nil
        if PlatformSession.store != nil { PlatformSync.resync() } else if fetchIfNeeded { Task { await PlatformSync.refreshAll() } }
    }
}

extension WatchBridge: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        Task { @MainActor in resend() }
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        // A watch app was just installed (or a different watch paired): send it today.
        Task { @MainActor in if watchReady { resend(fetchIfNeeded: true) } }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Switching to another paired watch: reactivate for the new one.
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        let reply = ReplyHandler(call: replyHandler)
        guard let command = WatchCommand(message: message) else {
            reply.call(WatchReply(error: "Update Fridgedoor on your iPhone.").message)
            return
        }
        Task { @MainActor in
            let result = await perform(command)
            reply.call(result.message)
        }
    }
}

/// WatchConnectivity's reply handler, carried to the main actor and called once.
private struct ReplyHandler: @unchecked Sendable {
    let call: ([String: Any]) -> Void
}
