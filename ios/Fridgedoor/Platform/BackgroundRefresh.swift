import BackgroundTasks
import Foundation

/// `BGAppRefreshTask` that refreshes household data while the app is closed, then
/// reschedules local notifications and updates the widget. iOS decides when (and
/// whether) it runs, based on how often the app is used.
@MainActor
enum BackgroundRefresh {
    /// `<bundle id>.refresh`, matching `BGTaskSchedulerPermittedIdentifiers` in Info.plist
    /// (both derive from `FRIDGEDOOR_BUNDLE_PREFIX`, see `Config/Base.xcconfig`).
    static let identifier = "\(Bundle.main.bundleIdentifier ?? "app.fridgedoor").refresh"

    private struct TaskBox: @unchecked Sendable { let task: BGAppRefreshTask }

    /// Must run before `didFinishLaunching` returns.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            let box = TaskBox(task: refresh)
            MainActor.assumeIsolated { handle(box) }
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = .now.addingTimeInterval(30 * 60)
        do { try BGTaskScheduler.shared.submit(request) } catch {
            #if DEBUG
            print("[Platform] Background refresh not scheduled: \(error)")
            #endif
        }
    }

    static func cancel() { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier) }

    private static func handle(_ box: TaskBox) {
        schedule() // keep the chain going
        let work = Task { @MainActor in
            let ok = await PlatformSync.refreshAll()
            box.task.setTaskCompleted(success: ok && !Task.isCancelled)
        }
        box.task.expirationHandler = { work.cancel() }
    }
}
