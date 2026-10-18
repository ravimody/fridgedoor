import FridgedoorKit
import SwiftUI

/// Type the household server's address. It's normalized (`ServerAddress`) and
/// checked (`ServerProbe`) before browser sign-in starts, so a typo or a server
/// that still needs first-run setup gets a clear message here, not a browser error.
struct ServerAddressSheet: View {
    let onVerified: (URL) -> Void
    let onPairingLink: (PairingLink) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var text = ""
    @State private var isChecking = false
    @State private var error: String?
    /// The server answered but its owner hasn't finished setup in a browser.
    @State private var needsSetup: URL?
    @FocusState private var focused: Bool

    private var preview: ServerAddress.Normalized? { try? ServerAddress.normalize(text) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("https://fridgedoor.example.com", text: $text)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { Task { await check() } }
                        .onChange(of: text) { _, _ in error = nil; needsSetup = nil }
                        .accessibilityLabel("Server address")
                } header: {
                    Text("Server address")
                } footer: {
                    Text("The address you open Fridgedoor at in a browser. A server at home might look like http://192.168.1.20:8080.")
                }
                .plannerRows()

                if let preview, preview.isInsecure {
                    Section {
                        notice("exclamationmark.triangle", tint: .warning,
                               "This connection isn't encrypted (http). That's fine on your home network or Tailscale, but use https for a server on the internet.")
                    }
                    .plannerRows()
                }

                if let error {
                    Section {
                        notice("exclamationmark.circle", tint: .danger, error)
                    }
                    .plannerRows()
                }

                if let needsSetup {
                    Section {
                        notice("wrench.and.screwdriver", tint: .plannerAccent,
                               "\(ServerAddress.Normalized.displayName(for: needsSetup)) isn't set up yet. Open it in a browser to create the owner account, then come back and tap Continue.")
                        Button("Open in Safari", systemImage: "safari") { openURL(needsSetup) }
                    }
                    .plannerRows()
                }
            }
            .plannerList()
            .navigationTitle("Your server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if isChecking {
                        ProgressView().accessibilityLabel("Checking server")
                    } else {
                        Button("Continue") { Task { await check() } }
                            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isChecking)
    }

    private func notice(_ systemImage: String, tint: Color, _ message: String) -> some View {
        Label {
            Text(message).font(.subheadline).foregroundStyle(Color.ink)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(tint)
        }
    }

    private func check() async {
        guard !isChecking else { return }
        error = nil; needsSetup = nil
        // A whole pairing link pasted here is a better way in: use it.
        if let link = try? PairingLink.parse(text) { onPairingLink(link); return }
        let address: ServerAddress.Normalized
        do {
            address = try ServerAddress.normalize(text)
        } catch {
            self.error = Self.message(for: error)
            return
        }
        isChecking = true
        defer { isChecking = false }
        var lastError: Error?
        for candidate in [address.url] + [address.fallback].compactMap(\.self) {
            do {
                let status = try await ServerProbe.check(candidate)
                // No scheme typed and only http answered: put the http address in the
                // field so its warning shows, and let the person continue from there.
                if candidate.scheme == "http", !address.isInsecure {
                    text = candidate.absoluteString
                    return
                }
                if status.setupRequired { needsSetup = candidate; return }
                onVerified(candidate)
                return
            } catch {
                lastError = error
            }
        }
        error = (lastError as? PlannerError)?.userMessage ?? "Couldn't reach \(address.displayName). Check the address and try again."
    }

    static func message(for problem: ServerAddress.Problem) -> String {
        switch problem {
        case .empty: "Enter your server's address."
        case .invalid: "That doesn't look like a server address. It should look like https://fridgedoor.example.com."
        case .unsupportedScheme: "Use an address that starts with https:// (or http:// for a server at home)."
        case .insecureRemote: "http isn't encrypted, so it only works for a server on your home network or Tailscale. Use the server's https:// address."
        }
    }
}
