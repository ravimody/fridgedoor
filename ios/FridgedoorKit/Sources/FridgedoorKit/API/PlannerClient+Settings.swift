import Foundation

/// Settings, household knowledge and suggestion-feedback endpoints. Request bodies
/// match the server's strict Zod schemas exactly (unknown keys are rejected).

// MARK: Account

public extension PlannerClient {
    /// Served by the native mount itself (`routes/native.ts`), not the dashboard API.
    func nativeSessions() async throws -> NativeSessionsResponse { try await get("native-sessions") }

    func revokeNativeSession(_ id: String) async throws {
        _ = try await send(.delete, "native-sessions/\(id)", as: DeletedResponse.self)
    }
}

// MARK: Google connection and sources

public extension PlannerClient {
    /// `action`: pause | resume | disconnect.
    func transitionConnection(_ action: String, expectedRevision: Int) async throws -> ConnectionStatus {
        try await send(.post, "connection/\(action)", body: RevisionBody(expectedRevision: expectedRevision))
    }

    func deletePrivateData() async throws {
        struct Body: Encodable, Sendable { let confirm = true }
        _ = try await send(.delete, "connection/private-data", body: Body(), as: DeletedResponse.self)
    }

    func sourcePolicy() async throws -> SourcePolicy { try await get("source-policy") }

    func saveSourcePolicy(_ policy: SourcePolicy) async throws -> SourcePolicy {
        struct Body: Encodable, Sendable { let excludedSenders: [String]; let excludedLabels: [String]; let genericAppointmentOptIn: Bool; let expectedRevision: Int }
        return try await send(.put, "source-policy", body: Body(excludedSenders: policy.excludedSenders, excludedLabels: policy.excludedLabels, genericAppointmentOptIn: policy.genericAppointmentOptIn, expectedRevision: policy.revision))
    }

    func sourceCalendars() async throws -> [SourceCalendar] { try await get("source-calendars") }

    func saveSourceCalendars(_ selections: [CalendarSelection]) async throws -> [SourceCalendar] {
        struct Body: Encodable, Sendable { let selections: [CalendarSelection] }
        return try await send(.put, "source-calendars", body: Body(selections: selections))
    }

    /// `expectedRevision` is the Google connection's revision; a successful save bumps it.
    func saveDestination(selectionId: String, expectedRevision: Int) async throws -> Destination? {
        struct Body: Encodable, Sendable { let ownCalendarSelectionId: String; let expectedRevision: Int }
        return try await send(.put, "destination", body: Body(ownCalendarSelectionId: selectionId, expectedRevision: expectedRevision))
    }
}

// MARK: AI and digest settings

public extension PlannerClient {
    func backgroundAi() async throws -> BackgroundAiStatus { try await get("background-ai") }

    func setBackgroundAi(enabled: Bool, expectedRevision: Int) async throws -> BackgroundAiStatus {
        struct Body: Encodable, Sendable { let enabled: Bool; let expectedRevision: Int }
        return try await send(.post, "background-ai", body: Body(enabled: enabled, expectedRevision: expectedRevision))
    }

    /// Enabling must echo the server's `disclosureVersion` as `consentVersion`.
    func setDailySettings(enabled: Bool, expectedRevision: Int, consentVersion: String?) async throws -> DailySettings {
        struct Body: Encodable, Sendable { let enabled: Bool; let expectedRevision: Int; let consentVersion: String? }
        return try await send(.post, "daily-ai-settings", body: Body(enabled: enabled, expectedRevision: expectedRevision, consentVersion: enabled ? consentVersion : nil))
    }

    func morningDigest() async throws -> MorningDigestStatus { try await get("morning-digest") }

    /// `localTime` is `HH:mm` in the member's timezone.
    func setMorningDigest(enabled: Bool, localTime: String, expectedRevision: Int) async throws -> MorningDigestStatus {
        struct Body: Encodable, Sendable { let enabled: Bool; let localTime: String; let expectedRevision: Int }
        return try await send(.post, "morning-digest", body: Body(enabled: enabled, localTime: localTime, expectedRevision: expectedRevision))
    }

    func setAssistant(enabled: Bool) async throws -> AssistantSettings {
        struct Body: Encodable, Sendable { let enabled: Bool }
        return try await send(.post, "assistant/settings", body: Body(enabled: enabled))
    }
}

// MARK: Web Push devices and capture credentials

public extension PlannerClient {
    func pushConfig() async throws -> PushConfig { try await get("push-config") }

    func pushSubscriptions() async throws -> [PushSubscription] {
        try await get("push-subscriptions", as: PushSubscriptionsResponse.self).subscriptions ?? []
    }

    func removePushSubscription(_ id: String) async throws {
        _ = try await send(.delete, "push-subscriptions/\(id)", as: JSONValue.self)
    }

    func testPushSubscription(_ id: String) async throws -> PushTestResult {
        try await send(.post, "push-subscriptions/\(id)/test")
    }

    func captureCredentials() async throws -> [CaptureCredential] {
        try await get("capture-credentials", as: CaptureCredentialsResponse.self).credentials ?? []
    }

    func createCaptureCredential(label: String) async throws -> NewCaptureCredential {
        struct Body: Encodable, Sendable { let label: String }
        return try await send(.post, "capture-credentials", body: Body(label: label))
    }

}

// MARK: Household knowledge

public extension PlannerClient {
    /// `expectedRevision` is 0 for a new fact.
    func saveKnowledge(key: String, value: String, expectedRevision: Int) async throws -> KnowledgeFact {
        struct Body: Encodable, Sendable { let key: String; let value: String; let expectedRevision: Int }
        return try await send(.post, "assistant/knowledge", body: Body(key: key, value: value, expectedRevision: expectedRevision))
    }

    func forgetKnowledge(key: String, expectedRevision: Int) async throws {
        _ = try await send(.delete, "assistant/knowledge/\(PlannerClient.pathSegment(key))", body: RevisionBody(expectedRevision: expectedRevision), as: JSONValue.self)
    }

    /// `expectedRevision` is the fact's current revision (0 if it was forgotten).
    func undoKnowledgeChange(_ id: String, expectedRevision: Int) async throws {
        _ = try await send(.post, "assistant/knowledge/history/\(id)/undo", body: RevisionBody(expectedRevision: expectedRevision), as: JSONValue.self)
    }

    /// `decision`: accept | dismiss.
    func decideKnowledgeProposal(_ id: String, decision: String) async throws {
        _ = try await send(.post, "assistant/knowledge/proposals/\(id)/\(decision)", as: JSONValue.self)
    }
}

// MARK: Relevance trial

public extension PlannerClient {
    func relevanceTrial() async throws -> TrialList { try await get("relevance-trial") }

    func nextTrialBatch() async throws -> TrialList { try await send(.post, "relevance-trial/next") }

    func rateTrialItem(_ id: String, vote: TrialVote, reason: String, expectedRevision: Int) async throws -> TrialList {
        struct Body: Encodable, Sendable { let value: TrialVote; let reason: String; let expectedRevision: Int }
        return try await send(.post, "relevance-trial/\(id)", body: Body(value: vote, reason: reason, expectedRevision: expectedRevision))
    }

    func trialSummary() async throws -> TrialSummaryRecord? { try await get("relevance-trial/summary") }

    func summarizeTrial() async throws -> TrialSummaryRecord { try await send(.post, "relevance-trial/summary") }

    func trialLearning() async throws -> TrialLearning { try await get("relevance-trial/learning") }

    func setTrialLearning(enabled: Bool, expectedRevision: Int) async throws -> TrialLearning {
        struct Body: Encodable, Sendable { let enabled: Bool; let expectedRevision: Int; let consentVersion: String? }
        return try await send(.post, "relevance-trial/learning", body: Body(enabled: enabled, expectedRevision: expectedRevision, consentVersion: enabled ? "personal-relevance-v1" : nil))
    }

    func forgetTrialLearning(expectedRevision: Int) async throws -> TrialLearning {
        try await send(.post, "relevance-trial/learning/forget", body: RevisionBody(expectedRevision: expectedRevision))
    }

    func clearTrial() async throws {
        _ = try await send(.delete, "relevance-trial", as: JSONValue.self)
    }
}
