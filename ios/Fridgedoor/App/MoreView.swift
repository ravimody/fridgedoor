import FridgedoorKit
import SwiftUI

/// Navigation only: everything else (appearance, sign out) lives in Settings.
struct MoreView: View {
    @Environment(PlannerStore.self) private var store

    var body: some View {
        List {
            Section {
                NavigationLink(value: Route.settings) {
                    HStack(spacing: 14) {
                        PersonAvatar(personId: store.member.id, size: 44).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(store.member.displayName).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                            Text("Account and settings").font(.subheadline).foregroundStyle(Color.muted)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }
            }
            .plannerRows()
            Section {
                NavigationLink(value: Route.savedPlans) {
                    Label("Plans", systemImage: "tray.full")
                        .badge(store.plans.filter(\.isOpenSuggestion).count)
                }
                NavigationLink(value: Route.requestHistory) { Label("Requests", systemImage: "bubble.left.and.text.bubble.right") }
                NavigationLink(value: Route.knowledge) {
                    Label("Household facts", systemImage: "books.vertical")
                        .badge(store.knowledgeProposals.filter { $0.status == "pending" }.count)
                }
            }
            .plannerRows()
            Section {
                NavigationLink(value: Route.settings) { Label("Settings", systemImage: "gearshape") }
            } footer: {
                Text("Signed in to \(ServerAddress.Normalized.displayName(for: store.client.baseURL)).")
            }
            .plannerRows()
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("More")
    }
}
