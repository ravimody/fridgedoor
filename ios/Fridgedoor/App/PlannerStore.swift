import Foundation
import Observation
import FridgedoorKit

/// App-wide cache of household state, mirroring the web `PlannerContext`.
/// Screens read from here and call feature mutations (`PlannerStore+<Area>.swift`)
/// that update these collections optimistically or after the server confirms.
@MainActor @Observable
final class PlannerStore {
    let client: PlannerClient
    private(set) var member: Member
    /// Everyone in the household (from `/me`); just the signed-in member until it loads.
    private(set) var household: [HouseholdPerson] = []
    /// Plans dismissed locally whose server request waits out the Undo window (`dismissWithUndo`).
    var pendingDismissals: [String: PlanSummary] = [:]
    /// Held dismissals whose request is in flight; they can no longer be undone or re-sent.
    var committingDismissals: Set<String> = []

    var plans: [PlanSummary] = []
    var agenda: [AgendaItem] = []
    var todos: [ListItem] = []
    var groceries: [ListItem] = []
    var reminders: [Reminder] = []
    var runs: [AssistantRun] = []
    var knowledge: [KnowledgeFact] = []
    var knowledgeHistory: [KnowledgeChangeEntry] = []
    var knowledgeProposals: [KnowledgeProposal] = []
    var assistantSettings: AssistantSettings?
    var connection: ConnectionStatus?
    var destination: Destination?
    var dailyOverview: DailyView?
    var dailySettings: DailySettings?
    var clarifications: [Clarification] = []

    private(set) var hasLoaded = false
    /// Parts that have loaded successfully at least once this session.
    private(set) var loadedParts: Set<Part> = []
    private(set) var isRefreshing = false
    private(set) var lastRefreshedAt: Date?
    /// Set when every request in the last refresh failed (offline, server down).
    private(set) var refreshError: PlannerError?

    /// While optimistic morning-review changes are in flight, polling must not
    /// overwrite them with a stale server copy (a count: dismissals can overlap).
    var dailyOverviewHolds = 0

    /// Calendar action states seen so far, to announce transitions to `succeeded`.
    private var knownActionStates: [String: String] = [:]
    private var pollTask: Task<Void, Never>?
    /// Per-part request generations: a result is applied only if no newer request or
    /// local edit touched that part since it was requested.
    private var partGeneration: [Part: Int] = [:]
    private var refreshesInFlight = 0

    /// Called after each refresh (widget snapshot, local notification schedule).
    var didRefresh: (@MainActor (PlannerStore) -> Void)?
    /// User-visible announcements (e.g. a calendar event finished syncing).
    var announce: (@MainActor (String) -> Void)?

    init(client: PlannerClient, member: Member) {
        self.client = client
        self.member = member
        self.household = [HouseholdPerson(id: member.id, displayName: member.displayName)]
    }

    var timeZone: TimeZone { member.timeZone }
    var calendar: Calendar { PlannerDates.calendar(timeZone) }

    enum Part: CaseIterable {
        case me, plans, agenda, todos, groceries, reminders, runs, knowledge, knowledgeHistory, knowledgeProposals, assistantSettings, connection, destination, dailyOverview, dailySettings, clarifications
    }

    func refresh(_ parts: Set<Part> = Set(Part.allCases)) async {
        var requested: [Part: Int] = [:]
        for part in parts { partGeneration[part, default: 0] += 1; requested[part] = partGeneration[part] }
        refreshesInFlight += 1
        isRefreshing = true
        defer { refreshesInFlight -= 1; isRefreshing = refreshesInFlight > 0 }
        let client = client
        let results = await withTaskGroup(of: (Part, Result<any Sendable, PlannerError>).self) { group in
            for part in parts {
                group.addTask {
                    do {
                        let value: any Sendable = switch part {
                        case .me: try await client.meWithHousehold()
                        case .plans: try await client.plans()
                        case .agenda: try await client.agenda()
                        case .todos: try await client.list(.todo)
                        case .groceries: try await client.list(.grocery)
                        case .reminders: try await client.reminders()
                        case .runs: try await client.assistantRuns()
                        case .knowledge: try await client.knowledge()
                        case .knowledgeHistory: try await client.knowledgeHistory()
                        case .knowledgeProposals: try await client.knowledgeProposals()
                        case .assistantSettings: try await client.assistantSettings()
                        case .connection: try await client.connection()
                        case .destination: try await client.destination() as Destination?
                        case .dailyOverview: try await client.dailyOverview()
                        case .dailySettings: try await client.dailySettings()
                        case .clarifications: try await client.clarifications()
                        }
                        return (part, .success(value))
                    } catch {
                        return (part, .failure(error as? PlannerError ?? .decoding))
                    }
                }
            }
            var collected: [(Part, Result<any Sendable, PlannerError>)] = []
            for await result in group { collected.append(result) }
            return collected
        }
        var failures: [PlannerError] = []
        var applied = 0
        for (part, result) in results {
            switch result {
            case .success(let value):
                // A newer request or a local edit for this part wins.
                guard partGeneration[part] == requested[part] else { continue }
                apply(part, value); applied += 1; loadedParts.insert(part)
            case .failure(let error): failures.append(error)
            }
        }
        refreshError = failures.count == results.count ? failures.first : nil
        guard applied > 0 || failures.count < results.count else { return }
        lastRefreshedAt = .now
        hasLoaded = true
        announceCalendarTransitions()
        didRefresh?(self)
    }

    /// Invalidates in-flight requests for these parts so they can't overwrite a local edit.
    func invalidateInFlightRefresh(_ parts: Set<Part> = Set(Part.allCases)) {
        for part in parts { partGeneration[part, default: 0] += 1 }
    }

    private func apply(_ part: Part, _ value: any Sendable) {
        switch part {
        case .me:
            if let value = value as? MeResponse {
                member = value.member
                if let people = value.household, !people.isEmpty { household = people }
            }
        case .plans: plans = (value as? [PlanSummary])?.filter { pendingDismissals[$0.id] == nil } ?? plans
        case .agenda: agenda = value as? [AgendaItem] ?? agenda
        case .todos: todos = value as? [ListItem] ?? todos
        case .groceries: groceries = value as? [ListItem] ?? groceries
        case .reminders: reminders = value as? [Reminder] ?? reminders
        case .runs: runs = value as? [AssistantRun] ?? runs
        case .knowledge: knowledge = value as? [KnowledgeFact] ?? knowledge
        case .knowledgeHistory: knowledgeHistory = value as? [KnowledgeChangeEntry] ?? knowledgeHistory
        case .knowledgeProposals: knowledgeProposals = value as? [KnowledgeProposal] ?? knowledgeProposals
        case .assistantSettings: assistantSettings = value as? AssistantSettings ?? assistantSettings
        case .connection: connection = value as? ConnectionStatus ?? connection
        case .destination: destination = value as? Destination
        case .dailyOverview: if dailyOverviewHolds == 0 { dailyOverview = value as? DailyView ?? dailyOverview }
        case .dailySettings: dailySettings = value as? DailySettings ?? dailySettings
        case .clarifications: clarifications = value as? [Clarification] ?? clarifications
        }
    }

    private func announceCalendarTransitions() {
        for plan in plans {
            guard let action = plan.calendarAction else { continue }
            if let previous = knownActionStates[action.actionId], previous != "succeeded", action.state == "succeeded" {
                let verb = action.kind == "cancel" ? "Removed" : action.kind == "update" ? "Updated" : "Added"
                announce?("\(verb) “\(plan.facts.title)” \(action.kind == "cancel" ? "from" : "on") the household calendar.")
            }
            knownActionStates[action.actionId] = action.state
        }
    }

    // MARK: Polling

    /// Work the server is still doing for us; poll quickly until it settles.
    var hasPendingWork: Bool {
        runs.contains(where: \.isWorking)
            || plans.contains { ["pending", "running", "reconciling"].contains($0.calendarAction?.state ?? "") }
            || dailyOverview?.refreshing == true
            || dailyOverview?.errorCode == "DAILY_OVERVIEW_UPDATING"
    }

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                let delay: Duration = self.hasPendingWork ? .seconds(3) : .seconds(45)
                try? await Task.sleep(for: delay)
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Polls fast for a short while after the user starts server-side work.
    func pollSoon() {
        Task { [weak self] in
            for _ in 0..<20 {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { return }
                await self.refresh([.runs, .plans, .agenda, .todos, .groceries, .reminders])
                if !self.hasPendingWork { return }
            }
        }
    }

    // MARK: Shared lookups

    func plan(_ id: String) -> PlanSummary? { plans.first { $0.id == id } }
    func listItem(_ id: String) -> ListItem? { (todos + groceries).first { $0.id == id } }
    func items(_ kind: ListKind) -> [ListItem] { kind == .todo ? todos : groceries }

    func replace(_ plan: PlanSummary) {
        invalidateInFlightRefresh([.plans])
        if let index = plans.firstIndex(where: { $0.id == plan.id }) { plans[index] = plan } else { plans.insert(plan, at: 0) }
    }

    func replace(_ item: ListItem) {
        invalidateInFlightRefresh(item.kind == .todo ? [.todos] : [.groceries])
        func update(_ list: inout [ListItem]) {
            if let index = list.firstIndex(where: { $0.id == item.id }) { list[index] = item } else { list.append(item) }
        }
        if item.kind == .todo { update(&todos) } else { update(&groceries) }
    }

    func remove(listItem id: String) {
        invalidateInFlightRefresh([.todos, .groceries])
        todos.removeAll { $0.id == id }
        groceries.removeAll { $0.id == id }
    }

    func replace(_ reminder: Reminder) {
        invalidateInFlightRefresh([.reminders])
        if let index = reminders.firstIndex(where: { $0.id == reminder.id }) { reminders[index] = reminder } else { reminders.append(reminder) }
    }

    func replace(_ run: AssistantRun) {
        invalidateInFlightRefresh([.runs])
        if let index = runs.firstIndex(where: { $0.id == run.id }) { runs[index] = run } else { runs.insert(run, at: 0) }
    }
}
