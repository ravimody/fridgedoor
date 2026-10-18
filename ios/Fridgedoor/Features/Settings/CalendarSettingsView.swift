import FridgedoorKit
import SwiftUI

/// "Calendars to read" and "Calendar for new events" (README → calendar settings).
/// Choices are saved together (sources before the destination) with the toolbar's
/// Save, or automatically when you leave the page with changes.
struct CalendarSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @State private var saveSucceeded = 0

    var body: some View {
        List {
            if store.connection?.status != "active" {
                Section {
                    EmptyState(systemImage: "calendar.badge.exclamationmark", title: "Google isn't syncing", message: store.connection?.status == "paused" ? "Resume sync in Google account to choose calendars." : "Connect Google first, then choose which calendars to read.")
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
            } else if !model.loaded.contains(.calendars) {
                Section { SettingsLoadingRow(failed: model.failed.contains(.calendars)) { Task { await model.load([.calendars]) } } }
                    .plannerRows()
            } else {
                if let notice = model.calendarNotice {
                    Section { SettingsNotice(text: notice.text, tone: notice.tone) }
                }
                readSection
                destinationSection
                if model.hasUnsavedCalendarChanges {
                    Section {
                        Button("Discard changes", role: .destructive) { model.discardCalendarChanges() }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(model.isSavingCalendars)
                    }
                    .plannerRows()
                }
            }
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Calendars")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await store.refresh([.connection, .destination])
            if model.hasUnsavedCalendarChanges { await model.refreshCalendarStatus() } else { await model.load([.calendars]) }
        }
        .sensoryFeedback(.success, trigger: saveSucceeded)
        .toolbar {
            if model.isSavingCalendars {
                ToolbarItem(placement: .confirmationAction) { ProgressView() }
            } else if model.hasUnsavedCalendarChanges {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { if await model.saveCalendars() { saveSucceeded += 1 } } }
                        .disabled(model.calendars.isEmpty)
                }
            }
        }
        .onDisappear(perform: saveOnLeave)
    }

    /// Leaving with changes saves them, like every other setting; the result arrives as a
    /// toast because this page is gone.
    private func saveOnLeave() {
        guard model.hasUnsavedCalendarChanges, !model.isSavingCalendars, !model.calendars.isEmpty else { return }
        let model = model, app = app
        Task {
            let saved = await model.saveCalendars()
            if let notice = model.calendarNotice {
                app.show(notice.text, isError: !saved)
            }
        }
    }

    // MARK: Calendars to read

    private var readSection: some View {
        @Bindable var model = model
        return Section {
            if model.calendars.isEmpty {
                Text("No calendars are available yet.").foregroundStyle(Color.muted)
            }
            ForEach($model.calendars) { $calendar in
                CalendarReadRow(calendar: $calendar)
                    .disabled(model.isSavingCalendars)
            }
        } header: {
            Text("Calendars to read")
        } footer: {
            Text("Selected calendars show on Home. Household calendars are shared; personal and work calendars stay with you.")
        }
        .plannerRows()
    }

    // MARK: Calendar for new events

    private var destinationSection: some View {
        let writable = model.calendars.filter(\.canBeDestination)
        return Section {
            Picker("Add plans to", selection: Binding(get: { model.effectiveDestinationChoice }, set: { model.destinationChoice = $0 })) {
                Text("Choose a calendar").tag("")
                ForEach(writable) { Text($0.name).tag($0.id) }
            }
            .pickerStyle(.menu)
            .tint(Color.muted)
            .disabled(model.isSavingCalendars || writable.isEmpty)
            if model.effectiveDestinationChoice.isEmpty {
                if model.savedDestinationIneligible {
                    SettingsNotice(text: "\(store.destination?.name ?? "The saved calendar") can't take new events anymore: it's read-only, set to work, or gone. Choose another.", tone: .warning)
                } else if writable.isEmpty {
                    Text("Select a household or personal calendar you can edit above first.")
                        .font(.footnote).foregroundStyle(Color.muted)
                }
            }
        } header: {
            Text("Calendar for new events")
        } footer: {
            Text("Plans you add to the calendar go here, and the household can see them.")
        }
        .plannerRows()
    }
}

private struct CalendarReadRow: View {
    @Binding var calendar: SourceCalendar

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: $calendar.selected) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(calendar.name).foregroundStyle(Color.ink)
                    Text(accessLabel).font(.caption).foregroundStyle(Color.muted)
                }
            }
            Picker("Privacy", selection: $calendar.classification) {
                Text("Household · shared").tag("household")
                Text("Personal · only you").tag("personal")
                Text("Work · only you").tag("work")
            }
            .pickerStyle(.menu)
            .tint(Color.muted)
            .accessibilityLabel("\(calendar.name) privacy")
            if calendar.selected || calendar.isDestination == true {
                syncStatus
            }
        }
        .padding(.vertical, 4)
    }

    private var accessLabel: String {
        switch calendar.accessRole {
        case "owner": "Owner"
        case "writer": "Can edit"
        case "reader": "Read only"
        case "freeBusyReader": "Free/busy only"
        default: calendar.accessRole
        }
    }

    /// Only problems show here; sync times and counts are in Help & diagnostics.
    @ViewBuilder
    private var syncStatus: some View {
        let sync = calendar.sync
        VStack(alignment: .leading, spacing: 4) {
            if calendar.isDestination == true {
                Label("New plans are added here.", systemImage: "calendar.badge.plus").foregroundStyle(Color.plannerAccent)
            }
            if let error = sync?.error {
                Label(errorText(error), systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.warning)
            } else if sync?.stale == true {
                Label("Sync is overdue. Events may be out of date.", systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.warning)
            } else if sync?.lastSuccessAt == nil, calendar.selected {
                Label("Waiting for the first sync.", systemImage: "clock")
            }
        }
        .font(.caption)
        .foregroundStyle(Color.muted)
        .labelStyle(CompactLabelStyle())
    }

    private func errorText(_ error: String) -> String {
        switch error {
        case "reconnect": "Reconnect Google to resume syncing."
        case "resyncing": "Refreshing calendar history. The worker will retry automatically."
        default: "Calendar sync failed. Retrying automatically; existing events may be out of date."
        }
    }
}

private struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon.frame(width: 14)
            configuration.title
        }
    }
}
