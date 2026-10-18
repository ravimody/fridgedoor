import Foundation
import FridgedoorKit

/// Human labels for plan/agenda/task times, always in the member's timezone.
/// Mirrors `timeLabel` in the web `PlanDetail.tsx`.
enum TimeLabels {
    static func dateTime(_ date: Date, in zone: TimeZone) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: zone))
    }

    static func time(_ date: Date, in zone: TimeZone) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone))
    }

    static func day(_ date: Date, in zone: TimeZone, style: Date.FormatStyle.DateStyle = .abbreviated) -> String {
        date.formatted(Date.FormatStyle(date: style, time: .omitted, timeZone: zone))
    }

    /// "Today", "Tomorrow", "Yesterday", or "Sat, Oct 12".
    static func relativeDay(_ date: Date, in zone: TimeZone, now: Date = .now) -> String {
        let calendar = PlannerDates.calendar(zone)
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) { return "Tomorrow" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        var style = Date.FormatStyle(timeZone: zone).weekday(.abbreviated).month(.abbreviated).day()
        if calendar.component(.year, from: date) != calendar.component(.year, from: now) { style = style.year() }
        return date.formatted(style)
    }

    /// `relativeDay` for use mid-sentence: "until tomorrow", "on Sat, Oct 12".
    static func relativeDayInSentence(_ date: Date, in zone: TimeZone, now: Date = .now, preposition: String? = nil) -> String {
        let day = relativeDay(date, in: zone, now: now)
        if ["Today", "Tomorrow", "Yesterday"].contains(day) { return day.lowercased() }
        return preposition.map { "\($0) \(day)" } ?? day
    }

    /// Relative days after the first are lower case: "Due tomorrow · 8:00 AM", "Today – tomorrow · All day".
    static func plan(_ time: NormalizedTime?, in zone: TimeZone) -> String {
        guard let time else { return "Time needs review" }
        switch time {
        case let .timed(start, end, _):
            guard let s = PlannerDates.instant(start) else { return "Time needs review" }
            let label = "\(relativeDay(s, in: zone)) · \(self.time(s, in: zone))"
            guard let e = PlannerDates.instant(end) else { return label }
            return PlannerDates.calendar(zone).isDate(s, inSameDayAs: e) ? "\(label) – \(self.time(e, in: zone))" : "\(label) – \(relativeDayInSentence(e, in: zone)) \(self.time(e, in: zone))"
        case let .deadline(at, _):
            guard let date = PlannerDates.instant(at) else { return "Due date needs review" }
            return "Due \(relativeDayInSentence(date, in: zone)) · \(self.time(date, in: zone))"
        case let .allDay(startDate, endDateExclusive):
            guard let s = PlannerDates.day(startDate, in: zone), let e = PlannerDates.day(endDateExclusive, in: zone) else { return "All day" }
            let calendar = PlannerDates.calendar(zone)
            let last = calendar.date(byAdding: .day, value: -1, to: e) ?? s
            return calendar.isDate(s, inSameDayAs: last) ? "\(relativeDay(s, in: zone)) · All day" : "\(relativeDay(s, in: zone)) – \(relativeDayInSentence(last, in: zone)) · All day"
        case let .unresolved(dateHint, startHint, missing):
            if let start = PlannerDates.instant(startHint) {
                return "\(relativeDay(start, in: zone)) · \(self.time(start, in: zone)) · \(missing == ["end"] ? "End time needed" : "Time needs review")"
            }
            if let day = PlannerDates.day(dateHint, in: zone) { return "\(relativeDay(day, in: zone)) · Time needs review" }
            return "Date and time need review"
        }
    }

    /// Left column of the day agenda ("9:30 AM", "All day", "Due").
    static func agendaColumn(_ time: NormalizedTime?, in zone: TimeZone) -> String {
        switch time {
        case let .timed(start, _, _)?: PlannerDates.instant(start).map { self.time($0, in: zone) } ?? ""
        case .allDay?: "All day"
        case let .deadline(at, _)?: PlannerDates.instant(at).map { "Due \(self.time($0, in: zone))" } ?? "Due"
        case let .unresolved(_, startHint, _)?: PlannerDates.instant(startHint).map { self.time($0, in: zone) } ?? "—"
        case nil: "—"
        }
    }

    static func relative(_ iso: String?, now: Date = .now) -> String? {
        guard let date = PlannerDates.instant(iso) else { return nil }
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}
