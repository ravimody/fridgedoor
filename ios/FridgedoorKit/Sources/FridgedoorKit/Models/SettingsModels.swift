import Foundation

// Settings, household knowledge and relevance-trial payloads. Shapes follow the
// server services (`services/connections.ts`, `background-ai.ts`, `morning-digest.ts`,
// `reminders.ts`, `auth/capture.ts`, `auth/native.ts`, `relevance-trial.ts`) and
// `packages/contracts/src/relevance-trial.ts`. Optional fields stay lenient.

// MARK: Google sources

public struct SourcePolicy: Codable, Hashable, Sendable {
    public var excludedSenders: [String]
    public var excludedLabels: [String]
    public var genericAppointmentOptIn: Bool
    public let revision: Int

    public init(excludedSenders: [String], excludedLabels: [String], genericAppointmentOptIn: Bool, revision: Int) {
        self.excludedSenders = excludedSenders; self.excludedLabels = excludedLabels
        self.genericAppointmentOptIn = genericAppointmentOptIn; self.revision = revision
    }
}

public struct CalendarSyncStatus: Codable, Hashable, Sendable {
    public let lastSuccessAt: String?
    public let error: String? // reconnect | resyncing | failed
    public let stale: Bool
    public let imported: Int
    public let upcoming: Int
}

public struct SourceCalendar: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public var selected: Bool
    public var classification: String // household | personal | work
    public let accessRole: String
    public var isDestination: Bool?
    public var sync: CalendarSyncStatus?

    /// Mirrors the web `canWrite`: the server only accepts a selected, writable, non-work destination.
    public var canBeDestination: Bool { selected && isWritableNonWork }

    /// A saved destination keeps working when later unselected as a source (it is still
    /// read), but not once it is read-only or classified as work.
    public var isWritableNonWork: Bool { ["writer", "owner"].contains(accessRole) && classification != "work" }
}

public extension Array where Element == SourceCalendar {
    /// `id` when it is still an eligible destination among these calendars, else "".
    func eligibleDestination(_ id: String?) -> String {
        guard let id, !id.isEmpty, contains(where: { $0.id == id && $0.canBeDestination }) else { return "" }
        return id
    }
}

public struct CalendarSelection: Codable, Hashable, Sendable {
    public let id: String
    public let selected: Bool
    public let classification: String
    public init(id: String, selected: Bool, classification: String) { self.id = id; self.selected = selected; self.classification = classification }
}

// MARK: AI settings

public struct BackgroundAiStatus: Codable, Hashable, Sendable {
    public let provider: String?
    public let model: String?
    public let failuresLastDay: Int
    public let available: Bool
    public let enabled: Bool
    public let revision: Int
    public let connectionActive: Bool
    public let attemptsLastDay: Int
    public let attemptsLastHour: Int
    public let volumeWarning: Bool
    public let pausedForVolume: Bool
    public let dailyLimit: Int
    public let hourlyLimit: Int
    public let pending: Int
    public let lastProcessedAt: String?
}

// `MorningDigestStatus` lives in PlatformModels.swift (shared with local notifications).

// MARK: Devices and credentials

public struct PushSubscription: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let status: String // enabled | disabled
    public let endpointHash: String?
    public let createdAt: String?
    public let lastUsedAt: String?
}

public struct PushSubscriptionsResponse: Codable, Sendable { public let subscriptions: [PushSubscription]? }

public struct PushConfig: Codable, Hashable, Sendable {
    public let enabled: Bool
    public let publicKey: String?
}

public struct PushTestResult: Codable, Hashable, Sendable { public let state: String } // accepted | gone | failed

public struct CaptureCredential: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let status: String // active | revoked
    public let createdAt: String?
    public let revokedAt: String?
    public let lastUsedAt: String?
}

public struct CaptureCredentialsResponse: Codable, Sendable { public let credentials: [CaptureCredential]? }

/// Returned once by `POST capture-credentials`; the token is never readable again.
public struct NewCaptureCredential: Codable, Hashable, Sendable {
    public let id: String
    public let label: String
    public let token: String
}

public struct NativeSessionInfo: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let createdAt: String
    public let lastUsedAt: String?
}

public struct NativeSessionsResponse: Codable, Hashable, Sendable {
    public let currentId: String
    public let sessions: [NativeSessionInfo]
}

// MARK: Relevance trial

public enum TrialVote: String, Codable, CaseIterable, Sendable {
    case useful, notUseful = "not_useful", skip
    public var label: String {
        switch self { case .useful: "Useful"; case .notUseful: "Not useful"; case .skip: "Skipped" }
    }
}

public struct TrialSource: Codable, Hashable, Sendable {
    public let sender: String?
    public let excerpt: String?
    public let available: Bool
}

public struct TrialItem: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let facts: PlanFacts
    public let source: TrialSource?
    public let observedAt: String
    public let value: TrialVote?
    public let reason: String
    public let revision: Int
}

public struct TrialList: Codable, Hashable, Sendable {
    public let items: [TrialItem]
    public let expiresAt: String?
}

public struct TrialPreference: Codable, Hashable, Sendable {
    public let direction: String // prefer | avoid | uncertain
    public let pattern: String
    public let evidenceIds: [String]
}

public struct TrialSummary: Codable, Hashable, Sendable {
    public let overview: String
    public let preferences: [TrialPreference]
}

public struct TrialSummaryRecord: Codable, Hashable, Sendable {
    public let result: TrialSummary
    public let generatedAt: String?
}

public struct TrialLearning: Codable, Hashable, Sendable {
    public let enabled: Bool
    public let revision: Int
    public let preferences: [TrialPreference]
    public let generatedAt: String?

    public init(enabled: Bool, revision: Int, preferences: [TrialPreference], generatedAt: String?) {
        self.enabled = enabled; self.revision = revision; self.preferences = preferences; self.generatedAt = generatedAt
    }
}
