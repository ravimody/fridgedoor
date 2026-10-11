import Foundation

/// Editable copy of `PlanFacts` for the native plan editor. Times are held as
/// `Date`s and converted back to the strict wire schema (`planFactsSchema`,
/// `normalizedTimeSchema`) only when saving, in the plan's own timezone.
public struct PlanDraft: Equatable, Sendable {
    public enum TimeMode: String, CaseIterable, Identifiable, Sendable {
        case timed, allDay, deadline, unresolved
        public var id: String { rawValue }
        public var label: String {
            switch self { case .timed: "Timed"; case .allDay: "All day"; case .deadline: "Due by"; case .unresolved: "Not sure" }
        }
    }

    public struct PrepTask: Equatable, Identifiable, Sendable {
        public let id: UUID
        public var text: String
        public init(id: UUID = UUID(), text: String) { self.id = id; self.text = text }
    }

    public enum ValidationError: Error, Equatable, LocalizedError, Sendable {
        case titleRequired, endBeforeStart, allDayEndBeforeStart, tooLong(String), tooMany(String)
        public var errorDescription: String? {
            switch self {
            case .titleRequired: "Add a title."
            case .endBeforeStart: "Choose an end time after the start."
            case .allDayEndBeforeStart: "The last day can't be before the first day."
            case .tooLong(let field): "\(field) is too long."
            case .tooMany(let field): "Too many \(field)."
            }
        }
    }

    public var title: String
    public var category: String
    public var participants: [String]
    public var location: String
    public var notes: String
    public var tasks: [PrepTask]
    public var unresolvedFields: [String]

    public var timeMode: TimeMode
    /// Set when the user touches any time control; until then the original time is preserved exactly.
    public var timeEdited = false
    public var start: Date
    public var end: Date
    public var due: Date
    public var firstDay: Date
    /// Inclusive in the UI; the wire format is exclusive (`endDateExclusive`).
    public var lastDay: Date
    public var knowsDate: Bool
    public var hintDay: Date
    public var knowsStart: Bool
    public var hintStart: Date

    public let timeZone: TimeZone
    public let original: PlanFacts

    public init(facts: PlanFacts, timeZone fallback: TimeZone, now: Date = .now) {
        original = facts
        title = facts.title
        category = facts.category
        participants = facts.participants
        location = facts.location ?? ""
        notes = facts.notes ?? ""
        tasks = facts.preparationTasks.map { PrepTask(text: $0) }
        unresolvedFields = facts.unresolvedFields
        let zone = facts.time?.timezoneIdentifier.flatMap(TimeZone.init(identifier:)) ?? fallback
        timeZone = zone
        let calendar = PlannerDates.calendar(zone)
        // Defaults: the next whole hour, one hour long.
        let nextHour = calendar.nextDate(after: now, matching: DateComponents(minute: 0), matchingPolicy: .nextTime) ?? now
        let today = calendar.startOfDay(for: now)
        start = nextHour; end = nextHour.addingTimeInterval(3600); due = nextHour
        firstDay = today; lastDay = today
        knowsDate = false; hintDay = today; knowsStart = false; hintStart = nextHour
        switch facts.time {
        case let .timed(s, e, _)?:
            timeMode = .timed
            start = PlannerDates.instant(s) ?? start
            end = PlannerDates.instant(e) ?? start.addingTimeInterval(3600)
        case let .allDay(s, e)?:
            timeMode = .allDay
            firstDay = PlannerDates.day(s, in: zone) ?? today
            let exclusive = PlannerDates.day(e, in: zone) ?? firstDay
            lastDay = max(firstDay, calendar.date(byAdding: .day, value: -1, to: exclusive) ?? firstDay)
        case let .deadline(at, _)?:
            timeMode = .deadline
            due = PlannerDates.instant(at) ?? due
            start = due; end = due.addingTimeInterval(3600)
        case let .unresolved(dateHint, startHint, _)?:
            timeMode = .unresolved
            if let day = PlannerDates.day(dateHint, in: zone) { knowsDate = true; hintDay = day; firstDay = day; lastDay = day }
            if let instant = PlannerDates.instant(startHint) {
                knowsStart = true; hintStart = instant; start = instant; end = instant.addingTimeInterval(3600)
                if !knowsDate { knowsDate = true; hintDay = calendar.startOfDay(for: instant) }
            }
        case nil:
            timeMode = .unresolved
        }
    }

    /// Switching modes carries the chosen moment across so the user doesn't start over.
    public mutating func setTimeMode(_ mode: TimeMode) {
        guard mode != timeMode else { return }
        let calendar = PlannerDates.calendar(timeZone)
        let anchor: Date = switch timeMode {
        case .timed: start
        case .deadline: due
        case .allDay: calendar.date(bySettingHour: 9, minute: 0, second: 0, of: firstDay) ?? firstDay
        case .unresolved: knowsStart ? hintStart : knowsDate ? (calendar.date(bySettingHour: 9, minute: 0, second: 0, of: hintDay) ?? hintDay) : start
        }
        switch mode {
        case .timed: start = anchor; end = anchor.addingTimeInterval(3600)
        case .deadline: due = anchor
        case .allDay: firstDay = calendar.startOfDay(for: anchor); lastDay = firstDay
        case .unresolved: hintDay = calendar.startOfDay(for: anchor)
        }
        timeMode = mode
        timeEdited = true
    }

    /// Converts back to the strict wire schema, or explains what to fix. Length caps count
    /// UTF-16 code units, like the server's zod `.max()`.
    public func facts() throws(ValidationError) -> PlanFacts {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { throw .titleRequired }
        guard trimmedTitle.utf16.count <= 200 else { throw .tooLong("The title") }
        let trimmedCategory = category.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedCategory.utf16.count <= 80 else { throw .tooLong("The category") }
        let people = participants.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard people.count <= 10 else { throw .tooMany("people (10 at most)") }
        guard people.allSatisfy({ $0.utf16.count <= 80 }) else { throw .tooLong("A name") }
        let place = location.trimmingCharacters(in: .whitespacesAndNewlines)
        guard place.utf16.count <= 500 else { throw .tooLong("The location") }
        let note = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard note.utf16.count <= 2000 else { throw .tooLong("The notes") }
        let prep = tasks.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard prep.count <= 20 else { throw .tooMany("preparation tasks (20 at most)") }
        guard prep.allSatisfy({ $0.utf16.count <= 200 }) else { throw .tooLong("A preparation task") }

        var unresolved = unresolvedFields
        var time = original.time
        if timeEdited {
            time = try editedTime()
            if time?.isCalendarReady == true || time?.isDeadline == true {
                unresolved.removeAll { PlanFacts.timeFieldMarkers.contains($0) }
            }
        }
        return PlanFacts(title: trimmedTitle, category: trimmedCategory.isEmpty ? "general" : trimmedCategory, participants: people, time: time,
                         location: place.isEmpty ? nil : place, notes: note.isEmpty ? nil : note, preparationTasks: prep, unresolvedFields: unresolved)
    }

    private func editedTime() throws(ValidationError) -> NormalizedTime? {
        let zone = timeZone.identifier
        switch timeMode {
        case .timed:
            guard end > start else { throw .endBeforeStart }
            return .timed(start: PlannerDates.offsetString(start, timeZone: timeZone), end: PlannerDates.offsetString(end, timeZone: timeZone), timezone: zone)
        case .deadline:
            return .deadline(at: PlannerDates.offsetString(due, timeZone: timeZone), timezone: zone)
        case .allDay:
            let calendar = PlannerDates.calendar(timeZone)
            let first = calendar.startOfDay(for: firstDay), last = calendar.startOfDay(for: lastDay)
            guard last >= first, let exclusive = calendar.date(byAdding: .day, value: 1, to: last) else { throw .allDayEndBeforeStart }
            return .allDay(startDate: PlannerDates.dayString(first, in: timeZone), endDateExclusive: PlannerDates.dayString(exclusive, in: timeZone))
        case .unresolved:
            let dateHint = knowsDate ? PlannerDates.dayString(hintDay, in: timeZone) : nil
            let startHint = knowsStart ? PlannerDates.offsetString(hintStart, timeZone: timeZone) : nil
            let missing = startHint != nil ? ["end"] : dateHint != nil ? ["start", "end"] : ["date"]
            return .unresolved(dateHint: startHint == nil ? dateHint : nil, startHint: startHint, missing: missing)
        }
    }

    /// True when saving would change something on the server.
    public var isDirty: Bool {
        guard let next = try? facts() else { return true }
        return next != original
    }
}
