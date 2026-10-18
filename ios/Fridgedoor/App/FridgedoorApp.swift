import FridgedoorKit
import SwiftUI

@main
struct FridgedoorApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(app.router)
                .environment(app.composer)
                .preferredColorScheme(app.appearance.colorScheme)
                .tint(.plannerAccent)
                .task { AppDelegate.app = app; await app.launch() }
                .onOpenURL { app.handle($0) }
                .onContinueUserActivity(PlatformIntegration.spotlightActivityType) { PlatformIntegration.continueActivity($0) }
                .onChange(of: scenePhase) { _, phase in
                    guard let store = app.store else { return }
                    if phase == .active { store.startPolling() } else if phase == .background {
                        store.stopPolling()
                        if !store.pendingDismissals.isEmpty {
                            // The held dismissals are sent now, so their Undo no longer applies.
                            app.dismissToast()
                            BackgroundWork.finish("Send dismissals") { await store.flushPendingDismissals() }
                        }
                    }
                }
        }
    }
}

/// Work that must finish after the app leaves the foreground (held dismissals): asks
/// iOS for background time so it isn't suspended mid-request.
@MainActor
enum BackgroundWork {
    static func finish(_ name: String, _ work: @escaping @MainActor () async -> Void) {
        let assertion = Assertion()
        let task = Task { @MainActor in
            await work()
            assertion.end()
        }
        assertion.id = UIApplication.shared.beginBackgroundTask(withName: name) {
            // Out of time: stop the work (an unsent dismissal comes back) and let iOS suspend.
            task.cancel()
            assertion.end()
        }
    }

    @MainActor private final class Assertion {
        var id = UIBackgroundTaskIdentifier.invalid
        func end() {
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    @MainActor static weak var app: AppModel?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        PlatformIntegration.didFinishLaunching()
        return true
    }
}
