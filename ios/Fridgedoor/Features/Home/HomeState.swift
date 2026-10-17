import Foundation
import Observation
import FridgedoorKit
import SwiftUI

/// Screen-local state and actions for Home: busy markers, the morning-review Undo
/// receipt, sheets, and haptic triggers. Shared mutations live in `PlannerStore+Actions`.
@MainActor @Observable
final class HomeState {
    struct MorningUndo: Equatable {
        let token: String
        let expiresAt: Date
    }

    let app: AppModel
    let store: PlannerStore

    var busy: Set<String> = []
    var morningUndo: MorningUndo?
    var calendarDraft: CalendarDraft?
    var datePickerTask: ListItem?
    var refreshingReview = false
    // Haptic triggers.
    var completedCount = 0
    var dismissedCount = 0

    init(app: AppModel, store: PlannerStore) {
        self.app = app
        self.store = store
    }

    func isBusy(_ id: String) -> Bool { busy.contains(id) }

    private func run(_ id: String, _ work: () async throws -> Void) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        do { try await work() } catch { app.show(error) }
    }

    // MARK: Morning review

    /// Optimistic dismissal with a five-minute Undo receipt (server-issued).
    func dismiss(_ item: DailyOverviewItem) {
        dismissedCount += 1
        Task { [self] in
            await run("review:\(item.id)") {
                let token = try await store.dismissMorningItems(item)
                guard let token else { app.show("Dismissed from your brief."); return }
                // The server honors the receipt for five minutes; stop offering it a little early.
                morningUndo = MorningUndo(token: token, expiresAt: .now.addingTimeInterval(290))
                app.show("Dismissed from your brief.", action: Toast.Action(label: "Undo") { [weak self] in self?.undoDismiss() })
            }
        }
    }

    func undoDismiss() {
        guard let receipt = morningUndo, receipt.expiresAt > .now else {
            morningUndo = nil
            app.show(PlannerError(code: "UNDO_UNAVAILABLE"))
            return
        }
        Task { [self] in
            await run("undo") {
                do {
                    try await store.restoreMorningItems(undoToken: receipt.token)
                    morningUndo = nil
                    app.show("Restored to your brief.")
                } catch let error as PlannerError where error.code == "UNDO_UNAVAILABLE" {
                    morningUndo = nil
                    throw error
                }
            }
        }
    }

    /// Queues a fresh morning review. The refresh revision is the daily-AI settings revision.
    func refreshReview() {
        guard let settings = store.dailySettings, settings.enabled else { return }
        let previous = store.dailyOverview?.generatedAt
        Task { [self] in
            refreshingReview = true
            defer { refreshingReview = false }
            do {
                _ = try await store.client.refreshMorningReview(expectedRevision: settings.revision)
            } catch {
                app.show(error)
                return
            }
            // Poll until a new review lands or the server stops reporting work (about a minute at most).
            for _ in 0..<20 {
                await store.refresh([.dailyOverview, .clarifications])
                let view = store.dailyOverview
                if view?.generatedAt != previous, view?.errorCode != "DAILY_OVERVIEW_UPDATING" { return }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    // MARK: Plans

    func decide(_ plan: PlanSummary, choice: String) {
        Task { [self] in
            await run("plan:\(plan.id)") {
                try await store.decide(plan, choice: choice)
                if choice == "keep" {
                    app.show("Saved “\(plan.facts.title)”.")
                } else {
                    // Never claim the Google write succeeded here; the store announces `succeeded`.
                    app.show("Adding “\(plan.facts.title)” to the household calendar…")
                }
            }
        }
    }

    // MARK: Clarifications

    func answer(_ clarification: Clarification, text: String) async -> Bool {
        var saved = false
        await run("clarification:\(clarification.id)") {
            _ = try await store.client.answerClarification(clarification.id, text: text, expectedRevision: clarification.revision)
            saved = true
            app.show("Answer saved.")
            await store.refresh([.clarifications, .plans, .dailyOverview])
        }
        return saved
    }

    func dismiss(_ clarification: Clarification) {
        let busyId = "clarification:\(clarification.id)"
        // `run` would skip the request while an answer is saving; don't hide the card for nothing.
        guard !busy.contains(busyId) else { return }
        let index = store.clarifications.firstIndex { $0.id == clarification.id } ?? 0
        store.invalidateInFlightRefresh()
        store.clarifications.removeAll { $0.id == clarification.id }
        dismissedCount += 1
        Task { [self] in
            await run(busyId) {
                do {
                    _ = try await store.client.dismissClarification(clarification.id, expectedRevision: clarification.revision)
                    app.show("Question dismissed.")
                } catch {
                    // Put back only this card; anything else may have been refreshed meanwhile.
                    if !store.clarifications.contains(where: { $0.id == clarification.id }) {
                        store.clarifications.insert(clarification, at: min(index, store.clarifications.count))
                    }
                    throw error
                }
            }
        }
    }

    // MARK: To-dos

    func complete(_ task: ListItem) {
        completedCount += 1
        Task { [self] in
            await run("task:\(task.id)") {
                try await store.setCompleted(task, true)
                app.show("Done: \(task.title)", action: Toast.Action(label: "Undo") { [weak self] in self?.reopen(task.id) })
                await store.refresh([.dailyOverview, .reminders])
            }
        }
    }

    private func reopen(_ id: String) {
        guard let current = store.listItem(id) else { return }
        Task { [self] in
            await run("task:\(id)") {
                try await store.setCompleted(current, false)
                await store.refresh([.dailyOverview, .reminders])
            }
        }
    }

    /// Moves a to-do's reminder date forward (member timezone).
    func snooze(_ task: ListItem, days: Int) {
        guard let date = store.calendar.date(byAdding: .day, value: days, to: store.calendar.startOfDay(for: .now)) else { return }
        snooze(task, to: date)
    }

    func snooze(_ task: ListItem, to date: Date) {
        Task { [self] in
            await run("task:\(task.id)") {
                try await store.snooze(task, to: date)
                app.show("Moved “\(task.title)” to \(TimeLabels.relativeDayInSentence(date, in: store.timeZone)).")
            }
        }
    }

    /// Deletes with Undo (re-adds the same to-do) instead of asking first.
    func delete(_ task: ListItem) {
        Task { [self] in
            await run("task:\(task.id)") {
                try await store.deleteListItem(task)
                app.show("Deleted “\(task.title)”.", action: Toast.Action(label: "Undo") { [weak self] in self?.restore(task) })
            }
        }
    }

    private func restore(_ task: ListItem) {
        Task { [self] in
            await run("task:\(task.id)") {
                _ = try await store.addListItem(.todo, title: task.title, quantity: task.quantity, assigneeId: task.assigneeId, dueTime: task.dueTime)
                await store.refresh([.dailyOverview, .reminders])
            }
        }
    }

    // MARK: Reminders

    func snoozeReminder(_ reminder: Reminder) {
        Task { [self] in
            await run("reminder:\(reminder.id)") {
                try await store.snoozeReminder(reminder, until: .now.addingTimeInterval(15 * 60))
                app.show("Snoozed for 15 minutes.")
            }
        }
    }

    func completeReminder(_ reminder: Reminder) {
        Task { [self] in
            await run("reminder:\(reminder.id)") {
                try await store.completeReminder(reminder)
                completedCount += 1
                app.show("Reminder done.")
            }
        }
    }

    func cancelReminder(_ reminder: Reminder) {
        Task { [self] in
            await run("reminder:\(reminder.id)") {
                try await store.cancelReminder(reminder)
                dismissedCount += 1
                app.show("Reminder canceled.")
            }
        }
    }
}
