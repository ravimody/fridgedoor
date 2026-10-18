import Foundation

// Assistant requests, captures and voice transcription. Request bodies mirror
// `server/src/routes/assistant.ts` and `routes/captures.ts` exactly — both
// parse with strict Zod schemas, so unknown keys are rejected.

public struct SubmittedRun: Decodable, Sendable { public let id: String }
public struct TranscriptResponse: Decodable, Sendable { public let text: String }
public struct AppliedRun: Decodable, Sendable { public let planIds: [String] }

public enum AssistantReviewTarget: String, Encodable, Sendable { case item, knowledge }

/// `save` (list items, knowledge), `keep` / `calendar` (events), `dismiss` (any).
public enum AssistantReviewChoice: String, Encodable, Sendable { case save, keep, calendar, dismiss }

public enum AssistantFeedback: String, Encodable, Sendable {
    case helpful
    case needsWork = "needs_work"
}

public extension PlannerClient {
    /// `POST assistant/runs`. Reuse `clientId` when retrying the same submission;
    /// the server answers with the existing run instead of creating a duplicate.
    func submitAssistantRun(clientId: String, text: String, captureId: String? = nil) async throws -> SubmittedRun {
        struct Body: Encodable, Sendable { let clientId: String; let text: String; let captureId: String? }
        return try await send(.post, "assistant/runs", body: Body(clientId: clientId, text: text, captureId: captureId))
    }

    /// `POST captures` (multipart). `clientCaptureId` must be a UUID; the server sniffs
    /// the bytes and accepts JPEG, PNG, PDF (and HEIC only when it can convert it).
    func uploadCapture(clientCaptureId: String, file: Data, filename: String, mimeType: String) async throws -> CaptureReceipt {
        try await upload("captures", fields: ["clientCaptureId": clientCaptureId], file: file, filename: filename, mimeType: mimeType)
    }

    /// `POST captures` (JSON) for a shared link or a note.
    func createCapture(clientCaptureId: String, text: String? = nil, url: String? = nil) async throws -> CaptureReceipt {
        struct Body: Encodable, Sendable { let clientCaptureId: String; let text: String?; let url: String? }
        return try await send(.post, "captures", body: Body(clientCaptureId: clientCaptureId, text: text, url: url))
    }

    func setAssistantEnabled(_ enabled: Bool) async throws -> AssistantSettings {
        struct Body: Encodable, Sendable { let enabled: Bool }
        return try await send(.post, "assistant/settings", body: Body(enabled: enabled))
    }

    /// Records one review decision. `edited` is sent only when the person changed the item.
    func reviewAssistantRun(_ runId: String, target: AssistantReviewTarget, index: Int, choice: AssistantReviewChoice, edited: AssistantItem? = nil) async throws -> AssistantReview {
        struct Body: Encodable, Sendable { let target: AssistantReviewTarget; let index: Int; let choice: AssistantReviewChoice; let edited: AssistantItem? }
        return try await send(.post, "assistant/runs/\(runId)/review", body: Body(target: target, index: index, choice: choice, edited: edited))
    }

    /// Archives a directly added list item if nobody changed it since.
    func undoAssistantItem(_ runId: String, index: Int) async throws {
        struct Body: Encodable, Sendable { let index: Int }
        struct Undone: Decodable, Sendable { let undone: Bool }
        _ = try await send(.post, "assistant/runs/\(runId)/undo", body: Body(index: index), as: Undone.self)
    }

    /// Saves every item of an unreviewed result at once (lists → shared lists, events → private plan drafts).
    func applyAssistantRun(_ runId: String) async throws -> AppliedRun {
        try await send(.post, "assistant/runs/\(runId)/apply", body: [String: String]())
    }

    func retryAssistantRun(_ runId: String) async throws {
        struct Queued: Decodable, Sendable { let queued: Bool }
        _ = try await send(.post, "assistant/runs/\(runId)/retry", body: [String: String](), as: Queued.self)
    }

    func sendAssistantFeedback(_ runId: String, _ value: AssistantFeedback) async throws {
        struct Body: Encodable, Sendable { let value: AssistantFeedback }
        struct Saved: Decodable, Sendable { let saved: Bool }
        _ = try await send(.post, "assistant/runs/\(runId)/feedback", body: Body(value: value), as: Saved.self)
    }

    func deleteAssistantRun(_ runId: String) async throws {
        struct Deleted: Decodable, Sendable { let deleted: Bool }
        _ = try await send(.delete, "assistant/runs/\(runId)", as: Deleted.self)
    }

    /// Server transcription fallback. The server holds the audio in memory for the
    /// request only; it is never written to planner storage or logs.
    func transcribe(audio: Data, filename: String = "recording.m4a", mimeType: String = "audio/mp4") async throws -> String {
        try await upload("assistant/transcribe", fields: [:], file: audio, filename: filename, mimeType: mimeType, as: TranscriptResponse.self).text
    }

    /// While the app is visible the server suppresses activity pushes for this member.
    func assistantPresence(clientId: String, visible: Bool) async throws {
        struct Body: Encodable, Sendable { let clientId: String; let visible: Bool }
        struct Recorded: Decodable, Sendable { let recorded: Bool }
        _ = try await send(.post, "assistant/presence", body: Body(clientId: clientId, visible: visible), as: Recorded.self)
    }
}

public extension PlannerError {
    /// Copy for assistant/capture failures (mirrors the web `Assistant.tsx` messages),
    /// falling back to the shared `userMessage`.
    var assistantMessage: String {
        switch code {
        case "UNSUPPORTED_HEIC_CONVERSION": "This photo is HEIC and couldn't be converted. Try another photo or a screenshot."
        case "CAPTURE_TOO_LARGE": "Choose a photo or PDF smaller than 10 MB."
        case "CAPTURE_IMAGE_TOO_LARGE": "That image is too large to read. Try a smaller photo or a screenshot."
        case "CAPTURE_TOO_MANY_PAGES": "PDFs can have up to 10 pages."
        case "PDF_PAGE_COUNT_UNAVAILABLE", "UNSUPPORTED_OR_CORRUPT_FILE": "That file couldn't be read. Use a JPEG, PNG or PDF."
        case "CAPTURE_IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT": "That request was already sent with different details. Try again."
        case "ASSISTANT_BUSY": "Several requests are waiting. Let them finish, then send this one."
        case "KNOWLEDGE_LIMIT": "There are 50 remembered facts. Edit or forget an existing fact before adding another."
        case "INPUT_REQUIRED", "CAPTURE_INPUT_REQUIRED": "Type a message or attach a photo or PDF."
        case "INPUT_TOO_LONG", "CAPTURE_TEXT_TOO_LONG": "That message is too long (8,000 characters)."
        case "INVALID_AUDIO": status == 413 ? "That recording is too long. Keep voice requests under two minutes." : "That recording couldn't be used. Try again or type instead."
        case "TRANSCRIPTION_FAILED": "Couldn't transcribe that. Try again or type instead."
        case "RESULT_PARTIALLY_REVIEWED": "Some items were already reviewed. Review the rest one at a time."
        case "RESULT_NOT_READY": "This request is still being worked on."
        case "PLAN_ALREADY_APPLIED": "This event is already on the calendar. Open it to change or remove it."
        case "EDIT_SAVED_PLAN": "This event is already saved. Open it to edit the details."
        case "RUN_NOT_FAILED": "This request is already being retried."
        case "CAPTURE_UNAVAILABLE": "The attachment for this request has expired."
        case "VALIDATION": "Some details aren't valid. Check the title and times, then try again."
        default: userMessage
        }
    }
}
