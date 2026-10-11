import Foundation
import FridgedoorKit

/// An authenticated client for code that can run without the UI: App Intents,
/// notification actions and background refresh.
///
/// Prefers the signed-in app's own client so there is a single `AuthSession`
/// (refresh tokens rotate; presenting a used one twice revokes the session).
/// Only when the app's UI hasn't started (background launch) does it build one
/// from the Keychain, and it drops that as soon as the app's client exists.
@MainActor
enum PlatformSession {
    private static var headless: PlannerClient?

    static func client() async -> PlannerClient? {
        if let app = AppDelegate.app {
            // The UI is mid-launch and about to create its own session: wait for it.
            for _ in 0..<50 where app.phase == .launching {
                try? await Task.sleep(for: .milliseconds(100))
            }
            switch app.phase {
            case .signedIn:
                if let client = app.client { headless = nil; return client }
            case .signedOut:
                headless = nil
                return nil
            case .launching:
                break
            }
        }
        guard let server = SharedContainer.serverURL else { headless = nil; return nil }
        if let headless, headless.baseURL == server, await headless.auth.isSignedIn { return headless }
        let auth = AuthSession.shared(for: server)
        guard await auth.isSignedIn else { headless = nil; return nil }
        let client = PlannerClient(auth: auth)
        headless = client
        return client
    }

    /// The live store when the app's UI is running and signed in.
    static var store: PlannerStore? { AppDelegate.app?.store }

    static func reset() { headless = nil }
}

/// The household data the platform integrations derive from, either copied from
/// the running app's store or fetched directly (background refresh).
struct PlatformData: Sendable {
    let member: Member
    let plans: [PlanSummary]
    let agenda: [AgendaItem]
    let todos: [ListItem]
    let groceries: [ListItem]
    let reminders: [Reminder]
    /// Names for other people's to-dos in the widgets.
    var household: [HouseholdPerson] = []
    /// Google connected with a household calendar chosen: widgets may offer "Add to calendar".
    var googleReady = false

    @MainActor init(store: PlannerStore) {
        member = store.member; plans = store.plans; agenda = store.agenda
        todos = store.todos; groceries = store.groceries; reminders = store.reminders
        household = store.household; googleReady = store.googleReady
    }

    init(member: Member, plans: [PlanSummary], agenda: [AgendaItem], todos: [ListItem], groceries: [ListItem], reminders: [Reminder], household: [HouseholdPerson] = [], googleReady: Bool = false) {
        self.member = member; self.plans = plans; self.agenda = agenda
        self.todos = todos; self.groceries = groceries; self.reminders = reminders
        self.household = household; self.googleReady = googleReady
    }

    static func fetch(_ client: PlannerClient) async throws -> PlatformData {
        async let me = client.meWithHousehold()
        async let plans = client.plans()
        async let agenda = client.agenda()
        async let todos = client.list(.todo)
        async let groceries = client.list(.grocery)
        async let reminders = client.reminders()
        // Best effort: without them the widgets just don't offer "Add to calendar".
        async let connection = try? client.connection()
        async let destination = try? client.destination()
        let (status, chosen) = await (connection, destination)
        let ready = status?.status == "active" && chosen?.ownCalendarSelectionId != nil
        let profile = try await me
        return try await PlatformData(member: profile.member, plans: plans, agenda: agenda, todos: todos, groceries: groceries, reminders: reminders,
                                      household: profile.household ?? [], googleReady: ready)
    }

    func snapshot(now: Date = .now) -> WidgetSnapshot {
        WidgetSnapshotBuilder.build(member: member, plans: plans, agenda: agenda, todos: todos, groceries: groceries, reminders: reminders,
                                    household: household, googleReady: googleReady, now: now)
    }
}
