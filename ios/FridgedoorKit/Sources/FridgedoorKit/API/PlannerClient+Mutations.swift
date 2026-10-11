import Foundation

/// Write endpoints shared by several screens. Every create sends an
/// `Idempotency-Key`; every update sends the `expectedRevision` the screen saw.
public struct RevisionBody: Encodable, Sendable { public let expectedRevision: Int }
public struct DeletedResponse: Decodable, Sendable { public let archived: Bool?; public let deleted: Bool?; public let revoked: Bool? }

// MARK: Plans

public extension PlannerClient {
    func editPlan(_ id: String, expectedRevision: Int, facts: PlanFacts) async throws -> PlanSummary {
        struct Body: Encodable, Sendable { let expectedRevision: Int; let facts: PlanFacts }
        return try await send(.patch, "plans/\(id)", body: Body(expectedRevision: expectedRevision, facts: facts))
    }

    func sharePlan(_ id: String, expectedRevision: Int, reviewedFacts: PlanFacts) async throws -> PlanSummary {
        struct Body: Encodable, Sendable { let expectedRevision: Int; let reviewedFacts: PlanFacts }
        return try await send(.post, "plans/\(id)/share", body: Body(expectedRevision: expectedRevision, reviewedFacts: reviewedFacts))
    }

    func dismissPlan(_ id: String, expectedRevision: Int) async throws -> PlanSummary {
        try await send(.post, "plans/\(id)/dismiss", body: RevisionBody(expectedRevision: expectedRevision))
    }

    /// `keep` saves privately in the planner; `calendar` shares and queues a Google Calendar write.
    func decide(plan id: String, expectedRevision: Int, choice: String) async throws -> JSONValue {
        struct Body: Encodable, Sendable { let expectedRevision: Int; let choice: String }
        return try await send(.post, "plans/\(id)/decision", body: Body(expectedRevision: expectedRevision, choice: choice))
    }

    /// `kind`: create | update | cancel. Reuse the same key when retrying the same user action.
    func applyPlan(_ id: String, expectedRevision: Int, kind: String, idempotencyKey: String) async throws -> ActionStatus {
        struct Body: Encodable, Sendable { let expectedRevision: Int; let kind: String }
        return try await send(.post, "plans/\(id)/apply", body: Body(expectedRevision: expectedRevision, kind: kind), idempotencyKey: idempotencyKey)
    }

    func retryAction(_ actionId: String, expectedRevision: Int) async throws -> ActionStatus {
        try await send(.post, "actions/\(actionId)/retry", body: RevisionBody(expectedRevision: expectedRevision))
    }

    func actionStatus(_ actionId: String) async throws -> ActionStatus { try await get("actions/\(actionId)") }

    func planHistory(_ id: String) async throws -> [HistoryEntry] { try await get("plans/\(id)/history", as: HistoryResponse.self).entries }

    func planEvidence(_ id: String, sourceVersionId: String? = nil) async throws -> Evidence {
        try await get("plans/\(id)/evidence", query: sourceVersionId.map { ["sourceVersionId": $0] } ?? [:])
    }
}

// MARK: Lists

/// PATCH body for a list item. `nil` leaves a field unchanged; `.some(nil)` clears it.
public struct ListItemPatch: Encodable, Sendable {
    public var expectedRevision: Int
    public var title: String?
    public var quantity: String?
    public var assigneeId: String??
    public var dueTime: String??
    public var completed: Bool?

    public init(expectedRevision: Int, title: String? = nil, quantity: String? = nil, assigneeId: String?? = nil, dueTime: String?? = nil, completed: Bool? = nil) {
        self.expectedRevision = expectedRevision; self.title = title; self.quantity = quantity
        self.assigneeId = assigneeId; self.dueTime = dueTime; self.completed = completed
    }

    enum CodingKeys: String, CodingKey { case expectedRevision, title, quantity, assigneeId, dueTime, completed }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedRevision, forKey: .expectedRevision)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(quantity, forKey: .quantity)
        if let assigneeId { try c.encode(assigneeId, forKey: .assigneeId) }
        if let dueTime { try c.encode(dueTime, forKey: .dueTime) }
        try c.encodeIfPresent(completed, forKey: .completed)
    }
}

public extension PlannerClient {
    func createListItem(_ kind: ListKind, title: String, quantity: String? = nil, assigneeId: String? = nil, dueTime: String? = nil, idempotencyKey: String = UUID().uuidString) async throws -> ListItem {
        struct Body: Encodable, Sendable { let title: String; let quantity: String?; let assigneeId: String?; let dueTime: String? }
        return try await send(.post, "lists/\(kind.rawValue)/items", body: Body(title: title, quantity: quantity, assigneeId: assigneeId, dueTime: dueTime), idempotencyKey: idempotencyKey)
    }

    func updateListItem(_ id: String, _ patch: ListItemPatch) async throws -> ListItem {
        try await send(.patch, "list-items/\(id)", body: patch)
    }

    func deleteListItem(_ id: String, expectedRevision: Int) async throws {
        _ = try await send(.delete, "list-items/\(id)", body: RevisionBody(expectedRevision: expectedRevision), as: DeletedResponse.self)
    }

    /// Moves an open to-do's date to `date` (`yyyy-MM-dd`, future, member timezone).
    func snoozeListItem(_ id: String, expectedRevision: Int, date: String) async throws -> ListItem {
        struct Body: Encodable, Sendable { let expectedRevision: Int; let date: String }
        return try await send(.post, "list-items/\(id)/snooze", body: Body(expectedRevision: expectedRevision, date: date))
    }
}

// MARK: Reminders

public extension PlannerClient {
    /// `parentType`: plan | list_item. `offsetMinutes` makes the reminder follow the plan's time.
    func createReminder(parentType: String, parentId: String, dueAt: String, timezone: String, offsetMinutes: Int? = nil, recipientId: String? = nil, idempotencyKey: String = UUID().uuidString) async throws -> Reminder {
        struct Body: Encodable, Sendable { let parentType: String; let parentId: String; let recipientId: String?; let dueAt: String; let timezone: String; let offsetMinutes: Int? }
        return try await send(.post, "reminders", body: Body(parentType: parentType, parentId: parentId, recipientId: recipientId, dueAt: dueAt, timezone: timezone, offsetMinutes: offsetMinutes), idempotencyKey: idempotencyKey)
    }

    func updateReminder(_ id: String, expectedRevision: Int, snoozeUntil: String? = nil, completed: Bool? = nil, canceled: Bool? = nil) async throws -> Reminder {
        struct Body: Encodable, Sendable { let expectedRevision: Int; let snoozeUntil: String?; let completed: Bool?; let canceled: Bool? }
        return try await send(.patch, "reminders/\(id)", body: Body(expectedRevision: expectedRevision, snoozeUntil: snoozeUntil, completed: completed, canceled: canceled))
    }
}

// MARK: Morning review

public extension PlannerClient {
    /// Returns the remaining review plus an `undoToken` valid for five minutes.
    func dismissMorningItems(refs: [String], expectedRevision: Int) async throws -> DailyView {
        struct Body: Encodable, Sendable { let refs: [String]; let expectedRevision: Int }
        return try await send(.post, "daily-overview/dismiss", body: Body(refs: refs, expectedRevision: expectedRevision))
    }

    func restoreMorningItems(undoToken: String) async throws -> DailyView {
        struct Body: Encodable, Sendable { let undoToken: String }
        return try await send(.post, "daily-overview/restore", body: Body(undoToken: undoToken))
    }

    func refreshMorningReview(expectedRevision: Int) async throws -> JSONValue {
        try await send(.post, "daily-overview/refresh", body: RevisionBody(expectedRevision: expectedRevision))
    }

    func answerClarification(_ id: String, text: String, expectedRevision: Int) async throws -> JSONValue {
        struct Body: Encodable, Sendable { let text: String; let expectedRevision: Int }
        return try await send(.post, "clarifications/\(id)/answer", body: Body(text: text, expectedRevision: expectedRevision))
    }

    func dismissClarification(_ id: String, expectedRevision: Int) async throws -> JSONValue {
        try await send(.post, "clarifications/\(id)/dismiss", body: RevisionBody(expectedRevision: expectedRevision))
    }
}
