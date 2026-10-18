import FridgedoorKit
import SwiftUI
import UIKit

/// Live input level as a row of rounded bars (newest on the right).
struct VoiceLevelsView: View {
    let levels: [Double]
    var count = 24
    var color: Color = .plannerAccent

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(Array(levels.suffix(count).enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(color)
                    .frame(width: 3, height: 4 + 20 * level)
            }
        }
        .frame(height: 24)
        .animation(.linear(duration: 0.08), value: levels)
        .accessibilityHidden(true)
    }
}

/// The single mic control: mic → stop while listening → spinner while sending.
struct VoiceMicButton: View {
    @Environment(ComposerModel.self) private var composer
    var size: CGFloat = 44

    var body: some View {
        let voice = composer.voice
        Button {
            if voice.isListening { Task { await voice.finish() } } else if !voice.isActive { composer.startVoice() }
        } label: {
            ZStack {
                if voice.phase == .preparing || voice.phase == .finishing || voice.phase == .transcribing {
                    ProgressView().tint(Color.plannerAccent)
                } else {
                    Image(systemName: voice.isListening ? "stop.fill" : "mic.fill")
                        .font(.system(size: size * 0.4, weight: .semibold))
                        .foregroundStyle(voice.isListening ? Color.onAccent : Color.plannerAccent)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .frame(width: size, height: size)
            .background(voice.isListening ? Color.plannerAccent : Color.soft, in: .circle)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .disabled(composer.isSending || (voice.isActive && !voice.isListening))
        .accessibilityLabel(voice.isListening ? "Finish recording" : voice.isActive ? "Sending voice" : "Record voice")
        .accessibilityHint(voice.isListening ? "Sends what you said" : "Speak a request; it sends when you pause")
        .sensoryFeedback(.start, trigger: voice.isListening) { _, listening in listening }
    }
}

/// Listening state, live transcript and privacy note inside the sheet.
struct VoicePanel: View {
    @Environment(ComposerModel.self) private var composer

    var body: some View {
        let voice = composer.voice
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                VoiceLevelsView(levels: voice.levels, count: 28)
                Spacer(minLength: 0)
                Text(status(voice)).font(.subheadline.weight(.medium)).foregroundStyle(Color.plannerAccent)
                if voice.phase == .preparing || voice.isListening {
                    Button("Cancel", systemImage: "xmark") { voice.cancel() }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(Color.muted)
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel("Cancel recording")
                }
            }
            if !voice.transcript.isEmpty {
                Text(voice.transcript)
                    .font(.body)
                    .foregroundStyle(Color.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
            }
            if let privacy = privacy(voice) {
                Text(privacy)
                    .font(.caption)
                    .foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .plannerCard(.soft, padding: 14)
        .animation(.snappy, value: voice.transcript)
        .accessibilityElement(children: .contain)
    }

    private func status(_ voice: VoiceInputModel) -> String {
        switch voice.phase {
        case .preparing: "Starting…"
        case .listening: voice.transcript.isEmpty ? "Listening…" : "Pause to send · tap ■ to finish"
        case .finishing: "Finishing…"
        case .transcribing: "Transcribing…"
        case .idle: ""
        }
    }

    /// Nothing until the engine is known: it's only chosen once the mic is ready.
    private func privacy(_ voice: VoiceInputModel) -> String? {
        switch voice.engine {
        case .onDevice: "Transcribed on this iPhone. Audio isn't stored or sent."
        case .server: "Your recording is sent to the planner and transcribed by your household's AI provider, under its data policy. On this iPhone it's held briefly in a temporary file, then deleted."
        case nil: nil
        }
    }
}

/// Voice problems (permission off, nothing heard, transcription failed) with recovery.
struct VoiceNotice: View {
    @Environment(ComposerModel.self) private var composer
    @Environment(\.openURL) private var openURL

    var body: some View {
        let voice = composer.voice
        if let notice = voice.notice {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: voice.needsSettings ? "mic.slash" : "waveform.badge.exclamationmark")
                    .foregroundStyle(Color.warning)
                VStack(alignment: .leading, spacing: 8) {
                    Text(notice).font(.subheadline).foregroundStyle(Color.ink)
                    HStack(spacing: 10) {
                        if voice.needsSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                            Button("Open Settings") { openURL(url) }.buttonStyle(.plannerQuiet)
                        }
                        if voice.retryClip != nil {
                            Button("Retry voice") { Task { await voice.retry() } }.buttonStyle(.plannerQuiet)
                        }
                    }
                }
                Spacer(minLength: 0)
                Button { voice.clearNotice() } label: { Image(systemName: "xmark").font(.caption.weight(.bold)) }
                    .foregroundStyle(Color.muted)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Close")
            }
            .plannerCard(.soft, padding: 12)
        }
    }
}
