import Foundation

/// Builds the widget's small "today" snapshot from the app's household data.
/// Covers today and tomorrow (member timezone) so the widget can roll over at
/// midnight without the app running.
public enum WidgetSnapshotBuilder {
    public static let maxEntries = 24

    public static let maxListRows = 24
    public static let maxDecisions = 6

    /// `googleReady`: Google connected with a household calendar chosen, so "Add to calendar"
    /// can be offered from the widget. `household` names other people's to-dos.
    public static func build(member: Member, plans: [PlanSummary], agenda: [AgendaItem], todos: [ListItem], groceries: [ListItem], reminders: [Reminder],
                             household: [HouseholdPerson] = [], googleReady: Bool = false, now: Date = .now) -> WidgetSnapshot {
        let zone = member.timeZone
        let calendar = PlannerDates.calendar(zone)
        let today = calendar.startOfDay(for: now)
        let days = [today, calendar.date(byAdding: .day, value: 1, to: today)].compactMap { $0 }
        guard let windowEnd = calendar.date(byAdding: .day, value: 2, to: today) else {
            return WidgetSnapshot(generatedAt: now, memberName: member.firstName, timezone: member.timezone, entries: [], attentionCount: 0, openTodoCount: 0, openGroceryCount: 0)
        }
        let inWindow = { (time: NormalizedTime) in days.contains { time.occurs(onDayStarting: $0, in: zone) } }
        var entries: [WidgetSnapshot.Entry] = []

        for item in agenda where inWindow(item.time) {
            guard let entry = entry(id: "agenda:\(item.id)", title: item.title, time: item.time, zone: zone, kind: "event",
                                    link: item.planId.map { "fridgedoor://plans/\($0)" } ?? "fridgedoor://home",
                                    isPrivate: item.visibility != "shared") else { continue }
            entries.append(entry)
        }

        // Plans kept in the planner without a calendar event aren't on the agenda.
        let agendaPlanIds = Set(agenda.compactMap(\.planId))
        for plan in plans where plan.status == "accepted" && !agendaPlanIds.contains(plan.id) {
            guard let time = plan.facts.time, inWindow(time),
                  let entry = entry(id: "plan:\(plan.id)", title: plan.facts.title, time: time, zone: zone, kind: "event", link: "fridgedoor://plans/\(plan.id)", isPrivate: plan.isPrivate) else { continue }
            entries.append(entry)
        }

        for item in todos where !item.isCompleted {
            guard let raw = item.dueTime, let due = PlannerDates.taskDate(raw, in: zone), due < windowEnd else { continue }
            let allDay = raw.count == 10
            // Overdue dated to-dos stay on today's list until they're done.
            let start = due < today ? today : due
            entries.append(.init(id: "todo:\(item.id)", title: item.title, start: start, end: nil, allDay: allDay || due < today, kind: "task", link: "fridgedoor://todos", isPrivate: false))
        }

        let plansById = Dictionary(plans.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let groceryIds = Set(groceries.map(\.id))
        for reminder in reminders where reminder.isActive {
            guard let due = reminder.due, due > now, due < windowEnd else { continue }
            let onPlan = reminder.parentType == "plan"
            let plan = onPlan ? plansById[reminder.parentId] : nil
            let link = onPlan ? "fridgedoor://plans/\(reminder.parentId)" : groceryIds.contains(reminder.parentId) ? "fridgedoor://groceries" : "fridgedoor://todos"
            entries.append(.init(id: "reminder:\(reminder.id)", title: reminder.title ?? plan?.facts.title ?? "Reminder", start: due, end: nil, allDay: false, kind: "reminder", link: link,
                                 isPrivate: PlatformNotificationPlan.isPrivate(reminder, plan: plan)))
        }

        entries.sort(by: WidgetSnapshot.order(in: calendar))
        return WidgetSnapshot(
            generatedAt: now,
            memberName: member.firstName,
            timezone: member.timezone,
            entries: Array(entries.prefix(maxEntries)),
            attentionCount: openDecisions(plans).count,
            openTodoCount: todos.filter { !$0.isCompleted }.count,
            openGroceryCount: groceries.filter { !$0.isCompleted }.count,
            groceries: groceryRows(groceries, zone: zone),
            todos: todoRows(todos, member: member, household: household, now: now),
            decisions: decisionRows(plans, googleReady: googleReady, zone: zone, now: now)
        )
    }

    /// Open groceries in store-walk (aisle) order, oldest first within an aisle.
    static func groceryRows(_ groceries: [ListItem], zone: TimeZone) -> [WidgetSnapshot.ListRow] {
        let open = groceries.openOrdered(in: zone)
        let order = Dictionary(uniqueKeysWithValues: GroceryAisle.allCases.enumerated().map { ($1, $0) })
        return open.enumerated()
            .sorted { a, b in
                let (x, y) = (order[GroceryAisle.of(a.element.title)] ?? 0, order[GroceryAisle.of(b.element.title)] ?? 0)
                return x != y ? x < y : a.offset < b.offset
            }
            .prefix(maxListRows)
            .map { .init(id: $0.element.id, title: $0.element.title, detail: $0.element.quantity, section: GroceryAisle.of($0.element.title).title) }
    }

    /// Open to-dos not pushed to Later: overdue, today, coming up, then undated.
    static func todoRows(_ todos: [ListItem], member: Member, household: [HouseholdPerson], now: Date) -> [WidgetSnapshot.ListRow] {
        let zone = member.timeZone
        let calendar = PlannerDates.calendar(zone)
        return todos.openOrdered(in: zone)
            .filter { !$0.isSnoozed(in: zone, now: now) }
            .prefix(maxListRows)
            .map { item in
                let state = item.dueState(in: zone, now: now)
                let detail: String?
                let section: String
                switch state {
                case .overdue: (detail, section) = ("Overdue", "Overdue")
                case .today: (detail, section) = ("Today", "Today")
                case .upcoming:
                    let due = item.dueDate(in: zone) ?? now
                    let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)).map { calendar.isDate(due, inSameDayAs: $0) } ?? false
                    (detail, section) = (tomorrow ? "Tomorrow" : due.formatted(Date.FormatStyle(timeZone: zone).weekday(.abbreviated).month(.abbreviated).day()), "Coming up")
                case .none: (detail, section) = (nil, "No date")
                }
                let assignee = item.assigneeId.flatMap { id in id == member.id ? nil : household.first { $0.id == id }.map { String($0.displayName.prefix(1)).uppercased() } }
                return .init(id: item.id, title: item.title, detail: detail, section: section, overdue: state == .overdue, assignee: assignee)
            }
    }

    /// Suggestions still waiting on a decision (what the Decisions widget and counts show).
    static func openDecisions(_ plans: [PlanSummary]) -> [PlanSummary] {
        plans.filter(isWaiting)
    }

    /// A suggestion nobody has saved, added to the calendar or dismissed yet.
    static func isWaiting(_ plan: PlanSummary) -> Bool {
        plan.isOpenSuggestion && plan.needsDecision && plan.calendarAction == nil
    }

    /// Suggestions still waiting on a decision, soonest first, with what one tap can do.
    static func decisionRows(_ plans: [PlanSummary], googleReady: Bool, zone: TimeZone, now: Date) -> [WidgetSnapshot.DecisionRow] {
        let open = openDecisions(plans)
        let start = { (plan: PlanSummary) in plan.effectiveFacts.time.flatMap { WidgetSnapshot.sortDate($0, zone: zone) } ?? .distantFuture }
        return open.sorted { start($0) < start($1) }.prefix(maxDecisions).map { decisionRow($0, googleReady: googleReady, zone: zone, now: now) }
    }

    /// One suggestion as a row, with what one tap can do (the widget and the watch).
    static func decisionRow(_ plan: PlanSummary, googleReady: Bool, zone: TimeZone, now: Date) -> WidgetSnapshot.DecisionRow {
        let facts = plan.effectiveFacts
        let action: WidgetSnapshot.DecisionRow.Action?
        if plan.canAddToCalendar && googleReady && !plan.isPrivate {
            action = .calendar
        } else if facts.time.map({ !$0.isCalendarReady && !$0.isDeadline }) ?? true {
            action = nil // Needs a date or time: decided in the app ("Set time").
        } else {
            action = plan.savedInPlanner == true ? nil : .keep
        }
        return .init(id: plan.id, title: facts.title, detail: WidgetSnapshot.label(facts.time, zone: zone, now: now), action: action, isPrivate: plan.isPrivate)
    }

    private static func entry(id: String, title: String, time: NormalizedTime, zone: TimeZone, kind: String, link: String, isPrivate: Bool) -> WidgetSnapshot.Entry? {
        switch time {
        case let .timed(start, end, _):
            guard let s = PlannerDates.instant(start) else { return nil }
            return .init(id: id, title: title, start: s, end: PlannerDates.instant(end), allDay: false, kind: kind, link: link, isPrivate: isPrivate)
        case let .allDay(startDate, endDateExclusive):
            guard let s = PlannerDates.day(startDate, in: zone) else { return nil }
            return .init(id: id, title: title, start: s, end: PlannerDates.day(endDateExclusive, in: zone), allDay: true, kind: kind, link: link, isPrivate: isPrivate)
        case let .deadline(at, _):
            guard let s = PlannerDates.instant(at) else { return nil }
            return .init(id: id, title: title, start: s, end: nil, allDay: false, kind: "task", link: link, isPrivate: isPrivate)
        case .unresolved:
            return nil
        }
    }
}

public extension WidgetSnapshot {
    var timeZone: TimeZone { TimeZone(identifier: timezone) ?? .current }
    var calendar: Calendar { PlannerDates.calendar(timeZone) }

    /// By day; within a day, all-day items and dated to-dos first, then by start time.
    static func order(in calendar: Calendar) -> (Entry, Entry) -> Bool {
        { a, b in
            let da = a.start ?? .distantFuture, db = b.start ?? .distantFuture
            let dayA = calendar.startOfDay(for: da), dayB = calendar.startOfDay(for: db)
            if dayA != dayB { return dayA < dayB }
            if a.allDay != b.allDay { return a.allDay }
            if da != db { return da < db }
            return a.title.localizedCompare(b.title) == .orderedAscending
        }
    }

    /// Whether `entry` belongs to the local day starting at `day`.
    func entry(_ entry: Entry, isOn day: Date) -> Bool {
        guard let start = entry.start, let next = calendar.date(byAdding: .day, value: 1, to: day) else { return false }
        if entry.allDay {
            // Open dated to-dos stay listed (as overdue) until they're done.
            let end = entry.end ?? (entry.kind == "task" ? .distantFuture : calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: start)) ?? next)
            return start < next && end > day
        }
        return start >= day && start < next
    }

    /// What's still ahead on the local day of `date`: all-day items and dated
    /// to-dos stay all day; events drop off once they end, reminders once due.
    func remaining(at date: Date) -> [Entry] {
        let day = calendar.startOfDay(for: date)
        return entries.filter { entry in
            guard self.entry(entry, isOn: day) else { return false }
            if entry.allDay || entry.kind == "task" { return true }
            guard let start = entry.start else { return false }
            return (entry.end ?? start) > date
        }
    }

    /// The first item on a later day, for "Nothing else today · Tomorrow …".
    func nextLater(than date: Date) -> Entry? {
        guard let next = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: date)) else { return nil }
        return entries.first { self.entry($0, isOn: next) && ($0.start ?? .distantPast) >= next }
    }

    /// Instants at which the widget's content changes: as events end, reminders
    /// pass, and at midnight. Always starts with `date`.
    func timelineDates(from date: Date, horizon: TimeInterval = 36 * 3600) -> [Date] {
        let limit = date.addingTimeInterval(horizon)
        var dates: Set<Date> = [date]
        for entry in entries where !entry.allDay && entry.kind != "task" {
            if let change = entry.end ?? entry.start, change > date, change < limit { dates.insert(change) }
        }
        var midnight = calendar.startOfDay(for: date)
        while let next = calendar.date(byAdding: .day, value: 1, to: midnight), next < limit {
            dates.insert(next); midnight = next
        }
        return dates.sorted()
    }

    /// Data older than this is labeled as possibly out of date.
    func isStale(at date: Date) -> Bool { date.timeIntervalSince(generatedAt) > 6 * 3600 }

    /// Snapshot equality ignoring `generatedAt`, so unchanged data doesn't spend widget reloads.
    func sameContent(as other: WidgetSnapshot?) -> Bool {
        guard let other else { return false }
        return entries == other.entries && memberName == other.memberName && timezone == other.timezone
            && attentionCount == other.attentionCount && openTodoCount == other.openTodoCount && openGroceryCount == other.openGroceryCount
            && groceries == other.groceries && todos == other.todos && decisions == other.decisions && lastChecked == other.lastChecked
    }

    /// The widget Undo stays offered this long after a check-off.
    static let undoWindow: TimeInterval = 10 * 60

    /// The last widget check-off, while it can still be undone.
    func undoable(at date: Date) -> Checked? {
        guard let lastChecked, date.timeIntervalSince(lastChecked.at) < Self.undoWindow else { return nil }
        return lastChecked
    }

    /// A copy with an item checked off (removed from its list, offered for Undo) or
    /// put back, so the widget updates before the next full refresh.
    func checking(_ id: String, kind: String, done: Bool, at date: Date = .now) -> WidgetSnapshot {
        var groceries = groceries, todos = todos
        var checked = lastChecked
        if done {
            let row = (kind == "grocery" ? groceries : todos)?.first { $0.id == id }
            if kind == "grocery" { groceries?.removeAll { $0.id == id } } else { todos?.removeAll { $0.id == id } }
            if let row { checked = Checked(id: id, title: row.title, kind: kind, at: date) }
        } else if checked?.id == id {
            checked = nil
        }
        let groceryDelta = kind == "grocery" ? (done ? -1 : 1) : 0
        let todoDelta = kind == "todo" ? (done ? -1 : 1) : 0
        return WidgetSnapshot(generatedAt: generatedAt, memberName: memberName, timezone: timezone, entries: done ? entries.filter { $0.id != "todo:\(id)" } : entries,
                              attentionCount: attentionCount, openTodoCount: max(0, openTodoCount + todoDelta), openGroceryCount: max(0, openGroceryCount + groceryDelta),
                              groceries: groceries, todos: todos, decisions: decisions, lastChecked: checked)
    }

    /// A copy without a decided suggestion.
    func deciding(_ planId: String) -> WidgetSnapshot {
        WidgetSnapshot(generatedAt: generatedAt, memberName: memberName, timezone: timezone, entries: entries, attentionCount: max(0, attentionCount - 1),
                       openTodoCount: openTodoCount, openGroceryCount: openGroceryCount, groceries: groceries, todos: todos,
                       decisions: decisions?.filter { $0.id != planId }, lastChecked: lastChecked)
    }

    /// Carries a still-fresh widget check-off over into a rebuilt snapshot.
    func keepingCheck(from previous: WidgetSnapshot?, at date: Date = .now) -> WidgetSnapshot {
        var copy = self
        copy.lastChecked = previous?.undoable(at: date)
        return copy
    }

    static func sortDate(_ time: NormalizedTime, zone: TimeZone) -> Date? {
        switch time {
        case let .timed(start, _, _): PlannerDates.instant(start)
        case let .allDay(startDate, _): PlannerDates.day(startDate, in: zone)
        case let .deadline(at, _): PlannerDates.instant(at)
        case let .unresolved(dateHint, startHint, _): PlannerDates.instant(startHint) ?? PlannerDates.day(dateHint, in: zone)
        }
    }

    /// Short when-label for a suggestion: "Today · 3:30 PM", "Due Fri · 8:00 AM", "Fri, Oct 16 · needs a time".
    static func label(_ time: NormalizedTime?, zone: TimeZone, now: Date) -> String {
        let calendar = PlannerDates.calendar(zone)
        func day(_ date: Date) -> String {
            if calendar.isDate(date, inSameDayAs: now) { return "Today" }
            if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) { return "Tomorrow" }
            return date.formatted(Date.FormatStyle(timeZone: zone).weekday(.abbreviated).month(.abbreviated).day())
        }
        func clock(_ date: Date) -> String { date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone)) }
        switch time {
        case let .timed(start, _, _)?:
            guard let s = PlannerDates.instant(start) else { return "Needs a time" }
            return "\(day(s)) · \(clock(s))"
        case let .allDay(startDate, _)?:
            return PlannerDates.day(startDate, in: zone).map { "\(day($0)) · All day" } ?? "All day"
        case let .deadline(at, _)?:
            return PlannerDates.instant(at).map { "Due \(day($0).lowercasedIfRelative) · \(clock($0))" } ?? "Deadline"
        case let .unresolved(dateHint, _, _)?:
            return PlannerDates.day(dateHint, in: zone).map { "\(day($0)) · needs a time" } ?? "Needs a date and time"
        case nil:
            return "Needs a date and time"
        }
    }
}

private extension String {
    var lowercasedIfRelative: String { ["Today", "Tomorrow"].contains(self) ? lowercased() : self }
}
