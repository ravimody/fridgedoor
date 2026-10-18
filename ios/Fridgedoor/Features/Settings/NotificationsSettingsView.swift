import FridgedoorKit
import SwiftUI

/// This iPhone's notification controls plus the member's Web Push
/// enrollments — other browsers and Home Screen web apps. This app can't enroll itself
/// for Web Push (`POST push-subscriptions` is browser-only); it uses iPhone notifications.
struct NotificationsSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @State private var busyId: String?
    @State private var removing: PushSubscription?

    var body: some View {
        List {
            NotificationSettingsSection()

            Section {
                if !model.loaded.contains(.push) {
                    SettingsLoadingRow(failed: model.failed.contains(.push)) { Task { await model.load([.push]) } }
                } else if enabledDevices.isEmpty {
                    Text("No browsers are enrolled for web notifications.").foregroundStyle(Color.muted)
                } else {
                    ForEach(enabledDevices) { device in
                        deviceRow(device)
                            .swipeActions {
                                Button("Turn off", systemImage: "bell.slash", role: .destructive) { removing = device }
                            }
                            .contextMenu {
                                Button("Send test notification", systemImage: "paperplane") { Task { await test(device) } }
                                Button("Turn off", systemImage: "bell.slash", role: .destructive) { removing = device }
                            }
                    }
                }
                if model.pushConfig?.enabled == false {
                    Text("Web notifications aren't configured on the server.").font(.footnote).foregroundStyle(Color.muted)
                }
            } header: {
                Text("Browsers and web apps")
            } footer: {
                Text("Browsers that get web notifications. Add one from Settings in the web app.")
            }
            .plannerRows()
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load([.push, .digest]) }
        .confirmationDialog("Turn off notifications for \(removing?.label ?? "this browser")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { device in
            Button("Turn off", role: .destructive) { Task { await remove(device) } }
        } message: { _ in
            Text("It stops receiving reminders and digests until it's enabled again from that browser.")
        }
    }

    private var enabledDevices: [PushSubscription] { model.pushDevices.filter { $0.status == "enabled" } }

    private func deviceRow(_ device: PushSubscription) -> some View {
        HStack(spacing: 12) {
            SettingsGlyph(systemImage: "globe")
            VStack(alignment: .leading, spacing: 2) {
                Text(device.label).foregroundStyle(Color.ink)
                Text(detail(device)).font(.caption).foregroundStyle(Color.muted)
            }
            Spacer()
            if busyId == device.id {
                ProgressView()
            } else {
                Button("Test") { Task { await test(device) } }
                    .buttonStyle(.plannerQuiet)
                    .frame(minHeight: 44)
                    .disabled(model.pushConfig?.enabled == false)
                    .accessibilityLabel("Send test notification to \(device.label)")
            }
        }
    }

    private func detail(_ device: PushSubscription) -> String {
        let added = settingsTimestamp(device.createdAt, in: store.timeZone).map { "Added \($0)" } ?? "Enrolled"
        guard let used = TimeLabels.relative(device.lastUsedAt) else { return added }
        return "\(added) · Last delivery \(used)"
    }

    private func test(_ device: PushSubscription) async {
        busyId = device.id
        defer { busyId = nil }
        do {
            let result = try await model.client.testPushSubscription(device.id)
            switch result.state {
            case "accepted": app.show("Test accepted by the delivery service. Check \(device.label).")
            case "gone":
                app.show("\(device.label) is no longer reachable. Enable it again from that browser.", isError: true)
                await model.load([.push])
            default: app.show("The test couldn't be delivered. Try enabling that browser again.", isError: true)
            }
        } catch {
            app.show(settingsErrorMessage(error, fallback: "Couldn't send the test. Try again."), isError: true)
        }
    }

    private func remove(_ device: PushSubscription) async {
        busyId = device.id
        defer { busyId = nil }
        do {
            try await model.client.removePushSubscription(device.id)
            await model.load([.push, .digest])
            app.show("Turned off notifications for \(device.label).")
        } catch {
            app.show(settingsErrorMessage(error, fallback: "Couldn't turn off that browser's notifications. Try again."), isError: true)
        }
    }
}
