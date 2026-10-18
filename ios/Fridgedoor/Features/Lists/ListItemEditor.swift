import FridgedoorKit
import SwiftUI

/// Edit a list item: title, quantity (groceries), due date (to-dos) and assignee.
/// Only changed fields are sent; `.some(nil)` clears a due date or assignee.
struct ListItemEditor: View {
    let item: ListItem
    /// Deletes after the sheet closes (the caller owns the Undo toast).
    let onDelete: (ListItem) -> Void

    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var title: String
    @State private var quantity: String
    @State private var hasDue: Bool
    @State private var includeTime: Bool
    @State private var due: Date
    @State private var assigneeId: String?
    @State private var isSaving = false
    @State private var confirmDiscard = false

    init(item: ListItem, zone: TimeZone, onDelete: @escaping (ListItem) -> Void) {
        self.item = item
        self.onDelete = onDelete
        _title = State(initialValue: item.title)
        _quantity = State(initialValue: item.quantity ?? "")
        _hasDue = State(initialValue: item.dueTime != nil)
        _includeTime = State(initialValue: item.dueTime != nil && !item.isAllDayDue)
        let calendar = PlannerDates.calendar(zone)
        let fallback = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: calendar.date(byAdding: .day, value: 1, to: .now) ?? .now) ?? .now
        _due = State(initialValue: item.dueDate(in: zone).map { item.isAllDayDue ? calendar.date(bySettingHour: 9, minute: 0, second: 0, of: $0) ?? $0 : $0 } ?? fallback)
        _assigneeId = State(initialValue: item.assigneeId)
    }

    private var zone: TimeZone { store.timeZone }
    private var isTodo: Bool { item.kind == .todo }
    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedQuantity: String { quantity.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The `dueTime` wire value for the current controls.
    private var newDue: String? {
        guard hasDue else { return nil }
        return includeTime ? PlannerDates.offsetString(due, timeZone: zone) : PlannerDates.dayString(due, in: zone)
    }

    private var dueChanged: Bool {
        guard hasDue == (item.dueTime != nil) else { return true }
        guard hasDue else { return false }
        if includeTime == item.isAllDayDue { return true }
        if includeTime { return abs((item.dueDate(in: zone) ?? .distantPast).timeIntervalSince(due)) >= 60 }
        return PlannerDates.dayString(due, in: zone) != item.dueTime
    }

    private var titleChanged: Bool { trimmedTitle != item.title }
    private var quantityChanged: Bool { item.kind == .grocery && trimmedQuantity != (item.quantity ?? "") }
    private var assigneeChanged: Bool { assigneeId != item.assigneeId }
    private var hasChanges: Bool { titleChanged || quantityChanged || dueChanged || assigneeChanged }
    private var isValid: Bool { !trimmedTitle.isEmpty && trimmedTitle.utf16.count <= GroceryEntry.maxTitle && trimmedQuantity.utf16.count <= GroceryEntry.maxQuantity }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical)
                        .font(.body)
                        .submitLabel(.done)
                    if item.kind == .grocery {
                        TextField("Quantity (optional)", text: $quantity)
                            .accessibilityLabel("Quantity")
                    }
                } footer: {
                    if trimmedTitle.utf16.count > GroceryEntry.maxTitle { Text("Titles can be up to 200 characters.").foregroundStyle(Color.danger) }
                }
                .plannerRows()

                if isTodo {
                    Section {
                        Toggle(isOn: $hasDue.animation(.snappy)) { Label("Due date", systemImage: "calendar") }
                        if hasDue {
                            DatePicker("Date", selection: $due, displayedComponents: .date)
                            Toggle(isOn: $includeTime.animation(.snappy)) { Label("Time", systemImage: "clock") }
                            if includeTime {
                                DatePicker("Time", selection: $due, displayedComponents: .hourAndMinute)
                            }
                        }
                    } footer: {
                        if item.isSnoozed(in: zone), dueChanged {
                            Text("Changing the date brings it back from Later.")
                        }
                    }
                    .plannerRows()
                    .tint(Color.plannerAccent)
                }

                Section {
                    Picker(selection: $assigneeId) {
                        Text("Unassigned").tag(String?.none)
                        ForEach(store.assignablePeople) { person in
                            Text(store.assigneeChoice(person)).tag(Optional(person.id))
                        }
                        if let other = item.assigneeId, store.person(other) == nil, other != store.member.id {
                            Text("Someone else").tag(Optional(other))
                        }
                    } label: {
                        Label("Assignee", systemImage: "person")
                    }
                }
                .plannerRows()

                Section {
                    if let added = item.createdDate {
                        LabeledContent("Added", value: TimeLabels.dateTime(added, in: zone))
                    }
                    if let done = item.completedDate {
                        LabeledContent("Completed", value: TimeLabels.dateTime(done, in: zone))
                    }
                }
                .foregroundStyle(Color.muted)
                .plannerRows()

                Section {
                    Button(isTodo ? "Delete to-do" : "Delete item", role: .destructive) {
                        dismiss()
                        onDelete(item)
                    }
                    .frame(maxWidth: .infinity)
                }
                .plannerRows()
            }
            .scrollContentBackground(.hidden)
            .background(Color.paper)
            .navigationTitle(isTodo ? "Edit to-do" : "Edit item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if hasChanges { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save", role: .confirm) { Task { await save() } }
                            .disabled(!hasChanges || !isValid)
                    }
                }
            }
            .confirmationDialog("Discard changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
        }
        .environment(\.timeZone, zone)
        .presentationDetents([.large])
        .interactiveDismissDisabled(hasChanges)
    }

    private func save() async {
        guard hasChanges, isValid else { return }
        isSaving = true
        defer { isSaving = false }
        // Diff against what the sheet opened with, but send the newest revision we know of
        // (polling may have refreshed it) so unrelated edits elsewhere don't block this one.
        let current = store.listItem(item.id) ?? item
        var patch = ListItemPatch(expectedRevision: current.revision)
        if titleChanged { patch.title = trimmedTitle }
        if quantityChanged { patch.quantity = trimmedQuantity } // "" clears it
        if dueChanged { patch.dueTime = .some(newDue) }
        if assigneeChanged { patch.assigneeId = .some(assigneeId) }
        do {
            try await store.updateListItem(current, patch)
            dismiss()
        } catch {
            app.showListError(error)
        }
    }
}
