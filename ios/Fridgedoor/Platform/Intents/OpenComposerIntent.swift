import AppIntents
import Foundation

/// Opens the app's composer. Compiled into both the app and the widget extension
/// (for the Control Center / Lock Screen control); it always runs in the app.
struct OpenComposerIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Ask the planner"
    static let description = IntentDescription("Opens Ask the planner so you can type or speak a request.")
    static let openAppWhenRun = true
    static let isDiscoverable = true

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        PlatformIntegration.open(URL(string: "fridgedoor://compose")!)
        #endif
        return .result()
    }
}
