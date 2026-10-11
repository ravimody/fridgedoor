import Foundation

// Server payloads that are not declared in `packages/contracts` but are typed in
// the web client (`features/Home/PlannerContext.tsx`). Optional fields are lenient
// on purpose: an additive server field must not break decoding a whole screen.

public struct Reminder: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let parentType: String // plan | list_item
    public let parentId: String
    public let dueAt: String
    public let timezone: String?
    public let offsetMinutes: Int?
    public let revision: Int
    public let state: String // active | completed
    public let updatedAt: String?
    public let title: String?

    public var due: Date? { PlannerDates.instant(dueAt) }
    public var isActive: Bool { state == "active" }
}

public struct RemindersResponse: Codable, Sendable { public let reminders: [Reminder] }

public struct DailyCoverage: Codable, Hashable, Sendable {
    public let channel: String
    public let status: String
    public let lastSuccessAt: String?
    public let omittedCount: Int?
}

public struct NavigationTarget: Codable, Hashable, Sendable {
    public let kind: String
    public let id: String
}

public struct DailyOverviewItem: Codable, Hashable, Sendable, Identifiable {
    public let refs: [String]
    public let category: String // today | prepare | deadline | change | decision
    public let headline: String
    public let detail: String
    public let priority: String // important | routine
    public let title: String?
    public let normalizedTime: NormalizedTime?
    public let sourceRefs: [String]?
    public let targets: [NavigationTarget]?
    public let href: String?

    public var id: String { refs.joined(separator: "|") }
    public var displayTitle: String { title ?? headline }
}

public struct DailyOverviewQuestion: Codable, Hashable, Sendable {
    public let refs: [String]
    public let text: String
    public let reason: String
}

public struct DailyOverviewResult: Codable, Hashable, Sendable {
    public let summary: String
    public let items: [DailyOverviewItem]?
    public let questions: [DailyOverviewQuestion]

    public init(summary: String, items: [DailyOverviewItem]?, questions: [DailyOverviewQuestion]) { self.summary = summary; self.items = items; self.questions = questions }
}

public struct DailyView: Codable, Hashable, Sendable {
    public let state: String // ready | fallback | unavailable (+ server states such as updating)
    public let result: DailyOverviewResult?
    public let items: [DailyOverviewItem]
    public let generatedAt: String?
    public let coverage: [DailyCoverage]?
    public let revision: Int
    public let errorCode: String?
    public let refreshing: Bool?
    public let undoToken: String?

    public init(state: String, result: DailyOverviewResult?, items: [DailyOverviewItem], generatedAt: String?, coverage: [DailyCoverage]?, revision: Int, errorCode: String?, refreshing: Bool?, undoToken: String?) {
        self.state = state; self.result = result; self.items = items; self.generatedAt = generatedAt; self.coverage = coverage
        self.revision = revision; self.errorCode = errorCode; self.refreshing = refreshing; self.undoToken = undoToken
    }
}

public struct DailySettings: Codable, Hashable, Sendable {
    public let enabled: Bool
    public let consentVersion: String?
    public let revision: Int
    public let available: Bool?
    public let disclosureVersion: String?
}

public struct Clarification: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let question: String
    public let reason: String
    public let sourceRefs: [String]?
    public let state: String // open | answered | dismissed | expired
    public let answer: String?
    public let revision: Int
    public let createdAt: String
    public let expiresAt: String?
}

public struct AssistantSettings: Codable, Hashable, Sendable {
    public let enabled: Bool
    public let consent: Bool
}

public struct ConnectionStatus: Codable, Hashable, Sendable {
    public let connected: Bool
    public let status: String // active | paused | needs_reauth | disconnected
    public let email: String?
    public let generation: Int?
    public let revision: Int
    public let syncLastSuccessAt: String?
    public let syncErrorCode: String?
    public let analysisPending: Int?
    public let consentedAt: String?

    enum CodingKeys: String, CodingKey { case connected, status, email, generation, revision, syncLastSuccessAt, syncErrorCode, analysisPending, consentedAt = "consented_at" }
}

public struct Destination: Codable, Hashable, Sendable {
    public let id: String?
    public let name: String
    public let active: Bool?
    public let ownCalendarSelectionId: String?
}

// MARK: Assistant

public struct AssistantItem: Codable, Hashable, Sendable {
    public var intent: String? // direct | proposal
    public var kind: String // event | todo | grocery
    public var title: String
    public var quantity: String?
    public var start: String?
    public var end: String?
    public var location: String?
    public var notes: String?

    public init(intent: String? = nil, kind: String, title: String, quantity: String? = nil, start: String? = nil, end: String? = nil, location: String? = nil, notes: String? = nil) {
        self.intent = intent; self.kind = kind; self.title = title; self.quantity = quantity; self.start = start; self.end = end; self.location = location; self.notes = notes
    }

    /// The edited-item schema is strict and requires every nullable key.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(intent, forKey: .intent)
        try c.encode(kind, forKey: .kind); try c.encode(title, forKey: .title)
        try c.encode(quantity, forKey: .quantity); try c.encode(start, forKey: .start); try c.encode(end, forKey: .end)
        try c.encode(location, forKey: .location); try c.encode(notes, forKey: .notes)
    }
}

public struct AssistantKnowledgeChange: Codable, Hashable, Sendable {
    public let operation: String // set | delete
    public let key: String
    public let value: String?
}

public struct AssistantResult: Codable, Hashable, Sendable {
    public let reply: String
    public let sources: [String]
    public let assumptions: [String]
    public let followups: [String]
    public let items: [AssistantItem]
    public let knowledge: [AssistantKnowledgeChange]
}

public struct AssistantReview: Codable, Hashable, Sendable {
    public struct CalendarAction: Codable, Hashable, Sendable { public let state: String; public let kind: String }
    public let calendarAction: CalendarAction?
    public let automatic: Bool?
    public let undoneAt: String?
    public let target: String // item:N | knowledge:N
    public let state: String // saved | kept | calendar | dismissed | draft
    public let planId: String?
}

public struct AssistantMetrics: Codable, Hashable, Sendable {
    public let model: String
    public let durationMs: Int
}

public struct AssistantRun: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let text: String
    public let state: String // queued | running | succeeded | failed
    public let createdAt: String
    public let captureId: String?
    public let result: AssistantResult?
    public let applied: Bool
    public let planIds: [String]
    public let errorCode: String?
    public let feedback: String?
    public let reviews: [AssistantReview]?
    public let metrics: AssistantMetrics?

    public var isWorking: Bool { state == "queued" || state == "running" }
    public func review(for target: String) -> AssistantReview? { reviews?.first { $0.target == target } }
}

public struct KnowledgeFact: Codable, Hashable, Sendable, Identifiable {
    public let key: String
    public let value: String
    public let revision: Int
    public let provenance: String? // legacy | user | source | maintenance
    public let confirmation: String? // confirmed | unconfirmed
    public let validFrom: String?
    public let validUntil: String?
    public let relationKey: String?
    public let archivedAt: String?

    public var id: String { key }
}

public struct KnowledgeChangeEntry: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let key: String
    public let baseRevision: Int
    public let resultRevision: Int
    public let before: String?
    public let after: String?
    public let origin: String // user | review | maintenance
    public let reason: String
    public let createdAt: String
    public let undoUntil: String?
}

public struct KnowledgeProposal: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let operation: String // add | update | archive | merge
    public let targetKeys: [String]
    public let baseRevisions: [Int]
    public let proposedValue: String?
    public let provenanceRefs: [String]
    public let reason: String
    public let status: String
    public let createdAt: String
    public let expiresAt: String
}
