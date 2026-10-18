import Foundation
import FridgedoorKit
import UserNotifications

/// Handles taps and the Snooze/Done actions on reminder alerts. The app may have
/// been launched in the background just for the action, in which case there is
/// no store yet and the server is updated with a Keychain-backed client.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = NotificationDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let info = content.userInfo
        let link = (info["link"] as? String).flatMap(URL.init(string:))
        let reminderId = info["reminderId"] as? String
        let revision = info["revision"] as? Int
        let action = response.actionIdentifier
        let title = content.title, body = content.body
        switch action {
        case NotificationScheduler.Action.snooze, NotificationScheduler.Action.done:
            guard let reminderId else { return }
            let ok = await NotificationActions.update(reminderId: reminderId, revision: revision, done: action == NotificationScheduler.Action.done)
            if !ok, action == NotificationScheduler.Action.snooze {
                await NotificationScheduler.scheduleLocalSnooze(title: title, body: body, link: link, reminderId: reminderId)
            }
        case UNNotificationDefaultActionIdentifier:
            if let link { await PlatformIntegration.open(link) }
        default:
            break
        }
    }
}

@MainActor
enum NotificationActions {
    /// Snoozes (15 minutes) or completes a reminder on the server. Retries once
    /// with the latest revision if it changed elsewhere. Returns false on failure.
    static func update(reminderId: String, revision: Int?, done: Bool) async -> Bool {
        if let store = PlatformSession.store {
            if store.reminders.isEmpty || store.reminders.first(where: { $0.id == reminderId }) == nil { await store.refresh([.reminders]) }
            for attempt in 0..<2 {
                guard let reminder = store.reminders.first(where: { $0.id == reminderId }) else { return true } // already gone
                do {
                    if done { try await store.completeReminder(reminder) } else { try await store.snoozeReminder(reminder, until: .now.addingTimeInterval(15 * 60)) }
                    await store.refresh([.reminders, .dailyOverview])
                    return true
                } catch let error as PlannerError where error.isStale && attempt == 0 {
                    await store.refresh([.reminders])
                } catch {
                    return false
                }
            }
            return false
        }

        guard let client = await PlatformSession.client() else { return false }
        var expected = revision
        for attempt in 0..<2 {
            do {
                if expected == nil {
                    guard let current = try await client.reminders().first(where: { $0.id == reminderId }) else { return true }
                    expected = current.revision
                }
                let zone = await client.auth.member?.timeZone ?? .current
                if done {
                    _ = try await client.updateReminder(reminderId, expectedRevision: expected ?? 1, completed: true)
                } else {
                    _ = try await client.updateReminder(reminderId, expectedRevision: expected ?? 1, snoozeUntil: PlannerDates.offsetString(.now.addingTimeInterval(15 * 60), timeZone: zone))
                }
                await PlatformSync.refreshAll()
                return true
            } catch let error as PlannerError where error.isStale && attempt == 0 {
                expected = nil
            } catch {
                return false
            }
        }
        return false
    }
}
