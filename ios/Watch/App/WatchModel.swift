import Foundation
import FridgedoorKit
import Observation
import WatchConnectivity
import WidgetKit

/// The watch app's state: the latest `WatchPayload` from the iPhone, and the
/// commands it sends back. The watch never talks to the server itself.
@MainActor
@Observable
final class WatchModel: NSObject {
    enum Phase: Equatable { case waiting, ready, signedOut }

    private(set) var payload: WatchPayload?
    private(set) var phase: Phase
    /// When the iPhone last signed out. Payloads built before it (a complication transfer
    /// that was queued before the sign-out, say) belong to the old session and are dropped.
    private var signedOutAt: Date? {
        get { UserDefaults.standard.object(forKey: "watch.signedOutAt") as? Date }
        set { UserDefaults.standard.set(newValue, forKey: "watch.signedOutAt") }
    }
    /// Decisions sent to the iPhone and not yet confirmed.
    private(set) var sending: Set<String> = []
    /// What went wrong with the last command, shown once.
    var failure: String?
    /// On screen. Only then does the watch ask the iPhone to refresh; background wakes
    /// just take in what arrived.
    var isActive = false {
        didSet { if isActive && !oldValue { refresh() } }
    }

    override init() {
        let stored = WatchPayload.stored()
        payload = stored
        phase = stored == nil ? .waiting : .ready
        super.init()
    }

    func activate() {
        guard WCSession.isSupported(), WCSession.default.delegate == nil else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Background wake for new data from the iPhone: take it in so the complication
    /// updates, then let the system suspend the app.
    func receivePending() async {
        activate()
        for _ in 0..<50 where WCSession.default.activationState != .activated || WCSession.default.hasContentPending {
            try? await Task.sleep(for: .milliseconds(200))
        }
    }

    /// Asks the iPhone for a fresh payload (when the app comes forward, or once it can).
    func refresh() {
        guard isActive, WCSession.default.activationState == .activated, WCSession.default.isReachable else { return }
        Task { _ = await send(.refresh) }
    }

    func decide(_ row: WidgetSnapshot.DecisionRow, _ action: WidgetSnapshot.DecisionRow.Action) {
        run(.decide(planId: row.id, choice: action), id: row.id)
    }

    func answer(_ question: WatchPayload.Question, _ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        run(.answer(questionId: question.id, text: String(text.prefix(500)), revision: question.revision), id: question.id)
    }

    func dismiss(_ question: WatchPayload.Question) {
        run(.dismiss(questionId: question.id, revision: question.revision), id: question.id)
    }

    /// Shows the outcome at once and puts it back if the iPhone couldn't do it.
    private func run(_ command: WatchCommand, id: String) {
        guard let before = payload, !sending.contains(id) else { return }
        sending.insert(id)
        apply(before.removing(decision: id))
        Task {
            let reply = await send(command)
            sending.remove(id)
            if let error = reply.error {
                // Only restore if nothing newer arrived meanwhile.
                if payload?.sameContent(as: before.removing(decision: id)) == true { apply(before) }
                failure = error
            }
        }
    }

    private func send(_ command: WatchCommand) async -> WatchReply {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else {
            return WatchReply(error: "Can’t reach your iPhone. Try again when it’s nearby.")
        }
        return await Self.deliver(command)
    }

    /// Not on the main actor: WatchConnectivity calls these handlers on its own queue.
    private nonisolated static func deliver(_ command: WatchCommand) async -> WatchReply {
        guard let message = try? command.message() else { return WatchReply(error: "Something went wrong.") }
        return await withCheckedContinuation { continuation in
            WCSession.default.sendMessage(message, replyHandler: { reply in
                continuation.resume(returning: WatchReply(message: reply))
            }, errorHandler: { _ in
                continuation.resume(returning: WatchReply(error: "Can’t reach your iPhone. Try again when it’s nearby."))
            })
        }
    }

    private func apply(_ new: WatchPayload?) {
        let changed = !(new?.sameContent(as: payload) ?? (payload == nil))
        payload = new
        WatchPayload.store(new)
        if changed { WidgetCenter.shared.reloadAllTimelines() }
    }

    fileprivate func receive(_ context: [String: Any]) {
        if let at = WatchPayload.signedOutAt(in: context) {
            signedOutAt = max(at, signedOutAt ?? at)
            apply(nil)
            phase = .signedOut
        } else if let data = context[WatchPayload.contextKey] as? Data, let new = WatchPayload.decode(data) {
            guard !new.predates(signOut: signedOutAt) else { return }
            // The complication channel and the application context can arrive out of order.
            if let payload, new.snapshot.generatedAt < payload.snapshot.generatedAt { return }
            // Decisions still being sent stay hidden until the iPhone confirms them.
            apply(sending.reduce(new) { $0.removing(decision: $1) })
            phase = .ready
        }
    }
}

extension WatchModel: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = Context(session.receivedApplicationContext)
        Task { @MainActor in
            if !context.value.isEmpty { receive(context.value) }
            refresh()
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let context = Context(applicationContext)
        Task { @MainActor in receive(context.value) }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        let context = Context(userInfo)
        Task { @MainActor in receive(context.value) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable else { return }
        Task { @MainActor in refresh() }
    }
}

/// An application context (property-list values only) carried to the main actor.
private struct Context: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}
