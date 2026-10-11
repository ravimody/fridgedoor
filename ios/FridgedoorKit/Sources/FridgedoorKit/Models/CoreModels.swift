import Foundation

// Swift mirrors of `packages/contracts`. Keep wire field names identical; the
// server parses requests with strict Zod schemas, so unknown keys are rejected.

public struct Envelope<T: Decodable & Sendable>: Decodable, Sendable { public let data: T }

public struct Member: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let householdId: String
    public let displayName: String
    public let timezone: String

    public init(id: String, householdId: String, displayName: String, timezone: String) {
        self.id = id; self.householdId = householdId; self.displayName = displayName; self.timezone = timezone
    }

    public var timeZone: TimeZone { TimeZone(identifier: timezone) ?? .current }
    public var firstName: String { displayName.split(separator: " ").first.map(String.init) ?? displayName }
}

public struct MeResponse: Codable, Sendable {
    public let member: Member
    /// Active members of the household (id and name). Older servers omit it.
    public let household: [HouseholdPerson]?
}

/// Someone in the household, for showing and assigning people.
public struct HouseholdPerson: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) { self.id = id; self.displayName = displayName }

    public var firstName: String { displayName.split(separator: " ").first.map(String.init) ?? displayName }
}

/// `normalizedTimeSchema`: a discriminated union on `kind`.
public enum NormalizedTime: Codable, Hashable, Sendable {
    case timed(start: String, end: String, timezone: String)
    case allDay(startDate: String, endDateExclusive: String)
    case deadline(at: String, timezone: String)
    case unresolved(dateHint: String?, startHint: String?, missing: [String])

    private enum CodingKeys: String, CodingKey { case kind, start, end, timezone, startDate, endDateExclusive, at, dateHint, startHint, missing }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "timed": self = .timed(start: try c.decode(String.self, forKey: .start), end: try c.decode(String.self, forKey: .end), timezone: try c.decode(String.self, forKey: .timezone))
        case "all_day": self = .allDay(startDate: try c.decode(String.self, forKey: .startDate), endDateExclusive: try c.decode(String.self, forKey: .endDateExclusive))
        case "deadline": self = .deadline(at: try c.decode(String.self, forKey: .at), timezone: try c.decode(String.self, forKey: .timezone))
        default: self = .unresolved(dateHint: try c.decodeIfPresent(String.self, forKey: .dateHint), startHint: try c.decodeIfPresent(String.self, forKey: .startHint), missing: (try c.decodeIfPresent([String].self, forKey: .missing)) ?? ["date"])
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .timed(start, end, timezone):
            try c.encode("timed", forKey: .kind); try c.encode(start, forKey: .start); try c.encode(end, forKey: .end); try c.encode(timezone, forKey: .timezone)
        case let .allDay(startDate, endDateExclusive):
            try c.encode("all_day", forKey: .kind); try c.encode(startDate, forKey: .startDate); try c.encode(endDateExclusive, forKey: .endDateExclusive)
        case let .deadline(at, timezone):
            try c.encode("deadline", forKey: .kind); try c.encode(at, forKey: .at); try c.encode(timezone, forKey: .timezone)
        case let .unresolved(dateHint, startHint, missing):
            try c.encode("unresolved", forKey: .kind); try c.encodeIfPresent(dateHint, forKey: .dateHint); try c.encodeIfPresent(startHint, forKey: .startHint); try c.encode(missing.isEmpty ? ["date"] : missing, forKey: .missing)
        }
    }

    public var kind: String {
        switch self { case .timed: "timed"; case .allDay: "all_day"; case .deadline: "deadline"; case .unresolved: "unresolved" }
    }

    /// The instant or day this item sorts and groups by, if known.
    public func anchor(in timeZone: TimeZone) -> Date? {
        switch self {
        case let .timed(start, _, _): PlannerDates.instant(start)
        case let .allDay(startDate, _): PlannerDates.day(startDate, in: timeZone)
        case let .deadline(at, _): PlannerDates.instant(at)
        case let .unresolved(dateHint, startHint, _): PlannerDates.instant(startHint) ?? PlannerDates.day(dateHint, in: timeZone)
        }
    }

    /// Whether any part of this time falls on the local day starting at `day`.
    public func occurs(onDayStarting day: Date, in timeZone: TimeZone) -> Bool {
        let calendar = PlannerDates.calendar(timeZone)
        guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { return false }
        switch self {
        case let .timed(start, end, _):
            guard let s = PlannerDates.instant(start) else { return false }
            let e = PlannerDates.instant(end) ?? s
            return s < next && (e > day || s >= day)
        case let .allDay(startDate, endDateExclusive):
            guard let s = PlannerDates.day(startDate, in: timeZone), let e = PlannerDates.day(endDateExclusive, in: timeZone) else { return false }
            return s < next && e > day
        default:
            guard let anchor = anchor(in: timeZone) else { return false }
            return anchor >= day && anchor < next
        }
    }

    public var isAllDay: Bool { if case .allDay = self { true } else { false } }
}

public struct PlanFacts: Codable, Hashable, Sendable {
    public var title: String
    public var category: String
    public var participants: [String]
    public var time: NormalizedTime?
    public var location: String?
    public var notes: String?
    public var preparationTasks: [String]
    public var unresolvedFields: [String]

    public init(title: String, category: String = "general", participants: [String] = [], time: NormalizedTime? = nil, location: String? = nil, notes: String? = nil, preparationTasks: [String] = [], unresolvedFields: [String] = []) {
        self.title = title; self.category = category; self.participants = participants; self.time = time
        self.location = location; self.notes = notes; self.preparationTasks = preparationTasks; self.unresolvedFields = unresolvedFields
    }

    /// Strict server schema: omit empty optionals rather than sending `""`.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(title, forKey: .title); try c.encode(category, forKey: .category); try c.encode(participants, forKey: .participants)
        try c.encodeIfPresent(time, forKey: .time)
        if let location, !location.isEmpty { try c.encode(location, forKey: .location) }
        if let notes, !notes.isEmpty { try c.encode(notes, forKey: .notes) }
        try c.encode(preparationTasks, forKey: .preparationTasks); try c.encode(unresolvedFields, forKey: .unresolvedFields)
    }
}

public struct CalendarActionRef: Codable, Hashable, Sendable {
    public let actionId: String
    public let state: String
    public let kind: String?
}

public struct SourceSummary: Codable, Hashable, Sendable {
    public let kind: String
    public let count: Int
    public let available: Bool
}

public struct PlanSummary: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let revision: Int
    public let visibility: String // shared | private
    public let status: String // needs_details | proposed | dismissed | accepted | archived
    public let facts: PlanFacts
    public let changeKind: String? // new | update | cancel
    public let createdAt: String
    public let updatedAt: String
    public let sourceSummary: SourceSummary
    public let possibleDuplicate: Bool
    public let pendingFacts: PlanFacts?
    public let savedInPlanner: Bool?
    public let calendarAction: CalendarActionRef?

    public var isPrivate: Bool { visibility == "private" }
    public var isOpenSuggestion: Bool { status == "proposed" || status == "needs_details" }
}

public struct PlansResponse: Codable, Sendable { public let plans: [PlanSummary] }

public struct ActionStatus: Codable, Hashable, Sendable {
    public let actionId: String
    public let planId: String
    public let state: String // pending | running | reconciling | succeeded | conflict | needs_reauth | failed
}

public struct AgendaItem: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let planId: String?
    public let title: String
    public let time: NormalizedTime
    public let location: String?
    public let status: String // confirmed | tentative
    public let visibility: String // shared | owner
    public let origin: String // household calendar | your private calendar
}

public struct AgendaResponse: Codable, Sendable { public let items: [AgendaItem] }

public enum ListKind: String, Codable, CaseIterable, Sendable, Identifiable {
    case todo, grocery
    public var id: String { rawValue }
    public var title: String { self == .todo ? "To do" : "Groceries" }
}

public struct ListItem: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let kind: ListKind
    public let title: String
    public let quantity: String?
    public let assigneeId: String?
    public let dueTime: String?
    public let snoozedUntil: String?
    public let completedAt: String?
    public let revision: Int
    public let createdAt: String

    public var isCompleted: Bool { completedAt != nil }

    public init(id: String, kind: ListKind, title: String, quantity: String?, assigneeId: String?, dueTime: String?, snoozedUntil: String?, completedAt: String?, revision: Int, createdAt: String) {
        self.id = id; self.kind = kind; self.title = title; self.quantity = quantity; self.assigneeId = assigneeId
        self.dueTime = dueTime; self.snoozedUntil = snoozedUntil; self.completedAt = completedAt; self.revision = revision; self.createdAt = createdAt
    }
}

public struct ListResponse: Codable, Sendable { public let items: [ListItem] }

public struct HistoryEntry: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let type: String
    public let actorLabel: String
    public let safePayload: [String: JSONValue]
    public let createdAt: String
}

public struct HistoryResponse: Codable, Sendable { public let entries: [HistoryEntry] }

public struct Evidence: Codable, Hashable, Sendable {
    public let sourceVersionId: String
    public let availability: String // available | expired | deleted | incomplete
    public let kind: String
    public let text: String?
    public let sender: String?
    public let labels: [String]
}
