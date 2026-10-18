import Foundation

/// Swift port of `packages/contracts/src/outcomes.ts`: the persisted state of a
/// request, summarized for receipts and history. The receipt reports what the
/// server stored, never what the model claimed.
public enum RequestOutcome: String, CaseIterable, Sendable {
    case working
    case calendarPending = "calendar_pending"
    case needsAttention = "needs_attention"
    case needsReview = "needs_review"
    case added
    case saved
    case calendarAdded = "calendar_added"
    case calendarUpdated = "calendar_updated"
    case calendarRemoved = "calendar_removed"
    case remembered
    case undone
    case dismissed
    case reply

    /// `outcomeLabels` — keep identical to the web copy, except "Saved" (ios/DESIGN.md words).
    public var label: String {
        switch self {
        case .working: "Working…"
        case .calendarPending: "Waiting for Google Calendar"
        case .needsAttention: "Needs attention"
        case .needsReview: "Needs review"
        case .added: "Added to household lists"
        case .saved: "Saved"
        case .calendarAdded: "Added to Google Calendar"
        case .calendarUpdated: "Updated in Google Calendar"
        case .calendarRemoved: "Removed from Google Calendar"
        case .remembered: "Household facts updated"
        case .undone: "Undone"
        case .dismissed: "Dismissed"
        case .reply: "Reply ready"
        }
    }

    /// Whether the outcome still asks something of the person.
    public var needsAction: Bool { self == .needsAttention || self == .needsReview }

    static let priority: [RequestOutcome] = [.needsAttention, .needsReview, .calendarPending, .working, .added, .saved, .calendarAdded, .calendarUpdated, .calendarRemoved, .remembered, .undone, .dismissed, .reply]

    public static func calendar(state: String, kind: String?) -> RequestOutcome {
        if state == "succeeded" { return kind == "cancel" ? .calendarRemoved : kind == "update" ? .calendarUpdated : .calendarAdded }
        return ["failed", "conflict", "needs_reauth", "canceled"].contains(state) ? .needsAttention : .calendarPending
    }
}

public extension AssistantRun {
    /// `requestOutcomes(run, plans)`, in display priority order.
    func outcomes(plans: [PlanSummary] = []) -> [RequestOutcome] {
        if isWorking { return [.working] }
        guard state == "succeeded", let result else { return [.needsAttention] }
        var found = Set<RequestOutcome>()
        for (index, item) in result.items.enumerated() {
            guard let review = review(for: "item:\(index)") else { found.insert(.needsReview); continue }
            if review.undoneAt != nil { found.insert(.undone); continue }
            if review.state == "dismissed" { found.insert(.dismissed); continue }
            if item.kind != "event" { found.insert(review.state == "saved" ? .added : .needsReview); continue }
            let plan = plans.first { $0.id == review.planId }
            let action: (state: String, kind: String?)? = plan?.calendarAction.map { ($0.state, $0.kind) } ?? review.calendarAction.map { ($0.state, $0.kind) }
            if let action {
                found.insert(RequestOutcome.calendar(state: action.state, kind: action.kind))
                if plan?.pendingFacts != nil, action.state == "succeeded" { found.insert(.needsReview) }
            } else if plan?.status == "dismissed" || plan?.status == "archived" {
                found.insert(.dismissed)
            } else if plan?.savedInPlanner == true || review.state == "kept" {
                found.insert(.saved)
            } else {
                found.insert(review.state == "calendar" ? .calendarPending : .needsReview)
            }
        }
        for index in result.knowledge.indices {
            guard let review = review(for: "knowledge:\(index)") else { found.insert(.needsReview); continue }
            found.insert(review.state == "dismissed" ? .dismissed : .remembered)
        }
        if found.isEmpty { found.insert(.reply) }
        return RequestOutcome.priority.filter(found.contains)
    }

    /// Items the server added directly ("add milk to groceries"), with their indexes.
    var automaticItems: [(index: Int, item: AssistantItem, review: AssistantReview)] {
        guard let result else { return [] }
        return result.items.enumerated().compactMap { index, item in
            guard let review = review(for: "item:\(index)"), review.automatic == true else { return nil }
            return (index, item, review)
        }
    }

    /// Only http(s) sources become links; anything else (`javascript:`, `file:`) is dropped.
    var sourceLinks: [URL] { AssistantLinks.safeLinks(result?.sources ?? []) }

    /// The one-line title used in lists: first item title, else the request text.
    var displayTitle: String {
        if let title = result?.items.first?.title { return title }
        let text = self.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "Photo or PDF" : String(text.prefix(100))
    }

    /// Whether "Save all" (`apply`) can run: an unreviewed, unapplied result with something to save.
    var canApplyAll: Bool {
        guard state == "succeeded", let result, !applied else { return false }
        return (reviews ?? []).isEmpty && (!result.items.isEmpty || !result.knowledge.isEmpty)
    }

    /// A placeholder shown between `POST assistant/runs` and the next refresh.
    static func pending(id: String, text: String, captureId: String?, createdAt: Date = .now) -> AssistantRun {
        AssistantRun(id: id, text: text, state: "queued", createdAt: PlannerDates.instantString(createdAt), captureId: captureId, result: nil, applied: false, planIds: [], errorCode: nil, feedback: nil, reviews: [], metrics: nil)
    }
}

public enum AssistantLinks {
    public static func safeLinks(_ sources: [String]) -> [URL] {
        sources.compactMap { source in
            guard let url = URL(string: source.trimmingCharacters(in: .whitespaces)),
                  let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  let host = url.host(), !host.isEmpty else { return nil }
            return url
        }
    }

    /// The first http(s) link typed or pasted into a message, for the link preview chip.
    public static func firstLink(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        for match in detector.matches(in: text, range: range) {
            guard let url = match.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { continue }
            // Ignore bare words the detector promotes to links ("example.com" is fine, "a.b" isn't useful).
            guard let host = url.host(), host.contains(".") else { continue }
            return url
        }
        return nil
    }
}

/// Port of the web `pauseDetector` (`silence-stop.ts`): at least 250 ms of audio
/// at RMS ≥ 0.015, then 1.5 s of quiet ends speech; 10 s without speech cancels.
public struct PauseDetector: Sendable {
    public enum Outcome: Equatable, Sendable { case speechEnded, noSpeech }

    public static let voiceThreshold: Float = 0.015
    public static let minimumVoiceMs = 250.0
    public static let quietMs = 1500.0
    public static let noSpeechMs = 10_000.0

    private var voiced = 0.0
    private var lastVoice = 0.0
    private var elapsed = 0.0

    public init() {}

    public var heardSpeech: Bool { voiced >= Self.minimumVoiceMs }

    /// Feed one analysis window. Returns an outcome once, when it is decided.
    public mutating func feed(rms: Float, milliseconds: Double) -> Outcome? {
        elapsed += milliseconds
        if rms >= Self.voiceThreshold { voiced += milliseconds; lastVoice = elapsed }
        if voiced >= Self.minimumVoiceMs && elapsed - lastVoice >= Self.quietMs { return .speechEnded }
        if voiced < Self.minimumVoiceMs && elapsed >= Self.noSpeechMs { return .noSpeech }
        return nil
    }

    /// Recognizers report words even when the level meter reads low (quiet voices,
    /// AGC); treat new words as voice so a soft speaker isn't cut off mid-sentence.
    public mutating func noteWords() {
        voiced = max(voiced, Self.minimumVoiceMs)
        lastVoice = elapsed
    }
}
