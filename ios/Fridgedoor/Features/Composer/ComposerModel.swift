import Foundation
import Observation
import FridgedoorKit
import SwiftUI
import UIKit

/// Composer state persists across tabs and sheet dismissals for this app session:
/// the draft text, the attachment, an unsent submission's idempotency keys, and the
/// short thread of requests sent since the sheet was last opened fresh.
///
/// One status indicator (C-04): while the sheet is open the thread shows progress and
/// results; while it's closed the bottom accessory does ("Working on your request…",
/// then a result chip that stays until opened or dismissed). No toasts for either.
@MainActor @Observable
final class ComposerModel {
    var isPresented = false
    var draft = ""
    var attachment: ComposerAttachment?
    /// Error or status shown above the field.
    var notice: String?
    private(set) var isSending = false
    /// Requests shown in the sheet, oldest first.
    private(set) var thread: [String] = []
    /// Sent requests the server is still working on, oldest first.
    private(set) var workingRunIds: [String] = []
    /// A request that finished while the sheet was closed; the accessory shows it until opened or dismissed.
    private(set) var finishedRunId: String?
    /// Bumps when a sent request finishes, for haptics.
    private(set) var completions = 0
    private(set) var lastCompletionFailed = false

    let voice = VoiceInputModel()
    @ObservationIgnored let presence = PresencePinger()

    /// The server's zod `.max(8000)`, which counts UTF-16 code units (emoji count 2+).
    static let maxLength = 8000
    /// Stop following a request after this long; it stays in Requests.
    private static let watchLimit: Duration = .seconds(300)

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private weak var store: PlannerStore?
    /// Reused when a failed send is retried unchanged, so the server dedupes it.
    @ObservationIgnored private var pending: PendingSubmission?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var watchStarted: [String: ContinuousClock.Instant] = [:]

    private struct PendingSubmission {
        let clientId: String
        let text: String
        let attachmentId: UUID?
        var captureId: String?
    }

    /// The most recently sent request still being worked on.
    var workingRunId: String? { workingRunIds.last }

    /// Opens the sheet. A fresh open starts a new thread, unless a request is still
    /// being worked on: then the sheet shows that thread.
    func open(prefill: String? = nil) {
        if let prefill, !prefill.isEmpty { draft = prefill }
        if !isPresented {
            if let working = workingRunIds.last {
                if !thread.contains(working) { thread = [working] }
            } else {
                thread = []
            }
        }
        isPresented = true
    }

    /// Opens the sheet on the request that finished while it was closed.
    func openResult() {
        guard let id = finishedRunId else { open(); return }
        finishedRunId = nil
        if !thread.contains(id) { thread = [id] }
        isPresented = true
    }

    func dismissResult() { finishedRunId = nil }

    /// "New request" in the sheet: clears the thread; requests still working keep going.
    func startNewThread() {
        thread = []
        notice = nil
    }

    func reset() {
        isPresented = false; draft = ""
        attachment = nil; notice = nil; pending = nil
        voice.cancel()
        watchTask?.cancel(); watchTask = nil; watchStarted = [:]
        thread = []; workingRunIds = []; finishedRunId = nil
        if let client = store?.client { presence.setVisible(false, client: client) }
    }

    /// The accessory and sheet hand over the app's shared objects when they appear.
    func bind(app: AppModel, store: PlannerStore) {
        self.app = app; self.store = store
    }

    var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Length as the server counts it (UTF-16 code units).
    var draftLength: Int { draft.utf16.count }
    var canSend: Bool { !isSending && !voice.isActive && (!trimmedDraft.isEmpty || attachment != nil) && trimmedDraft.utf16.count <= Self.maxLength }
    var detectedLink: URL? { AssistantLinks.firstLink(in: draft) }

    func removeLink(_ url: URL) {
        draft = draft.replacingOccurrences(of: url.absoluteString, with: "")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Send

    /// Uploads the attachment (if any) and submits the request exactly like the web
    /// composer: `POST captures` then `POST assistant/runs {clientId, text, captureId?}`.
    func send() async {
        guard let store, !isSending else { return }
        let text = trimmedDraft
        guard !text.isEmpty || attachment != nil else { return }
        guard text.utf16.count <= Self.maxLength else { notice = "That message is too long (8,000 characters)."; return }
        guard store.assistantReady else { open(); return }
        isSending = true
        notice = nil
        defer { isSending = false }
        if pending == nil || pending?.text != text || pending?.attachmentId != attachment?.id {
            pending = PendingSubmission(clientId: UUID().uuidString.lowercased(), text: text, attachmentId: attachment?.id)
        }
        do {
            guard var submission = pending else { return }
            if let attachment, submission.captureId == nil {
                submission.captureId = try await store.client.uploadCapture(clientCaptureId: submission.clientId, file: attachment.data, filename: attachment.filename, mimeType: attachment.mimeType).captureId
                pending = submission
            }
            let run = try await store.client.submitAssistantRun(clientId: submission.clientId, text: text, captureId: submission.captureId)
            if store.assistantRun(run.id) == nil { store.replace(AssistantRun.pending(id: run.id, text: text, captureId: submission.captureId)) }
            pending = nil; draft = ""; attachment = nil
            // Sent from the bar with the sheet closed: a finished thread gives way to this one.
            if !isPresented && !thread.contains(where: workingRunIds.contains) { thread = [] }
            if !thread.contains(run.id) { thread.append(run.id) }
            // A newer request supersedes an unopened result chip; that one stays in Requests.
            finishedRunId = nil
            follow(run.id)
            store.pollSoon()
        } catch {
            let planner = error as? PlannerError
            notice = planner?.assistantMessage ?? "That didn't send. Your message is still here; try again."
            if planner?.code == "ASSISTANT_CONSENT_REQUIRED" { await store.refresh([.assistantSettings]) }
            // Voice requests sent from the bar surface the problem with the draft intact.
            open()
        }
    }

    // MARK: Voice

    /// Starts listening (mic in the bar or sheet). Opens the sheet when something
    /// needs the person first: consent or a permission.
    func startVoice() {
        guard let store else { return }
        guard store.assistantReady else { open(); return }
        notice = nil
        Task {
            let started = await voice.start(client: store.client) { [weak self] words, autoSend in
                await self?.receiveVoice(words, autoSend: autoSend)
            }
            if !started, voice.notice != nil { open() }
        }
    }

    private func receiveVoice(_ words: String, autoSend: Bool) async {
        let combined = trimmedDraft.isEmpty ? words : "\(trimmedDraft)\n\(words)"
        guard combined.utf16.count <= Self.maxLength else {
            notice = "That message is too long (8,000 characters). Shorten it, then send."
            open()
            return
        }
        draft = combined
        if autoSend { await send() } else { open() }
    }

    // MARK: Following requests

    /// Follows a sent (or retried) request until the server settles it.
    func follow(_ id: String) {
        workingRunIds.removeAll { $0 == id }
        workingRunIds.append(id)
        watchStarted[id] = .now
        guard watchTask == nil else { return }
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                // Cancelled by `reset()`, which already cleared `watchTask`.
                guard let self, !Task.isCancelled else { return }
                guard let store = self.store else { self.watchTask = nil; return }
                for id in self.workingRunIds {
                    let elapsed = self.watchStarted[id].map { ContinuousClock.now - $0 } ?? .zero
                    if let run = store.assistantRun(id), !run.isWorking {
                        self.finished(run)
                    } else if elapsed > Self.watchLimit || (store.assistantRun(id) == nil && elapsed > .seconds(15)) {
                        // Gone (deleted, expired) or taking far too long: stop following; Requests still has it.
                        self.stopFollowing(id)
                    }
                }
                if self.workingRunIds.isEmpty { self.watchTask = nil; return }
            }
        }
    }

    private func stopFollowing(_ id: String) {
        workingRunIds.removeAll { $0 == id }
        watchStarted[id] = nil
    }

    private func finished(_ run: AssistantRun) {
        stopFollowing(run.id)
        lastCompletionFailed = run.state == "failed"
        completions += 1
        let shownInSheet = isPresented && thread.contains(run.id)
        if !shownInSheet { finishedRunId = run.id }
        // The thread or chip shows the result; VoiceOver hears it once.
        let chip = store.map { ComposerResultChip(run: run, store: $0) }
        AccessibilityNotification.Announcement(chip.map { "The planner: \($0.message)" } ?? "The planner finished your request.").post()
    }

    /// Undoes every direct list add from a request (the chip's Undo).
    func undoAdds(_ run: AssistantRun) async {
        guard let store, let app else { return }
        do {
            try await store.undoRequestAdds(run)
            if finishedRunId == run.id { finishedRunId = nil }
            app.show("Undone.")
        } catch {
            app.show((error as? PlannerError)?.assistantMessage ?? "Undo didn't complete. Try again from the request.", isError: true)
        }
    }
}

/// How a finished request reads in one line: the accessory's result chip and the
/// VoiceOver announcement. Never a ✓ for something that still waits.
struct ComposerResultChip {
    enum Kind { case failed, review, added, reply }

    let kind: Kind
    let message: String

    @MainActor
    init(run: AssistantRun, store: PlannerStore) {
        if run.state == "failed" {
            (kind, message) = (.failed, "Couldn't finish")
            return
        }
        if let waiting = run.reviewCount(plans: store.plans).label {
            (kind, message) = (.review, waiting)
            return
        }
        let added = run.automaticItems.filter { $0.review.undoneAt == nil }
        if added.count == 1, let item = added.first {
            (kind, message) = (.added, "Added “\(item.item.title)”")
        } else if added.count > 1 {
            (kind, message) = (.added, "Added \(added.count) items")
        } else {
            (kind, message) = (.reply, "Reply ready")
        }
    }

    var systemImage: String {
        switch kind {
        case .failed: "exclamationmark.triangle.fill"
        case .review: "hand.raised.fill"
        case .added: "checkmark.circle.fill"
        case .reply: "text.bubble.fill"
        }
    }

    var tint: Color {
        switch kind {
        case .failed: .danger
        case .review: .attentionInk
        case .added, .reply: .plannerAccent
        }
    }
}
