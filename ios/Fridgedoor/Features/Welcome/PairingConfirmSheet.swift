import FridgedoorKit
import SwiftUI

/// "Connect to fridgedoor.example.com?" before a pairing code is used. A pairing
/// link can come from anywhere (a QR code on a poster, a message), and whoever
/// runs the server named in it would see everything this iPhone sends, so the
/// person always sees the host and confirms.
struct PairingConfirmSheet: View {
    let link: PairingLink

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    private var host: String { link.server.displayName }
    private var current: URL? { app.phase == .signedIn ? app.client?.baseURL : nil }
    private var alreadyConnected: Bool { current == link.server.url }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Image(systemName: "link.badge.plus")
                        .font(.largeTitle)
                        .foregroundStyle(Color.plannerAccent)
                        .accessibilityHidden(true)
                    Text(alreadyConnected ? "Already connected" : "Connect to \(host)?")
                        .font(.serif(.title2))
                        .foregroundStyle(Color.ink)
                        .accessibilityAddTraits(.isHeader)
                    if alreadyConnected {
                        Text("This iPhone is already signed in to \(host). To sign in as someone else, sign out in Settings first, then scan a new code.")
                            .foregroundStyle(Color.muted)
                    } else {
                        Text("Fridgedoor on this iPhone will sign in to the server at **\(host)**.")
                            .foregroundStyle(Color.ink)
                        notice("hand.raised", tint: .plannerAccent,
                               "Only continue if this code came from your own household's Fridgedoor. A code from someone else would connect this iPhone to a server they control.")
                        if link.server.isInsecure {
                            notice("exclamationmark.triangle", tint: .warning,
                                   "This server uses an unencrypted connection (http). That's fine on your home network or Tailscale.")
                        }
                        if let current {
                            notice("rectangle.portrait.and.arrow.right", tint: .muted,
                                   "You'll be signed out of \(ServerAddress.Normalized.displayName(for: current)) on this iPhone.")
                        }
                        if let error = app.pairingError {
                            notice("exclamationmark.circle", tint: .danger, error)
                        }
                    }
                }
                .font(.body)
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    if alreadyConnected { dismiss() } else { Task { await app.confirmPairing(link) } }
                } label: {
                    HStack {
                        if app.isPairing { ProgressView().tint(Color.onAccent) }
                        Text(alreadyConnected ? "Done" : app.isPairing ? "Connecting…" : "Connect")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PlannerButtonStyle(kind: .primary, size: .large))
                .disabled(app.isPairing)
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            }
            .plannerBackground()
            .toolbar {
                if !alreadyConnected {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(app.isPairing) }
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(app.isPairing)
    }

    private func notice(_ systemImage: String, tint: Color, _ message: String) -> some View {
        Label {
            Text(message).font(.subheadline).foregroundStyle(Color.ink)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(tint)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.card, in: .rect(cornerRadius: 14))
    }
}
