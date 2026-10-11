import AppIntents
import SwiftUI
import WidgetKit

/// Control Center / Lock Screen / Action button control that opens the app's
/// composer (`fridgedoor://compose`) via `OpenComposerIntent`, which runs in the app.
struct AskPlannerControl: ControlWidget {
    static let kind = "app.fridgedoor.ask"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenComposerIntent()) {
                Label("Ask Planner", systemImage: "sparkles")
            }
        }
        .displayName("Ask Planner")
        .description("Type or speak a request to the planner.")
    }
}
