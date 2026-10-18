import Foundation

/// One local notification the app wants scheduled. Pure data so the schedule can
/// be computed (and tested) without `UserNotifications`.
public struct PlatformNotification: Hashable, Sendable {
    public enum Category: String, Sendable { case reminder = "planner.reminder", digest = "planner.digest", evening = "planner.evening" }

    public let identifier: String
    public let fireDate: Date
    public let title: String
    public let body: String
    public let category: Category
    public let link: String
    public let reminderId: String?
    public let revision: Int?

    public init(identifier: String, fireDate: Date, title: String, body: String, category: Category, link: String, reminderId: String?, revision: Int?) {
        self.identifier = identifier; self.fireDate = fireDate; self.title = title; self.body = body
        self.category = category; self.link = link; self.reminderId = reminderId; self.revision = revision
    }
}

/// Computes the local notification schedule from server data. The server stays
/// the source of truth: identifiers are stable per reminder id + revision, so a
/// snooze/edit elsewhere (new revision) replaces the old alert on the next sync.
public enum PlatformNotificationPlan {
    public static let reminderPrefix = "reminder."
    public static let digestPrefix = "digest."
    public static let eveningPrefix = "evening."
    /// iOS keeps at most 64 pending requests per app; leave room for digests and tests.
    public static let reminderLimit = 50

    public static func reminderIdentifier(id: String, revision: Int) -> String { "\(reminderPrefix)\(id).r\(revision)" }

    /// Whether a reminder's details must stay off the Lock Screen: its plan is
    /// private, or it belongs to a plan that isn't in `plans` (e.g. plans failed to
    /// load), so its visibility is unknown.
    public static func isPrivate(_ reminder: Reminder, plan: PlanSummary?) -> Bool {
        reminder.parentType == "plan" && (plan?.isPrivate ?? true)
    }

    /// Active reminders due in the future, soonest first. Private (or unknown)
    /// plans get a generic title so their details never show on the Lock Screen.
    public static func reminders(_ reminders: [Reminder], plans: [PlanSummary], groceryIds: Set<String> = [], timeZone: TimeZone, now: Date = .now) -> [PlatformNotification] {
        let plansById = Dictionary(plans.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return reminders
            .compactMap { reminder -> (Reminder, Date)? in
                guard reminder.isActive, let due = reminder.due, due > now else { return nil }
                return (reminder, due)
            }
            .sorted { $0.1 < $1.1 }
            .prefix(reminderLimit)
            .map { reminder, due in
                let plan = reminder.parentType == "plan" ? plansById[reminder.parentId] : nil
                let link = reminder.parentType == "plan" ? "fridgedoor://plans/\(reminder.parentId)"
                    : groceryIds.contains(reminder.parentId) ? "fridgedoor://groceries" : "fridgedoor://todos"
                let title: String, body: String
                if isPrivate(reminder, plan: plan) {
                    title = "Private reminder"
                    body = "Open Fridgedoor to see it."
                } else {
                    title = reminder.title ?? plan?.facts.title ?? "Household reminder"
                    body = plan.flatMap { describe($0.facts.time, timeZone: timeZone, now: due) }
                        ?? (reminder.parentType == "list_item" ? (groceryIds.contains(reminder.parentId) ? "On the grocery list" : "On your to-do list") : "Household reminder")
                }
                return PlatformNotification(identifier: reminderIdentifier(id: reminder.id, revision: reminder.revision), fireDate: due, title: title, body: body, category: .reminder, link: link, reminderId: reminder.id, revision: reminder.revision)
            }
    }

    /// What one day holds, for the morning and evening alerts: a count, and the first
    /// shared item. Private calendar items count but are never named, so nothing private
    /// reaches the Lock Screen.
    public struct DayOutlook: Equatable, Sendable {
        public let count: Int
        public let firstTitle: String?
        public let firstStart: Date?
        public init(count: Int, firstTitle: String?, firstStart: Date?) { self.count = count; self.firstTitle = firstTitle; self.firstStart = firstStart }
    }

    public static func outlook(for day: Date, agenda: [AgendaItem], timeZone: TimeZone) -> DayOutlook {
        let calendar = PlannerDates.calendar(timeZone)
        let onDay = agenda.compactMap { item -> (AgendaItem, Date)? in
            switch item.time {
            case let .timed(start, _, _):
                guard let s = PlannerDates.instant(start), calendar.isDate(s, inSameDayAs: day) else { return nil }
                return (item, s)
            case let .deadline(at, _):
                guard let a = PlannerDates.instant(at), calendar.isDate(a, inSameDayAs: day) else { return nil }
                return (item, a)
            case let .allDay(startDate, endDateExclusive):
                guard let s = PlannerDates.day(startDate, in: timeZone), let e = PlannerDates.day(endDateExclusive, in: timeZone),
                      calendar.startOfDay(for: day) >= s, calendar.startOfDay(for: day) < e else { return nil }
                return (item, calendar.startOfDay(for: day))
            case .unresolved:
                return nil
            }
        }.sorted { $0.1 < $1.1 }
        let first = onDay.first { $0.0.visibility == "shared" }
        let timed: Date? = first.flatMap { if case .allDay = $0.0.time { return nil }; return $0.1 }
        return DayOutlook(count: onDay.count, firstTitle: first?.0.title, firstStart: timed)
    }

    /// "3 things today. First: Soccer practice at 5:30 PM." The decisions count is what
    /// the app knew at its last sync.
    static func morningBody(_ day: DayOutlook, decisions: Int, timeZone: TimeZone) -> String {
        var parts: [String] = []
        if day.count == 0 { parts.append("Nothing on the calendar today.") }
        else {
            let things = day.count == 1 ? "1 thing today" : "\(day.count) things today"
            if let title = day.firstTitle { parts.append("\(things). First: \(title)\(day.firstStart.map { " at \(clock($0, timeZone))" } ?? "").") }
            else { parts.append("\(things).") }
        }
        if decisions > 0 { parts.append(decisions == 1 ? "1 decision waiting." : "\(decisions) decisions waiting.") }
        return parts.joined(separator: " ")
    }

    /// Suggestions waiting on a decision, counted the same way as the Decisions widget.
    public static func openDecisionCount(_ plans: [PlanSummary]) -> Int { WidgetSnapshotBuilder.openDecisions(plans).count }

    private static func clock(_ date: Date, _ timeZone: TimeZone) -> String { date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: timeZone)) }

    /// "Good morning" at `hour:minute` member time for the next `days` days, saying what
    /// the day holds. The time is part of the identifier so a new time replaces it.
    /// Concrete instants (not a repeating calendar trigger) so the alert follows the
    /// member's timezone even if the phone's differs or DST shifts.
    public static func digests(hour: Int, minute: Int, timeZone: TimeZone, now: Date = .now, days: Int = 7, agenda: [AgendaItem] = [], decisions: Int = 0) -> [PlatformNotification] {
        let calendar = PlannerDates.calendar(timeZone)
        let today = calendar.startOfDay(for: now)
        return (0...days).compactMap { offset -> PlatformNotification? in
            guard let day = calendar.date(byAdding: .day, value: offset, to: today),
                  let fire = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day), fire > now else { return nil }
            let body = morningBody(outlook(for: day, agenda: agenda, timeZone: timeZone), decisions: decisions, timeZone: timeZone)
            return PlatformNotification(identifier: "\(digestPrefix)\(PlannerDates.dayString(day, in: timeZone)).\(String(format: "%02d%02d", hour, minute))", fireDate: fire, title: "Good morning", body: body, category: .digest, link: "fridgedoor://home", reminderId: nil, revision: nil)
        }
        .prefix(days)
        .map { $0 }
    }

    /// An evening look at tomorrow, only on evenings when tomorrow has something on it.
    public static func eveningLookAheads(hour: Int = 20, minute: Int = 0, timeZone: TimeZone, now: Date = .now, days: Int = 7, agenda: [AgendaItem]) -> [PlatformNotification] {
        let calendar = PlannerDates.calendar(timeZone)
        let today = calendar.startOfDay(for: now)
        return (0..<days).compactMap { offset -> PlatformNotification? in
            guard let evening = calendar.date(byAdding: .day, value: offset, to: today),
                  let fire = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: evening), fire > now,
                  let tomorrow = calendar.date(byAdding: .day, value: 1, to: evening) else { return nil }
            let day = outlook(for: tomorrow, agenda: agenda, timeZone: timeZone)
            guard day.count > 0 else { return nil }
            let things = day.count == 1 ? "1 thing" : "\(day.count) things"
            let body = day.firstTitle.map { "\(things). First: \($0)\(day.firstStart.map { " at \(clock($0, timeZone))" } ?? "")." } ?? "\(things) on the calendar."
            return PlatformNotification(identifier: "\(eveningPrefix)\(PlannerDates.dayString(evening, in: timeZone))", fireDate: fire, title: "Tomorrow", body: body, category: .evening, link: "fridgedoor://home", reminderId: nil, revision: nil)
        }
    }

    /// "Starts at 7:00 PM", "Tomorrow at 9:30 AM", "Due today", "Sat, Oct 12".
    static func describe(_ time: NormalizedTime?, timeZone: TimeZone, now: Date) -> String? {
        guard let time else { return nil }
        let calendar = PlannerDates.calendar(timeZone)
        func day(_ date: Date) -> String {
            if calendar.isDate(date, inSameDayAs: now) { return "today" }
            if let next = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: next) { return "tomorrow" }
            return date.formatted(Date.FormatStyle(timeZone: timeZone).weekday(.abbreviated).month(.abbreviated).day())
        }
        func clock(_ date: Date) -> String { date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: timeZone)) }
        switch time {
        case let .timed(start, _, _):
            guard let s = PlannerDates.instant(start) else { return nil }
            let d = day(s)
            return d == "today" ? "Starts at \(clock(s))" : "Starts \(d) at \(clock(s))"
        case let .deadline(at, _):
            guard let a = PlannerDates.instant(at) else { return nil }
            return "Due \(day(a)) at \(clock(a))"
        case let .allDay(startDate, _):
            guard let s = PlannerDates.day(startDate, in: timeZone) else { return nil }
            let d = day(s)
            return d == "today" || d == "tomorrow" ? d.capitalized : d
        case .unresolved:
            return nil
        }
    }
}
