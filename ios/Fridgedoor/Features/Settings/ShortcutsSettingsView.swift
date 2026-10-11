import AppIntents
import FridgedoorKit
import SwiftUI
import UniformTypeIdentifiers

/// Siri phrases, the Share sheet, and capture-only credentials for the Apple Shortcut
/// (`/capture-credentials`). The app's own Share extension keeps a separate
/// capture-only credential of its own.
struct ShortcutsSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @State private var naming = false
    @State private var label = "Phone shortcut"
    @State private var created: NewCaptureCredential?
    @State private var revoking: CaptureCredential?
    @State private var browser: BrowserLink?
    @State private var busy = false

    var body: some View {
        List {
            Section {
                SettingsSummary(points: [
                    .init("basket", "“Add to groceries in Fridgedoor”"),
                    .init("calendar", "“What's on today in Fridgedoor”"),
                    .init("sparkles", "“Ask Fridgedoor”"),
                ])
                ShortcutsLink()
                    .shortcutsLinkStyle(.automaticOutline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            } header: {
                Text("Ask Siri")
            }
            .plannerRows()

            Section {
                Label {
                    Text("Share text, links, photos or PDFs from any app with **Share → Fridgedoor**. Nothing to set up.")
                } icon: {
                    SettingsGlyph(systemImage: "square.and.arrow.up")
                }
                .font(.subheadline)
                if let share = model.shareCredential {
                    // Not revocable here: Settings would only recreate it at next launch, and
                    // Share stops working until then. Signing out revokes it.
                    VStack(alignment: .leading, spacing: 2) {
                        Text("This iPhone's Share sheet").foregroundStyle(Color.ink)
                        Text(credentialDetail(share)).font(.caption).foregroundStyle(Color.muted)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Share from this iPhone")
            } footer: {
                if model.shareCredential != nil {
                    Text("Managed by the app and revoked when you sign out.")
                }
            }
            .plannerRows()

            Section {
                if !model.loaded.contains(.credentials) {
                    SettingsLoadingRow(failed: model.failed.contains(.credentials)) { Task { await model.load([.credentials]) } }
                } else if active.isEmpty {
                    Text("No Shortcut credentials yet.").foregroundStyle(Color.muted)
                }
                ForEach(active) { credential in
                    credentialRow(credential)
                        .swipeActions { Button("Revoke", systemImage: "xmark.circle", role: .destructive) { revoking = credential } }
                        .contextMenu { Button("Revoke credential", systemImage: "xmark.circle", role: .destructive) { revoking = credential } }
                }
                Button("Create Shortcut credential", systemImage: "key.badge.plus") { label = "Phone shortcut"; naming = true }
                    .disabled(busy)
            } header: {
                Text("Shortcut credentials")
            } footer: {
                Text("A credential can only send things in; it can't read plans or add events. What it sends waits on Home for you.\(revokedCount > 0 ? " \(revokedCount) revoked credential\(revokedCount == 1 ? "" : "s") hidden." : "")")
            }
            .plannerRows()

            Section {
                Button {
                    browser = BrowserLink(url: store.client.webURL("settings/other-apps"))
                } label: {
                    Label("Download the Shortcut in Safari", systemImage: "safari")
                }
                Link(destination: URL(string: "shortcuts://")!) {
                    Label("Open the Shortcuts app", systemImage: "square.2.layers.3d")
                }
            } header: {
                Text("Apple Shortcut setup")
            } footer: {
                Text("1. Create and copy a credential above.\n2. Download the Shortcut in Safari, open it in Shortcuts and tap Set Up Shortcut.\n3. Paste the credential when asked, without “Bearer”.\n4. Run it from Share or on its own to speak or type. What you send waits on Home.")
            }
            .plannerRows()
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Siri, Share & Shortcuts")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load([.credentials]) }
        .alert("New Shortcut credential", isPresented: $naming) {
            TextField("Label", text: $label)
            Button("Create") { Task { await create() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Name it after the device or Shortcut that will use it.")
        }
        .confirmationDialog("Revoke \(revoking?.label ?? "this credential")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { credential in
            Button("Revoke", role: .destructive) { Task { await revoke(credential) } }
        } message: { _ in
            Text("Shortcuts using it can no longer submit.")
        }
        .sheet(item: Binding(get: { created.map { CreatedBox(credential: $0) } }, set: { if $0 == nil { created = nil } })) { box in
            CreatedCredentialSheet(credential: box.credential) { browser = BrowserLink(url: store.client.webURL("settings/other-apps")) }
        }
        .fullScreenCover(item: $browser) { SafariView(url: $0.url).ignoresSafeArea() }
    }

    /// Shortcut credentials only; this iPhone's Share credential is listed above.
    private var active: [CaptureCredential] { model.shortcutCredentials }
    private var revokedCount: Int { model.credentials.filter { $0.status != "active" }.count }

    private func credentialRow(_ credential: CaptureCredential) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(credential.label).foregroundStyle(Color.ink)
            Text(credentialDetail(credential)).font(.caption).foregroundStyle(Color.muted)
        }
        .accessibilityElement(children: .combine)
    }

    private func credentialDetail(_ credential: CaptureCredential) -> String {
        let created = settingsTimestamp(credential.createdAt, in: store.timeZone).map { "Created \($0)" } ?? "Active"
        guard let used = TimeLabels.relative(credential.lastUsedAt) else { return "\(created) · Not used yet" }
        return "\(created) · Used \(used)"
    }

    private func create() async {
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true
        defer { busy = false }
        do {
            created = try await model.client.createCaptureCredential(label: (name.isEmpty ? "Phone shortcut" : name).clipped(utf16: 80))
            await model.load([.credentials])
        } catch {
            app.show(settingsErrorMessage(error, fallback: "Couldn't create a capture credential."), isError: true)
        }
    }

    private func revoke(_ credential: CaptureCredential) async {
        busy = true
        defer { busy = false }
        do {
            try await model.client.revokeCaptureCredential(credential.id)
            await model.load([.credentials])
            app.show("Credential revoked. Shortcuts using it can no longer submit.")
        } catch {
            app.show(settingsErrorMessage(error, fallback: "Couldn't revoke this credential. Try again."), isError: true)
        }
    }
}

private struct CreatedBox: Identifiable {
    let credential: NewCaptureCredential
    var id: String { credential.id }
}

/// Shows the one-time token. It is never readable again after this sheet closes.
private struct CreatedCredentialSheet: View {
    let credential: NewCaptureCredential
    let openSetup: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var copied = 0

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(credential.token)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .foregroundStyle(Color.ink)
                        .padding(.vertical, 4)
                    Button("Copy credential", systemImage: "doc.on.doc") {
                        // Local-only and short-lived: don't sync a secret through Universal Clipboard.
                        UIPasteboard.general.setItems([[UTType.plainText.identifier: credential.token]], options: [.localOnly: true, .expirationDate: Date.now.addingTimeInterval(600)])
                        copied += 1
                    }
                } header: {
                    Text(credential.label)
                } footer: {
                    Text("Copy it now — it's shown only once. Paste it into the Shortcut's setup question without adding “Bearer”. The clipboard clears it after 10 minutes.")
                }
                .plannerRows()
                Section {
                    Button("Download the Shortcut in Safari", systemImage: "safari") { dismiss(); openSetup() }
                }
                .plannerRows()
            }
            .plannerList()
            .navigationTitle("Credential created")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sensoryFeedback(.success, trigger: copied)
        }
        .presentationDetents([.medium, .large])
    }
}

/// Server limits are zod `.max(n)`, which counts UTF-16 code units (an emoji is 2+).
/// File-private on purpose; keeps whole Characters.
private extension String {
    func clipped(utf16 limit: Int) -> String {
        guard utf16.count > limit else { return self }
        var result = "", used = 0
        for character in self {
            used += character.utf16.count
            if used > limit { break }
            result.append(character)
        }
        return result
    }
}
