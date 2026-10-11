import Foundation
import FridgedoorKit

/// Shared household actions. Optimistic where the web app is (list completion,
/// morning dismissal), with rollback on failure. Errors are rethrown so the
/// calling screen can show them (`app.show(error)`).
extension PlannerStore {
    // MARK: Lists

    @discardableResult
    /// Pass the same `idempotencyKey` when retrying the same add, so a lost response can't create a duplicate.
    func addListItem(_ kind: ListKind, title: String, quantity: String? = nil, assigneeId: String? = nil, dueTime: String? = nil, idempotencyKey: String = UUID().uuidString) async throws -> ListItem {
        let item = try await client.createListItem(kind, title: title, quantity: quantity?.nilIfBlank, assigneeId: assigneeId, dueTime: dueTime, idempotencyKey: idempotencyKey)
        replace(item)
        return item
    }

    func setCompleted(_ item: ListItem, _ completed: Bool) async throws {
        // Deleted meanwhile (here or by someone else): don't resurrect a stale copy.
        guard listItem(item.id) != nil else { return }
        let original = item
        // Optimistic: move it to/from Completed immediately.
        replace(ListItem(id: item.id, kind: item.kind, title: item.title, quantity: item.quantity, assigneeId: item.assigneeId, dueTime: item.dueTime, snoozedUntil: item.snoozedUntil, completedAt: completed ? PlannerDates.instantString(.now) : nil, revision: item.revision, createdAt: item.createdAt))
        do {
            replace(try await client.updateListItem(item.id, ListItemPatch(expectedRevision: item.revision, completed: completed)))
        } catch {
            replace(original)
            throw error
        }
    }

    func updateListItem(_ item: ListItem, _ patch: ListItemPatch) async throws {
        replace(try await client.updateListItem(item.id, patch))
    }

    func deleteListItem(_ item: ListItem) async throws {
        remove(listItem: item.id)
        do { try await client.deleteListItem(item.id, expectedRevision: item.revision) }
        catch { replace(item); throw error }
        await refresh([.reminders, .dailyOverview])
    }

    /// Snoozes a to-do to a local date (`yyyy-MM-dd`).
    func snooze(_ item: ListItem, to date: Date) async throws {
        replace(try await client.snoozeListItem(item.id, expectedRevision: item.revision, date: PlannerDates.dayString(date, in: timeZone)))
        await refresh([.reminders, .dailyOverview])
    }

    // MARK: Plans

    func editPlan(_ plan: PlanSummary, facts: PlanFacts) async throws -> PlanSummary {
        let next = try await client.editPlan(plan.id, expectedRevision: plan.revision, facts: facts)
        replace(next)
        return next
    }

    func dismissPlan(_ plan: PlanSummary) async throws {
        replace(try await client.dismissPlan(plan.id, expectedRevision: plan.revision))
        await refresh([.plans, .dailyOverview, .agenda])
    }

    /// Keep privately in the planner (no Google) or share and add to the calendar.
    func decide(_ plan: PlanSummary, choice: String) async throws {
        _ = try await client.decide(plan: plan.id, expectedRevision: plan.revision, choice: choice)
        await refresh([.plans, .agenda, .dailyOverview, .reminders])
        if choice == "calendar" { pollSoon() }
    }

    /// Create/update/cancel the plan's Google Calendar event. The key is per user action.
    func applyPlan(_ plan: PlanSummary, kind: String, idempotencyKey: String = UUID().uuidString) async throws {
        _ = try await client.applyPlan(plan.id, expectedRevision: plan.revision, kind: kind, idempotencyKey: idempotencyKey)
        await refresh([.plans, .agenda])
        pollSoon()
    }

    func retryCalendarAction(_ plan: PlanSummary) async throws {
        guard let action = plan.calendarAction else { return }
        _ = try await client.retryAction(action.actionId, expectedRevision: plan.revision)
        await refresh([.plans])
        pollSoon()
    }

    // MARK: Reminders

    func reminders(for parentId: String) -> [Reminder] {
        reminders.filter { $0.parentId == parentId && $0.isActive }
    }

    /// Reuse `idempotencyKey` while retrying an unchanged reminder (same parent, time and offset).
    func addReminder(parentType: String, parentId: String, at date: Date, offsetMinutes: Int? = nil, idempotencyKey: String = UUID().uuidString) async throws {
        let reminder = try await client.createReminder(parentType: parentType, parentId: parentId, dueAt: PlannerDates.offsetString(date, timeZone: timeZone), timezone: member.timezone, offsetMinutes: offsetMinutes, idempotencyKey: idempotencyKey)
        replace(reminder)
        await NotificationScheduler.reminderCreated()
        await refresh([.reminders])
    }

    func snoozeReminder(_ reminder: Reminder, until date: Date) async throws {
        replace(try await client.updateReminder(reminder.id, expectedRevision: reminder.revision, snoozeUntil: PlannerDates.offsetString(date, timeZone: timeZone)))
    }

    func completeReminder(_ reminder: Reminder) async throws {
        replace(try await client.updateReminder(reminder.id, expectedRevision: reminder.revision, completed: true))
    }

    func cancelReminder(_ reminder: Reminder) async throws {
        _ = try await client.updateReminder(reminder.id, expectedRevision: reminder.revision, canceled: true)
        invalidateInFlightRefresh([.reminders])
        reminders.removeAll { $0.id == reminder.id }
    }

    // MARK: Morning review

    /// Optimistically removes the items; returns the server's undo token.
    func dismissMorningItems(_ item: DailyOverviewItem) async throws -> String? {
        guard let view = dailyOverview else { return nil }
        dailyOverviewHolds += 1
        defer { dailyOverviewHolds -= 1; invalidateInFlightRefresh([.dailyOverview]) }
        invalidateInFlightRefresh([.dailyOverview])
        let refs = Array(item.refs.prefix(5))
        dailyOverview = view.removing(refs: refs)
        do {
            let next = try await client.dismissMorningItems(refs: refs, expectedRevision: view.revision)
            dailyOverview = next
            return next.undoToken
        } catch {
            // Put back only this item; other dismissals may have succeeded meanwhile.
            if let current = dailyOverview { dailyOverview = current.restoring(item, from: view) }
            throw error
        }
    }

    func restoreMorningItems(undoToken: String) async throws {
        dailyOverviewHolds += 1
        defer { dailyOverviewHolds -= 1; invalidateInFlightRefresh([.dailyOverview]) }
        invalidateInFlightRefresh([.dailyOverview])
        dailyOverview = try await client.restoreMorningItems(undoToken: undoToken)
    }
}

extension DailyView {
    /// Re-inserts `item` (at its position in `original`) if it isn't already present.
    func restoring(_ item: DailyOverviewItem, from original: DailyView) -> DailyView {
        guard !items.contains(where: { $0.id == item.id }), let index = original.items.firstIndex(where: { $0.id == item.id }) else { return self }
        var restored = items
        restored.insert(item, at: min(index, restored.count))
        return DailyView(state: state, result: result, items: restored, generatedAt: generatedAt, coverage: coverage, revision: revision, errorCode: errorCode, refreshing: refreshing, undoToken: undoToken)
    }

    func removing(refs: [String]) -> DailyView {
        let keep = { (item: DailyOverviewItem) in !item.refs.contains(where: refs.contains) }
        return DailyView(state: state, result: result.map { DailyOverviewResult(summary: $0.summary, items: $0.items?.filter(keep), questions: $0.questions.filter { !$0.refs.contains(where: refs.contains) }) }, items: items.filter(keep), generatedAt: generatedAt, coverage: coverage, revision: revision, errorCode: errorCode, refreshing: refreshing, undoToken: nil)
    }
}

extension String {
    var nilIfBlank: String? { let trimmed = trimmingCharacters(in: .whitespacesAndNewlines); return trimmed.isEmpty ? nil : trimmed }
}
