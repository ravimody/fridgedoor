import FridgedoorKit
import SwiftUI

/// Settings → Delete my account. Deletes the member's account on the household's server
/// (the same as the web app's Settings → Profile), then signs this iPhone out.
struct DeleteAccountView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @State private var password = ""
    @State private var confirm = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Text("This deletes your email connection, private plans, requests and settings on \(ServerAddress.Normalized.displayName(for: store.client.baseURL)), and signs you out everywhere. Plans and list items you shared stay with the household, shown as from “Former member”.")
                    .foregroundStyle(Color.ink)
                Text("This can't be undone. If you run this household's server, your account can't be deleted here.")
                    .foregroundStyle(Color.muted)
            }
            .plannerRows()

            Section {
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .submitLabel(.done)
                    .frame(minHeight: 44)
            } footer: {
                if let error { Text(error).foregroundStyle(Color.danger) }
            }
            .plannerRows()

            Section {
                Button("Delete my account", role: .destructive) { confirm = true }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(password.isEmpty || busy)
            }
            .plannerRows()
        }
        .plannerList()
        .plannerBackground()
        .navigationTitle("Delete my account")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete your Fridgedoor account?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Delete my account", role: .destructive) { Task { await delete() } }
        } message: {
            Text("This can't be undone.")
        }
    }

    private func delete() async {
        busy = true
        defer { busy = false }
        error = nil
        do {
            try await store.client.deleteAccount(password: password)
            await app.signOut()
            app.show("Your account was deleted.")
        } catch let failure as PlannerError {
            error = failure.userMessage
        } catch {
            self.error = PlannerError.serverDown.userMessage
        }
    }
}
