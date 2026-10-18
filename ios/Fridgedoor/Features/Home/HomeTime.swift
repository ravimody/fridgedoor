import Foundation
import FridgedoorKit

/// Compact time labels for Home rows, in the member's timezone. The selected day
/// is already shown by the day picker, so rows say "7:45 – 8:15 AM", not the date.
enum HomeTime {
    /// Left column of the timeline ("7:45 AM", "All day", "Earlier").
    static func column(_ entry: AgendaEntry, day: Date, in zone: TimeZone) -> String {
        if entry.isCarriedOver { return "Earlier" }
        if entry.task != nil, entry.time.isAllDay { return "Any time" }
        switch entry.time {
        case let .timed(start, _, _):
            guard let s = PlannerDates.instant(start) else { return "Any time" }
            return s < day ? "Cont." : TimeLabels.time(s, in: zone)
        case .allDay: return "All day"
        case let .deadline(at, _):
            guard let date = PlannerDates.instant(at) else { return "Any time" }
            return isMidnight(date, in: zone) ? "Any time" : TimeLabels.time(date, in: zone)
        case .unresolved: return "Time open"
        }
    }

    /// Detail line under a timeline title.
    static func detail(_ entry: AgendaEntry, day: Date, in zone: TimeZone) -> String? {
        let calendar = PlannerDates.calendar(zone)
        if entry.isCarriedOver, let start = HomeSchedule.start(entry.time, in: zone) {
            return "Planned for \(inSentence(TimeLabels.relativeDay(start, in: zone)))"
        }
        // A dated to-do's date is a reminder date, not a time slot.
        if entry.task != nil, entry.time.isAllDay { return nil }
        switch entry.time {
        case let .timed(start, end, _):
            guard let s = PlannerDates.instant(start) else { return "Time needs review" }
            let e = PlannerDates.instant(end) ?? s
            if calendar.isDate(s, inSameDayAs: e) {
                return (s..<max(e, s)).formatted(Date.IntervalFormatStyle(date: .omitted, time: .shortened, timeZone: zone))
            }
            if s < day { return "Until \(weekdayTime(e, in: zone, relativeTo: day))" }
            return "\(TimeLabels.time(s, in: zone)) – \(weekdayTime(e, in: zone, relativeTo: day))"
        case let .allDay(startDate, endDateExclusive):
            guard let s = PlannerDates.day(startDate, in: zone), let e = PlannerDates.day(endDateExclusive, in: zone) else { return "All day" }
            let total = calendar.dateComponents([.day], from: s, to: e).day ?? 1
            guard total > 1 else { return "All day" }
            let index = (calendar.dateComponents([.day], from: s, to: day).day ?? 0) + 1
            let last = calendar.date(byAdding: .day, value: -1, to: e) ?? e
            return "Day \(min(max(index, 1), total)) of \(total) · through \(TimeLabels.relativeDay(last, in: zone))"
        case let .deadline(at, _):
            guard let date = PlannerDates.instant(at) else { return "Due date needs review" }
            return isMidnight(date, in: zone) ? "Due \(TimeLabels.relativeDay(date, in: zone))" : "Due \(TimeLabels.time(date, in: zone))"
        case let .unresolved(_, startHint, missing):
            if let start = PlannerDates.instant(startHint) {
                return "\(TimeLabels.time(start, in: zone)) · \(missing == ["end"] ? "End time needed" : "Time needs review")"
            }
            return "Time needs review"
        }
    }

    /// "Due 8:00 AM", "Tomorrow · 6:00 – 7:00 PM" etc. for review cards (which can be any day).
    static func review(_ time: NormalizedTime?, in zone: TimeZone) -> String? {
        guard let time else { return nil }
        if case let .deadline(at, _) = time, let date = PlannerDates.instant(at) {
            return "Due \(inSentence(TimeLabels.relativeDay(date, in: zone))) · \(TimeLabels.time(date, in: zone))"
        }
        return TimeLabels.plan(time, in: zone)
    }

    /// "Tomorrow" → "tomorrow" mid-sentence; other dates are unchanged.
    static func inSentence(_ relativeDay: String) -> String {
        ["Today", "Tomorrow", "Yesterday"].contains(relativeDay) ? relativeDay.lowercased() : relativeDay
    }

    /// Reminder due label; past-due reminders say so.
    static func reminder(_ reminder: Reminder, in zone: TimeZone, now: Date) -> String {
        guard let due = reminder.due else { return "" }
        let label = "\(TimeLabels.relativeDay(due, in: zone)) · \(TimeLabels.time(due, in: zone))"
        return due < now ? "Was due \(inSentence(TimeLabels.relativeDay(due, in: zone))) · \(TimeLabels.time(due, in: zone))" : label
    }

    private static func weekdayTime(_ date: Date, in zone: TimeZone, relativeTo day: Date) -> String {
        "\(date.formatted(Date.FormatStyle(timeZone: zone).weekday(.abbreviated))) \(TimeLabels.time(date, in: zone))"
    }

    private static func isMidnight(_ date: Date, in zone: TimeZone) -> Bool {
        let parts = PlannerDates.calendar(zone).dateComponents([.hour, .minute], from: date)
        return parts.hour == 0 && parts.minute == 0
    }
}
