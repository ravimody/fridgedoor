import FridgedoorKit
import SwiftUI

/// Google connection status and lifecycle. Consent is browser-only (the server returns
/// `NATIVE_UNSUPPORTED` to the app), so Connect/Reconnect opens the web Settings page.
struct GoogleAccountView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @State private var browser: BrowserLink?
    @State private var busy = false
    @State private var confirmDisconnect = false
    @State private var showDelete = false

    var body: some View {
        List {
            if let connection = store.connection {
                statusSection(connection)
                actionSections(connection)
            } else {
                Section { SettingsLoadingRow(failed: store.refreshError != nil) { Task { await store.refresh([.connection]) } } }
                    .plannerRows()
            }
            if store.connection?.connected == true {
                Section {
                    Button("Disconnect Google", role: .destructive) { confirmDisconnect = true }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .disabled(busy)
                }
                .plannerRows()
            }
            Section {
                Button("Delete my private data", role: .destructive) { showDelete = true }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(busy)
            } footer: {
                Text("Removes your private data on the server and disconnects Google. Shared household plans stay.")
            }
            .plannerRows()
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Google account")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh([.connection, .destination]) }
        .fullScreenCover(item: $browser, onDismiss: returnedFromBrowser) { link in
            SafariView(url: link.url).ignoresSafeArea()
        }
        .confirmationDialog("Disconnect Google?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { Task { await transition("disconnect") } }
        } message: {
            Text("Gmail and Calendar sync stop and Fridgedoor asks Google to revoke its access. Saved plans stay. You can connect again later.")
        }
        .sheet(isPresented: $showDelete) { DeletePrivateDataSheet().environment(model) }
    }

    // MARK: Sections

    @ViewBuilder
    private func statusSection(_ connection: ConnectionStatus) -> some View {
        Section {
            HStack(spacing: 14) {
                SettingsGlyph(systemImage: connection.connected ? "envelope.badge" : "envelope", tint: connection.status == "active" ? .plannerAccent : .muted)
                VStack(alignment: .leading, spacing: 3) {
                    Text(connection.email.flatMap { $0.isEmpty ? nil : $0 } ?? "Not connected")
                        .font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                    Text(statusSentence(connection)).font(.subheadline).foregroundStyle(connection.status == "active" ? Color.muted : GoogleStatus(connection.status).tone)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
            if connection.connected {
                LabeledContent("Last email sync", value: settingsTimestamp(connection.syncLastSuccessAt, in: store.timeZone) ?? "Not yet")
            }
            if let code = connection.syncErrorCode, connection.status != "disconnected" {
                SettingsNotice(text: syncErrorText(code), tone: .warning)
            }
        }
        .plannerRows()
    }

    @ViewBuilder
    private func actionSections(_ connection: ConnectionStatus) -> some View {
        switch connection.status {
        case "active":
            Section {
                Button("Pause sync", systemImage: "pause.circle") { Task { await transition("pause") } }
                    .disabled(busy)
            } footer: {
                Text("Stops Gmail and Calendar sync until you resume, and cancels email waiting to be read.")
            }
            .plannerRows()
        case "paused":
            Section {
                Button("Resume sync", systemImage: "play.circle") { Task { await transition("resume") } }
                    .disabled(busy)
            } footer: {
                Text("Resume to pick up new email and calendar changes.")
            }
            .plannerRows()
        default:
            Section {
                Button {
                    browser = BrowserLink(url: store.client.webURL("settings/email"))
                } label: {
                    Label(connection.status == "needs_reauth" ? "Reconnect Google in Safari" : "Connect Google in Safari", systemImage: "safari")
                }
            } footer: {
                Text("Google sign-in only works in a browser. Finish there, then tap Done to come back.")
            }
            .plannerRows()
            Section("What connecting shares") {
                SettingsSummary(points: [
                    .init("envelope", "The planner can read Gmail to find household plans."),
                    .init("calendar", "It reads the calendars you choose and can add events you approve."),
                    .init("line.3.horizontal.decrease", "Senders and labels you skip are filtered out where possible."),
                ], details: [Self.consentDetail])
            }
            .plannerRows()
        }
        if connection.connected, connection.status != "needs_reauth" {
            Section {
                Button("Reconnect in Safari", systemImage: "safari") { browser = BrowserLink(url: store.client.webURL("settings/email")) }
            } footer: {
                Text("Use this if Google asks you to approve access again.")
            }
            .plannerRows()
        }
    }

    /// The full description of Google access, shown under "Read more".
    private static let consentDetail = "Google consent requests read-only Gmail access plus Calendar list and event access. The planner scans Gmail message metadata and bodies to find possible household plans; exclusions reduce processing and sharing but can't promise that an excluded work message is never read. Calendar sync starts with no calendars selected."

    private func statusSentence(_ connection: ConnectionStatus) -> String {
        switch connection.status {
        case "active": "Connected · syncing"
        case "paused": "Connected · sync paused"
        case "needs_reauth": "Google needs you to reconnect"
        default: "Connect to find plans in email and calendars"
        }
    }

    private func syncErrorText(_ code: String) -> String {
        switch code {
        case "reconnect", "needs_reauth", "GOOGLE_REAUTH_REQUIRED": "Google needs you to reconnect before sync can continue."
        default: "The last email sync had a problem. It retries automatically."
        }
    }

    // MARK: Actions

    private func transition(_ action: String) async {
        guard let revision = store.connection?.revision, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let next = try await model.client.transitionConnection(action, expectedRevision: revision)
            store.connection = next
            await store.refresh([.connection, .destination])
            await model.load([.calendars, .backgroundAi])
            app.show(action == "disconnect" ? "Google disconnected." : action == "pause" ? "Sync paused." : "Sync resumed.")
        } catch {
            app.show(settingsErrorMessage(error, fallback: "The connection couldn't be changed. Try again."), isError: true)
            await store.refresh([.connection])
        }
    }

    private func returnedFromBrowser() {
        Task {
            let before = store.connection?.status
            await store.refresh([.connection, .destination])
            await model.load([.calendars, .backgroundAi, .policy])
            if before != "active", store.connection?.status == "active" {
                app.show("Google connected. Choose calendars to begin sync.")
            }
        }
    }
}

/// Strong confirmation for `DELETE connection/private-data`: the person types DELETE.
private struct DeletePrivateDataSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmation = ""
    @State private var busy = false
    @State private var failed = false

    private var confirmed: Bool { confirmation.trimmingCharacters(in: .whitespaces).uppercased() == "DELETE" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("This permanently deletes, for your account only:")
                    ForEach(Self.removed, id: \.self) { item in
                        Label(item, systemImage: "minus.circle").foregroundStyle(Color.ink)
                    }
                } footer: {
                    Text("Shared household plans, lists and calendar events stay. Older encrypted off-site backups age out on their own schedule. This can't be undone.")
                }
                .plannerRows()
                Section {
                    TextField("Type DELETE to confirm", text: $confirmation)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                } header: {
                    Text("Confirm")
                }
                .plannerRows()
                if failed {
                    Section { SettingsNotice(text: "Your data couldn't be deleted. Nothing was changed; try again.", tone: .warning) }
                }
                Section {
                    Button(role: .destructive) {
                        Task { await delete() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("Delete my private data").bold() }
                            Spacer()
                        }
                        .frame(minHeight: 44)
                    }
                    .disabled(!confirmed || busy)
                }
                .plannerRows()
            }
            .plannerList()
            .navigationTitle("Delete private data")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(busy)
    }

    private static let removed = [
        "Google connection, email sources and calendar choices",
        "Private plans, drafts and requests",
        "Household facts and their history",
        "Shortcut credentials and pending captures",
        "Email suggestion and daily brief settings",
        "Teach suggestions ratings and learned preferences",
    ]

    private func delete() async {
        busy = true; failed = false
        defer { busy = false }
        do {
            try await model.client.deletePrivateData()
            dismiss()
            app.show("Your private data was deleted.")
            await store.refresh()
            await model.load()
        } catch {
            failed = true
        }
    }
}
