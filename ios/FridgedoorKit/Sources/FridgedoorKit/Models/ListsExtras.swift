import Foundation

/// A grocery line typed into the quick-add field, split into title and quantity.
/// "2 avocados" → ("Avocados", "2"), "milk x2" → ("Milk", "2"),
/// "1 dozen eggs" → ("Eggs", "1 dozen"), "flour (5 lb)" → ("Flour", "5 lb").
public struct GroceryEntry: Equatable, Sendable {
    public let title: String
    public let quantity: String?

    public init(title: String, quantity: String?) { self.title = title; self.quantity = quantity }

    /// Server limits (`lists.ts`): title 1–200 characters, quantity up to 80. Zod counts
    /// UTF-16 code units, so compare against `utf16.count`, not `count`.
    public static let maxTitle = 200
    public static let maxQuantity = 80

    private static let units = [
        "lb", "lbs", "pound", "pounds", "oz", "ounce", "ounces", "kg", "g", "gram", "grams", "l", "liter", "liters", "litre", "litres",
        "ml", "gal", "gallon", "gallons", "qt", "quart", "quarts", "pint", "pints", "cup", "cups", "dozen", "doz", "pack", "packs",
        "packet", "packets", "bag", "bags", "box", "boxes", "can", "cans", "jar", "jars", "bottle", "bottles", "carton", "cartons",
        "bunch", "bunches", "loaf", "loaves", "head", "heads", "stick", "sticks", "container", "containers", "tub", "tubs",
        "case", "cases", "roll", "rolls", "block", "blocks", "piece", "pieces", "pc", "pcs", "ct", "count", "tray", "trays",
    ]
    private static let numberWords = ["one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "a": "1", "an": "1", "half": "½"]

    public static func parse(_ text: String) -> GroceryEntry {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        guard !raw.isEmpty else { return GroceryEntry(title: "", quantity: nil) }
        let unit = "(?:" + units.joined(separator: "|") + ")"
        let number = #"(?:\d+(?:[.,/]\d+)?|½|¼|¾)"#

        // Trailing: "milk x2", "milk × 2", "eggs 2x", "flour (5 lb)".
        let trailing: [String] = [
            #"^(.+?)\s+[x×]\s*("# + number + #")$"#,
            #"^(.+?)\s+("# + number + #")\s*[x×]$"#,
            #"^(.+?)\s*\(\s*("# + number + #"(?:\s*"# + unit + #")?)\s*\)$"#,
        ]
        for pattern in trailing {
            if let match = raw.firstMatch(pattern), match.count == 3, match[1].count > 0 {
                return make(title: match[1], quantity: match[2])
            }
        }

        // Leading: "2 avocados", "2lb chicken", "1 dozen eggs", "a bag of chips",
        // "two cartons of oat milk". A bare number needs a following space so "2% milk" stays intact.
        let leadingWithUnit = #"^("# + number + #"|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an?|half(?: a)?)\s*("# + unit + #")\.?\s+(?:of\s+)?(.+)$"#
        if let match = raw.firstMatch(leadingWithUnit, caseInsensitive: true), match.count == 4 {
            let count = normalizedCount(match[1])
            return make(title: match[3], quantity: "\(count) \(match[2].lowercased())")
        }
        let leadingBare = #"^("# + number + #"|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:x\s+)?(.+)$"#
        if let match = raw.firstMatch(leadingBare, caseInsensitive: true), match.count == 3 {
            return make(title: match[2], quantity: normalizedCount(match[1]))
        }
        return make(title: raw, quantity: nil)
    }

    private static func normalizedCount(_ value: String) -> String {
        let lower = value.lowercased()
        if lower == "half a" { return "½" }
        return numberWords[lower] ?? value
    }

    private static func make(title: String, quantity: String?) -> GroceryEntry {
        var title = title.trimmingCharacters(in: .whitespaces)
        if let first = title.first, first.isLowercase { title = first.uppercased() + title.dropFirst() }
        let quantity = quantity?.trimmingCharacters(in: .whitespaces)
        return GroceryEntry(title: title.prefix(utf16Count: maxTitle), quantity: quantity.flatMap { $0.isEmpty ? nil : $0.prefix(utf16Count: maxQuantity) })
    }
}

private extension String {
    /// Capture groups of the first full-string match (index 0 is the whole match).
    func firstMatch(_ pattern: String, caseInsensitive: Bool = true) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : []) else { return nil }
        let range = NSRange(startIndex..., in: self)
        guard let match = regex.firstMatch(in: self, range: range) else { return nil }
        return (0..<match.numberOfRanges).map { index in
            Range(match.range(at: index), in: self).map { String(self[$0]) } ?? ""
        }
    }
}

// MARK: - Task dates and ordering

public enum TaskDueState: Equatable, Sendable {
    case none
    case overdue
    case today
    case upcoming
}

public extension ListItem {
    /// Whether `dueTime` is a calendar date (`yyyy-MM-dd`) rather than an instant.
    var isAllDayDue: Bool { dueTime?.count == 10 }

    /// The due moment: start of the day for date-only values, in the member timezone.
    func dueDate(in timeZone: TimeZone) -> Date? { PlannerDates.taskDate(dueTime, in: timeZone) }

    func dueState(in timeZone: TimeZone, now: Date = .now) -> TaskDueState {
        guard let due = dueDate(in: timeZone) else { return .none }
        let calendar = PlannerDates.calendar(timeZone)
        if isAllDayDue {
            let today = calendar.startOfDay(for: now)
            if due < today { return .overdue }
            return calendar.isDate(due, inSameDayAs: now) ? .today : .upcoming
        }
        if due < now { return .overdue }
        return calendar.isDate(due, inSameDayAs: now) ? .today : .upcoming
    }

    /// True while a "Remind me later" date is still in the future.
    func isSnoozed(in timeZone: TimeZone, now: Date = .now) -> Bool {
        guard let snoozedUntil, let day = PlannerDates.day(snoozedUntil, in: timeZone) else { return false }
        return day > now
    }

    var createdDate: Date? { PlannerDates.instant(createdAt) }
    var completedDate: Date? { PlannerDates.instant(completedAt) }
}

public extension Array where Element == ListItem {
    /// Open to-dos: dated first by due date (so overdue leads), then undated; ties oldest first.
    /// Groceries: oldest first, so new additions land next to the add row.
    func openOrdered(in timeZone: TimeZone) -> [ListItem] {
        filter { !$0.isCompleted }.sorted { a, b in
            if a.kind == .todo {
                let da = a.dueDate(in: timeZone), db = b.dueDate(in: timeZone)
                switch (da, db) {
                case let (x?, y?) where x != y: return x < y
                case (.some, nil): return true
                case (nil, .some): return false
                default: break
                }
            }
            if a.createdAt != b.createdAt { return (a.createdDate ?? .distantPast) < (b.createdDate ?? .distantPast) }
            return a.id < b.id
        }
    }

    /// Completed items, newest completion first.
    func completedOrdered() -> [ListItem] {
        filter(\.isCompleted).sorted { ($0.completedDate ?? .distantPast) > ($1.completedDate ?? .distantPast) }
    }

    /// Recently completed groceries not already on the open list (case-insensitive),
    /// for one-tap "Buy again" suggestions.
    func buyAgainSuggestions(limit: Int = 8) -> [ListItem] {
        var seen = Set(filter { !$0.isCompleted }.map { $0.title.lowercased() })
        var result: [ListItem] = []
        for item in completedOrdered() where seen.insert(item.title.lowercased()).inserted {
            result.append(item)
            if result.count == limit { break }
        }
        return result
    }
}
