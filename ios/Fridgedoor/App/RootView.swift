import FridgedoorKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        ZStack {
            Color.paper.ignoresSafeArea()
            switch app.phase {
            case .launching: ProgressView().controlSize(.large)
            case .signedOut: WelcomeView().transition(.opacity)
            case .signedIn: if let store = app.store { MainTabView().environment(store).transition(.opacity) }
            }
        }
        .animation(.smooth, value: app.phase)
        // Pairing links arrive from anywhere (Camera app, a tapped link, the scanner),
        // signed in or out, so they're confirmed here at the root.
        .sheet(item: $app.pendingPairing) { PairingConfirmSheet(link: $0) }
        .alert("Can't use this pairing code", isPresented: Binding(get: { app.pairingProblem != nil }, set: { if !$0 { app.pairingProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(app.pairingProblem ?? "")
        }
    }
}
