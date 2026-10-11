import FridgedoorKit
import SwiftUI

/// The persistent "Ask, add, or share…" bar in the tab view's bottom accessory.
/// Tapping opens the composer sheet; the mic starts listening right here, with a
/// live level meter and transcript, and sends when you pause. With the sheet closed
/// it is the one place a request's progress shows: "Working on your request…", then
/// a result chip that stays until it's opened or dismissed (C-04).
struct ComposerAccessory: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(ComposerModel.self) private var composer
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
    @Environment(\.scenePhase) private var scenePhase

    private var inline: Bool { placement == .inline }

    var body: some View {
        let voice = composer.voice
        HStack(spacing: inline ? 8 : 10) {
            if voice.isActive && !composer.isPresented {
                listening(voice)
            } else if composer.isSending && !composer.isPresented {
                status(spinner: true, text: "Sending…")
            } else if composer.workingRunId != nil, !composer.isPresented {
                working
            } else if let id = composer.finishedRunId, let run = store.assistantRun(id), !composer.isPresented {
                result(run)
            } else {
                field
            }
        }
        .padding(.leading, inline ? 12 : 16)
        .padding(.trailing, 4)
        .frame(maxWidth: .infinity, minHeight: 44)
        .animation(.snappy, value: voice.phase)
        .animation(.snappy, value: composer.workingRunId)
        .animation(.snappy, value: composer.finishedRunId)
        .sensoryFeedback(trigger: composer.completions) { _, _ in composer.lastCompletionFailed ? .error : .success }
        .task { composer.bind(app: app, store: store) }
        .task(id: scenePhase) { composer.presence.setVisible(scenePhase == .active, client: store.client) }
    }

    private var field: some View {
        HStack(spacing: inline ? 8 : 10) {
            Button { composer.open() } label: {
                HStack(spacing: 8) {
                    Image(systemName: composer.attachment == nil ? "sparkles" : "paperclip")
                        .foregroundStyle(Color.plannerAccent)
                        .imageScale(.medium)
                    Text(composer.trimmedDraft.isEmpty ? (composer.attachment == nil ? "Ask, add, or share…" : "Photo or PDF ready to send") : composer.trimmedDraft)
                        .lineLimit(1)
                        .foregroundStyle(composer.trimmedDraft.isEmpty ? Color.muted : Color.ink)
                    Spacer(minLength: 0)
                }
                .frame(maxHeight: .infinity)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(composer.trimmedDraft.isEmpty ? "Ask, add, or share" : "Continue draft: \(composer.trimmedDraft)")
            .accessibilityHint("Opens Ask the planner")
            VoiceMicButton(size: inline ? 32 : 36)
        }
    }

    private func listening(_ voice: VoiceInputModel) -> some View {
        HStack(spacing: 10) {
            if voice.isListening {
                VoiceLevelsView(levels: voice.levels, count: inline ? 10 : 16)
            } else {
                ProgressView().controlSize(.small)
            }
            Text(voice.transcript.isEmpty ? listeningLabel(voice) : voice.transcript)
                .lineLimit(1)
                .truncationMode(.head)
                .foregroundStyle(voice.transcript.isEmpty ? Color.muted : Color.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Cancel", systemImage: "xmark") { voice.cancel() }
                .labelStyle(.iconOnly)
                .foregroundStyle(Color.muted)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.rect)
                .opacity(voice.isListening || voice.phase == .preparing ? 1 : 0)
            VoiceMicButton(size: inline ? 32 : 36)
        }
        .accessibilityElement(children: .contain)
    }

    private func listeningLabel(_ voice: VoiceInputModel) -> String {
        switch voice.phase {
        case .preparing: "Starting…"
        case .listening: "Listening…"
        case .finishing: "Finishing…"
        case .transcribing: "Transcribing…"
        case .idle: ""
        }
    }

    private var working: some View {
        Button { composer.open() } label: {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Working on your request…").lineLimit(1).foregroundStyle(Color.ink)
                Spacer(minLength: 0)
            }
            .padding(.trailing, 12)
            .frame(maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("The planner is working on your request")
        .accessibilityHint("Opens the request")
    }

    /// A finished request, until it's opened or dismissed: "Reply ready · View",
    /// "1 plan to review · View", "Added 3 items · Undo", "Couldn't finish · View".
    private func result(_ run: AssistantRun) -> some View {
        let chip = ComposerResultChip(run: run, store: store)
        return HStack(spacing: inline ? 4 : 6) {
            Button { composer.openResult() } label: {
                HStack(spacing: 8) {
                    Image(systemName: chip.systemImage).foregroundStyle(chip.tint).imageScale(.medium)
                    Text(chip.message).lineLimit(1).foregroundStyle(Color.ink)
                    if chip.kind != .added || !inline {
                        Text("· View").lineLimit(1).font(.subheadline.weight(.semibold)).foregroundStyle(Color.plannerAccent)
                            .layoutPriority(1)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxHeight: .infinity)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(chip.message)
            .accessibilityHint("Opens the result")
            if chip.kind == .added {
                Button("Undo") { Task { await composer.undoAdds(run) } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.plannerAccent)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
                    .accessibilityLabel("Undo: \(chip.message)")
            }
            if !inline {
                Button { composer.dismissResult() } label: {
                    Image(systemName: "xmark").font(.footnote.weight(.bold)).foregroundStyle(Color.muted)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss result")
            }
        }
    }

    private func status(spinner: Bool, text: String) -> some View {
        HStack(spacing: 10) {
            if spinner { ProgressView().controlSize(.small) }
            Text(text).foregroundStyle(Color.muted)
            Spacer(minLength: 0)
        }
    }
}
