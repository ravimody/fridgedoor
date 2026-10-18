import FridgedoorKit
import SwiftUI

/// Morning brief: consent for the AI-written brief and scheduled household-facts
/// maintenance (`POST daily-ai-settings`; enabling echoes `disclosureVersion` as
/// `consentVersion`), then the morning notification on/off and time
/// (`POST morning-digest`). Switches save on their own; time edits wait briefly so
/// scrolling the wheel doesn't send every minute.
struct DailyBriefView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @State private var aiBusy = false
    @State private var pendingAi: Bool?
    @State private var time = Date.now
    /// The debounce wait only; a request already sent is never cancelled (that would
    /// report a false error and revert the person's choice).
    @State private var debounce: Task<Void, Never>?
    /// A change made while a request was in flight, saved right after it.
    @State private var queued: Bool?
    /// Optimistic toggle value while a save is pending or in flight.
    @State private var pendingDigest: Bool?
    /// A morning-notification request is in flight.
    @State private var digestBusy = false
    @State private var changed = 0
    /// Turning the brief on asks for explicit agreement to the full disclosure first.
    @State private var askingConsent = false

    /// The full disclosure the switch accepts. Shown verbatim under "Read more".
    static let disclosure = [
        "The planner can prepare a short private overview for Home using your current plans, calendar context, reminders, recent permitted source metadata and confirmed private facts. It doesn't create events, send messages or mark tasks complete.",
        "When enabled, this also permits scheduled maintenance suggestions for household knowledge. AI processing is off until you turn it on here. Results are encrypted and kept for one week; usage records contain metadata only and are kept for up to 30 days.",
    ]

    var body: some View {
        List {
            aiSection
            digestSection
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Morning brief")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await store.refresh([.dailySettings])
            await model.load([.digest])
        }
        .sensoryFeedback(.success, trigger: changed)
        .sheet(isPresented: $askingConsent) {
            DailyBriefConsentSheet {
                guard let settings = store.dailySettings else { return }
                pendingAi = true
                await saveAi(enabled: true, settings: settings)
            }
        }
        .onAppear(perform: syncTime)
        .onChange(of: model.digest?.localTime) { _, _ in if debounce == nil && !digestBusy { syncTime() } }
    }

    // MARK: AI brief

    @ViewBuilder
    private var aiSection: some View {
        Section {
            SettingsSummary(points: [
                .init("sun.horizon", "The planner writes a short summary of your day for Home."),
                .init("tray.full", "It reads your plans, calendar, reminders, recent email details and confirmed household facts."),
                .init("hand.raised", "It never creates events, sends messages or completes to-dos."),
            ], details: Self.disclosure)
            if let settings = store.dailySettings {
                Toggle(isOn: Binding(get: { pendingAi ?? settings.enabled }, set: { value in
                    if value && !settings.enabled { askingConsent = true; return }
                    pendingAi = value
                    Task { await saveAi(enabled: value, settings: settings) }
                })) {
                    HStack {
                        Text("Morning brief").foregroundStyle(Color.ink)
                        if aiBusy { Spacer(); ProgressView() }
                    }
                }
                .disabled(aiBusy || (settings.available == false && !settings.enabled))
            } else {
                SettingsLoadingRow(failed: store.failedParts.contains(.dailySettings)) { Task { await store.refresh([.dailySettings]) } }
            }
        } footer: {
            if store.dailySettings?.available == false {
                Text("AI isn't set up on the server. Home still shows your plans.")
            } else {
                Text("Turning this on asks you to agree to the full description first. Teach suggestions' nightly learning also needs it.")
            }
        }
        .plannerRows()
    }

    private func saveAi(enabled: Bool, settings: DailySettings) async {
        guard !aiBusy else { return }
        aiBusy = true
        defer { aiBusy = false; pendingAi = nil }
        do {
            store.dailySettings = try await store.client.setDailySettings(enabled: enabled, expectedRevision: settings.revision, consentVersion: settings.disclosureVersion)
            changed += 1
            app.show(enabled ? "Morning brief turned on." : "Morning brief turned off.")
            await store.refresh([.dailyOverview])
        } catch {
            app.show(settingsErrorMessage(error, fallback: "Couldn't save the morning brief setting."), isError: true)
            await store.refresh([.dailySettings])
        }
    }

    // MARK: Morning notification

    @ViewBuilder
    private var digestSection: some View {
        if let digest = model.digest {
            Section {
                Toggle(isOn: Binding(get: { pendingDigest ?? digest.enabled }, set: { value in pendingDigest = value; scheduleSave(enabled: value, delay: .zero) })) {
                    Text("Morning notification").foregroundStyle(Color.ink)
                }
                .disabled(digestBusy || (!(digest.available ?? false) && !digest.enabled))
                DatePicker("Time", selection: Binding(get: { time }, set: { time = $0; scheduleSave(enabled: pendingDigest ?? digest.enabled, delay: .milliseconds(900)) }), displayedComponents: .hourAndMinute)
                    .environment(\.timeZone, store.timeZone)
                    .disabled(!digest.enabled && pendingDigest != true)
                if !(digest.available ?? false) {
                    SettingsNotice(text: digest.enabled ? "Morning delivery isn't set up on the server, so the time can't change right now. You can still turn it off." : "Morning delivery isn't set up on the server yet, so it can't be turned on.", tone: .warning)
                }
            } footer: {
                Text("A notification when your brief is ready; it opens Home. Times are in \(settingsTimeZoneName(store.timeZone, fallback: digest.timezone)). Choose which devices alert in Notifications.")
            }
            .plannerRows()
        } else {
            Section { SettingsLoadingRow(failed: model.failed.contains(.digest)) { Task { await model.load([.digest]) } } }
                .plannerRows()
        }
    }

    private func syncTime() {
        if let value = model.digest?.localTime, let date = localTimeDate(value, in: store.timeZone) { time = date }
    }

    private var localTime: String {
        let parts = store.calendar.dateComponents([.hour, .minute], from: time)
        return String(format: "%02d:%02d", parts.hour ?? 7, parts.minute ?? 0)
    }

    private func scheduleSave(enabled: Bool, delay: Duration) {
        if digestBusy { queued = enabled; return }
        debounce?.cancel()
        debounce = Task {
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled else { return }
            debounce = nil
            await saveDigest(enabled: enabled)
        }
    }

    private func saveDigest(enabled: Bool) async {
        guard let digest = model.digest, enabled != digest.enabled || localTime != digest.localTime else {
            pendingDigest = nil
            return
        }
        digestBusy = true
        do {
            let saved = try await model.client.setMorningDigest(enabled: enabled, localTime: localTime, expectedRevision: digest.revision)
            model.digest = saved
            // This iPhone's own brief alert follows the account's time; reschedule it now
            // rather than at the next throttled status check.
            PlatformPreferences.shared.serverDigest = saved
            PlatformSync.resync()
            changed += 1
            app.show(enabled ? "Morning notification set for \(localTimeLabel(localTime, in: store.timeZone))." : "Morning notification turned off.")
        } catch {
            queued = nil
            if !(error is CancellationError || (error as? URLError)?.code == .cancelled) {
                app.show(settingsErrorMessage(error, fallback: "Couldn't save. Check the current setting and try again."), isError: true)
                await model.load([.digest])
                syncTime()
            }
        }
        digestBusy = false
        if let next = queued {
            queued = nil
            await saveDigest(enabled: next)
        } else {
            pendingDigest = nil
        }
    }
}

/// Consent before the morning brief's AI starts: the full disclosure and an explicit
/// "Agree and turn on" (as for Email suggestions).
private struct DailyBriefConsentSheet: View {
    let turnOn: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(DailyBriefView.disclosure, id: \.self) { paragraph in
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
                    Text("You agree to AI processing for your morning brief and household-facts maintenance, as described here and in Privacy.")
                }
            }
            .plannerList()
            .navigationTitle("Turn on the morning brief")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
