import Foundation
import Observation
import FridgedoorKit

enum AppTab: String, Hashable, CaseIterable {
    case home, todo, groceries, more
}

/// Every pushable screen. Feature views own their content; this enum only names them.
enum Route: Hashable {
    case plan(String)
    case request(String)
    case savedPlans
    case requestHistory
    case knowledge
    case settings
}

@MainActor @Observable
final class Router {
    var tab: AppTab = .home
    var homePath: [Route] = []
    var todoPath: [Route] = []
    var groceryPath: [Route] = []
    var morePath: [Route] = []
    /// Set by `fridgedoor://groceries/add` (widgets, controls); the list focuses its add field and clears it.
    var focusAdd: ListKind?

    /// Pushes onto the current tab unless a tab is given (e.g. from a notification).
    func open(_ route: Route, in tab: AppTab? = nil) {
        if let tab { self.tab = tab }
        switch self.tab {
        case .home: homePath.append(route)
        case .todo: todoPath.append(route)
        case .groceries: groceryPath.append(route)
        case .more: morePath.append(route)
        }
    }

    func popToRoot(_ tab: AppTab) {
        switch tab {
        case .home: homePath = []
        case .todo: todoPath = []
        case .groceries: groceryPath = []
        case .more: morePath = []
        }
    }

    func reset() {
        tab = .home; homePath = []; todoPath = []; groceryPath = []; morePath = []
    }

    /// `fridgedoor://plans/<id>`, `requests/<id>`, `home`, `todos[/add]`, `groceries[/add]`,
    /// `more`, `settings`, `knowledge`, `history`, `suggestions`.
    /// Returns false for links the router does not handle (e.g. `auth/callback`, `compose`).
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard url.scheme == "fridgedoor" else { return false }
        let parts = ([url.host()].compactMap { $0 } + url.pathComponents.filter { $0 != "/" })
        switch (parts.first, parts.dropFirst().first) {
        case ("plans", let id?): popToRoot(.home); open(.plan(id), in: .home)
        case ("requests", let id?): popToRoot(.home); open(.request(id), in: .home)
        case ("home", _): tab = .home; popToRoot(.home)
        case ("todos", let action): tab = .todo; popToRoot(.todo); if action == "add" { focusAdd = .todo }
        case ("groceries", let action): tab = .groceries; popToRoot(.groceries); if action == "add" { focusAdd = .grocery }
        case ("more", _): tab = .more
        case ("settings", _): popToRoot(.more); open(.settings, in: .more)
        case ("knowledge", _): popToRoot(.more); open(.knowledge, in: .more)
        case ("history", _): popToRoot(.more); open(.requestHistory, in: .more)
        case ("suggestions", _): popToRoot(.more); open(.savedPlans, in: .more)
        default: return false
        }
        return true
    }
}
