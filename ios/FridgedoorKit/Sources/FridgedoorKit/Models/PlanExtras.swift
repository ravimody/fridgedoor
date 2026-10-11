import Foundation

// Plan presentation rules ported from the web client (`features/Plans/PlanDetail.tsx`,
// `features/Home/Home.tsx` `PlannerArchive`) and `packages/contracts/src/outcomes.ts`.
// Kept in FridgedoorKit so they are unit-tested alongside the wire models.

/// `outcomes.ts` → `calendarOutcome` / `outcomeLabels`, limited to calendar writes.
public enum CalendarOutcome: String, Sendable {
    case pending, added, updated, removed, needsAttention

    public init(state: String, kind: String?) {
        if state == "succeeded" {
            self = kind == "cancel" ? .removed : kind == "update" ? .updated : .added
        } else if ["failed", "conflict", "needs_reauth", "canceled"].contains(state) {
            self = .needsAttention
        } else {
            self = .pending
        }
    }

    /// Same copy as the web `outcomeLabels`.
    public var label: String {
        switch self {
        case .pending: "Waiting for Google Calendar"
        case .added: "Added to Google Calendar"
        case .updated: "Updated in Google Calendar"
        case .removed: "Removed from Google Calendar"
        case .needsAttention: "Needs attention"
        }
    }
}

public extension CalendarActionRef {
    /// `failed`/`needs_reauth` can be retried server-side; `conflict` cannot.
    var isRetryable: Bool { state == "failed" || state == "needs_reauth" }
    /// Still waiting on the worker — the UI must not claim success yet.
    var isInFlight: Bool { !["succeeded", "failed", "conflict", "needs_reauth", "canceled"].contains(state) }
    var outcome: CalendarOutcome { CalendarOutcome(state: state, kind: kind) }

    /// Present-tense progress copy while the worker runs ("Adding…").
    var progressLabel: String {
        if state == "reconciling" { return "Checking with Google Calendar…" }
        switch kind {
        case "update": return "Updating Google Calendar…"
        case "cancel": return "Removing from Google Calendar…"
        default: return "Adding to Google Calendar…"
        }
    }

    /// Follow-up guidance for states that need the user (mirrors web copy).
    var guidance: String? {
        switch state {
        case "conflict": "The event changed in Google. Your correction has not overwritten it. Review the event in Google Calendar."
        case "needs_reauth": "Reconnect Google in Settings, then retry."
        case "failed": "Google has not confirmed this change. Retry checks the original event before writing again."
        default: nil
        }
    }
}

public extension NormalizedTime {
    /// Google Calendar needs a resolved start and end: timed or all-day only.
    var isCalendarReady: Bool {
        switch self { case .timed, .allDay: true; case .deadline, .unresolved: false }
    }

    var isDeadline: Bool { if case .deadline = self { true } else { false } }

    /// Instant a reminder offset is measured from (`services/reminders.ts`): timed start or deadline.
    var reminderAnchor: Date? {
        switch self {
        case let .timed(start, _, _): PlannerDates.instant(start)
        case let .deadline(at, _): PlannerDates.instant(at)
        default: nil
        }
    }

    /// IANA zone the time was written in, when it carries one.
    var timezoneIdentifier: String? {
        switch self {
        case let .timed(_, _, zone), let .deadline(_, zone): zone
        default: nil
        }
    }
}

public extension PlanSummary {
    /// What the planner would act on: a pending update wins (web `pendingFacts ?? facts`).
    var effectiveFacts: PlanFacts { pendingFacts ?? facts }

    var isClosed: Bool { status == "dismissed" || status == "archived" }

    /// A Google event exists (or an update/cancel of one is underway).
    var hasCalendarEvent: Bool {
        guard let action = calendarAction else { return false }
        return action.state == "succeeded" || ["update", "cancel"].contains(action.kind ?? "create")
    }

    var isCalendarBusy: Bool { calendarAction?.isInFlight ?? false }

    /// Web `canEdit`: not while a calendar write runs, and never once closed.
    var canEdit: Bool { !isCalendarBusy && !isClosed }

    /// Web `PlannerArchive.needsPlan`: still waiting on a decision from someone.
    var needsDecision: Bool {
        guard !isClosed else { return false }
        if let action = calendarAction { return action.state != "succeeded" || pendingFacts != nil }
        return savedInPlanner != true
    }

    /// Web `PlannerArchive.saved`: kept in the planner or on the household calendar.
    var isSaved: Bool {
        guard !isClosed else { return false }
        return savedInPlanner == true || hasCalendarEvent
    }

    /// Server `plan-decisions.ts` precondition for "Add to household calendar".
    var canAddToCalendar: Bool {
        let facts = effectiveFacts
        return facts.unresolvedFields.isEmpty && (facts.time?.isCalendarReady ?? false)
    }

    /// Reminder offsets follow the plan's current (not pending) time on the server.
    var reminderAnchor: Date? { facts.time?.reminderAnchor }
}

public extension PlanFacts {
    enum Field: String, CaseIterable, Sendable {
        case title, time, location, participants, category, notes, preparationTasks

        public var label: String {
            switch self {
            case .title: "Title"
            case .time: "When"
            case .location: "Where"
            case .participants: "Who"
            case .category: "Category"
            case .notes: "Notes"
            case .preparationTasks: "To prepare"
            }
        }
    }

    /// Fields whose values differ from `other` (for the pending-update diff).
    func changedFields(from other: PlanFacts) -> [Field] {
        Field.allCases.filter { field in
            switch field {
            case .title: title != other.title
            case .time: time != other.time
            case .location: (location ?? "") != (other.location ?? "")
            case .participants: participants != other.participants
            case .category: category != other.category
            case .notes: (notes ?? "") != (other.notes ?? "")
            case .preparationTasks: preparationTasks != other.preparationTasks
            }
        }
    }

    /// Time-related unresolved markers cleared once the user sets an explicit time (web `save`).
    static let timeFieldMarkers: Set<String> = ["time", "date", "start", "end", "timezone"]
}

public extension HistoryEntry {
    /// Readable label for the plan history timeline (web `readableHistory`, with friendlier copy).
    var readableLabel: String {
        let changeKind = safePayload["changeKind"]?.stringValue
        switch type {
        case "suggestion_created":
            return safePayload["visibility"]?.stringValue == "private" ? "Suggested privately" : "Suggested"
        case "suggestion_updated":
            return changeKind == "cancel" ? "Cancellation suggested" : "Update suggested"
        case "facts_edited": return "Details edited"
        case "proposal_shared": return "Shared with the household"
        case "suggestion_dismissed": return "Dismissed"
        default:
            let words = type.replacingOccurrences(of: "_", with: " ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }

    var systemImage: String {
        switch type {
        case "suggestion_created": "sparkles"
        case "suggestion_updated": "arrow.triangle.2.circlepath"
        case "facts_edited": "pencil"
        case "proposal_shared": "person.2"
        case "suggestion_dismissed": "xmark.circle"
        default: "clock"
        }
    }
}
