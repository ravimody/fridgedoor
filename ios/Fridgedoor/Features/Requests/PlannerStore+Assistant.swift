import Foundation
import FridgedoorKit

/// Assistant request mutations. Each refreshes what the decision can touch
/// (runs, lists, plans, knowledge) so every screen agrees afterwards.
extension PlannerStore {
    func assistantRun(_ id: String) -> AssistantRun? { runs.first { $0.id == id } }

    var assistantReady: Bool { assistantSettings?.enabled == true && assistantSettings?.consent == true }

    func setAssistantEnabled(_ enabled: Bool) async throws {
        let settings = try await client.setAssistantEnabled(enabled)
        invalidateInFlightRefresh([.assistantSettings])
        assistantSettings = settings
    }

    func reviewRequest(_ run: AssistantRun, target: AssistantReviewTarget, index: Int, choice: AssistantReviewChoice, edited: AssistantItem? = nil) async throws {
        _ = try await client.reviewAssistantRun(run.id, target: target, index: index, choice: choice, edited: edited)
        await refresh(target == .knowledge ? [.runs, .knowledge, .knowledgeHistory] : [.runs, .plans, .agenda, .todos, .groceries, .dailyOverview])
        if choice == .calendar { pollSoon() }
    }

    /// Undoes the given directly-added items (all of them by default).
    func undoRequestAdds(_ run: AssistantRun, indexes: [Int]? = nil) async throws {
        let targets = indexes ?? run.automaticItems.filter { $0.review.undoneAt == nil }.map(\.index)
        var failure: Error?
        for index in targets {
            do { try await client.undoAssistantItem(run.id, index: index) } catch { failure = error }
        }
        await refresh([.runs, .todos, .groceries, .dailyOverview])
        if let failure { throw failure }
    }

    /// Undoes a Household facts change a request saved (same endpoint as Household facts' Undo).
    func undoKnowledgeChange(_ entry: KnowledgeChangeEntry) async throws {
        guard let fact = knowledge.first(where: { $0.key == entry.key }) else { throw PlannerError(code: "UNDO_UNAVAILABLE") }
        try await client.undoKnowledgeChange(entry.id, expectedRevision: fact.revision)
        await refresh([.knowledge, .knowledgeHistory])
    }

    func applyRequest(_ run: AssistantRun) async throws {
        _ = try await client.applyAssistantRun(run.id)
        await refresh([.runs, .plans, .todos, .groceries, .knowledge, .knowledgeHistory])
    }

    func retryRequest(_ run: AssistantRun) async throws {
        try await client.retryAssistantRun(run.id)
        await refresh([.runs])
        pollSoon()
    }

    func requestFeedback(_ run: AssistantRun, _ value: AssistantFeedback) async throws {
        try await client.sendAssistantFeedback(run.id, value)
        await refresh([.runs])
    }

    /// Optimistic: the request disappears immediately and comes back if the server refuses.
    func deleteRequest(_ run: AssistantRun) async throws {
        invalidateInFlightRefresh()
        let position = runs.firstIndex { $0.id == run.id }
        runs.removeAll { $0.id == run.id }
        do { try await client.deleteAssistantRun(run.id) }
        catch {
            if let position { runs.insert(run, at: min(position, runs.count)) }
            throw error
        }
    }
}
