import Accelerate
import AVFoundation
import Foundation
import Speech

// Audio plumbing for voice requests. Everything here is deliberately nonisolated:
// the engine's tap block runs on a real-time audio thread, and a closure formed in
// a MainActor context would trap there under Swift 6 isolation checks.

/// Where microphone buffers go while listening.
protocol SpeechSink: AnyObject, Sendable {
    func append(_ buffer: AVAudioPCMBuffer)
    /// Final text and whether recognition was interrupted.
    func finish() async -> (text: String, interrupted: Bool)
    func cancel() async
}

enum VoiceError: Error { case noInput }

/// Resumes a continuation with the first value offered; later offers are ignored.
/// Lets a deadline win without waiting for the work it gave up on.
final class FirstValue<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?

    init(_ continuation: CheckedContinuation<Value, Never>) { self.continuation = continuation }

    func offer(_ value: Value) {
        let waiting = lock.withLock { () -> CheckedContinuation<Value, Never>? in
            defer { continuation = nil }
            return continuation
        }
        waiting?.resume(returning: value)
    }
}

/// Runs `work` in an unstructured task and returns its value, or nil once `timeout`
/// passes. The work is not awaited past the deadline (it may keep running).
func valueWithin<Value: Sendable>(_ timeout: Duration, _ work: @escaping @Sendable () async -> Value) async -> Value? {
    var tasks: [Task<Void, Never>] = []
    let value: Value? = await withCheckedContinuation { continuation in
        let first = FirstValue<Value?>(continuation)
        tasks.append(Task { first.offer(await work()) })
        tasks.append(Task { try? await Task.sleep(for: timeout); first.offer(nil) })
    }
    tasks.last?.cancel()
    return value
}

/// Owns the `AVAudioEngine` input tap and reports a level per buffer.
final class AudioCapture: @unchecked Sendable {
    /// Exposed for `AVAudioEngineConfigurationChange` observation.
    let engine = AVAudioEngine()

    var inputFormat: AVAudioFormat { engine.inputNode.outputFormat(forBus: 0) }

    func start(sink: (any SpeechSink)?, onLevel: @escaping @Sendable (_ rms: Float, _ milliseconds: Double) -> Void) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceError.noInput }
        let sampleRate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            sink?.append(buffer)
            onLevel(Self.rms(buffer), Double(buffer.frameLength) / sampleRate * 1000)
        }
        engine.prepare()
        do { try engine.start() } catch { input.removeTap(onBus: 0); throw error }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var value: Float = 0
        vDSP_rmsqv(channel, 1, &value, vDSP_Length(buffer.frameLength))
        return value
    }
}

/// iOS 26 on-device `SpeechAnalyzer` + `SpeechTranscriber`. Audio never leaves the phone.
final class AnalyzerSink: SpeechSink, @unchecked Sendable {
    private let analyzer: SpeechAnalyzer
    private let transcriber: SpeechTranscriber
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let targetFormat: AVAudioFormat
    private var converter: AVAudioConverter?
    private let lock = NSLock()
    private var finalized = ""
    private var volatile = ""
    private var failed = false
    private var resultsTask: Task<Void, Never>?

    private init(analyzer: SpeechAnalyzer, transcriber: SpeechTranscriber, continuation: AsyncStream<AnalyzerInput>.Continuation, targetFormat: AVAudioFormat, inputFormat: AVAudioFormat) {
        self.analyzer = analyzer; self.transcriber = transcriber; self.continuation = continuation; self.targetFormat = targetFormat
        converter = inputFormat == targetFormat ? nil : AVAudioConverter(from: inputFormat, to: targetFormat)
    }

    private static func transcriber() async -> SpeechTranscriber? {
        guard SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: .current) else { return nil }
        return SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    }

    /// Checks (and if needed downloads) the on-device model before the microphone
    /// session starts. A download that doesn't finish within `timeout` keeps going in
    /// the background for next time; this attempt uses another engine.
    static func prepareAssets(timeout: Duration) async -> Bool {
        guard let transcriber = await transcriber() else { return false }
        do {
            guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else { return true }
            return await valueWithin(timeout) { (try? await request.downloadAndInstall()) != nil } ?? false
        } catch {
            return false
        }
    }

    /// Nil when the device/simulator has no installed on-device model for the current
    /// language (call `prepareAssets` first; this never downloads).
    static func make(inputFormat: AVAudioFormat, onText: @escaping @Sendable (String) -> Void) async -> AnalyzerSink? {
        guard let transcriber = await transcriber() else { return nil }
        do {
            guard try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) == nil else { return nil }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: inputFormat) else { return nil }
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let sink = AnalyzerSink(analyzer: analyzer, transcriber: transcriber, continuation: continuation, targetFormat: format, inputFormat: inputFormat)
            sink.resultsTask = Task { await sink.readResults(onText) }
            try await analyzer.start(inputSequence: stream)
            return sink
        } catch {
            return nil
        }
    }

    private func readResults(_ onText: @Sendable (String) -> Void) async {
        do {
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                let combined = lock.withLock {
                    if result.isFinal { finalized += text; volatile = "" } else { volatile = text }
                    return (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                onText(combined)
            }
        } catch {
            lock.withLock { failed = true }
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { continuation.yield(AnalyzerInput(buffer: buffer)); return }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        lock.withLock {
            _ = converter.convert(to: output, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true
                status.pointee = .haveData
                return buffer
            }
        }
        if error == nil, output.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: output)) }
    }

    func finish() async -> (text: String, interrupted: Bool) {
        continuation.finish()
        let analyzer = analyzer, results = resultsTask
        // Finalization normally takes well under a second; never hang the UI on it. The
        // deadline must not wait for the (uncancellable) finalization it gives up on, so
        // this races unstructured work instead of a task group.
        let completed = await valueWithin(.seconds(5)) {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
            await results?.value
            return true
        } ?? false
        if !completed {
            results?.cancel()
            Task { await analyzer.cancelAndFinishNow() }
        }
        return lock.withLock { ((finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines), failed || !completed) }
    }

    func cancel() async {
        continuation.finish()
        resultsTask?.cancel()
        await analyzer.cancelAndFinishNow()
    }
}

/// `SFSpeechRecognizer` restricted to on-device recognition, for devices where the
/// iOS 26 transcriber has no model for the current language.
final class RecognizerSink: SpeechSink, @unchecked Sendable {
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?
    private let lock = NSLock()
    private var text = ""
    private var failed = false
    private var done = false
    private var waiter: CheckedContinuation<Void, Never>?

    init?(onText: @escaping @Sendable (String) -> Void) {
        guard let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return nil }
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let latest = result.bestTranscription.formattedString
                lock.withLock { text = latest }
                onText(latest)
                if result.isFinal { complete(failed: false) }
            }
            if error != nil { complete(failed: true) }
        }
    }

    private func complete(failed: Bool) {
        let waiter = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            guard !done else { return nil }
            done = true
            self.failed = failed
            defer { self.waiter = nil }
            return self.waiter
        }
        waiter?.resume()
    }

    func append(_ buffer: AVAudioPCMBuffer) { request.append(buffer) }

    func finish() async -> (text: String, interrupted: Bool) {
        request.endAudio()
        let deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { self?.complete(failed: true) }
        }
        await withCheckedContinuation { continuation in
            let resumeNow = lock.withLock { () -> Bool in
                if done { return true }
                waiter = continuation
                return false
            }
            if resumeNow { continuation.resume() }
        }
        deadline.cancel()
        task?.cancel()
        // A recognizer error after words were heard still leaves usable text for review.
        return lock.withLock { (text.trimmingCharacters(in: .whitespacesAndNewlines), failed) }
    }

    func cancel() async {
        task?.cancel()
        complete(failed: true)
    }
}

/// Server fallback: records AAC (`audio/mp4`) to a temporary file that is read
/// once for upload and deleted. The planner server never stores the audio.
final class FileSink: SpeechSink, @unchecked Sendable {
    private let url: URL
    private var file: AVAudioFile?
    private let lock = NSLock()
    private(set) var bytesWritten = 0
    /// The server caps audio at 5 MiB; two minutes of 48 kbps AAC is ~0.7 MB.
    static let maxBytes = 5 * 1024 * 1024

    init(format: AVAudioFormat) throws {
        url = FileManager.default.temporaryDirectory.appending(path: "voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount,
            AVEncoderBitRateKey: 48_000,
        ]
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            guard let file else { return }
            do { try file.write(from: buffer) } catch { self.file = nil }
        }
    }

    /// Closes the file and returns its bytes, deleting it from disk.
    func takeAudio() -> Data? {
        lock.withLock { file = nil }
        defer { discard() }
        guard let data = try? Data(contentsOf: url), !data.isEmpty, data.count <= Self.maxBytes else { return nil }
        return data
    }

    func discard() {
        lock.withLock { file = nil }
        try? FileManager.default.removeItem(at: url)
    }

    func finish() async -> (text: String, interrupted: Bool) { ("", false) }
    func cancel() async { discard() }
}
