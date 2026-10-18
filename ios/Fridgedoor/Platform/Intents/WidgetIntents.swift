import AppIntents
import Foundation
import FridgedoorKit
#if !WIDGET_EXTENSION
import WidgetKit
#endif

// Intents behind the interactive widgets' buttons. Compiled into both the app and
// the widget extension: the extension only declares them for its views, and
// `LiveActivityIntent` makes the system run them in the app's process (launched in
// the background if needed), where the signed-in session lives. Widgets themselves
// only ever read the snapshot; they hold no credential that can change data.

/// Checks off (or puts back) a to-do or grocery from a widget.
struct CheckListItemIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Check Off a List Item"
    static let isDiscoverable = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Item") var itemId: String
    @Parameter(title: "List") var list: String
    @Parameter(title: "Done") var done: Bool

    init() {}

    init(itemId: String, list: ListKind, done: Bool) {
        self.itemId = itemId
        self.list = list.rawValue
        self.done = done
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        guard let kind = ListKind(rawValue: list) else { return .result() }
        // Show it at once (and remember it for the widget's Undo); the refresh below
        // then rewrites the snapshot from the server.
        let before = SharedContainer.readSnapshot()
        if let before { SharedContainer.writeSnapshot(before.checking(itemId, kind: list, done: done)) }
        guard let client = await PlatformSession.client() else {
            SharedContainer.writeSnapshot(before)
            throw IntentFailure(PlannerError.signedOut)
        }
        do {
            if let item = try await client.list(kind).first(where: { $0.id == itemId }), item.isCompleted != done {
                _ = try await client.updateListItem(item.id, ListItemPatch(expectedRevision: item.revision, completed: done))
            }
        } catch {
            SharedContainer.writeSnapshot(before)
            WidgetCenter.shared.reloadAllTimelines()
            throw IntentFailure(error)
        }
        await IntentSupport.didChange([kind == .todo ? .todos : .groceries, .dailyOverview, .reminders])
        #endif
        return .result()
    }
}

/// Saves a suggestion, or adds it to the household calendar, from the Decisions widget.
struct DecidePlanIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Decide on a Suggestion"
    static let isDiscoverable = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Plan") var planId: String
    /// `keep` (Save) or `calendar` (Add to calendar), as the server's plan decisions.
    @Parameter(title: "Choice") var choice: String

    init() {}

    init(planId: String, action: WidgetSnapshot.DecisionRow.Action) {
        self.planId = planId
        self.choice = action.rawValue
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        guard ["keep", "calendar"].contains(choice) else { return .result() }
        let before = SharedContainer.readSnapshot()
        if let before { SharedContainer.writeSnapshot(before.deciding(planId)) }
        guard let client = await PlatformSession.client() else {
            SharedContainer.writeSnapshot(before)
            throw IntentFailure(PlannerError.signedOut)
        }
        do {
            let plan = try await client.plan(planId)
            if plan.isOpenSuggestion, plan.calendarAction == nil {
                _ = try await client.decide(plan: plan.id, expectedRevision: plan.revision, choice: choice)
            }
        } catch {
            SharedContainer.writeSnapshot(before)
            WidgetCenter.shared.reloadAllTimelines()
            throw IntentFailure(error)
        }
        await IntentSupport.didChange([.plans, .agenda, .dailyOverview, .reminders])
        #endif
        return .result()
    }
}

/// Opens a `fridgedoor://` screen (small widgets can't use `Link`).
struct OpenPlannerLinkIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Fridgedoor"
    static let openAppWhenRun = true
    static let isDiscoverable = false

    @Parameter(title: "Screen") var path: String

    init() {}

    init(path: String) { self.path = path }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        if let url = URL(string: "fridgedoor://\(path)") { PlatformIntegration.open(url) }
        #endif
        return .result()
    }
}

/// Opens a list with its add field focused ("Add grocery" / "Add to-do" widgets and controls).
struct OpenListAddIntent: AppIntent {
    static let title: LocalizedStringResource = "Add to a List"
    static let description = IntentDescription("Opens Fridgedoor's grocery or to-do list, ready to type.")
    static let openAppWhenRun = true
    static let isDiscoverable = false

    @Parameter(title: "List") var list: String

    init() {}

    init(_ kind: ListKind) { list = kind.rawValue }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        PlatformIntegration.open(URL(string: list == ListKind.todo.rawValue ? "fridgedoor://todos/add" : "fridgedoor://groceries/add")!)
        #endif
        return .result()
    }
}
