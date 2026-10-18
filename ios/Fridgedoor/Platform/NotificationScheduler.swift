import Foundation
import FridgedoorKit
import UIKit
import UserNotifications

/// Local notifications computed from server data. The free developer team has no
/// APNs, so server push can't reach the app: after every refresh the pending
/// local alerts are reconciled with the server's active reminders and the
/// member's morning review time.
@MainActor
enum NotificationScheduler {
    enum Action {
        static let snooze = "planner.snooze15"
        static let done = "planner.done"
    }
    static let testIdentifier = "planner.test"
    private static var center: UNUserNotificationCenter { .current() }

    static func registerCategories() {
        let snooze = UNNotificationAction(identifier: Action.snooze, title: "Snooze 15 min", options: [], icon: UNNotificationActionIcon(systemImageName: "moon.zzz"))
        let done = UNNotificationAction(identifier: Action.done, title: "Done", options: [.authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "checkmark.circle"))
        // With iOS's default "Show Previews: When Unlocked", the Lock Screen shows
        // only these placeholders, never plan titles.
        let reminder = UNNotificationCategory(identifier: PlatformNotification.Category.reminder.rawValue, actions: [snooze, done], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "Household reminder", categorySummaryFormat: "%u more reminders", options: [])
        let digest = UNNotificationCategory(identifier: PlatformNotification.Category.digest.rawValue, actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "Morning brief", options: [])
        let evening = UNNotificationCategory(identifier: PlatformNotification.Category.evening.rawValue, actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "Tomorrow", options: [])
        center.setNotificationCategories([reminder, digest, evening])
    }

    // MARK: Authorization

    static func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    static func canSchedule(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }

    /// Quiet delivery to Notification Center without a prompt, so reminders work
    /// before the person is ever asked.
    static func requestProvisionalIfNeeded() async {
        guard await authorizationStatus() == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge, .provisional])
    }

    /// The real prompt — shown when it's meaningful (the person just created a
    /// reminder in the app, or tapped "Turn on" in Settings).
    @discardableResult
    static func requestFullAuthorization() async -> Bool {
        PlatformPreferences.shared.askedForAlerts = true
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        return granted
    }

    // MARK: Reconcile

    /// Makes the pending reminder/digest alerts match `desired`. Existing requests
    /// with the same identifier are left alone; stale ones are removed. Delivered
    /// alerts for reminders that are no longer active are cleared too.
    static func reconcile(_ desired: [PlatformNotification], activeReminderIds: Set<String>) async {
        let managed = { (id: String) in id.hasPrefix(PlatformNotificationPlan.reminderPrefix) || id.hasPrefix(PlatformNotificationPlan.digestPrefix) || id.hasPrefix(PlatformNotificationPlan.eveningPrefix) }
        let pending = Set(await center.pendingNotificationRequests().map(\.identifier).filter(managed))
        let wanted = Set(desired.map(\.identifier))
        let stale = pending.subtracting(wanted)
        if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: Array(stale)) }

        let delivered = await center.deliveredNotifications().map(\.request)
        let finished = delivered.filter { request in
            guard request.identifier.hasPrefix(PlatformNotificationPlan.reminderPrefix), let id = request.content.userInfo["reminderId"] as? String else { return false }
            return !activeReminderIds.contains(id)
        }
        if !finished.isEmpty { center.removeDeliveredNotifications(withIdentifiers: finished.map(\.identifier)) }

        guard canSchedule(await authorizationStatus()) else { return }
        let added = desired.filter { !pending.contains($0.identifier) }
        for notification in added {
            try? await center.add(request(for: notification))
        }
        #if DEBUG
        if !added.isEmpty || !stale.isEmpty { await logPending() }
        #endif
    }

    static func request(for notification: PlatformNotification, fireDate: Date? = nil, identifier: String? = nil) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        content.categoryIdentifier = notification.category.rawValue
        content.threadIdentifier = notification.category.rawValue
        content.targetContentIdentifier = notification.link
        // Time Sensitive needs an entitlement the free developer team can't get.
        content.interruptionLevel = .active
        content.relevanceScore = notification.category == .reminder ? 0.8 : 0.5
        var info: [String: Any] = ["link": notification.link]
        if let reminderId = notification.reminderId { info["reminderId"] = reminderId }
        if let revision = notification.revision { info["revision"] = revision }
        content.userInfo = info
        let interval = max(1, (fireDate ?? notification.fireDate).timeIntervalSinceNow)
        return UNNotificationRequest(identifier: identifier ?? notification.identifier, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false))
    }

    /// Local fallback when a Snooze couldn't reach the server (offline). Outside the
    /// reconciled prefixes so the next sync doesn't remove it.
    static func scheduleLocalSnooze(title: String, body: String, link: URL?, reminderId: String) async {
        let notification = PlatformNotification(identifier: "snooze.\(reminderId)", fireDate: .now.addingTimeInterval(15 * 60), title: title, body: body, category: .reminder, link: link?.absoluteString ?? "fridgedoor://home", reminderId: reminderId, revision: nil)
        try? await center.add(request(for: notification))
    }

    /// After the person creates a reminder in the app: ask once for full alerts.
    static func reminderCreated() async {
        guard PlatformPreferences.shared.reminderAlerts, !PlatformPreferences.shared.askedForAlerts else { return }
        let status = await authorizationStatus()
        guard status == .notDetermined || status == .provisional else { return }
        await requestFullAuthorization()
    }

    static func removeAll() {
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
    }

    /// "Send test notification" in Settings: a local alert in 5 seconds.
    static func sendTest() async -> Bool {
        var status = await authorizationStatus()
        if status == .notDetermined || status == .provisional {
            await requestFullAuthorization()
            status = await authorizationStatus()
        }
        guard canSchedule(status) else { return false }
        let content = UNMutableNotificationContent()
        content.title = "Fridgedoor"
        content.body = "Notifications are working on this iPhone."
        content.sound = .default
        content.userInfo = ["link": "fridgedoor://settings"]
        let request = UNNotificationRequest(identifier: testIdentifier, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false))
        do { try await center.add(request); return true } catch { return false }
    }

    static func pendingCount() async -> Int {
        await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(PlatformNotificationPlan.reminderPrefix) || $0.identifier.hasPrefix(PlatformNotificationPlan.digestPrefix) || $0.identifier.hasPrefix(PlatformNotificationPlan.eveningPrefix) }.count
    }

    #if DEBUG
    static func logPending() async {
        let requests = await center.pendingNotificationRequests().sorted { $0.identifier < $1.identifier }
        print("[Platform] \(requests.count) pending notifications")
        for request in requests {
            let fire = (request.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate()
            print("[Platform]   \(request.identifier) @ \(fire.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "?") — \(request.content.title) · \(request.content.body)")
        }
    }
    #endif
}
