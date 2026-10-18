import Foundation
import FridgedoorKit

/// Plan mutations used only by the Plans feature (shared ones live in `PlannerStore+Actions.swift`).
extension PlannerStore {
    /// Shares a private draft with the household using the facts the owner reviewed.
    @discardableResult
    func sharePlan(_ plan: PlanSummary) async throws -> PlanSummary {
        let next = try await client.sharePlan(plan.id, expectedRevision: plan.revision, reviewedFacts: plan.effectiveFacts)
        replace(next)
        await refresh([.plans, .agenda, .dailyOverview])
        return next
    }

    /// Fetches one plan (including dismissed/archived ones the list omits) and caches it if active.
    @discardableResult
    func reloadPlan(_ id: String) async throws -> PlanSummary {
        let plan = try await client.plan(id)
        if !plan.isClosed || plans.contains(where: { $0.id == id }) { replace(plan) }
        return plan
    }

    /// Dismissed and archived plans (the default list omits both).
    func closedPlans() async throws -> [PlanSummary] {
        async let dismissed = client.plans(status: "dismissed")
        async let archived = client.plans(status: "archived")
        return try await (dismissed + archived).sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: Dismiss with Undo

    /// The server has no "undismiss", so a dismissal is held locally for the Undo window
    /// and only then sent. Refreshes keep the plan hidden meanwhile; backgrounding flushes.
    func dismissWithUndo(_ plan: PlanSummary, app: AppModel) {
        guard pendingDismissals[plan.id] == nil else { return }
        pendingDismissals[plan.id] = plan
        invalidateInFlightRefresh([.plans])
        plans.removeAll { $0.id == plan.id }
        app.show("Dismissed “\(plan.effectiveFacts.title)”.", action: Toast.Action(label: "Undo") { [weak self, weak app] in self?.undoDismissal(plan.id, app: app) })
        Task { [weak self] in
            try? await Task.sleep(for: Toast.undoWindow + .seconds(1))
            await self?.commitDismissal(plan.id, app: app)
        }
    }

    func undoDismissal(_ id: String, app: AppModel? = nil) {
        // Already sent (the app went to the background meanwhile): say so rather than pretend.
        guard !committingDismissals.contains(id), let plan = pendingDismissals.removeValue(forKey: id) else {
            app?.show("Already dismissed. You can find it under Plans → Dismissed.")
            return
        }
        replace(plan)
    }

    func commitDismissal(_ id: String, app: AppModel?) async {
        guard let plan = pendingDismissals[id], !committingDismissals.contains(id) else { return }
        committingDismissals.insert(id)
        defer { committingDismissals.remove(id); pendingDismissals[id] = nil }
        do {
            _ = try await client.dismissPlan(plan.id, expectedRevision: plan.revision)
            await refresh([.plans, .dailyOverview, .agenda])
        } catch {
            replace(plan)
            app?.showPlanError(error)
        }
    }

    /// Sends any held dismissals now (the app is going to the background).
    func flushPendingDismissals() async {
        for id in Array(pendingDismissals.keys) { await commitDismissal(id, app: nil) }
    }

    // MARK: Set a time

    /// Gives a plan a concrete start and end (clearing the time-related "still needs"
    /// markers), then optionally adds it to the household calendar.
    func setTime(_ plan: PlanSummary, start: Date, end: Date, addToCalendar: Bool) async throws {
        var facts = plan.effectiveFacts
        facts.time = .timed(start: PlannerDates.offsetString(start, timeZone: timeZone), end: PlannerDates.offsetString(end, timeZone: timeZone), timezone: member.timezone)
        facts.unresolvedFields.removeAll { PlanFacts.timeFieldMarkers.contains($0) }
        let saved = try await savePlan(plan, facts: facts, updateCalendar: plan.hasCalendarEvent)
        // The server retires a question about this plan once its time changes; pick that up now.
        await refresh([.clarifications])
        guard !plan.hasCalendarEvent else { return }
        try await decide(saved, choice: addToCalendar ? "calendar" : "keep")
    }

    /// Edits, then queues the Google update with a key tied to the saved revision so
    /// a retried tap can never queue a second write.
    func savePlan(_ plan: PlanSummary, facts: PlanFacts, updateCalendar: Bool) async throws -> PlanSummary {
        let next = try await editPlan(plan, facts: facts)
        if updateCalendar {
            do { try await applyPlan(next, kind: "update", idempotencyKey: "update:\(next.id):\(next.revision)") }
            catch { throw PlanCalendarError.savedButNotQueued(error) }
        }
        await refresh([.plans, .agenda, .dailyOverview, .reminders])
        return next
    }
}

/// The edit succeeded but the follow-up calendar write didn't queue.
struct PlanCalendarError: Error {
    let underlying: Error
    static func savedButNotQueued(_ error: Error) -> PlanCalendarError { PlanCalendarError(underlying: error) }
}

enum PlanErrorCopy {
    /// Plan/calendar server codes the generic `PlannerError.userMessage` doesn't know.
    static func message(for error: Error) -> String {
        if let error = error as? PlanCalendarError {
            return "Your corrections are saved, but the calendar change couldn't be queued. \(message(for: error.underlying))"
        }
        guard let error = error as? PlannerError else { return error.localizedDescription }
        switch error.code {
        case "STALE_REVISION": return "This plan changed elsewhere. It's been refreshed — check it and try again."
        case "PLAN_TIME_INCOMPLETE": return "Add a start and end (or make it all day) before adding it to the calendar."
        case "DESTINATION_NOT_ALLOWED": return "Choose a household calendar you can edit in Settings first."
        case "RETRY_ORIGINAL_ACTION": return "Retry the earlier calendar change first."
        case "ACTION_IN_PROGRESS": return "A calendar change is already in progress."
        case "EVENT_ALREADY_BOUND": return "This plan is already on the calendar."
        case "EVENT_BINDING_NOT_FOUND": return "The original calendar event couldn't be found."
        case "PLAN_NOT_ACCEPTED": return "This plan isn't on the calendar yet."
        case "PLAN_DISMISSED": return "This plan was dismissed."
        case "ORIGINAL_ACTION_CHANGED": return "The plan changed since that calendar action. Check the event in Google Calendar before trying again."
        case "ACTION_NOT_RETRYABLE": return "That calendar change can't be retried."
        case "GOOGLE_CALENDAR_CONFLICT": return "The event changed in Google Calendar. Review it there first."
        case "REMINDER_TIME_INCOMPLETE": return "This plan needs a time before a reminder can follow it."
        case "RECIPIENT_NOT_FOUND", "RECIPIENT_NOT_ENABLED": return "That person can't receive reminders yet."
        case "FORBIDDEN": return "Only the person who owns this draft can share it."
        default: return error.userMessage
        }
    }
}

extension AppModel {
    /// Shows plan-specific copy; stale revisions still trigger the app-wide refresh.
    func showPlanError(_ error: Error) {
        if let planner = error as? PlannerError, planner.isStale {
            show(error)
        } else {
            show(PlanErrorCopy.message(for: error), isError: true)
        }
    }
}
