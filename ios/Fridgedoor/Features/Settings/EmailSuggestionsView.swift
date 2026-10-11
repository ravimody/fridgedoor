import FridgedoorKit
import SwiftUI

/// Background AI over synced email (README → Email suggestions) and the source
/// privacy policy that filters what reaches it. Turning it on asks for consent in a
/// sheet; turning it off sits at the bottom. Operator details (provider, model,
/// counts, limits) are in Help & diagnostics.
struct EmailSuggestionsView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @State private var showConsent = false
    @State private var confirmOff = false
    @State private var busy = false
    @State private var changed = 0

    /// What the person agrees to when turning this on. Shown verbatim under "Read more"
    /// and in the consent sheet.
    static let disclosure = [
        "The configured AI provider receives limited email text and supported attachments to suggest household plans. Permitted logistics may be shared with your household; source emails stay private. Calendar changes require approval.",
        "Enabling starts with up to 100 recent retained emails, then new synced email. Excluded senders and labels are skipped before AI when recognized; this can't guarantee every work message is excluded. Turning this off stops future analysis, including pending results, but doesn't remove saved suggestions or pause Gmail sync.",
    ]

    static let points: [SettingsSummary.Point] = [
        .init("envelope", "The planner reads new email to suggest plans for Home."),
        .init("person.2", "Your household sees the plan details; the emails stay private to you."),
        .init("calendar.badge.checkmark", "Nothing goes on a calendar without your approval."),
    ]

    var body: some View {
        List {
            if let status = model.backgroundAi {
                statusSection(status)
            } else {
                Section { SettingsLoadingRow(failed: model.failed.contains(.backgroundAi)) { Task { await model.load([.backgroundAi]) } } }
                    .plannerRows()
            }
            SourcePolicySections()
            if let status = model.backgroundAi, status.enabled {
                Section {
                    Button("Turn off email suggestions", role: .destructive) { confirmOff = true }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .disabled(busy)
                } footer: {
                    Text("Google sync keeps running; pause it in Google account.")
                }
                .plannerRows()
            }
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Email suggestions")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load([.backgroundAi, .policy]) }
        .sensoryFeedback(.success, trigger: changed)
        .sheet(isPresented: $showConsent) {
            EmailSuggestionsConsentSheet { await save(enabled: true) }
        }
        .confirmationDialog("Turn off email suggestions?", isPresented: $confirmOff, titleVisibility: .visible) {
            Button("Turn off", role: .destructive) { Task { await save(enabled: false) } }
        } message: {
            Text("The planner stops reading new email, including emails waiting to be read. Saved suggestions stay, and Gmail sync keeps running.")
        }
    }

    private func statusSection(_ status: BackgroundAiStatus) -> some View {
        Section {
            LabeledContent {
                if busy { ProgressView() } else { Text(status.enabled ? "On" : "Off").foregroundStyle(Color.muted) }
            } label: {
                Text("Email suggestions").foregroundStyle(Color.ink)
            }
            SettingsSummary(points: Self.points, details: Self.disclosure)
            if !status.available {
                SettingsNotice(text: "Email suggestions aren't available on the server right now.", tone: .warning)
            } else if !status.connectionActive {
                SettingsNotice(text: "Connect or resume Google to process email.", tone: .info)
            }
            if status.enabled, status.pausedForVolume {
                SettingsNotice(text: "Paused for a while because of unusually heavy email. It resumes on its own.", tone: .warning)
            } else if status.enabled, status.failuresLastDay > 0 {
                SettingsNotice(text: "\(status.failuresLastDay) \(status.failuresLastDay == 1 ? "email" : "emails") couldn't be read in the last day, so they may be missing suggestions.", tone: .warning)
            }
            if !status.enabled {
                Button {
                    showConsent = true
                } label: {
                    Text("Turn on email suggestions…").frame(maxWidth: .infinity)
                }
                .buttonStyle(.plannerPrimary)
                .disabled(busy || !status.available)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 12, trailing: 16))
            }
        }
        .plannerRows()
    }

    private func save(enabled: Bool) async {
        guard let status = model.backgroundAi, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            model.backgroundAi = try await model.client.setBackgroundAi(enabled: enabled, expectedRevision: status.revision)
            changed += 1
            app.show(enabled ? "Email suggestions are on." : "Email suggestions are off. Google sync keeps running.")
        } catch {
            app.show(settingsErrorMessage(error, fallback: "Couldn't save. Check the current setting and try again."), isError: true)
            await model.load([.backgroundAi])
        }
    }
}

/// Consent before background AI starts: the summary, the full disclosure, and an
/// explicit "Agree and turn on".
private struct EmailSuggestionsConsentSheet: View {
    let turnOn: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SettingsSummary(points: EmailSuggestionsView.points)
                }
                .plannerRows()
                Section("Before you turn this on") {
                    ForEach(EmailSuggestionsView.disclosure, id: \.self) { paragraph in
                        Text(paragraph).font(.subheadline).foregroundStyle(Color.ink)
                    }
                }
                .plannerRows()
                Section {
                    Button {
                        Task {
                            busy = true
                            await turnOn()
                            busy = false
                            dismiss()
                        }
                    } label: {
                        HStack {
                            if busy { ProgressView().tint(Color.onAccent) }
                            Text("Agree and turn on")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plannerPrimary)
                    .disabled(busy)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    Text("You agree to background AI processing and the sharing and retention described here and in Privacy.")
                }
            }
            .plannerList()
            .navigationTitle("Email suggestions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(busy)
    }
}

/// Excluded senders/labels and the generic-appointment opt-in (`PUT source-policy`).
/// Each change saves immediately with the policy's revision.
private struct SourcePolicySections: View {
    @Environment(AppModel.self) private var app
    @Environment(SettingsModel.self) private var model
    @State private var adding: Field?
    @State private var draft = ""
    @State private var busy = false

    enum Field: String, Identifiable { case sender, label; var id: String { rawValue } }

    var body: some View {
        if let policy = model.policy {
            Section {
                ForEach(policy.excludedSenders, id: \.self) { sender in
                    Text(sender).foregroundStyle(Color.ink)
                        .swipeActions { Button("Delete", systemImage: "trash", role: .destructive) { update { $0.excludedSenders.removeAll { $0 == sender } } } }
                        .contextMenu { Button("Delete", systemImage: "trash", role: .destructive) { update { $0.excludedSenders.removeAll { $0 == sender } } } }
                }
                Button("Add sender", systemImage: "plus") { draft = ""; adding = .sender }
                    .disabled(busy || policy.excludedSenders.count >= 100)
            } header: {
                Text("Skip these senders")
            }
            .plannerRows()
            Section {
                ForEach(policy.excludedLabels, id: \.self) { label in
                    Text(gmailLabelName(label)).foregroundStyle(Color.ink)
                        .swipeActions { Button("Delete", systemImage: "trash", role: .destructive) { update { $0.excludedLabels.removeAll { $0 == label } } } }
                        .contextMenu { Button("Delete", systemImage: "trash", role: .destructive) { update { $0.excludedLabels.removeAll { $0 == label } } } }
                }
                Button("Add Gmail label", systemImage: "plus") { draft = ""; adding = .label }
                    .disabled(busy || policy.excludedLabels.count >= 100)
            } header: {
                Text("Skip these Gmail labels")
            } footer: {
                Text("The planner skips matching email before reading it, when it can tell.")
            }
            .plannerRows()
            Section {
                Toggle("Share medical appointment times", isOn: Binding(get: { policy.genericAppointmentOptIn }, set: { value in update { $0.genericAppointmentOptIn = value } }))
                    .disabled(busy)
            } footer: {
                Text("Medical email stays private. When on, only appointment logistics like time and place are shared, never a diagnosis or provider details.")
            }
            .plannerRows()
            .alert(adding == .sender ? "Skip a sender" : "Skip a Gmail label", isPresented: Binding(get: { adding != nil }, set: { if !$0 { adding = nil } }), presenting: adding) { field in
                TextField(field == .sender ? "news@example.com" : "Receipts", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(field == .sender ? .emailAddress : .default)
                Button("Add") { add(field) }
                Button("Cancel", role: .cancel) {}
            } message: { field in
                Text(field == .sender ? "Enter the full email address." : "Enter the label name exactly as it appears in Gmail.")
            }
        } else {
            Section("Skip these senders") { SettingsLoadingRow(failed: model.failed.contains(.policy)) { Task { await model.load([.policy]) } } }
                .plannerRows()
        }
    }

    private func add(_ field: Field) {
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        switch field {
        case .sender:
            guard value.wholeMatch(of: /[^@\s]+@[^@\s]+\.[^@\s]+/) != nil else {
                app.show("Enter a full email address, like news@example.com.", isError: true)
                return
            }
            update { if !$0.excludedSenders.contains(value) { $0.excludedSenders.append(value) } }
        case .label:
            guard value.utf16.count <= 200 else { app.show("Label names are limited to 200 characters.", isError: true); return }
            update { if !$0.excludedLabels.contains(value) { $0.excludedLabels.append(value) } }
        }
    }

    private func update(_ change: (inout SourcePolicy) -> Void) {
        guard var next = model.policy, !busy else { return }
        change(&next)
        guard next != model.policy else { return }
        let previous = model.policy
        model.policy = next // optimistic
        busy = true
        Task {
            defer { busy = false }
            do {
                model.policy = try await model.client.saveSourcePolicy(next)
            } catch {
                model.policy = previous
                app.show(settingsErrorMessage(error, fallback: "Source preferences couldn't be saved."), isError: true)
                if (error as? PlannerError)?.isStale == true { await model.load([.policy]) }
            }
        }
    }
}
