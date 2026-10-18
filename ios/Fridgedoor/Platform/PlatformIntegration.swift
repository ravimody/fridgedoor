import CoreSpotlight
import Foundation
import FridgedoorKit
import UIKit
import UserNotifications

/// Hooks the app shell calls for the iOS integrations: local notifications,
/// background refresh, the widget snapshot, Spotlight and the Share extension's
/// capture credential. App Intents live in `Platform/Intents/`.
@MainActor
enum PlatformIntegration {
    /// A deep link that arrived (notification tap, control, intent) before the UI could take it.
    private static var pendingLink: URL?
    private static var backgroundObserver: NSObjectProtocol?

    /// `NSUserActivity` type for tapped Spotlight results.
    static let spotlightActivityType = CSSearchableItemActionType

    static func didFinishLaunching() {
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
        NotificationScheduler.registerCategories()
        BackgroundRefresh.register()
        WatchBridge.shared.activate()
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { BackgroundRefresh.schedule() }
        }
    }

    static func didSignIn(_ app: AppModel) {
        PlatformSession.reset()
        if let link = pendingLink { pendingLink = nil; app.handle(link) }
        BackgroundRefresh.schedule()
        guard let client = app.client else { return }
        Task {
            await ShareCredentialManager.ensure(client)
            await PlatformSync.refreshDigestStatusIfNeeded(client, force: true)
        }
    }

    /// Called before the session is revoked, while the client can still reach the server.
    static func willSignOut(_ app: AppModel) async {
        BackgroundRefresh.cancel()
        // Bounded so signing out offline isn't held up by the revoke call.
        let client = app.client
        let revoke = Task { await ShareCredentialManager.revoke(client) }
        let timeout = Task { try? await Task.sleep(for: .seconds(5)); revoke.cancel() }
        await revoke.value
        timeout.cancel()
        await PlatformSync.clearLocalState()
        PlatformSession.reset()
        pendingLink = nil
    }

    /// The session ended without an explicit sign-out (revoked elsewhere, refresh rejected).
    /// The server-side capture credential can't be revoked without a session; drop it locally.
    static func didExpire() async {
        BackgroundRefresh.cancel()
        await PlatformSync.clearLocalState()
        PlatformSession.reset()
        pendingLink = nil
    }

    static func storeDidRefresh(_ store: PlannerStore) {
        // Late refreshes from a signed-out store must not repopulate notifications,
        // the widget or Spotlight with the previous account's data.
        guard let app = AppDelegate.app, app.phase == .signedIn, app.store === store else { return }
        // Notifications, widget and Spotlight are derived from these together; a partial
        // first load would schedule from empty lists (and mistake loaded reminders for new ones).
        guard store.loadedParts.isSuperset(of: [.plans, .agenda, .todos, .groceries, .reminders]) else { return }
        PlatformSync.apply(PlatformData(store: store), client: store.client, fromForeground: UIApplication.shared.applicationState == .active)
    }

    /// Opens a `fridgedoor://` link in the app, now or once it's signed in.
    static func open(_ url: URL) {
        if let app = AppDelegate.app, app.phase != .launching {
            app.handle(url)
        } else {
            pendingLink = url
        }
    }

    /// A Spotlight result was tapped.
    static func continueActivity(_ activity: NSUserActivity) {
        guard let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
              let link = SpotlightIndexer.link(for: identifier) else { return }
        open(link)
    }
}
