import Foundation

/// What the iPhone app hands the Apple Watch app over WatchConnectivity: the widget
/// snapshot plus the daily brief and the planner's open questions. The watch holds
/// no credential and never talks to the server; it shows this and asks the phone
/// to act with a `WatchCommand`.
public struct WatchPayload: Codable, Hashable, Sendable {
    public struct Brief: Codable, Hashable, Sendable {
        public let summary: String
        public let generatedAt: Date
        public init(summary: String, generatedAt: Date) { self.summary = summary; self.generatedAt = generatedAt }
    }

    /// One of the planner's questions (Home → Decisions), answered in a sentence.
    public struct Question: Codable, Hashable, Sendable, Identifiable {
        public let id: String
        public let text: String
        public let revision: Int
        public init(id: String, text: String, revision: Int) { self.id = id; self.text = text; self.revision = revision }
    }

    public static let maxQuestions = 4
    public static let maxDecisions = 6

    public let snapshot: WidgetSnapshot
    public let brief: Brief?
    /// Suggestions the brief flags as needing you: the same list as Home → Decisions.
    public let decisions: [WidgetSnapshot.DecisionRow]
    public let questions: [Question]

    public init(snapshot: WidgetSnapshot, brief: Brief?, decisions: [WidgetSnapshot.DecisionRow], questions: [Question]) {
        self.snapshot = snapshot; self.brief = brief
        self.decisions = Array(decisions.prefix(Self.maxDecisions)); self.questions = Array(questions.prefix(Self.maxQuestions))
    }

    /// Builds the payload from what the phone has, choosing what Home shows:
    /// - the brief's summary, only if it's a ready brief from today (member's timezone),
    ///   so the watch never shows yesterday's morning as this morning's;
    /// - the brief's decisions and deadlines whose suggestion is still open (decided
    ///   ones drop off at once, where Home shows them as Saved until the next brief);
    /// - the planner's open questions, except one that only asks for a time a
    ///   suggestion above already needs.
    public init(snapshot: WidgetSnapshot, daily: DailyView?, clarifications: [Clarification], plans: [PlanSummary], googleReady: Bool, now: Date = .now) {
        var brief: Brief?
        if let daily, daily.state == "ready", let summary = daily.result?.summary.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty,
           !Self.placeholderSummaries.contains(summary),
           let generated = PlannerDates.instant(daily.generatedAt), snapshot.calendar.isDate(generated, inSameDayAs: now) {
            brief = Brief(summary: summary, generatedAt: generated)
        }

        let zone = snapshot.timeZone
        let plansById = Dictionary(plans.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var decisions: [WidgetSnapshot.DecisionRow] = []
        var needsTimeRefs = Set<String>()
        for item in daily?.items ?? [] where item.category == "decision" || item.category == "deadline" {
            if let planId = item.targets?.first(where: { $0.kind == "plan" })?.id {
                // Saved, added to the calendar or dismissed since the brief was written:
                // no longer waiting on anyone (Home keeps it with its status until the next brief).
                guard let plan = plansById[planId], WidgetSnapshotBuilder.isWaiting(plan) else { continue }
                let row = WidgetSnapshotBuilder.decisionRow(plan, googleReady: googleReady, zone: zone, now: now)
                if row.action == nil {
                    needsTimeRefs.formUnion(item.refs + (item.sourceRefs ?? []))
                }
                decisions.append(row)
            } else {
                let detail = item.normalizedTime.map { WidgetSnapshot.label($0, zone: zone, now: now) } ?? item.detail
                decisions.append(.init(id: "brief:\(item.id)", title: item.displayTitle, detail: detail, action: nil, isPrivate: false))
            }
        }
        let questions = clarifications
            .filter { $0.state == "open" && Set($0.sourceRefs ?? []).isDisjoint(with: needsTimeRefs) }
            .map { Question(id: $0.id, text: $0.question, revision: $0.revision) }
        self.init(snapshot: snapshot, brief: brief, decisions: decisions, questions: questions)
    }

    /// Server placeholders left after the whole brief is dismissed (see HomeSnapshot.summary).
    static let placeholderSummaries: Set<String> = ["Your remaining morning review.", "Your morning review"]

    /// Everything waiting on a decision, as Home counts it.
    public var decisionCount: Int { decisions.count + questions.count }

    /// Payload equality ignoring `generatedAt`, so an unchanged refresh isn't resent.
    public func sameContent(as other: WatchPayload?) -> Bool {
        guard let other else { return false }
        return snapshot.sameContent(as: other.snapshot) && brief == other.brief && decisions == other.decisions && questions == other.questions
    }

    /// A copy without a decided suggestion or a handled question, shown at once on the watch.
    public func removing(decision id: String) -> WatchPayload {
        WatchPayload(snapshot: snapshot, brief: brief, decisions: decisions.filter { $0.id != id }, questions: questions.filter { $0.id != id })
    }

    // MARK: Transport

    /// WatchConnectivity application-context key.
    public static let contextKey = "payload"

    public func encoded() throws -> Data { try JSONEncoder().encode(self) }
    public static func decode(_ data: Data) -> WatchPayload? { try? JSONDecoder().decode(WatchPayload.self, from: data) }

    // MARK: Storage on the watch (the app and its complications share it)

    static var fileURL: URL? {
        SharedContainer.appGroup.flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }?.appending(path: "watch-payload.json")
    }
    static var keychain: KeychainStore { KeychainStore(service: "dev.fridgedoor.watch", accessGroup: SharedContainer.sharedKeychainGroup) }

    /// Saves (or with nil, removes) the payload where the watch's complications can read it.
    public static func store(_ payload: WatchPayload?) {
        let data = payload.flatMap { try? $0.encoded() }
        guard let url = fileURL else {
            keychain.set(data, for: "watch-payload")
            return
        }
        if let data {
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }

    public static func stored() -> WatchPayload? {
        let data = fileURL.map { try? Data(contentsOf: $0) } ?? keychain.data("watch-payload")
        return data.flatMap(decode)
    }
}

/// What the watch asks the phone to do. The phone runs it with its own session and
/// replies with `WatchReply`.
public enum WatchCommand: Codable, Hashable, Sendable {
    /// Save a suggestion, or add it to the household calendar (`keep` / `calendar`).
    case decide(planId: String, choice: WidgetSnapshot.DecisionRow.Action)
    /// Answer one of the planner's questions.
    case answer(questionId: String, text: String, revision: Int)
    /// Dismiss one of the planner's questions.
    case dismiss(questionId: String, revision: Int)
    /// Send a fresh payload.
    case refresh

    public static let messageKey = "command"

    public func message() throws -> [String: Any] { [Self.messageKey: try JSONEncoder().encode(self)] }

    public init?(message: [String: Any]) {
        guard let data = message[Self.messageKey] as? Data, let command = try? JSONDecoder().decode(WatchCommand.self, from: data) else { return nil }
        self = command
    }
}

/// The phone's answer to a `WatchCommand`: nil `error` means it worked.
public struct WatchReply: Sendable, Equatable {
    public let error: String?
    public init(error: String?) { self.error = error }

    public static let ok = WatchReply(error: nil)
    public var message: [String: Any] { error.map { ["error": $0] } ?? [:] }
    public init(message: [String: Any]) { error = message["error"] as? String }
}
