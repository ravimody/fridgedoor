import Foundation

/// Read endpoints used by the app-wide refresh. Mutations live next to the
/// feature that owns them (`PlannerClient+Plans.swift`, `+Lists`, …).
public extension PlannerClient {
    func plans(status: String? = nil) async throws -> [PlanSummary] {
        try await get("plans", query: status.map { ["status": $0] } ?? [:], as: PlansResponse.self).plans
    }
    func plan(_ id: String) async throws -> PlanSummary { try await get("plans/\(id)") }
    func agenda() async throws -> [AgendaItem] { try await get("agenda", as: AgendaResponse.self).items }
    func list(_ kind: ListKind) async throws -> [ListItem] { try await get("lists/\(kind.rawValue)", as: ListResponse.self).items }
    func reminders() async throws -> [Reminder] { try await get("reminders", as: RemindersResponse.self).reminders }
    func dailyOverview() async throws -> DailyView { try await get("daily-overview") }
    func dailySettings() async throws -> DailySettings { try await get("daily-ai-settings") }
    func clarifications() async throws -> [Clarification] { try await get("clarifications") }
    func assistantSettings() async throws -> AssistantSettings { try await get("assistant/settings") }
    func assistantRuns() async throws -> [AssistantRun] { try await get("assistant/runs") }
    func knowledge() async throws -> [KnowledgeFact] { try await get("assistant/knowledge") }
    func knowledgeHistory() async throws -> [KnowledgeChangeEntry] { try await get("assistant/knowledge/history") }
    func knowledgeProposals() async throws -> [KnowledgeProposal] { try await get("assistant/knowledge/proposals") }
    func connection() async throws -> ConnectionStatus { try await get("connection") }
    func destination() async throws -> Destination? { try await get("destination") }
}
