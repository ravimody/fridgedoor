import FridgedoorKit
import SwiftUI

/// One exchange in the composer thread: what you asked, then the planner working on it,
/// then the result inline — the answer, proposals with their decisions, direct adds
/// with Undo, or what to do when it couldn't finish (C-01). Each message is its
/// own VoiceOver element, and the planner's replies are headings for rotor navigation.
struct ComposerThreadEntry: View {
    let run: AssistantRun
    /// Puts text in the field for a follow-up or a reworded request.
    let reuse: (String) -> Void
    @Environment(Router.self) private var router
    @Environment(ComposerModel.self) private var composer

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            UserMessage(run: run)
            response
        }
    }

    @ViewBuilder private var response: some View {
        if run.isWorking {
            HStack(spacing: 10) {
                ProgressView()
                Text(run.state == "queued" ? "Waiting to start…" : "Working on it…")
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(run.state == "queued" ? "The planner will start on this shortly" : "The planner is working on it")
        } else if run.state == "failed" {
            RequestFailureCard(run: run, rephrase: reuse) { composer.follow(run.id) }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Label("Planner", systemImage: "sparkles")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.plannerAccent)
                    .accessibilityAddTraits(.isHeader)
                RequestReplyView(run: run)
                if let result = run.result { RequestAssumptions(assumptions: result.assumptions) }
                RequestResultItems(run: run, headings: false)
                if let followups = run.result?.followups, !followups.isEmpty {
                    FlowChips(items: followups, action: reuse)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Follow-up suggestions")
                }
                Button { router.open(.request(run.id)) } label: {
                    HStack(spacing: 4) {
                        Text("Request details")
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.plannerAccent)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows sources, feedback and more")
            }
        }
    }
}

/// Your side of the thread, right-aligned like Messages.
private struct UserMessage: View {
    let run: AssistantRun

    var body: some View {
        let text = run.text.trimmingCharacters(in: .whitespacesAndNewlines)
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 4) {
                if !text.isEmpty {
                    Text(text)
                        .font(.body)
                        .foregroundStyle(Color.onAccent)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if run.captureId != nil {
                    Label("Photo or PDF", systemImage: "paperclip")
                        .font(.footnote)
                        .foregroundStyle(Color.onAccent.opacity(0.85))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.plannerAccent, in: .rect(cornerRadius: 18, style: .continuous))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("You asked: \(text.isEmpty ? "a photo or PDF" : text)\(run.captureId != nil && !text.isEmpty ? ", with a photo or PDF" : "")")
    }
}
