import FridgedoorKit
import SwiftUI

/// Draft state for the add field. Submitting keeps the keyboard up for rapid entry.
struct ListDraft: Equatable {
    var text = ""
    /// To-dos: an optional due day (member timezone).
    var dueDay: Date?
    /// To-dos: who it's for (nil = unassigned).
    var assigneeId: String?

    var hasOptions: Bool { dueDay != nil || assigneeId != nil }
    mutating func resetOptions() { dueDay = nil; assigneeId = nil }
}

/// The sticky "Add a to-do…" / "Add an item…" field pinned under the title and search.
struct ListAddBar: View {
    let kind: ListKind
    @Binding var draft: ListDraft
    var focused: FocusState<Bool>.Binding
    let zone: TimeZone
    let isEnabled: Bool
    let onSubmit: () -> Void
    let onChooseDate: () -> Void

    @Environment(PlannerStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(isEnabled ? Color.plannerAccent : Color.muted)
                    .frame(width: 32)
                    .accessibilityHidden(true)
                TextField(ListCopy.addPlaceholder(kind), text: $draft.text)
                    .focused(focused)
                    .submitLabel(.next)
                    .onSubmit(onSubmit)
                    .textInputAutocapitalization(.sentences)
                    .disabled(!isEnabled)
                    .accessibilityLabel(kind == .todo ? "New to-do" : "New grocery item")
                    .frame(minHeight: 44)
                if !draft.text.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button(action: onSubmit) {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.plannerAccent)
                    .frame(width: 44, height: 44)
                    .accessibilityLabel("Add")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.leading, 8)
            .padding(.trailing, 4)
            .background(Color.card, in: .rect(cornerRadius: 14, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line, lineWidth: 1) }
            .contentShape(.rect)
            .onTapGesture { if isEnabled { focused.wrappedValue = true } }

            if kind == .grocery, let hint = groceryHint {
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .padding(.leading, 12)
                    .transition(.opacity)
            }
            if kind == .todo, focused.wrappedValue || draft.hasOptions {
                todoOptions
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.top, 4)
        .padding(.bottom, 8)
        .animation(.snappy, value: draft)
        .animation(.snappy, value: focused.wrappedValue)
    }

    /// Shows how "2 avocados" / "milk x2" will be saved.
    private var groceryHint: String? {
        let entry = GroceryEntry.parse(draft.text)
        guard let quantity = entry.quantity, !entry.title.isEmpty else { return nil }
        return "Adds “\(entry.title)”, quantity \(quantity)"
    }

    private var todoOptions: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Menu {
                    ForEach(QuickDate.allCases) { option in
                        Button(option.label, systemImage: option.systemImage) { draft.dueDay = option.date(in: zone) }
                    }
                    Button("Choose a date…", systemImage: "calendar", action: onChooseDate)
                    if draft.dueDay != nil {
                        Divider()
                        Button("No date", systemImage: "xmark") { draft.dueDay = nil }
                    }
                } label: {
                    OptionChip(
                        text: draft.dueDay.map { TimeLabels.relativeDay($0, in: zone) } ?? "Date",
                        systemImage: "calendar",
                        isOn: draft.dueDay != nil
                    )
                }
                .accessibilityLabel(draft.dueDay.map { "Due \(TimeLabels.relativeDayInSentence($0, in: zone))" } ?? "Add a due date")
                Menu {
                    ForEach(store.assignablePeople) { person in
                        Button(store.assigneeChoice(person)) { draft.assigneeId = person.id }
                    }
                    if draft.assigneeId != nil {
                        Divider()
                        Button("Unassigned", systemImage: "xmark") { draft.assigneeId = nil }
                    }
                } label: {
                    OptionChip(text: assigneeText, systemImage: "person", isOn: draft.assigneeId != nil)
                }
                .accessibilityLabel(draft.assigneeId.map { store.assigneeLabel($0) } ?? "Assign")
            }
            .padding(.horizontal, 2)
        }
        .scrollClipDisabled()
    }

    private var assigneeText: String {
        guard let id = draft.assigneeId else { return "Assign" }
        return id == store.member.id ? "Me" : store.person(id)?.firstName ?? "Assigned"
    }
}

struct OptionChip: View {
    let text: String
    let systemImage: String
    let isOn: Bool
    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .frame(minHeight: 34)
            .foregroundStyle(isOn ? Color.onAccent : Color.plannerAccent)
            .background(isOn ? Color.plannerAccent : Color.soft, in: .capsule)
            .frame(minHeight: 44)
            .contentShape(.rect)
    }
}

/// Everyone / Mine / each other person, above the To do list.
struct ListFilterChips: View {
    @Binding var filter: ListFilter
    @Environment(PlannerStore.self) private var store

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("Everyone", .everyone)
                chip("Mine", .mine)
                ForEach(store.household.filter { $0.id != store.member.id }) { person in
                    chip(person.firstName, .person(person.id))
                }
            }
        }
        .scrollClipDisabled()
    }

    private func chip(_ title: String, _ value: ListFilter) -> some View {
        Button {
            withAnimation(.snappy) { filter = value }
        } label: {
            Text(title)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .frame(minHeight: 34)
                .foregroundStyle(filter == value ? Color.onAccent : Color.ink)
                .background(filter == value ? Color.plannerAccent : Color.soft, in: .capsule)
                .frame(minHeight: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(value == .everyone ? "Everyone's to-dos" : value == .mine ? "My to-dos" : "\(title)'s to-dos")
        .accessibilityAddTraits(filter == value ? .isSelected : [])
    }
}

/// One-tap "Buy again" chips from recently completed groceries, under the add field.
struct BuyAgainStrip: View {
    let suggestions: [ListItem]
    let onAdd: (ListItem) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Text("Buy again")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.muted)
                    .accessibilityAddTraits(.isHeader)
                ForEach(suggestions) { item in
                    Button { onAdd(item) } label: {
                        Label(ListCopy.titleWithQuantity(item), systemImage: "arrow.counterclockwise")
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 12)
                            .frame(minHeight: 34)
                            .foregroundStyle(Color.plannerAccent)
                            .background(Color.soft, in: .capsule)
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Add \(item.title) again")
                }
            }
        }
        .scrollClipDisabled()
    }
}
