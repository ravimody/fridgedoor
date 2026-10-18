import FridgedoorKit
import SwiftUI

@main
struct FridgedoorWatchApp: App {
    @State private var model = WatchModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                TodayView()
            }
            .environment(model)
            .tint(.plannerAccent)
            .task { model.activate() }
            .onChange(of: scenePhase, initial: true) { _, phase in
                model.isActive = phase == .active
            }
        }
        .backgroundTask(.watchConnectivity) {
            await model.receivePending()
        }
    }
}
