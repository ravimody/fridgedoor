import AVFoundation
import Foundation
import Observation
import FridgedoorKit
import Speech

/// One mic control: tap, speak, stop automatically on a pause and send (web
/// `VoiceInput.tsx` + `silence-stop.ts`). Transcription runs on the iPhone when an
/// on-device model exists; otherwise the clip is uploaded to `assistant/transcribe`,
/// which holds it in memory for that request only.
@MainActor @Observable
final class VoiceInputModel {
    enum Phase: Equatable { case idle, preparing, listening, finishing, transcribing }
    enum Engine: Equatable { case onDevice, server }

    private(set) var phase: Phase = .idle
    private(set) var engine: Engine?
    /// Live words while listening (on-device only).
    private(set) var transcript = ""
    /// Recent input levels, 0…1, newest last.
    private(set) var levels: [Double] = Array(repeating: 0, count: 32)
    private(set) var notice: String?
    /// Microphone permission is off; offer a Settings deep link.
    private(set) var needsSettings = false
    /// A clip whose server transcription failed, kept in memory for "Retry voice".
    private(set) var retryClip: Data?
    /// Whether retrying `retryClip` may send automatically (false after an interruption).
    private var retryAutoSend = true

    var isActive: Bool { phase != .idle }
    var isListening: Bool { phase == .listening }

    typealias Deliver = @MainActor (_ text: String, _ autoSend: Bool) async -> Void

    private var generation = 0
    private var capture: AudioCapture?
    private var sink: (any SpeechSink)?
    private var detector = PauseDetector()
    private var lastWordsAt: Date?
    private var stopReason: PauseDetector.Outcome?
    private var watchdog: Task<Void, Never>?
    /// Interruption, route and engine-configuration observers for the current recording.
    private var observers: [Task<Void, Never>] = []
    private var deliver: Deliver?
    private var client: PlannerClient?

    static let maxDuration: Duration = .seconds(120)
    /// Recognized words that stop changing for this long also end the request; the
    /// level detector alone can be fooled by steady background noise.
    static let wordQuiet: TimeInterval = 2
    /// How long to wait for an on-device speech model download before using another engine.
    static let modelTimeout: Duration = .seconds(8)

    /// Starts listening. Returns false when the mic is unavailable (see `notice`).
    @discardableResult
    func start(client: PlannerClient, deliver: @escaping Deliver) async -> Bool {
        guard phase == .idle else { return false }
        generation += 1
        let attempt = generation
        self.client = client; self.deliver = deliver
        phase = .preparing; notice = nil; needsSettings = false; retryClip = nil; transcript = ""
        levels = Array(repeating: 0, count: levels.count)
        detector = PauseDetector(); lastWordsAt = nil; stopReason = nil; engine = nil

        guard await microphoneAllowed() else {
            guard attempt == generation else { return false }
            phase = .idle; needsSettings = true
            notice = "Microphone access is off. Turn it on in Settings to speak requests, or use the keyboard's dictation."
            return false
        }
        guard attempt == generation else { return false }
        // Choose the engine before the audio session is active, so a model download never
        // holds the microphone; Cancel stays available while this runs.
        let modelReady = await AnalyzerSink.prepareAssets(timeout: Self.modelTimeout)
        guard attempt == generation else { return false }
        let recognizerAllowed = modelReady ? SFSpeechRecognizer.authorizationStatus() == .authorized : await speechRecognitionAllowed()
        guard attempt == generation else { return false }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            return fail("Couldn't start the microphone. Try again or use the keyboard's dictation.")
        }
        let capture = AudioCapture()
        let format = capture.inputFormat
        let onText: @Sendable (String) -> Void = { [weak self] text in
            Task { @MainActor in self?.heard(text, attempt: attempt) }
        }
        var sink: (any SpeechSink)? = modelReady ? await AnalyzerSink.make(inputFormat: format, onText: onText) : nil
        if sink == nil, recognizerAllowed { sink = RecognizerSink(onText: onText) }
        guard attempt == generation else { await sink?.cancel(); return false }
        engine = sink == nil ? .server : .onDevice
        if sink == nil {
            do { sink = try FileSink(format: format) } catch { return fail("Recording is unavailable right now. Use the keyboard's dictation.") }
        }
        do {
            try capture.start(sink: sink) { [weak self] rms, milliseconds in
                Task { @MainActor in self?.level(rms, milliseconds, attempt: attempt) }
            }
        } catch {
            await sink?.cancel()
            return fail("Couldn't start the microphone. Try again or use the keyboard's dictation.")
        }
        self.capture = capture
        self.sink = sink
        phase = .listening
        watchdog = Task { [weak self] in
            try? await Task.sleep(for: Self.maxDuration)
            guard !Task.isCancelled else { return }
            await self?.finish()
        }
        // A call, Siri or an alarm, a lost input device, or an engine reconfiguration
        // ends the recording; what was heard is kept for review instead of being sent.
        stopForReview(on: AVAudioSession.interruptionNotification) { note in
            (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
        }
        stopForReview(on: AVAudioSession.routeChangeNotification) { note in
            (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)) == .oldDeviceUnavailable
        }
        stopForReview(on: .AVAudioEngineConfigurationChange, object: capture.engine)
        return true
    }

    /// Tap to finish early, or called on a detected pause.
    func finish() async { await stop(reviewOnly: false) }

    /// Ends listening. `reviewOnly` (an interruption) delivers the words without sending.
    private func stop(reviewOnly: Bool) async {
        guard phase == .listening, let sink else { return }
        let attempt = generation
        phase = .finishing
        stopAudio()
        if let file = sink as? FileSink {
            self.sink = nil
            let audio = file.takeAudio()
            guard stopReason != .noSpeech, let audio else {
                phase = .idle
                notice = "No usable speech received. Tap the mic to try again."
                return
            }
            await transcribe(audio, attempt: attempt, autoSend: !reviewOnly)
            return
        }
        let (text, interrupted) = await sink.finish()
        self.sink = nil
        guard attempt == generation else { return }
        guard !text.isEmpty else {
            phase = .idle
            notice = "No speech received. Tap the mic to try again."
            return
        }
        transcript = text
        // Interrupted recognition keeps its words for review instead of sending a fragment.
        let review = interrupted || reviewOnly
        await deliver?(text, !review)
        guard attempt == generation else { return }
        phase = .idle
        transcript = ""
        notice = review ? Self.reviewNotice : nil
    }

    private static let reviewNotice = "Recording was interrupted, so it wasn't sent. Review the text, then send."

    func retry() async {
        guard phase == .idle, let clip = retryClip else { return }
        generation += 1
        await transcribe(clip, attempt: generation, autoSend: retryAutoSend)
    }

    /// Discards everything; late callbacks from this attempt are ignored.
    func cancel() {
        generation += 1
        let sink = self.sink
        stopAudio()
        self.sink = nil
        if let sink { Task { await sink.cancel() } }
        phase = .idle; transcript = ""; retryClip = nil; notice = nil; needsSettings = false
    }

    func clearNotice() { notice = nil; needsSettings = false }

    // MARK: Private

    private func transcribe(_ audio: Data, attempt: Int, autoSend: Bool) async {
        guard let client else { phase = .idle; return }
        phase = .transcribing
        notice = nil
        do {
            let text = try await client.transcribe(audio: audio)
            guard attempt == generation else { return }
            retryClip = nil
            transcript = text
            await deliver?(text, autoSend)
            guard attempt == generation else { return }
            transcript = ""
            if !autoSend { notice = Self.reviewNotice }
        } catch {
            guard attempt == generation else { return }
            retryClip = audio
            retryAutoSend = autoSend
            let code = (error as? PlannerError)?.code
            notice = code == "TRANSCRIPTION_LIMIT" || code == "TRANSCRIPTION_UNAVAILABLE" || code == "OFFLINE"
                ? (error as? PlannerError)?.assistantMessage
                : "Couldn't transcribe. Your recording is still here — retry, or type instead."
        }
        phase = .idle
    }

    private func level(_ rms: Float, _ milliseconds: Double, attempt: Int) {
        guard attempt == generation, phase == .listening else { return }
        levels.removeFirst()
        levels.append(min(1, Double(rms).squareRoot() * 3.2))
        if let outcome = detector.feed(rms: rms, milliseconds: milliseconds) {
            // On-device recognition that heard words ends normally even if the meter read low.
            stopReason = outcome == .noSpeech && !transcript.isEmpty ? .speechEnded : outcome
            if stopReason == .noSpeech, engine == .onDevice { noSpeech(); return }
            Task { await finish() }
        } else if let lastWordsAt, !transcript.isEmpty, Date.now.timeIntervalSince(lastWordsAt) >= Self.wordQuiet {
            stopReason = .speechEnded
            Task { await finish() }
        }
    }

    private func heard(_ text: String, attempt: Int) {
        guard attempt == generation, phase == .listening, text != transcript else { return }
        transcript = text
        detector.noteWords()
        lastWordsAt = .now
    }

    private func noSpeech() {
        cancel()
        notice = "No speech received. Tap the mic to try again."
    }

    private func fail(_ message: String) -> Bool {
        stopAudio()
        phase = .idle
        notice = message
        return false
    }

    private func stopForReview(on name: Notification.Name, object: AnyObject? = nil, when matches: @escaping @MainActor (Notification) -> Bool = { _ in true }) {
        observers.append(Task { [weak self] in
            for await note in NotificationCenter.default.notifications(named: name, object: object) where matches(note) {
                await self?.stop(reviewOnly: true)
            }
        })
    }

    private func stopAudio() {
        watchdog?.cancel(); watchdog = nil
        observers.forEach { $0.cancel() }; observers = []
        capture?.stop(); capture = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func microphoneAllowed() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: true
        case .denied: false
        default: await AVAudioApplication.requestRecordPermission()
        }
    }

    /// Nonisolated: the authorization callback arrives on a background queue.
    private nonisolated func speechRecognitionAllowed() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        default: return false
        }
    }
}
