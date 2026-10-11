import Foundation

/// Parsing and formatting for the server's wire formats. Instants are ISO 8601
/// with offsets (fractional seconds optional); calendar dates are `yyyy-MM-dd`
/// and are interpreted in the member's timezone, never the device's.
public enum PlannerDates {
    public static func instant(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        if let date = try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        return try? Date(value, strategy: .iso8601)
    }

    /// `2026-10-10T14:30:00.000Z` — what the server emits for `datetime()` fields.
    public static func instantString(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    /// An instant with the member's local offset, e.g. `2026-10-10T09:00:00-04:00`.
    public static func offsetString(_ date: Date, timeZone: TimeZone) -> String {
        var style = Date.ISO8601FormatStyle(timeZone: timeZone)
        style = style.year().month().day().dateSeparator(.dash).time(includingFractionalSeconds: false).timeSeparator(.colon).timeZone(separator: .colon)
        return date.formatted(style)
    }

    public static func calendar(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = .current
        return calendar
    }

    /// Start of the given `yyyy-MM-dd` day in `timeZone`.
    public static func day(_ value: String?, in timeZone: TimeZone) -> Date? {
        guard let value else { return nil }
        let parts = value.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar(timeZone).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    public static func dayString(_ date: Date, in timeZone: TimeZone) -> String {
        let parts = calendar(timeZone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// A `taskDateSchema` value is either a date or an instant.
    public static func taskDate(_ value: String?, in timeZone: TimeZone) -> Date? {
        guard let value else { return nil }
        return value.count == 10 ? day(value, in: timeZone) : instant(value)
    }
}
