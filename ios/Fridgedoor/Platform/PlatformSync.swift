import Foundation
import FridgedoorKit
import UIKit
import UserNotifications
import WidgetKit

/// Derives the widget snapshot, local notification schedule and Spotlight index
/// from household data. Runs are serialized so a fast poll can't interleave two
/// reconciles.
@MainActor
enum PlatformSync {
    private static var chain: Task<Void, Never>?
    private static var lastSnapshot: WidgetSnapshot?
    /// Reminder ids seen so far, to notice one the person just created.

    /// Queues a sync of `data`. `client` is used for the throttled morning-digest lookup.
    static func apply(_ data: PlatformData, client: PlannerClient?, fromForeground: Bool) {
        enqueue { await run(data, client: client, fromForeground: fromForeground) }
    }

    /// Waits for every queued sync to finish.
    static func waitForIdle() async { await chain?.value }

    /// Refreshes from the server — through the live store when the UI is running,
    /// otherwise directly — then syncs. Returns false if nothing could be fetched.
    @discardableResult
    static func refreshAll() async -> Bool {
        if let store = PlatformSession.store {
            await store.refresh([.plans, .agenda, .todos, .groceries, .reminders])
            await waitForIdle()
            return store.refreshError == nil
        }
        guard let client = await PlatformSession.client() else {
            // Signed out (possibly expired while the UI wasn't running).
            await clearLocalState()
            return false
        }
        do {
            let data = try await PlatformData.fetch(client)
            enqueue { await run(data, client: client, fromForeground: false) }
            await waitForIdle()
            return true
        } catch {
            if (error as? PlannerError)?.code == PlannerError.signedOut.code { await clearLocalState() }
            return false
        }
    }

    /// Re-applies the current preferences (toggles changed) without a network refresh.
    static func resync() {
        if let store = PlatformSession.store {
            apply(PlatformData(store: store), client: store.client, fromForeground: true)
        } else {
            Task { await refreshAll() }
        }
    }

    /// Removes everything derived from the signed-in account on this device.
    static func clearLocalState() async {
        await waitForIdle()
        NotificationScheduler.removeAll()
        lastSnapshot = nil
        SharedContainer.writeSnapshot(nil)
        WidgetCenter.shared.reloadAllTimelines()
        WatchBridge.shared.clear()
        SpotlightIndexer.clear()
        PlatformPreferences.shared.resetAccountState()
        // Responses from the old account (or server) must not answer the next one's requests.
        URLCache.shared.removeAllCachedResponses()
    }

    private static func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = chain
        chain = Task { @MainActor in
            await previous?.value
            await work()
        }
    }

    private static func run(_ data: PlatformData, client: PlannerClient?, fromForeground: Bool) async {
        updateWidget(data)
        await WatchBridge.shared.update(data, client: client)
        SpotlightIndexer.update(plans: data.plans, todos: data.todos, groceries: data.groceries, timeZone: data.member.timeZone)
        if let client { await refreshDigestStatusIfNeeded(client) }
        await NotificationScheduler.requestProvisionalIfNeeded()
        await scheduleNotifications(data)
    }

    // MARK: Widget

    private static func updateWidget(_ data: PlatformData) {
        let previous = lastSnapshot ?? SharedContainer.readSnapshot()
        // A widget check-off stays undoable from the widget across refreshes.
        let snapshot = data.snapshot().keepingCheck(from: SharedContainer.readSnapshot() ?? previous)
        let changed = !snapshot.sameContent(as: previous)
        let age = previous.map { snapshot.generatedAt.timeIntervalSince($0.generatedAt) } ?? .infinity
        // Polling runs every few seconds while work is pending; only rewrite when
        // something changed or the "updated at" time is worth refreshing.
        guard changed || age > 15 * 60 else { return }
        lastSnapshot = snapshot
        SharedContainer.writeSnapshot(snapshot)
        // Reloads are budgeted; spend one only when what the widget shows changed
        // (or the stored copy is old enough to be labeled stale).
        if changed || age > 3 * 3600 { WidgetCenter.shared.reloadAllTimelines() }
    }

    // MARK: Notifications

    static func refreshDigestStatusIfNeeded(_ client: PlannerClient, force: Bool = false) async {
        let prefs = PlatformPreferences.shared
        if !force, let fetched = prefs.serverDigestFetchedAt, Date.now.timeIntervalSince(fetched) < 30 * 60 { return }
        guard let status = try? await client.morningDigestStatus() else { return }
        prefs.serverDigest = status
        prefs.serverDigestFetchedAt = .now
    }

    private static func scheduleNotifications(_ data: PlatformData) async {
        let prefs = PlatformPreferences.shared
        var desired: [PlatformNotification] = []
        if prefs.reminderAlerts {
            desired += PlatformNotificationPlan.reminders(data.reminders, plans: data.plans, groceryIds: Set(data.groceries.map(\.id)), timeZone: data.member.timeZone)
        }
        if prefs.digestAlerts {
            let time = prefs.serverDigest?.hourMinute ?? (hour: 7, minute: 0)
            let decisions = PlatformNotificationPlan.openDecisionCount(data.plans)
            desired += PlatformNotificationPlan.digests(hour: time.hour, minute: time.minute, timeZone: data.member.timeZone, agenda: data.agenda, decisions: decisions)
        }
        if prefs.eveningAlerts {
            desired += PlatformNotificationPlan.eveningLookAheads(timeZone: data.member.timeZone, agenda: data.agenda)
        }
        let active = Set(data.reminders.filter(\.isActive).map(\.id))
        await NotificationScheduler.reconcile(desired, activeReminderIds: active)
    }
}
