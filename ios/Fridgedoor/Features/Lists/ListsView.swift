import FridgedoorKit
import SwiftUI

/// The shared To do and Groceries lists (`docs/features/home-design.md` → "List completion
/// and sharing", "Persistent to-dos and snoozing"). Mirrors web `features/Lists`.
/// A sticky add field sits under the title; to-dos group by when they're due (Later
/// ones collapse at the bottom), groceries by aisle. Actions live in `ListsView+Actions.swift`.
struct ListsView: View {
    let kind: ListKind

    @Environment(AppModel.self) var app
    @Environment(PlannerStore.self) var store
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("lists.grocerySort") private var grocerySort: GrocerySort = .aisles

    @State var draft = ListDraft()
    @FocusState var addFocused: Bool
    /// Bumped by the toolbar + to scroll the add field (the list's first row) into view.
    @State private var revealAddBar = 0
    private static let addBarID = "add-bar"
    @State var pendingAdds: [PendingListAdd] = []
    @State private var query = ""
    @State private var filter: ListFilter = .everyone
    @State private var showCompleted = false
    @State private var showLater = false
    /// Items with a request in flight (one change per item at a time keeps revisions valid).
    @State var busy: Set<String> = []
    /// To-dos showing the check animation before they move to Completed.
    @State var checking: Set<String> = []
    /// Groceries checked off on this visit. The server already has them as done; they stay
    /// in place, struck through, until "Clear checked" or the screen goes away.
    @State var lingering: Set<String> = []

    @State var editing: ListItem?
    @State var reminding: ListItem?
    @State var deferring: ListItem?
    @State var assigning: ListItem?
    @State private var choosingDraftDate = false

    @State var completedTick = 0
    @State var reopenedTick = 0
    @State var addedTick = 0
    @State var errorTick = 0

    var zone: TimeZone { store.timeZone }
    var part: PlannerStore.Part { kind == .todo ? .todos : .groceries }
    var items: [ListItem] { store.items(kind) }
    private var me: String { store.member.id }
    private var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
    private var isLoading: Bool { !store.hasLoaded && items.isEmpty }

    // MARK: What's shown

    private var showsFilters: Bool { kind == .todo && store.household.count > 1 }

    /// The chosen filter, or Everyone when filters are hidden or that person left.
    private var activeFilter: ListFilter {
        guard showsFilters else { return .everyone }
        if case .person(let id) = filter, store.person(id) == nil { return .everyone }
        return filter
    }

    private func isVisible(_ item: ListItem) -> Bool { activeFilter.includes(item, me: me) }

    private func matches(_ item: ListItem) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return item.title.localizedStandardContains(needle) || (item.quantity?.localizedStandardContains(needle) ?? false)
    }

    private func isLingering(_ item: ListItem) -> Bool { item.isCompleted && lingering.contains(item.id) }

    /// Open to-dos that aren't pushed to Later, grouped by when they're due.
    private var todoGroups: [ListGroup<TodoBucket>] {
        let open = items.openOrdered(in: zone).filter { !$0.isSnoozed(in: zone) && isVisible($0) }
        let grouped = Dictionary(grouping: open) { TodoBucket.of($0, zone: zone) }
        return TodoBucket.allCases.compactMap { bucket in grouped[bucket].map { ListGroup(key: bucket, items: $0) } }
    }

    private var laterTodos: [ListItem] {
        items.openOrdered(in: zone).filter { $0.isSnoozed(in: zone) && isVisible($0) }
    }

    /// Open groceries plus the ones checked off on this visit.
    private var shownGroceries: [ListItem] { items.filter { !$0.isCompleted || lingering.contains($0.id) } }

    /// By aisle (store-walk order, oldest first within an aisle), or one group newest first.
    private var groceryGroups: [ListGroup<GroceryAisle?>] {
        let shown = shownGroceries.sorted(by: Self.olderFirst)
        guard grocerySort == .aisles else { return shown.isEmpty ? [] : [ListGroup(key: nil, items: shown.reversed())] }
        let grouped = Dictionary(grouping: shown) { GroceryAisle.of($0.title) }
        return GroceryAisle.allCases.compactMap { aisle in grouped[aisle].map { ListGroup(key: aisle, items: $0) } }
    }

    private var completedItems: [ListItem] {
        items.completedOrdered().filter { !lingering.contains($0.id) && isVisible($0) }
    }

    private var buyAgainSuggestions: [ListItem] {
        let onList = shownGroceries.map(\.title) + pendingAdds.map(\.title)
        return items.filter { !lingering.contains($0.id) }.buyAgainSuggestions()
            .filter { suggestion in !onList.contains { GroceryEntry.titlesMatch($0, suggestion.title) } }
    }

    private var hasNothingOpen: Bool {
        pendingAdds.isEmpty && (kind == .todo ? todoGroups.isEmpty : shownGroceries.isEmpty)
    }

    private static func olderFirst(_ a: ListItem, _ b: ListItem) -> Bool {
        if a.createdAt != b.createdAt { return (a.createdDate ?? .distantPast) < (b.createdDate ?? .distantPast) }
        return a.id < b.id
    }

    // MARK: Body

    var body: some View {
        ScrollViewReader { proxy in
        List {
            if let error = store.refreshError {
                Section {
                    ErrorBanner(message: "\(error.userMessage) Showing the last list loaded.") {
                        Task { await store.refresh([part, .reminders]) }
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if isLoading {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading your list…").foregroundStyle(Color.muted)
                    }
                    .padding(.vertical, 12)
                }
                .plannerRows()
            } else if isSearching {
                searchSections
            } else {
                browseSections
            }
        }
        .plannerList()
        .onChange(of: revealAddBar) { withAnimation(.snappy) { proxy.scrollTo(Self.addBarID, anchor: .top) } }
        }
        .listSectionSpacing(.compact)
        .scrollDismissesKeyboard(.interactively)
        .animation(.snappy, value: items)
        .animation(.snappy, value: pendingAdds)
        .animation(.snappy, value: lingering)
        .animation(.snappy, value: grocerySort)
        .navigationTitle(ListCopy.heading(kind))
        .toolbarTitleDisplayMode(.large)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: ListCopy.searchPrompt(kind))
        .refreshable { await store.refresh([part, .reminders]) }
        .toolbar { toolbar }
        .task { await store.refresh([part, .reminders]) }
        .onChange(of: router.focusAdd, initial: true) { _, target in
            // "Add grocery" from a widget or control: bring up this list's add field.
            guard target == kind else { return }
            router.focusAdd = nil
            query = ""
            revealAddBar += 1
            Task { try? await Task.sleep(for: .milliseconds(350)); addFocused = true }
        }
        .onDisappear { lingering.removeAll() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { lingering.removeAll() }
        }
        .sensoryFeedback(.success, trigger: completedTick)
        .sensoryFeedback(.impact(weight: .light), trigger: reopenedTick)
        .sensoryFeedback(.impact(flexibility: .soft), trigger: addedTick)
        .sensoryFeedback(.error, trigger: errorTick)
        .sheet(item: $editing) { item in
            ListItemEditor(item: item, zone: zone) { delete($0) }
        }
        .sheet(item: $reminding) { item in
            // No anchor: the server only re-times offset reminders for plans, so
            // list-item reminders must be absolute times.
            ReminderEditorSheet(parentType: "list_item", parentId: item.id, title: item.title, anchor: nil)
        }
        .sheet(item: $deferring) { item in
            LaterSheet(item: item, zone: zone) { later(item, to: $0) }
        }
        .sheet(isPresented: $choosingDraftDate) {
            ListDatePickerSheet(
                title: "Due date",
                zone: zone,
                minimum: QuickDate.today.date(in: zone),
                initial: draft.dueDay,
                confirmLabel: "Set date"
            ) { day in
                draft.dueDay = day
                addFocused = true
            }
        }
        .confirmationDialog("Assign", isPresented: presenting($assigning), titleVisibility: .visible, presenting: assigning) { item in
            ForEach(store.assignablePeople) { person in
                Button(store.assigneeChoice(person)) { assign(item, to: person.id) }
            }
            if item.assigneeId != nil { Button("Unassigned") { assign(item, to: nil) } }
        } message: { item in
            Text("Who's handling “\(item.title)”?")
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            ShareLink(item: ListCopy.shareText(kind, items: items.openOrdered(in: zone), zone: zone)) {
                Image(systemName: "square.and.arrow.up")
            }
            .accessibilityLabel("Share the \(ListCopy.heading(kind).lowercased()) list")
            .disabled(items.allSatisfy(\.isCompleted))
        }
        if kind == .grocery {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Sort", selection: $grocerySort) {
                        ForEach(GrocerySort.allCases) { Text($0.label).tag($0) }
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
                .accessibilityLabel("Sort groceries")
                .accessibilityValue(grocerySort.label)
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                // Clear any search (the add field returns with the browse list), scroll the
                // field into view, then focus it.
                query = ""
                revealAddBar += 1
                Task { try? await Task.sleep(for: .milliseconds(250)); addFocused = true }
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel(kind == .todo ? "Add a to-do" : "Add an item")
            .disabled(isLoading)
        }
    }

    // MARK: Sections

    @ViewBuilder private var browseSections: some View {
        chipSection {
            ListAddBar(
                kind: kind, draft: $draft, focused: $addFocused, zone: zone, isEnabled: store.hasLoaded,
                onSubmit: submitAdd, onChooseDate: { choosingDraftDate = true }
            )
        }
        .id(Self.addBarID)
        let suggestions = kind == .grocery ? buyAgainSuggestions : []
        if !suggestions.isEmpty {
            chipSection { BuyAgainStrip(suggestions: suggestions) { buyAgain($0) } }
        }
        if showsFilters {
            chipSection { ListFilterChips(filter: Binding(get: { activeFilter }, set: { filter = $0 })) }
        }
        if !pendingAdds.isEmpty {
            Section {
                ForEach(pendingAdds) { PendingAddRow(pending: $0) }
                    .listRowInsets(rowInsets)
            }
            .plannerRows()
        }
        if kind == .todo {
            ForEach(todoGroups) { group in
                Section {
                    ForEach(group.items) { openRow($0) }
                } header: {
                    if group.key == .overdue {
                        ListSectionHeader(title: group.key.title, tint: .warning) { moveToTodayButton(group.items) }
                    } else {
                        ListSectionHeader(group.key.title)
                    }
                }
                .plannerRows()
            }
        } else {
            ForEach(groceryGroups) { group in
                if let aisle = group.key {
                    Section {
                        ForEach(group.items) { openRow($0) }
                    } header: {
                        ListSectionHeader(aisle.title)
                    }
                    .plannerRows()
                } else {
                    Section { ForEach(group.items) { openRow($0) } }
                        .plannerRows()
                }
            }
            clearCheckedSection
        }
        if hasNothingOpen {
            Section { emptyState }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
        }
        if kind == .todo { laterSection }
        completedSection(completedItems)
    }

    @ViewBuilder private var searchSections: some View {
        let open = (kind == .todo ? items.openOrdered(in: zone) : shownGroceries.sorted(by: Self.olderFirst)).filter(matches)
        let done = items.completedOrdered().filter { !lingering.contains($0.id) && matches($0) }
        if open.isEmpty && done.isEmpty {
            Section {
                Text("Nothing matches “\(query)”.")
                    .foregroundStyle(Color.muted)
                    .padding(.vertical, 12)
            }
            .plannerRows()
        }
        if !open.isEmpty {
            Section { ForEach(open) { openRow($0) } }
                .plannerRows()
        }
        completedSection(done, alwaysExpanded: true)
    }

    private func chipSection(@ViewBuilder _ content: () -> some View) -> some View {
        Section { content() }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets())
    }

    private func moveToTodayButton(_ overdue: [ListItem]) -> some View {
        Button("Move to today") { moveToToday(overdue) }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.plannerAccent)
            .frame(minHeight: 44)
            .contentShape(.rect)
            .disabled(overdue.contains { busy.contains($0.id) })
            .accessibilityHint(overdue.count == 1 ? "Moves 1 overdue to-do to today" : "Moves \(overdue.count) overdue to-dos to today")
    }

    @ViewBuilder private var clearCheckedSection: some View {
        let checked = shownGroceries.filter(isLingering).count
        if checked > 0 {
            Section {
                Button {
                    withAnimation(.snappy) { lingering.removeAll() }
                } label: {
                    Label(checked == 1 ? "Clear 1 checked item" : "Clear \(checked) checked items", systemImage: "checkmark.circle")
                }
                .buttonStyle(PlannerButtonStyle(kind: .quiet, size: .small))
                .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
    }

    private var emptyState: some View {
        let filtered = activeFilter != .everyone
        let hasCompleted = items.contains(where: \.isCompleted)
        let title: String
        var message: String?
        var systemImage = kind == .todo ? "checklist" : "basket"
        if filtered {
            title = "Nothing assigned to \(filterName)."
            systemImage = "person"
        } else if kind == .todo && !laterTodos.isEmpty {
            title = "Nothing due now."
            message = "The rest is in Later."
            systemImage = "moon.zzz"
        } else if hasCompleted {
            title = "All done for now."
            systemImage = "checkmark.seal"
        } else {
            title = "Nothing here yet."
            message = kind == .todo ? ListCopy.sharedNote : "\(ListCopy.sharedNote) Type “2 avocados” to include a quantity."
        }
        return EmptyState(systemImage: systemImage, title: title, message: message)
    }

    private var filterName: String {
        switch activeFilter {
        case .everyone, .mine: "you"
        case .person(let id): store.person(id)?.firstName ?? "them"
        }
    }

    @ViewBuilder private var laterSection: some View {
        let later = laterTodos
        if !later.isEmpty {
            Section {
                if showLater { ForEach(later) { openRow($0) } }
            } header: {
                DisclosureHeader(title: "Later", systemImage: "moon.zzz", count: later.count, expanded: showLater) {
                    withAnimation(.snappy) { showLater.toggle() }
                }
            }
            .plannerRows()
        }
    }

    @ViewBuilder private func completedSection(_ completed: [ListItem], alwaysExpanded: Bool = false) -> some View {
        if !completed.isEmpty {
            let expanded = showCompleted || alwaysExpanded
            Section {
                if expanded { ForEach(completed) { completedRow($0) } }
            } header: {
                if alwaysExpanded {
                    ListSectionHeader("Completed")
                } else {
                    DisclosureHeader(title: "Completed", count: completed.count, expanded: expanded) {
                        withAnimation(.snappy) { showCompleted.toggle() }
                    }
                }
            }
            .plannerRows()
        }
    }

    // MARK: Rows

    private var rowInsets: EdgeInsets { EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20) }

    /// Swipes and the context menu offer the same actions in the same order (DESIGN.md →
    /// Sheets, swipes, menus): leading Done; trailing Later, Assign / Move to To do, Delete.
    private func openRow(_ item: ListItem) -> some View {
        let isTodo = item.kind == .todo
        let checked = isLingering(item)
        return OpenItemRow(
            item: item, zone: zone,
            reminder: store.reminders(for: item.id).min { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) },
            isChecked: checked || checking.contains(item.id), isBusy: busy.contains(item.id),
            onToggle: { toggle(item) }, onOpen: { editing = item }
        ) {
            Button(checked ? "Mark not done" : "Mark done") { toggle(item) }
            if isTodo {
                Button("Later") { deferring = item }
                Button("Assign") { assigning = item }
                Button("Remind me") { reminding = item }
            } else if !checked {
                Button("Move to To do") { moveToTodo(item) }
            }
            Button("Delete") { delete(item) }
        }
        .listRowInsets(rowInsets)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { toggle(item) } label: {
                if checked { Label("Not done", systemImage: "arrow.uturn.backward") } else { Label("Done", systemImage: "checkmark") }
            }
            .tint(Color.plannerAccent)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            // Listed outermost first: Delete sits at the edge, Later furthest in.
            Button(role: .destructive) { delete(item) } label: { Label("Delete", systemImage: "trash") }
                .tint(Color.danger)
            if isTodo {
                Button { assigning = item } label: { Label("Assign", systemImage: "person") }
                    .tint(Color.muted)
                Button { deferring = item } label: { Label("Later", systemImage: "moon.zzz") }
                    .tint(Color.warning)
            } else if !checked {
                Button { moveToTodo(item) } label: { Label("Move to To do", systemImage: "checklist") }
                    .tint(Color.muted)
            }
        }
        .contextMenu {
            if checked {
                Button("Mark not done", systemImage: "arrow.uturn.backward") { toggle(item) }
            } else {
                Button("Done", systemImage: "checkmark.circle") { toggle(item) }
            }
            if isTodo {
                Button("Later…", systemImage: "moon.zzz") { deferring = item }
                Menu("Assign", systemImage: "person") {
                    Picker("Assign", selection: Binding(get: { item.assigneeId }, set: { assign(item, to: $0) })) {
                        Text("Unassigned").tag(String?.none)
                        ForEach(store.assignablePeople) { person in
                            Text(store.assigneeChoice(person)).tag(Optional(person.id))
                        }
                    }
                    .pickerStyle(.inline)
                }
                Button("Remind me", systemImage: "bell") { reminding = item }
            } else if !checked {
                Button("Move to To do", systemImage: "checklist") { moveToTodo(item) }
            }
            Button("Edit", systemImage: "pencil") { editing = item }
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) { delete(item) }
        }
    }

    private func completedRow(_ item: ListItem) -> some View {
        CompletedItemRow(item: item, zone: zone, isBusy: busy.contains(item.id)) { setCompleted(item, false) }
            .listRowInsets(rowInsets)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button { setCompleted(item, false) } label: { Label("Reopen", systemImage: "arrow.uturn.backward") }
                    .tint(Color.plannerAccent)
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { delete(item) } label: { Label("Delete", systemImage: "trash") }
                    .tint(Color.danger)
            }
            .contextMenu {
                Button("Reopen", systemImage: "arrow.uturn.backward") { setCompleted(item, false) }
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive) { delete(item) }
            }
            .accessibilityActions {
                Button("Delete") { delete(item) }
            }
    }

    private func presenting(_ binding: Binding<ListItem?>) -> Binding<Bool> {
        Binding(get: { binding.wrappedValue != nil }, set: { if !$0 { binding.wrappedValue = nil } })
    }
}

/// A run of rows under one header: a due bucket or an aisle.
struct ListGroup<Key: Hashable>: Identifiable {
    let key: Key
    let items: [ListItem]
    var id: Key { key }
}
