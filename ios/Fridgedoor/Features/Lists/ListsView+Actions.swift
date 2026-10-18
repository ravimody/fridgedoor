import FridgedoorKit
import SwiftUI

/// List mutations. Every change that can be undone says so in a toast with Undo;
/// nothing asks for confirmation first.
extension ListsView {
    // MARK: Adding

    func submitAdd() {
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Keep the keyboard up for the next item, even on an empty submit.
        addFocused = true
        guard !text.isEmpty, store.hasLoaded else { return }
        let entry = kind == .grocery ? GroceryEntry.parse(text) : GroceryEntry(title: text, quantity: nil)
        guard !entry.title.isEmpty else { return }
        guard entry.title.utf16.count <= GroceryEntry.maxTitle else {
            app.show("Titles can be up to 200 characters.", isError: true)
            errorTick += 1
            return
        }
        let pending = PendingListAdd(
            title: entry.title, quantity: entry.quantity,
            assigneeId: kind == .todo ? draft.assigneeId : nil,
            dueTime: kind == .todo ? draft.dueDay.map { PlannerDates.dayString($0, in: zone) } : nil
        )
        draft.text = ""
        draft.resetOptions()
        if let existing = items.openDuplicate(of: entry.title) {
            addDuplicate(pending, existing: existing)
        } else if pendingAdds.contains(where: { GroceryEntry.titlesMatch($0.title, entry.title) }) {
            alreadyOnList(entry.title, pending)
        } else {
            add(pending)
        }
    }

    /// Same title as an open item: groceries with plain-number quantities add up
    /// ("2 lemons" + "2 lemons" → 4); anything else isn't added twice unless asked.
    private func addDuplicate(_ pending: PendingListAdd, existing: ListItem) {
        let current = store.listItem(existing.id) ?? existing
        guard kind == .grocery, !busy.contains(current.id),
              let total = GroceryEntry.summedQuantity(current.quantity, pending.quantity)
        else { return alreadyOnList(current.title, pending) }
        Task {
            do {
                guard let before = try await patch(current, { $0.quantity = total }) else { return alreadyOnList(current.title, pending) }
                addedTick += 1
                app.show("Changed “\(before.title)” to \(total).", action: Toast.Action(label: "Undo") {
                    undoing { _ = try await patch(before) { $0.quantity = before.quantity ?? "" } }
                })
            } catch {
                errorTick += 1
                app.showListError(error)
            }
        }
    }

    private func alreadyOnList(_ title: String, _ pending: PendingListAdd) {
        app.show("“\(title)” is already on the list.", action: Toast.Action(label: "Add anyway") { add(pending) })
    }

    func add(_ pending: PendingListAdd) {
        // A retry reuses the same pending add (and key); ignore it while that add is still in flight.
        guard !pendingAdds.contains(where: { $0.id == pending.id }) else { return }
        pendingAdds.append(pending)
        Task {
            defer { pendingAdds.removeAll { $0.id == pending.id } }
            do {
                try await store.addListItem(kind, title: pending.title, quantity: pending.quantity, assigneeId: pending.assigneeId, dueTime: pending.dueTime, idempotencyKey: pending.id)
                addedTick += 1
            } catch {
                errorTick += 1
                let reason = ListCopy.message(for: error) ?? (error as? PlannerError)?.userMessage ?? error.localizedDescription
                app.show("Couldn't add “\(pending.title)”. \(reason)", action: Toast.Action(label: "Retry") {
                    add(pending)
                }, isError: true)
            }
        }
    }

    func buyAgain(_ item: ListItem) {
        add(PendingListAdd(title: item.title, quantity: item.quantity, assigneeId: nil, dueTime: nil))
    }

    // MARK: Done

    /// To-dos play the check animation, then move to Completed with an Undo toast.
    /// Groceries complete right away but stay in place, struck through, until
    /// "Clear checked"; tapping one again un-checks it.
    func toggle(_ item: ListItem) {
        let current = store.listItem(item.id) ?? item
        guard !busy.contains(current.id) else { return }
        if current.kind == .todo {
            check(current)
        } else if current.isCompleted {
            // Stays struck through until the server confirms, so a failure doesn't drop it into Completed.
            setCompleted(current, false)
        } else {
            lingering.insert(current.id)
            completedTick += 1
            setCompleted(current, true)
        }
    }

    private func check(_ item: ListItem) {
        guard !checking.contains(item.id) else { return }
        checking.insert(item.id)
        completedTick += 1
        Task {
            try? await Task.sleep(for: .milliseconds(350))
            checking.remove(item.id)
            setCompleted(store.listItem(item.id) ?? item, true)
        }
    }

    func setCompleted(_ item: ListItem, _ completed: Bool) {
        guard !busy.contains(item.id) else { return }
        busy.insert(item.id)
        if !completed { reopenedTick += 1 }
        Task {
            defer { busy.remove(item.id) }
            do {
                try await store.setCompleted(item, completed)
                if !completed { lingering.remove(item.id) }
                guard item.kind == .todo else { return }
                if completed, let saved = store.listItem(item.id) {
                    app.show("Marked “\(item.title)” done.", action: Toast.Action(label: "Undo") { setCompleted(saved, false) })
                }
                await store.refresh([.dailyOverview])
            } catch {
                if completed { lingering.remove(item.id) }
                errorTick += 1
                if let message = ListCopy.message(for: error) {
                    app.show(message, isError: true)
                } else {
                    app.show("Couldn't save “\(item.title)”. It's been restored — try again.", isError: true)
                }
                if (error as? PlannerError)?.isStale == true { await store.refresh([part]) }
            }
        }
    }

    // MARK: Later, dates and people

    func later(_ item: ListItem, to date: Date) {
        guard !busy.contains(item.id) else { return }
        busy.insert(item.id)
        Task {
            defer { busy.remove(item.id) }
            do {
                try await store.snooze(store.listItem(item.id) ?? item, to: date)
                reopenedTick += 1
                app.show("“\(item.title)” comes back \(TimeLabels.relativeDayInSentence(date, in: zone, preposition: "on")).")
            } catch {
                errorTick += 1
                app.showListError(error)
            }
        }
    }

    /// Re-dates every overdue to-do to today, with one Undo for the lot.
    func moveToToday(_ overdue: [ListItem]) {
        let today = PlannerDates.dayString(.now, in: zone)
        Task {
            var moved: [ListItem] = []
            var failure: Error?
            for item in overdue {
                do {
                    if let before = try await patch(item, { $0.dueTime = .some(today) }) { moved.append(before) }
                } catch {
                    failure = error
                }
            }
            if let failure, moved.isEmpty {
                errorTick += 1
                app.showListError(failure)
                return
            }
            guard !moved.isEmpty else { return }
            reopenedTick += 1
            var message = moved.count == 1 ? "Moved “\(moved[0].title)” to today." : "Moved \(moved.count) to-dos to today."
            if failure != nil { message += " Some couldn't be moved — try again." }
            app.show(message, action: Toast.Action(label: "Undo") {
                undoing {
                    for before in moved { _ = try await patch(before) { $0.dueTime = .some(before.dueTime) } }
                    await store.refresh([.dailyOverview])
                }
            }, isError: failure != nil)
            await store.refresh([.dailyOverview])
        }
    }

    func assign(_ item: ListItem, to personId: String?) {
        guard personId != (store.listItem(item.id) ?? item).assigneeId else { return }
        Task {
            do {
                guard let before = try await patch(item, { $0.assigneeId = .some(personId) }) else { return }
                let message = personId.map { "Assigned “\(item.title)” to \($0 == store.member.id ? "you" : store.person($0)?.firstName ?? "them")." }
                    ?? "Unassigned “\(item.title)”."
                app.show(message, action: Toast.Action(label: "Undo") {
                    undoing { _ = try await patch(before) { $0.assigneeId = .some(before.assigneeId) } }
                })
            } catch {
                errorTick += 1
                app.showListError(error)
            }
        }
    }

    // MARK: Delete and move

    /// Deletes right away; open items come back with Undo (re-created, so reminders don't return).
    func delete(_ item: ListItem) {
        guard !busy.contains(item.id) else { return }
        busy.insert(item.id)
        Task {
            defer { busy.remove(item.id) }
            let current = store.listItem(item.id) ?? item
            do {
                try await store.deleteListItem(current)
                lingering.remove(item.id)
                if current.isCompleted {
                    app.show("Deleted “\(current.title)”.")
                } else {
                    app.show("Deleted “\(current.title)”.", action: Toast.Action(label: "Undo") {
                        add(PendingListAdd(title: current.title, quantity: current.quantity, assigneeId: current.assigneeId, dueTime: current.dueTime))
                    })
                }
            } catch {
                errorTick += 1
                app.showListError(error)
            }
        }
    }

    /// A grocery that's really a chore: creates a to-do with the same title, then deletes the grocery.
    func moveToTodo(_ item: ListItem) {
        guard !busy.contains(item.id) else { return }
        busy.insert(item.id)
        Task {
            defer { busy.remove(item.id) }
            let grocery = store.listItem(item.id) ?? item
            do {
                let todo = try await store.addListItem(.todo, title: grocery.title)
                do {
                    try await store.deleteListItem(grocery)
                } catch {
                    try? await store.deleteListItem(todo)
                    throw error
                }
                app.show("Moved “\(grocery.title)” to To do.", action: Toast.Action(label: "Undo") {
                    add(PendingListAdd(title: grocery.title, quantity: grocery.quantity, assigneeId: grocery.assigneeId, dueTime: nil))
                    undoing { try await store.deleteListItem(store.listItem(todo.id) ?? todo) }
                })
            } catch {
                errorTick += 1
                app.showListError(error)
            }
        }
    }

    // MARK: Helpers

    /// Sends one edit using the newest revision we know of. Returns the item as it was
    /// before (for Undo), or nil when another change to it is still in flight.
    private func patch(_ item: ListItem, _ edit: (inout ListItemPatch) -> Void) async throws -> ListItem? {
        guard !busy.contains(item.id) else { return nil }
        busy.insert(item.id)
        defer { busy.remove(item.id) }
        let current = store.listItem(item.id) ?? item
        var patch = ListItemPatch(expectedRevision: current.revision)
        edit(&patch)
        try await store.updateListItem(current, patch)
        return current
    }

    /// Runs an Undo, reporting failure instead of dropping it.
    private func undoing(_ work: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await work() } catch {
                errorTick += 1
                app.showListError(error)
            }
        }
    }
}
