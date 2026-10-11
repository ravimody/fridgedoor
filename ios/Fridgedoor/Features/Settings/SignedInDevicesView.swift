import FridgedoorKit
import SwiftUI

/// Native app sign-ins for this member (`GET native-sessions`). Other devices can be
/// signed out here; this iPhone signs out from Settings.
struct SignedInDevicesView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @State private var revoking: NativeSessionInfo?
    @State private var confirmOthers = false
    @State private var busy = false

    var body: some View {
        List {
            if let response = model.sessions {
                let current = response.sessions.filter { $0.id == response.currentId }
                let others = response.sessions.filter { $0.id != response.currentId }
                Section("This iPhone") {
                    ForEach(current) { row($0, isCurrent: true) }
                }
                .plannerRows()
                Section {
                    if others.isEmpty {
                        Text("No other devices are signed in.").foregroundStyle(Color.muted)
                    }
                    ForEach(others) { session in
                        row(session, isCurrent: false)
                            .swipeActions {
                                Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { revoking = session }
                            }
                            .contextMenu {
                                Button("Sign out this device", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { revoking = session }
                            }
                    }
                } header: {
                    Text("Other devices")
                } footer: {
                    Text("Fridgedoor app sign-ins. Signing one out ends it right away.")
                }
                .plannerRows()
                if others.count > 1 {
                    Section {
                        Button("Sign out all other devices", role: .destructive) { confirmOthers = true }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(busy)
                    }
                    .plannerRows()
                }
            } else {
                Section { SettingsLoadingRow(failed: model.failed.contains(.sessions)) { Task { await model.load([.sessions]) } } }
                    .plannerRows()
            }
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Signed-in devices")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load([.sessions]) }
        .confirmationDialog("Sign out \(revoking?.label ?? "this device")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { session in
            Button("Sign out", role: .destructive) { Task { await revoke([session]) } }
        } message: { _ in
            Text("It will need to sign in again to see household plans.")
        }
        .confirmationDialog("Sign out all other devices?", isPresented: $confirmOthers, titleVisibility: .visible) {
            Button("Sign out others", role: .destructive) {
                let others = model.sessions?.sessions.filter { $0.id != model.sessions?.currentId } ?? []
                Task { await revoke(others) }
            }
        }
    }

    private func row(_ session: NativeSessionInfo, isCurrent: Bool) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.label).foregroundStyle(Color.ink)
                Text(detail(session, isCurrent: isCurrent)).font(.subheadline).foregroundStyle(Color.muted)
            }
        } icon: {
            SettingsGlyph(systemImage: session.label.localizedCaseInsensitiveContains("ipad") ? "ipad" : "iphone")
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func detail(_ session: NativeSessionInfo, isCurrent: Bool) -> String {
        let signedIn = settingsTimestamp(session.createdAt, in: store.timeZone).map { "Signed in \($0)" } ?? "Signed in"
        if isCurrent { return signedIn }
        guard let used = TimeLabels.relative(session.lastUsedAt) else { return signedIn }
        return "\(signedIn) · Active \(used)"
    }

    private func revoke(_ sessions: [NativeSessionInfo]) async {
        busy = true
        defer { busy = false }
        var failures = 0
        for session in sessions {
            do { try await model.client.revokeNativeSession(session.id) } catch { failures += 1 }
        }
        await model.load([.sessions])
        if failures > 0 {
            app.show("Couldn't sign out \(failures == 1 ? "one device" : "\(failures) devices"). Try again.", isError: true)
        } else {
            app.show(sessions.count == 1 ? "Signed out \(sessions[0].label)." : "Signed out \(sessions.count) devices.")
        }
    }
}
