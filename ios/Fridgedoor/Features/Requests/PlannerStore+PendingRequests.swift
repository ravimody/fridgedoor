import Foundation
import FridgedoorKit

/// What a request still asks of the person: proposals nobody has decided on yet.
/// Home's Decisions, the composer's result chip and request rows all count the same way.
struct RequestReviewCount: Equatable {
    var plans = 0
    var items = 0
    var facts = 0

    var total: Int { plans + items + facts }

    /// "1 plan to review", "3 items to review", "2 suggestions to review"; nil when nothing waits.
    var label: String? {
        guard total > 0 else { return nil }
        let kinds = [plans, items, facts].filter { $0 > 0 }.count
        if kinds > 1 { return "\(total) suggestions to review" }
        if plans > 0 { return plans == 1 ? "1 plan to review" : "\(plans) plans to review" }
        if items > 0 { return items == 1 ? "1 item to review" : "\(items) items to review" }
        return facts == 1 ? "1 fact to review" : "\(facts) facts to review"
    }
}

extension AssistantRun {
    /// Proposals in a finished request that still wait for a decision. Direct list
    /// adds are already applied (they carry an automatic review) and never count.
    func reviewCount(plans: [PlanSummary]) -> RequestReviewCount {
        var count = RequestReviewCount()
        guard state == "succeeded", let result else { return count }
        for (index, item) in result.items.enumerated() {
            guard let review = review(for: "item:\(index)") else {
                if item.kind == "event" { count.plans += 1 } else { count.items += 1 }
                continue
            }
            // A saved draft plan ("Save all") is decided on the plan itself.
            if review.undoneAt == nil, review.state != "dismissed", let planId = review.planId,
               let plan = plans.first(where: { $0.id == planId }), plan.awaitsDecision {
                count.plans += 1
            }
        }
        count.facts = result.knowledge.indices.filter { review(for: "knowledge:\($0)") == nil }.count
        return count
    }

    /// Titles of the undecided proposals, in result order.
    func pendingTitles(plans: [PlanSummary]) -> [String] {
        guard state == "succeeded", let result else { return [] }
        var titles: [String] = []
        for (index, item) in result.items.enumerated() {
            guard let review = review(for: "item:\(index)") else { titles.append(item.title); continue }
            if review.undoneAt == nil, review.state != "dismissed", let planId = review.planId,
               let plan = plans.first(where: { $0.id == planId }), plan.awaitsDecision {
                titles.append(plan.effectiveFacts.title)
            }
        }
        for (index, change) in result.knowledge.enumerated() where review(for: "knowledge:\(index)") == nil {
            titles.append(humanKey(change.key))
        }
        return titles
    }
}

extension PlanSummary {
    /// Still waiting for the person: not yet saved or on the calendar, or an update to apply.
    /// Calendar work in progress or failing is a status, not a pending proposal.
    var awaitsDecision: Bool {
        guard !isClosed else { return false }
        return pendingFacts != nil || (calendarAction == nil && savedInPlanner != true)
    }
}

extension PlannerStore {
    /// Finished requests with proposals still waiting for a decision, newest first.
    /// Home surfaces these in Decisions ("From your request").
    var runsNeedingReview: [AssistantRun] {
        runs.filter { $0.reviewCount(plans: plans).total > 0 }
            .sorted { (PlannerDates.instant($0.createdAt) ?? .distantPast) > (PlannerDates.instant($1.createdAt) ?? .distantPast) }
    }

    /// A short title for a request waiting for review: the first undecided proposal,
    /// plus how many more ("Art show + 2 more"), else the request's own short title.
    func reviewTitle(for run: AssistantRun) -> String {
        let titles = run.pendingTitles(plans: plans)
        guard let first = titles.first else { return run.shortTitle }
        return titles.count == 1 ? first : "\(first) + \(titles.count - 1) more"
    }

    /// "1 plan to review", "3 items to review"; nil when nothing waits.
    func reviewLabel(for run: AssistantRun) -> String? { run.reviewCount(plans: plans).label }
}
