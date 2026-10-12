import AuthenticationServices
import FridgedoorKit
import SwiftUI

/// First run and signed out. Fridgedoor has no server of its own: the person
/// pairs with their household's server (QR code), types its address, or follows
/// the setup guide. Once a server is known, this offers browser sign-in to it.
struct WelcomeView: View {
    static let setupGuide = URL(string: "https://fridgedoor.dev/#set-up")!

    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var showScanner = false
    @State private var showAddress = false
    /// Set by the scanner; offered once its sheet is gone (two sheets can't overlap).
    @State private var scanned: PairingLink?
    /// Set by the address sheet; browser sign-in starts once its sheet is gone.
    @State private var verifiedServer: URL?

    var body: some View {
        // Fits on one screen when it can; scrolls at the largest text sizes.
        ViewThatFits(in: .vertical) {
            content(spaced: true)
            ScrollView { content(spaced: false) }
        }
        .sheet(isPresented: $showScanner, onDismiss: {
            if let scanned { self.scanned = nil; app.offerPairing(scanned) }
        }) {
            PairingScannerSheet { link in
                scanned = link
                showScanner = false
            }
        }
        .sheet(isPresented: $showAddress, onDismiss: {
            if let scanned { self.scanned = nil; app.offerPairing(scanned); return }
            guard let verifiedServer else { return }
            self.verifiedServer = nil
            app.useServer(verifiedServer)
            Task { await app.signIn(using: webAuthenticationSession) }
        }) {
            ServerAddressSheet(
                onVerified: { url in verifiedServer = url; showAddress = false },
                // Someone pasted a whole pairing link into the address field.
                onPairingLink: { link in scanned = link; showAddress = false }
            )
        }
    }

    private func content(spaced: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if spaced { Spacer(minLength: 24) }
            Eyebrow("Fridgedoor")
            Text("Your household,\nplanned together.")
                .font(.serif(.largeTitle))
                .foregroundStyle(Color.ink)
                .padding(.top, 10)
            Text("Fridgedoor connects to your household's own server, where your plans, lists and calendar live.")
                .font(.body)
                .foregroundStyle(Color.muted)
                .padding(.top, 12)
            VStack(alignment: .leading, spacing: 18) {
                benefit("envelope.badge", "Plans found in your email, ready to add")
                benefit("checklist", "Shared to-dos and groceries for everyone")
                benefit("sparkles", "Ask the planner what's coming up, or to add something")
            }
            .padding(.top, 28)
            if spaced { Spacer(minLength: 24) } else { Color.clear.frame(height: 32) }
            if let error = app.signInError {
                Label {
                    Text(error).foregroundStyle(Color.ink)
                } icon: {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(Color.danger)
                }
                .font(.subheadline)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.soft, in: .rect(cornerRadius: 14))
                .padding(.bottom, 16)
            }
            if let server = app.serverURL {
                signIn(to: server)
            } else {
                connect
            }
        }
        .padding(28)
    }

    /// No server yet: pair, type an address, or set one up.
    private var connect: some View {
        VStack(spacing: 0) {
            Button { showScanner = true } label: {
                Label("Scan pairing code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
            }
            .buttonStyle(PlannerButtonStyle(kind: .primary, size: .large))
            Text("In Fridgedoor on the web, open Settings → iPhone and scan the code it shows.")
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
            Button { showAddress = true } label: {
                Text("Enter server address").frame(maxWidth: .infinity)
            }
            .buttonStyle(PlannerButtonStyle(kind: .quiet, size: .large))
            .padding(.top, 16)
            Link(destination: Self.setupGuide) {
                Text("Don't have a server? **Set one up**")
                    .font(.footnote)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .foregroundStyle(Color.plannerAccent)
            .padding(.top, 8)
        }
    }

    /// A server is known (signed out, or just verified): sign in to it.
    private func signIn(to server: URL) -> some View {
        VStack(spacing: 0) {
            Button {
                Task { await app.signIn(using: webAuthenticationSession) }
            } label: {
                HStack {
                    if app.isSigningIn { ProgressView().tint(Color.onAccent) }
                    Text(app.isSigningIn ? "Signing in…" : "Sign in")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(PlannerButtonStyle(kind: .primary, size: .large))
            .disabled(app.isSigningIn)
            Text("Sign in to **\(ServerAddress.Normalized.displayName(for: server))** in a secure browser sheet.")
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
            HStack(spacing: 4) {
                Button("Scan pairing code") { showScanner = true }
                Text("·").foregroundStyle(Color.muted).accessibilityHidden(true)
                Button("Use a different server") { app.forgetServer() }
            }
            .font(.footnote)
            .foregroundStyle(Color.plannerAccent)
            .frame(maxWidth: .infinity, minHeight: 44)
            .disabled(app.isSigningIn)
            .padding(.top, 8)
        }
    }

    private func benefit(_ systemImage: String, _ text: String) -> some View {
        Label {
            Text(text).font(.body).foregroundStyle(Color.ink)
        } icon: {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(Color.plannerAccent)
                .frame(width: 32)
                .accessibilityHidden(true)
        }
    }
}
