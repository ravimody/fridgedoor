import FridgedoorKit
import SwiftUI
import UIKit
import UserNotifications

/// Native notification preferences for this iPhone as list rows: permission status,
/// the per-device reminder and daily brief toggles, and a test alert. Meant to sit in
/// a `Section` (see `NotificationSettingsSection`).
struct NotificationSettingsControls: View {
    @Environment(PlannerStore.self) private var store
    @Environment(\.openURL) private var openURL
    @Bindable private var prefs = PlatformPreferences.shared
    @State private var status: UNAuthorizationStatus?
    @State private var scheduled: Int?
    @State private var testState: TestState = .idle
    @State private var requesting = false

    private enum TestState: Equatable { case idle, sending, sent, failed }

    var body: some View {
        permissionRow
            // Attached to one row: modifiers on a group of rows run once per row.
            .task { await reload() }
            .task { await PlatformSync.refreshDigestStatusIfNeeded(store.client, force: true) }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                Task { await reload() } // back from iOS Settings
            }

        Toggle(isOn: $prefs.reminderAlerts) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Reminders").foregroundStyle(Color.ink)
                Text("Alerts at each reminder's time, even offline.").font(.footnote).foregroundStyle(Color.muted)
            }
        }
        .tint(.plannerAccent)
        .onChange(of: prefs.reminderAlerts) { PlatformSync.resync() }

        Toggle(isOn: digestBinding) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Morning").foregroundStyle(Color.ink)
                Text(digestNote).font(.footnote).foregroundStyle(Color.muted)
            }
        }
        .tint(.plannerAccent)

        Toggle(isOn: $prefs.eveningAlerts) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Evening look-ahead").foregroundStyle(Color.ink)
                Text("At 8:00 PM, a look at tomorrow. Only on evenings when tomorrow has something on it.").font(.footnote).foregroundStyle(Color.muted)
            }
        }
        .tint(.plannerAccent)
        .onChange(of: prefs.eveningAlerts) { PlatformSync.resync() }

        testRow
    }

    // MARK: Permission

    @ViewBuilder private var permissionRow: some View {
        HStack(alignment: .center, spacing: 12) {
            SettingsGlyph(systemImage: statusIcon, tint: status == .denied ? .warning : .plannerAccent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Notifications").foregroundStyle(Color.ink)
                Text(statusText).font(.footnote).foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            switch status {
            case .notDetermined?, .provisional?:
                Button(requesting ? "…" : "Turn on") {
                    Task {
                        requesting = true
                        await NotificationScheduler.requestFullAuthorization()
                        requesting = false
                        await reload()
                        PlatformSync.resync()
                    }
                }
                .buttonStyle(PlannerButtonStyle(kind: .primary, size: .small))
                .frame(minHeight: 44)
                .disabled(requesting)
            case .denied?:
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                }
                .buttonStyle(PlannerButtonStyle(kind: .secondary, size: .small))
                .frame(minHeight: 44)
            case .authorized?, .ephemeral?:
                Text("On").foregroundStyle(Color.muted)
            case nil:
                ProgressView().controlSize(.small)
            @unknown default:
                EmptyView()
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var statusIcon: String {
        switch status {
        case .authorized?, .ephemeral?: "bell.fill"
        case .denied?: "bell.slash"
        default: "bell"
        }
    }

    private var statusText: String {
        switch status {
        case .authorized?, .ephemeral?: "Alerts and sounds are on for Fridgedoor."
        case .provisional?: "Arriving quietly in Notification Center. Turn on for banners and sounds."
        case .denied?: "Off for Fridgedoor in iOS Settings."
        case .notDetermined?: "Get alerts on this iPhone at the right time."
        default: "Checking…"
        }
    }

    // MARK: Daily brief

    private var digestBinding: Binding<Bool> {
        Binding(
            get: { prefs.digestAlerts },
            set: { value in
                prefs.digestAlertsOverride = value
                PlatformSync.resync()
            }
        )
    }

    /// "At 7:00 AM, when it's ready." The time is the account's Daily brief time.
    private var digestNote: String {
        let (hour, minute) = prefs.serverDigest?.hourMinute ?? (7, 0)
        let zone = store.timeZone
        let time = PlannerDates.calendar(zone).date(bySettingHour: hour, minute: minute, second: 0, of: .now)
            .map { TimeLabels.time($0, in: zone) } ?? "7:00 AM"
        return "At \(time): what's on today and what needs a decision. Change the time in Daily brief."
    }

    // MARK: Test

    private var testRow: some View {
        HStack(spacing: 12) {
            Button {
                Task { await sendTest() }
            } label: {
                HStack(spacing: 6) {
                    if testState == .sending { ProgressView().controlSize(.small) } else { Image(systemName: "bell.badge") }
                    Text("Send test notification")
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .tint(.plannerAccent)
            .disabled(testState == .sending || status == .denied)
            Spacer(minLength: 0)
            switch testState {
            case .sent: Text("Arrives in 5 seconds").font(.caption).foregroundStyle(Color.muted).transition(.opacity)
            case .failed: Text("Couldn't send").font(.caption).foregroundStyle(Color.danger)
            default:
                if let scheduled, NotificationScheduler.canSchedule(status ?? .notDetermined) {
                    Text(scheduled == 1 ? "1 alert scheduled" : "\(scheduled) alerts scheduled")
                        .font(.caption).foregroundStyle(Color.muted)
                }
            }
        }
        .sensoryFeedback(.success, trigger: testState == .sent)
        .animation(.snappy, value: testState)
    }

    // MARK: Actions

    private func reload() async {
        status = await NotificationScheduler.authorizationStatus()
        scheduled = await NotificationScheduler.pendingCount()
    }

    private func sendTest() async {
        testState = .sending
        let ok = await NotificationScheduler.sendTest()
        testState = ok ? .sent : .failed
        await reload()
        try? await Task.sleep(for: .seconds(6))
        if testState != .sending { testState = .idle }
    }
}
