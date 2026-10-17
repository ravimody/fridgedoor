import FridgedoorKit
import SwiftUI
import UIKit
import UserNotifications

/// Settings root, grouped by what people want to do. Row values summarize each page's
/// state so most people never need to open it. Data not cached by `PlannerStore` lives
/// in a `SettingsModel` shared with those pages.
/// Pushed pages don't inherit environment set on the root list (they crash on iOS 26.5
/// without it), so every `NavigationLink` destination gets `.environment(model)`.
struct SettingsView: View {
    @Environment(PlannerStore.self) private var store
    @State private var model: SettingsModel?

    var body: some View {
        Group {
            if let model {
                SettingsRootList().environment(model)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .plannerBackground()
        .navigationTitle("Settings")
        .task {
            guard model == nil else { return }
            let next = SettingsModel(store: store)
            model = next
            await next.load()
        }
    }
}

private struct SettingsRootList: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @Bindable private var prefs = PlatformPreferences.shared
    @State private var confirmSignOut = false
    @State private var confirmSwitch = false
    @State private var notificationStatus: UNAuthorizationStatus?

    var body: some View {
        @Bindable var app = app
        List {
            Section {
                NavigationLink { SignedInDevicesView().environment(model) } label: { profile }
            }
            .plannerRows()

            Section("Household") {
                NavigationLink { GoogleAccountView().environment(model) } label: {
                    SettingsRowLabel(title: "Email", systemImage: "envelope", value: connectionValue, valueTone: GoogleStatus(store.connection?.status).tone)
                }
                NavigationLink { CalendarSettingsView().environment(model) } label: {
                    SettingsRowLabel(title: "Calendars", systemImage: "calendar", value: calendarValue)
                }
                .disabled(store.connection == nil || otherMailbox)
            }
            .plannerRows()

            Section("Your day") {
                NavigationLink { DailyBriefView().environment(model) } label: {
                    SettingsRowLabel(title: "Daily brief", systemImage: "sun.horizon", value: briefValue)
                }
                NavigationLink { NotificationsSettingsView().environment(model) } label: {
                    SettingsRowLabel(title: "Notifications", systemImage: "bell", value: notificationsValue)
                }
            }
            .plannerRows()

            Section("Suggestions") {
                NavigationLink { EmailSuggestionsView().environment(model) } label: {
                    SettingsRowLabel(title: "Email suggestions", systemImage: "sparkles", value: model.backgroundAi.map { $0.enabled ? "On" : "Off" })
                }
                NavigationLink { RelevanceTrialView() } label: {
                    SettingsRowLabel(title: "Teach suggestions", systemImage: "hand.thumbsup")
                }
            }
            .plannerRows()

            Section {
                NavigationLink { ShortcutsSettingsView().environment(model) } label: {
                    SettingsRowLabel(title: "Siri, Share & Shortcuts", systemImage: "square.and.arrow.up", value: shortcutValue)
                }
                Picker(selection: $app.appearance) {
                    ForEach(Appearance.allCases) { Text($0.label).tag($0) }
                } label: {
                    Label {
                        Text("Appearance").foregroundStyle(Color.ink)
                    } icon: {
                        SettingsGlyph(systemImage: "circle.lefthalf.filled")
                    }
                }
                .pickerStyle(.menu)
                .tint(Color.muted)
                NavigationLink { AppIconSettingsView() } label: {
                    SettingsRowLabel(title: "App icon", systemImage: "app")
                }
                NavigationLink { PrivacyDisclosureView() } label: {
                    SettingsRowLabel(title: "Privacy", systemImage: "hand.raised")
                }
                NavigationLink { HelpDiagnosticsView().environment(model) } label: {
                    SettingsRowLabel(title: "Help & diagnostics", systemImage: "info.circle")
                }
            }
            .plannerRows()

            Section {
                Button("Switch server") { confirmSwitch = true }
                    .frame(maxWidth: .infinity, minHeight: 44)
            } footer: {
                Text("Connected to \(ServerAddress.Normalized.displayName(for: store.client.baseURL)).")
            }
            .plannerRows()

            Section {
                Button("Sign out", role: .destructive) { confirmSignOut = true }
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .plannerRows()
        }
        .plannerList()
        .settingsBottomClearance()
        .refreshable {
            await store.refresh([.me, .connection, .destination, .assistantSettings, .dailySettings])
            await model.load()
        }
        .task { notificationStatus = await NotificationScheduler.authorizationStatus() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            Task { notificationStatus = await NotificationScheduler.authorizationStatus() }
        }
        .onChange(of: store.connection?.status) { _, _ in
            Task { await model.load([.calendars, .backgroundAi]) }
        }
        .confirmationDialog("Sign out of Fridgedoor on this iPhone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await app.signOut() } }
        } message: {
            Text("Scheduled reminder alerts on this iPhone will be removed.")
        }
        .confirmationDialog("Switch to a different server?", isPresented: $confirmSwitch, titleVisibility: .visible) {
            Button("Sign out and switch", role: .destructive) { Task { await app.switchServer() } }
        } message: {
            Text("You'll be signed out of \(ServerAddress.Normalized.displayName(for: store.client.baseURL)). Reminder alerts, widgets and Spotlight results from it are removed from this iPhone.")
        }
    }

    // MARK: Profile

    private var profile: some View {
        HStack(spacing: 14) {
            PersonAvatar(personId: store.member.id, size: 44).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(store.member.displayName).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                Text(profileDetail).font(.subheadline).foregroundStyle(Color.muted)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows signed-in devices")
    }

    /// "Signed in on 1 iPhone · Eastern Time" — the timezone is a footnote here, not a row.
    private var profileDetail: String {
        let zone = settingsTimeZoneName(store.member.timeZone, fallback: store.member.timezone)
        guard let sessions = model.sessions?.sessions, !sessions.isEmpty else { return zone }
        let allPhones = sessions.allSatisfy { !$0.label.localizedCaseInsensitiveContains("ipad") }
        let noun = allPhones ? "iPhone" : "device"
        return "Signed in on \(sessions.count) \(noun)\(sessions.count == 1 ? "" : "s") · \(zone)"
    }

    // MARK: Values

    private var connectionValue: String? {
        guard let connection = store.connection else { return nil }
        return GoogleStatus(connection.status).label
    }

    /// Calendars come from Google; a connected iCloud or other IMAP mailbox has none to read.
    private var otherMailbox: Bool {
        guard let connection = store.connection else { return false }
        return !connection.isGoogle && connection.status != "disconnected"
    }

    /// "Household + 1": the destination (or first) calendar read, plus how many more.
    private var calendarValue: String? {
        guard let connection = store.connection else { return nil }
        guard !otherMailbox else { return "Google only" }
        guard connection.status == "active" else { return "Connect first" }
        guard model.loaded.contains(.calendars) else { return nil }
        let selected = model.savedCalendars.filter(\.selected)
        guard let first = selected.first(where: { $0.isDestination == true }) ?? selected.first else { return "None" }
        return selected.count == 1 ? first.name : "\(first.name) + \(selected.count - 1)"
    }

    /// The morning time when the notification is on, otherwise whether the AI brief is on.
    private var briefValue: String? {
        if let digest = model.digest, digest.enabled { return localTimeLabel(digest.localTime, in: store.timeZone) }
        guard let daily = store.dailySettings else { return nil }
        return daily.enabled ? "On" : "Off"
    }

    private var notificationsValue: String? {
        guard let status = notificationStatus else { return nil }
        if status == .denied || status == .notDetermined { return "Off" }
        return prefs.reminderAlerts || prefs.digestAlerts ? "On" : "Off"
    }

    private var shortcutValue: String? {
        guard model.loaded.contains(.credentials) else { return nil }
        let active = model.shortcutCredentials.count
        return active == 0 ? nil : "\(active) active"
    }
}

/// Email connection states as the person should read them.
struct GoogleStatus {
    let raw: String?
    init(_ raw: String?) { self.raw = raw }

    var label: String {
        switch raw {
        case "active": "Connected"
        case "paused": "Paused"
        case "needs_reauth": "Reconnect"
        case "disconnected": "Not connected"
        default: "—"
        }
    }

    /// Connected is ordinary state (muted); paused and reconnect are worth noticing.
    var tone: Color {
        switch raw {
        case "paused", "needs_reauth": .warning
        default: .muted
        }
    }
}

/// `HH:mm` (member-local wall time) → "7:00 AM".
func localTimeLabel(_ value: String, in zone: TimeZone) -> String {
    guard let date = localTimeDate(value, in: zone) else { return value }
    return TimeLabels.time(date, in: zone)
}

/// Today's date at `HH:mm` in `zone`, for display and `DatePicker` binding.
func localTimeDate(_ value: String, in zone: TimeZone) -> Date? {
    let parts = value.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2 else { return nil }
    let calendar = PlannerDates.calendar(zone)
    return calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: .now)
}
