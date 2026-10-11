import FridgedoorKit
import SwiftUI

/// More → Plans. Ports the web `PlannerArchive`: suggestions to review, saved plans
/// outside Home's week, plans on the household calendar, and dismissed/archived ones.
/// Assistant requests live under Requests; this list only links there.
struct SavedPlansView: View {
    enum Filter: String, CaseIterable, Identifiable {
        case suggestions, saved, calendar, dismissed
        var id: String { rawValue }
        var label: String {
            switch self { case .suggestions: "To review"; case .saved: "Saved"; case .calendar: "On calendar"; case .dismissed: "Dismissed" }
        }
    }

    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store

    @State private var filter: Filter = .suggestions
    @State private var query = ""
    @State private var closed: [PlanSummary]?
    @State private var closedError: PlannerError?
    @State private var remindPlan: PlanSummary?
    @State private var dismissedCount = 0
    @State private var savedCount = 0

    var body: some View {
        List {
            Section {
                Picker("Show", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

            if let error = store.refreshError, !store.hasLoaded || store.plans.isEmpty {
                Section { ErrorBanner(message: error.userMessage) { Task { await refresh() } } }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }

            if !store.hasLoaded && filter != .dismissed {
                Section { ProgressView("Loading your plans…").frame(maxWidth: .infinity).padding() }
                    .listRowBackground(Color.clear)
            } else {
                switch filter {
                case .suggestions: suggestions
                case .saved: datedSections(savedPlans, empty: emptySaved); remindersSection
                case .calendar: datedSections(calendarPlans, empty: emptyCalendar)
                case .dismissed: dismissedSection
                }
            }
        }
        .plannerList()
        .navigationTitle("Plans")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search plans")
        .refreshable { await refresh() }
        .task(id: filter) { if filter == .dismissed { await loadClosed() } }
        .animation(.snappy, value: filter)
        .sheet(item: $remindPlan) { plan in
            ReminderEditorSheet(parentType: "plan", parentId: plan.id, title: plan.effectiveFacts.title, anchor: plan.reminderAnchor)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: dismissedCount)
        .sensoryFeedback(.success, trigger: savedCount)
    }

    // MARK: To review (web "All pending suggestions")

    /// Requests still waiting on someone: working, failed, or with items to review.
    private var pendingRunCount: Int {
        store.runs.filter { run in
            if run.state != "succeeded" { return true }
            let items = run.result?.items.indices.contains { index in
                guard let receipt = run.review(for: "item:\(index)") else { return true }
                guard let planId = receipt.planId else { return false }
                return store.plans.contains { $0.id == planId && $0.needsDecision }
            } ?? false
            let knowledge = run.result?.knowledge.indices.contains { run.review(for: "knowledge:\($0)") == nil } ?? false
            return items || knowledge
        }
        .count
    }

    /// Plans tied to a request are reviewed from that request, as on the web.
    private var pendingPlans: [PlanSummary] {
        let linked = Set(store.runs.flatMap { $0.reviews ?? [] }.compactMap(\.planId))
        return sortedByTime(store.plans.filter { $0.needsDecision && !linked.contains($0.id) && matches($0) })
    }

    @ViewBuilder
    private var suggestions: some View {
        let plans = pendingPlans, runs = query.isEmpty ? pendingRunCount : 0
        if plans.isEmpty && runs == 0 {
            emptyState(query.isEmpty ? EmptyState(systemImage: "tray", title: "Nothing to review", message: "New suggestions appear here after the next email sync or when you ask the planner.") : nil)
        } else {
            if !plans.isEmpty {
                Section {
                    ForEach(plans) { plan in planLink(plan) }
                }
                .plannerRows()
            }
            if runs > 0 {
                Section {
                    NavigationLink(value: Route.requestHistory) {
                        HStack {
                            Label("Requests", systemImage: "text.bubble")
                                .foregroundStyle(Color.ink)
                            Spacer()
                            Text("\(runs)").foregroundStyle(Color.muted)
                        }
                        .frame(minHeight: 44)
                    }
                    .accessibilityLabel("Requests, \(runs) waiting")
                }
                .plannerRows()
            }
        }
    }

    // MARK: Saved / Calendar

    private var savedPlans: [PlanSummary] { store.plans.filter { $0.isSaved && !$0.hasCalendarEvent && matches($0) } }
    private var calendarPlans: [PlanSummary] { store.plans.filter { $0.hasCalendarEvent && !$0.isClosed && matches($0) } }

    private var emptySaved: EmptyState {
        EmptyState(systemImage: "bookmark", title: "No saved plans", message: "Suggestions you save without adding to the calendar appear here.")
    }

    private var emptyCalendar: EmptyState {
        EmptyState(systemImage: "calendar", title: "Nothing on the household calendar yet", message: "Plans you add to the calendar appear here.")
    }

    @ViewBuilder
    private func datedSections(_ plans: [PlanSummary], empty: EmptyState) -> some View {
        let sections = Self.sections(plans, zone: store.timeZone)
        if sections.isEmpty {
            emptyState(query.isEmpty ? empty : nil)
        } else {
            ForEach(sections, id: \.title) { section in
                Section(section.title) {
                    ForEach(section.plans) { plan in planLink(plan, showsNeutralStatus: false) }
                }
                .plannerRows()
            }
        }
    }

    // MARK: Dismissed

    @ViewBuilder
    private var dismissedSection: some View {
        if let closed {
            let shown = closed.filter(matches)
            if shown.isEmpty {
                emptyState(query.isEmpty ? EmptyState(systemImage: "archivebox", title: "Nothing dismissed", message: "Suggestions you dismiss and events you remove from the calendar are kept here.") : nil)
            } else {
                Section {
                    ForEach(shown) { plan in planLink(plan, showsNeutralStatus: false) }
                } footer: {
                    Text("Dismissed suggestions don't come back unless their details change.")
                }
                .plannerRows()
            }
        } else if let closedError {
            Section { ErrorBanner(message: closedError.userMessage) { Task { await loadClosed() } } }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
        } else {
            Section { ProgressView().frame(maxWidth: .infinity).padding() }
                .listRowBackground(Color.clear)
        }
    }

    // MARK: Reminders (web archive "Reminders")

    @ViewBuilder
    private var remindersSection: some View {
        let active = store.reminders.filter(\.isActive).sorted { $0.dueAt < $1.dueAt }
        if !active.isEmpty && query.isEmpty {
            Section("Reminders") {
                ForEach(active) { reminder in
                    reminderRow(reminder)
                }
            }
            .plannerRows()
        }
    }

    private func reminderRow(_ reminder: Reminder) -> some View {
        let title = reminder.title ?? store.plan(reminder.parentId)?.facts.title ?? store.listItem(reminder.parentId)?.title ?? "Household reminder"
        let row = HStack(spacing: 12) {
            Image(systemName: "bell").foregroundStyle(Color.plannerAccent)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Color.ink)
                if let due = reminder.due {
                    Text("\(TimeLabels.relativeDay(due, in: store.timeZone)) · \(TimeLabels.time(due, in: store.timeZone))")
                        .font(.caption).foregroundStyle(Color.muted)
                }
            }
        }
        .frame(minHeight: 44)
        return Group {
            if reminder.parentType == "plan" {
                NavigationLink(value: Route.plan(reminder.parentId)) { row }
            } else {
                row
            }
        }
        .swipeActions(edge: .leading) {
            Button("Done", systemImage: "checkmark") { reminderAction { try await store.completeReminder(reminder) } }
                .tint(Color.plannerAccent)
        }
        .swipeActions(edge: .trailing) {
            Button("Cancel reminder", systemImage: "bell.slash", role: .destructive) { reminderAction { try await store.cancelReminder(reminder) } }
            Button("Snooze 15 minutes", systemImage: "moon.zzz") {
                reminderAction { try await store.snoozeReminder(reminder, until: .now.addingTimeInterval(15 * 60)) }
            }
            .tint(Color.warning)
        }
    }

    // MARK: Rows

    /// Suggestions swipe like everywhere else (DESIGN.md → Swipes): leading Save, trailing
    /// Dismiss with Undo. Settled plans offer Remind me.
    private func planLink(_ plan: PlanSummary, showsNeutralStatus: Bool = true) -> some View {
        let canSave = plan.isOpenSuggestion && plan.savedInPlanner != true && plan.calendarAction == nil
        let canDismiss = plan.canEdit && plan.calendarAction == nil
        return NavigationLink(value: Route.plan(plan.id)) { PlanRow(plan: plan, showsNeutralStatus: showsNeutralStatus) }
            .swipeActions(edge: .leading) {
                if canSave {
                    Button("Save", systemImage: "bookmark") { save(plan) }
                        .tint(Color.plannerAccent)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if canDismiss {
                    Button("Dismiss", systemImage: "eye.slash") { dismissPlan(plan) }
                        .tint(Color.muted)
                }
                if !plan.isClosed {
                    Button("Remind me", systemImage: "bell") { remindPlan = plan }
                        .tint(Color.plannerAccent)
                }
            }
            .contextMenu {
                if canSave {
                    Button("Save", systemImage: "bookmark") { save(plan) }
                }
                if !plan.isClosed {
                    Button("Remind me", systemImage: "bell") { remindPlan = plan }
                }
                ShareLink(item: PlanText.summary(plan.effectiveFacts, in: store.timeZone), preview: SharePreview(plan.effectiveFacts.title)) {
                    Label("Share…", systemImage: "square.and.arrow.up")
                }
                if canDismiss {
                    Button("Dismiss", systemImage: "eye.slash") { dismissPlan(plan) }
                }
            }
    }

    @ViewBuilder
    private func emptyState(_ state: EmptyState?) -> some View {
        Section {
            if let state {
                state
            } else {
                ContentUnavailableView.search(text: query)
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    // MARK: Data

    private func refresh() async {
        await store.refresh([.plans, .runs, .reminders, .connection, .destination])
        if filter == .dismissed { await loadClosed() }
    }

    private func loadClosed() async {
        do { closed = try await store.closedPlans(); closedError = nil }
        catch { if closed == nil { closedError = error as? PlannerError ?? .decoding } }
    }

    private func dismissPlan(_ plan: PlanSummary) {
        store.dismissWithUndo(plan, app: app)
        dismissedCount += 1
        closed = nil
    }

    private func save(_ plan: PlanSummary) {
        Task {
            do {
                try await store.decide(plan, choice: "keep")
                savedCount += 1
                app.show("Saved “\(plan.effectiveFacts.title)”.")
            } catch {
                app.showPlanError(error)
            }
        }
    }

    private func reminderAction(_ work: @escaping () async throws -> Void) {
        Task { do { try await work() } catch { app.showPlanError(error) } }
    }

    // MARK: Search & grouping

    private func matches(_ plan: PlanSummary) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return true }
        let facts = plan.effectiveFacts
        let haystack = [facts.title, facts.category, facts.location ?? "", facts.notes ?? ""] + facts.participants + facts.preparationTasks
        return haystack.contains { $0.localizedStandardContains(needle) }
    }

    private func sortedByTime(_ plans: [PlanSummary]) -> [PlanSummary] {
        plans.sorted { a, b in
            switch (a.effectiveFacts.time?.anchor(in: store.timeZone), b.effectiveFacts.time?.anchor(in: store.timeZone)) {
            case let (x?, y?): x < y
            case (.some, nil): true
            case (nil, .some): false
            case (nil, nil): a.updatedAt > b.updatedAt
            }
        }
    }

    struct DateSection { let title: String; let plans: [PlanSummary] }

    /// Upcoming days in order, then "Earlier" (most recent first), then "No date yet".
    static func sections(_ plans: [PlanSummary], zone: TimeZone, now: Date = .now) -> [DateSection] {
        let calendar = PlannerDates.calendar(zone)
        let today = calendar.startOfDay(for: now)
        var upcoming: [Date: [(Date, PlanSummary)]] = [:]
        var earlier: [(Date, PlanSummary)] = []
        var undated: [PlanSummary] = []
        for plan in plans {
            guard let anchor = plan.effectiveFacts.time?.anchor(in: zone) else { undated.append(plan); continue }
            let day = calendar.startOfDay(for: anchor)
            if day >= today { upcoming[day, default: []].append((anchor, plan)) } else { earlier.append((anchor, plan)) }
        }
        var sections = upcoming.keys.sorted().map { day in
            DateSection(title: TimeLabels.relativeDay(day, in: zone, now: now), plans: upcoming[day]!.sorted { $0.0 < $1.0 }.map(\.1))
        }
        if !earlier.isEmpty { sections.append(DateSection(title: "Earlier", plans: earlier.sorted { $0.0 > $1.0 }.map(\.1))) }
        if !undated.isEmpty { sections.append(DateSection(title: "No date yet", plans: undated.sorted { $0.updatedAt > $1.updatedAt })) }
        return sections
    }
}
