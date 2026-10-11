import FridgedoorKit
import SwiftUI

struct MainTabView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(PlannerStore.self) private var store
    @Environment(ComposerModel.self) private var composer

    var body: some View {
        @Bindable var router = router
        @Bindable var composer = composer
        TabView(selection: $router.tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                NavigationStack(path: $router.homePath) {
                    HomeView().routeDestinations()
                }
            }
            .badge(attentionBadge)
            Tab("To do", systemImage: "checklist", value: AppTab.todo) {
                NavigationStack(path: $router.todoPath) {
                    ListsView(kind: .todo).routeDestinations()
                }
            }
            Tab("Groceries", systemImage: "basket", value: AppTab.groceries) {
                NavigationStack(path: $router.groceryPath) {
                    ListsView(kind: .grocery).routeDestinations()
                }
            }
            Tab("More", systemImage: "ellipsis", value: AppTab.more) {
                NavigationStack(path: $router.morePath) {
                    MoreView().routeDestinations()
                }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory { ComposerAccessory() }
        .sheet(isPresented: $composer.isPresented) { ComposerSheet() }
        .overlay(alignment: .top) { ToastOverlay() }
        .onAppear { store.startPolling() }
    }

    /// Same count as Home's "N need you" line.
    private var attentionBadge: Int {
        HomeSnapshot(store: store, selectedDay: nil, now: .now).decisionCount
    }
}

extension View {
    func routeDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .plan(let id): PlanDetailView(planId: id)
            case .request(let id): RequestDetailView(runId: id)
            case .savedPlans: SavedPlansView()
            case .requestHistory: RequestHistoryView()
            case .knowledge: KnowledgeView()
            case .settings: SettingsView()
            case .relevanceTrial: RelevanceTrialView()
            }
        }
    }
}

struct ToastOverlay: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let toast = app.toast {
            HStack(spacing: 12) {
                if toast.isPending {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: toast.isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(toast.isError ? Color.danger : Color.ink)
                }
                Text(toast.message)
                    .font(.subheadline)
                    .foregroundStyle(Color.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let action = toast.action {
                    Button(action.label) { action.perform(); app.dismissToast() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.plannerAccent)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, toast.action == nil ? 16 : 8)
            .padding(.vertical, toast.action == nil ? 12 : 2)
            .glassEffect(.regular, in: .rect(cornerRadius: 20))
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .transition(.move(edge: .top).combined(with: .opacity))
            .onTapGesture { app.dismissToast() }
            .accessibilityAddTraits(.isStaticText)
            .id(toast.id)
        }
    }
}
