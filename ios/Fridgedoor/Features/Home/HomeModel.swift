import Foundation
import FridgedoorKit

/// Pure derivations for Home, mirroring `web/src/features/Home/Home.tsx` and
/// `schedule-time.ts`. Everything is computed in the member's timezone.
enum HomeSchedule {
    /// The instant a time sorts by (`scheduleStart` on the web).
    static func start(_ time: NormalizedTime?, in zone: TimeZone) -> Date? {
        switch time {
        case let .timed(start, _, _)?: PlannerDates.instant(start)
        case let .deadline(at, _)?: PlannerDates.instant(at)
        case let .allDay(startDate, _)?: PlannerDates.day(startDate, in: zone)
        case let .unresolved(dateHint, startHint, _)?: PlannerDates.instant(startHint) ?? PlannerDates.day(dateHint, in: zone)
        case nil: nil
        }
    }

    /// Whether any part of `time` falls in `[start, end)` (`inScheduleRange` on the web).
    static func inRange(_ time: NormalizedTime?, from start: Date, to end: Date, in zone: TimeZone) -> Bool {
        guard let from = self.start(time, in: zone) else { return false }
        switch time {
        case let .timed(_, endValue, _)?:
            guard let to = PlannerDates.instant(endValue) else { return false }
            return from < end && to > start
        case let .allDay(_, endDateExclusive)?:
            guard let to = PlannerDates.day(endDateExclusive, in: zone) else { return false }
            return from < end && to > start
        default:
            return from >= start && from < end
        }
    }

    /// A to-do's reminder date as a schedule time: a calendar date is all-day, an instant is a deadline.
    static func taskTime(_ dueTime: String, in zone: TimeZone) -> NormalizedTime {
        if dueTime.count == 10, let day = PlannerDates.day(dueTime, in: zone),
           let next = PlannerDates.calendar(zone).date(byAdding: .day, value: 1, to: day) {
            return .allDay(startDate: dueTime, endDateExclusive: PlannerDates.dayString(next, in: zone))
        }
        return .deadline(at: dueTime, timezone: zone.identifier)
    }
}

/// One row of the day timeline.
struct AgendaEntry: Identifiable, Hashable {
    enum Source: Hashable {
        case calendar(AgendaItem)
        case plan(PlanSummary)
        case task(ListItem)
    }

    let id: String
    let source: Source
    let title: String
    let time: NormalizedTime
    let origin: String
    let location: String?
    /// Navigation identities this row represents (`calendar:<id>`, `plan:<id>`, `task:<id>`),
    /// used to avoid repeating routine review cards.
    let identities: Set<String>
    var isTentative = false
    /// A dated to-do from an earlier day that is still open (shown on Today only).
    var isCarriedOver = false

    var planId: String? {
        switch source {
        case .calendar(let item): item.planId
        case .plan(let plan): plan.id
        case .task: nil
        }
    }

    var task: ListItem? { if case .task(let item) = source { item } else { nil } }
    var isHouseholdCalendar: Bool { if case .calendar(let item) = source { item.visibility == "shared" } else { false } }
}

/// Everything Home shows for one selected day.
struct HomeSnapshot {
    let today: Date
    let day: Date
    let isToday: Bool
    let schedule: [AgendaEntry]
    let attention: [DailyOverviewItem]
    let routine: [DailyOverviewItem]
    let upcoming: [DailyOverviewItem]
    let reminders: [Reminder]
    let clarifications: [Clarification]
    /// Requests with proposals nobody has decided on yet (shown on today's Decisions).
    let pendingRequests: [AssistantRun]
    /// Day starts (the seven-day strip) that have at least one scheduled entry.
    let daysWithPlans: Set<Date>
    /// How many scheduled entries each day of the strip has (for its busyness dots).
    let dayLoad: [Date: Int]
    let days: [Date]
    /// Clarifications folded into a plan row that already asks for the same missing fact.
    let answeredByDecision: Set<String>

    @MainActor
    init(store: PlannerStore, selectedDay: Date?, now: Date) {
        let zone = store.timeZone
        let calendar = store.calendar
        let today = calendar.startOfDay(for: now)
        let days = (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
        let day = selectedDay.flatMap { selected in days.first { calendar.isDate($0, inSameDayAs: selected) } } ?? today
        let dayEnd = calendar.date(byAdding: .day, value: 1, to: day) ?? day
        let dayString = PlannerDates.dayString(day, in: zone)
        let isToday = day == today
        self.today = today
        self.day = day
        self.isToday = isToday
        self.days = days

        // Calendar events, kept/accepted plans not already on the calendar, and dated open to-dos.
        let saved = store.plans.filter { plan in
            (plan.savedInPlanner == true || plan.calendarAction?.state == "succeeded" || ["update", "cancel"].contains(plan.calendarAction?.kind ?? ""))
                && !["dismissed", "archived"].contains(plan.status)
        }
        var events: [AgendaEntry] = store.agenda.map { item in
            AgendaEntry(
                id: "calendar:\(item.id)", source: .calendar(item), title: item.title, time: item.time,
                origin: item.origin.prefix(1).uppercased() + item.origin.dropFirst(), location: item.location,
                identities: Set(["calendar:\(item.id)"] + (item.planId.map { ["plan:\($0)"] } ?? [])),
                isTentative: item.status == "tentative"
            )
        }
        events += saved.filter { plan in !store.agenda.contains { $0.planId == plan.id } }.compactMap { plan in
            guard let time = plan.facts.time else { return nil }
            let origin = plan.calendarAction?.state == "succeeded" ? "Household calendar" : "Saved in planner\(plan.isPrivate ? " · Only you" : "")"
            return AgendaEntry(id: "plan:\(plan.id)", source: .plan(plan), title: plan.facts.title, time: time, origin: origin, location: plan.facts.location, identities: ["plan:\(plan.id)"])
        }
        let openDated = store.todos.filter { !$0.isCompleted && $0.dueTime != nil }
        func taskEntry(_ todo: ListItem, carriedOver: Bool = false) -> AgendaEntry {
            AgendaEntry(id: "task:\(todo.id)", source: .task(todo), title: todo.title, time: HomeSchedule.taskTime(todo.dueTime!, in: zone),
                        origin: "To do", location: nil, identities: ["task:\(todo.id)"], isCarriedOver: carriedOver)
        }
        // A snoozed to-do shows again from its snooze date (inclusive).
        let datedTasks = openDated.map { (snoozedUntil: $0.snoozedUntil ?? "", entry: taskEntry($0)) }
        func tasks(on date: String) -> [AgendaEntry] { datedTasks.filter { $0.snoozedUntil <= date }.map(\.entry) }
        let tasksForDay = tasks(on: dayString)

        // Chronological; ties keep calendar items before to-dos, then alphabetical, so rows never jitter between refreshes.
        let sortKey = { (entry: AgendaEntry) in HomeSchedule.start(entry.time, in: zone)?.timeIntervalSince1970 ?? 0 }
        let ordered = { (a: AgendaEntry, b: AgendaEntry) -> Bool in
            let (ka, kb) = (sortKey(a), sortKey(b))
            if ka != kb { return ka < kb }
            if (a.task == nil) != (b.task == nil) { return a.task == nil }
            return (a.title, a.id) < (b.title, b.id)
        }
        var schedule = (events + tasksForDay)
            .filter { HomeSchedule.inRange($0.time, from: day, to: dayEnd, in: zone) }
            .sorted(by: ordered)
        // Undated-time to-dos ("any time today") read better after the timed plan than before 6 AM.
        let anytime = schedule.filter { entry in entry.task != nil && { if case .allDay = entry.time { true } else { false } }() }
        schedule = schedule.filter { entry in !anytime.contains(entry) } + anytime
        if isToday {
            // Open to-dos whose date has passed stay visible until done, snoozed or deleted.
            let todayString = PlannerDates.dayString(today, in: zone)
            let carried = openDated
                .filter { ($0.snoozedUntil ?? "") <= todayString }
                .map { taskEntry($0, carriedOver: true) }
                .filter { entry in (HomeSchedule.start(entry.time, in: zone) ?? today) < today && !HomeSchedule.inRange(entry.time, from: day, to: dayEnd, in: zone) }
                .sorted(by: ordered)
            schedule = carried + schedule
        }
        self.schedule = schedule

        var load: [Date: Int] = [:]
        for candidate in days {
            let end = calendar.date(byAdding: .day, value: 1, to: candidate) ?? candidate
            let candidateEvents = events + tasks(on: PlannerDates.dayString(candidate, in: zone))
            load[candidate] = candidateEvents.filter { HomeSchedule.inRange($0.time, from: candidate, to: end, in: zone) }.count
        }
        dayLoad = load
        daysWithPlans = Set(load.filter { $0.value > 0 }.keys)

        // Reminders: today includes anything already due; other days only that day's.
        let relevant = store.reminders.filter { reminder in
            guard reminder.isActive, let due = reminder.due else { return false }
            if reminder.parentType == "list_item", store.todos.contains(where: { $0.id == reminder.parentId }) { return false }
            return isToday ? due < dayEnd : (due >= day && due < dayEnd)
        }.sorted { ($0.due ?? .distantPast) < ($1.due ?? .distantPast) }
        reminders = relevant

        // Morning review. Attention = an unresolved decision or consequential deadline.
        let reviews = store.dailyOverview?.items ?? []
        let represented = Set(schedule.flatMap(\.identities) + (isToday ? relevant.map { "reminder:\($0.id)" } : []))
        // A plan decided or dismissed elsewhere (or awaiting its Undo window) drops out of the review.
        let plansLoaded = store.loadedParts.contains(.plans)
        let live = { (item: DailyOverviewItem) -> Bool in
            guard plansLoaded, let id = item.planTargetId else { return true }
            guard let plan = store.plan(id) else { return false }
            return !plan.isClosed && store.pendingDismissals[id] == nil
        }
        let attention = reviews.filter { $0.needsAttention && live($0) }
        self.attention = attention
        routine = reviews.filter { item in
            !item.needsAttention && item.category == "today"
                && !((item.targets ?? []).isEmpty == false && (item.targets ?? []).allSatisfy { represented.contains("\($0.kind):\($0.id)") })
        }
        upcoming = reviews.filter { !$0.needsAttention && $0.category != "today" }
        // A question that asks for the start time a "Set time" row already asks for isn't shown twice.
        let timeRows = attention.filter { item in item.planTargetId.flatMap(store.plan).map { store.decision(for: $0).primary == .setTime } ?? false }
        let timeRefs = Set(timeRows.flatMap { ($0.sourceRefs ?? []) + $0.refs })
        let open = store.clarifications.filter { $0.state == "open" }
        let folded = open.filter { !Set($0.sourceRefs ?? []).isDisjoint(with: timeRefs) }
        let foldedIds = Set(folded.map(\.id))
        answeredByDecision = foldedIds
        clarifications = open.filter { !foldedIds.contains($0.id) }
        pendingRequests = store.runsNeedingReview
    }

    /// Everything waiting on a decision today: brief items, questions and requests.
    var decisionCount: Int { attention.count + clarifications.count + pendingRequests.count }

    /// What's happening now or next on today's schedule, for the greeting's glance line.
    @MainActor
    func nextUp(after now: Date, zone: TimeZone) -> AgendaEntry? {
        guard isToday else { return nil }
        return schedule.first { entry in
            guard case let .timed(_, end, _) = entry.time, let date = PlannerDates.instant(end) else { return false }
            return date > now
        }
    }

    /// The server's summary, unless it is the placeholder left after a dismissal.
    @MainActor
    static func summary(_ view: DailyView?) -> String? {
        guard let view, view.state == "ready", let summary = view.result?.summary.nilIfBlank,
              !["Your remaining morning review.", "Your morning review"].contains(summary) else { return nil }
        return summary
    }
}

extension DailyOverviewItem {
    var needsAttention: Bool { category == "decision" || category == "deadline" }
    /// Task suggestions are resolved with Done / Later / Delete, never dismissed.
    var isTask: Bool { targets?.contains { $0.kind == "task" } ?? false }
    var planTargetId: String? { targets?.first { $0.kind == "plan" }?.id }

    var categoryLabel: String {
        switch category {
        case "decision": "Decision"
        case "deadline": "Deadline"
        case "change": "Changed"
        case "prepare": "Prepare"
        case "today": "Today"
        default: "Coming up"
        }
    }

    var categorySymbol: String {
        switch category {
        case "decision": "questionmark.circle"
        case "deadline": "clock.badge.exclamationmark"
        case "change": "arrow.triangle.2.circlepath"
        case "prepare": "checklist"
        case "today": "sun.max"
        default: "calendar"
        }
    }
}
