import Foundation
import ImageIO
import Observation
import FridgedoorKit
import UIKit
import UniformTypeIdentifiers

/// What the person shared, normalized to what `/capture/v1/items` accepts:
/// text (links are inlined so the assistant can look them up, like the Shortcut),
/// or one JPEG image / PDF file.
enum SharePayload {
    case text(String, link: URL?)
    case file(data: Data, filename: String, mimeType: String, preview: UIImage?)

    var isFile: Bool { if case .file = self { true } else { false } }
}

@MainActor @Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading, ready, sending, sent
        case failed(String)
        case signedOut
        case unsupported(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var payload: SharePayload?
    var note = ""

    private let items: [NSExtensionItem]
    private let finish: @MainActor (Bool) -> Void
    /// One id per share: a retry after a timeout can't create a second capture.
    private let captureId = UUID()

    init(items: [NSExtensionItem], finish: @escaping @MainActor (Bool) -> Void) {
        self.items = items
        self.finish = finish
    }

    var credential: SharedContainer.CaptureCredential? { SharedContainer.captureCredential }

    var canSend: Bool {
        guard phase == .ready || { if case .failed = phase { true } else { false } }() else { return false }
        if case let .text(text, link) = payload { return !text.isEmpty || link != nil || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return payload != nil
    }

    func cancel() { finish(false) }

    // MARK: Loading

    func load() async {
        guard credential != nil else { phase = .signedOut; return }
        let providers = items.flatMap { $0.attachments ?? [] }
        var texts: [String] = []
        var link: URL?

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                guard let data = await Self.loadData(provider, .pdf) else { continue }
                await setFile(data: data, name: provider.suggestedName, mime: "application/pdf", ext: "pdf", preview: nil)
                return
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                if let data = await Self.loadData(provider, .image) {
                    await setImage(data, name: provider.suggestedName)
                    return
                }
                continue
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = await Self.loadURL(provider) {
                if url.isFileURL {
                    let type = UTType(filenameExtension: url.pathExtension)
                    if type?.conforms(to: .pdf) == true, let data = Self.read(url) {
                        await setFile(data: data, name: url.deletingPathExtension().lastPathComponent, mime: "application/pdf", ext: "pdf", preview: nil)
                        return
                    }
                    if type?.conforms(to: .image) == true, let data = Self.read(url) {
                        await setImage(data, name: url.deletingPathExtension().lastPathComponent)
                        return
                    }
                    phase = .unsupported("The planner can read text, links, photos and PDFs, but not this kind of file.")
                    return
                }
                if link == nil { link = url }
                continue
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let text = await Self.loadString(provider) {
                texts.append(text)
                continue
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
                phase = .unsupported("The planner can read text, links, photos and PDFs, but not this kind of file.")
                return
            }
        }

        if texts.isEmpty, let attributed = items.compactMap(\.attributedContentText?.string).first(where: { !$0.isEmpty }) {
            texts.append(attributed)
        }
        var text = texts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        // Some apps share the link as text too.
        if let link, text == link.absoluteString { text = "" }
        guard !text.isEmpty || link != nil else {
            phase = .unsupported("There's nothing here the planner can read. Try sharing text, a link, a photo or a PDF.")
            return
        }
        payload = .text(text, link: link)
        phase = .ready
    }

    private func setImage(_ data: Data, name: String?) async {
        phase = .loading
        let converted = await Task.detached(priority: .userInitiated) { ImageConverter.jpeg(from: data) }.value
        guard let jpeg = converted else {
            phase = .unsupported("That photo couldn't be read or is too large to send (10 MB limit).")
            return
        }
        await setFile(data: jpeg, name: name, mime: "image/jpeg", ext: "jpg", preview: UIImage(data: jpeg))
    }

    private func setFile(data: Data, name: String?, mime: String, ext: String, preview: UIImage?) async {
        guard data.count <= CaptureUploader.maxFileBytes else {
            phase = .unsupported("That file is too large to send (10 MB limit).")
            return
        }
        let base = (name?.isEmpty == false ? name! : (mime == "application/pdf" ? "Document" : "Photo"))
        payload = .file(data: data, filename: "\(base).\(ext)", mimeType: mime, preview: preview)
        phase = .ready
    }

    // MARK: Sending

    func send() async {
        guard let credential, let payload else { phase = .signedOut; return }
        phase = .sending
        let uploader = CaptureUploader(credential: credential)
        do {
            switch payload {
            case let .text(text, link):
                let parts = [note.trimmingCharacters(in: .whitespacesAndNewlines), text, link?.absoluteString ?? ""].filter { !$0.isEmpty }
                _ = try await uploader.send(text: parts.joined(separator: "\n\n"), clientCaptureId: captureId)
            case let .file(data, filename, mimeType, _):
                _ = try await uploader.send(file: data, filename: filename, mimeType: mimeType, clientCaptureId: captureId)
            }
            phase = .sent
            try? await Task.sleep(for: .seconds(1.6))
            finish(true)
        } catch let error as PlannerError {
            phase = .failed(error.captureMessage)
        } catch {
            phase = .failed("Couldn't send that. Try again.")
        }
    }

    // MARK: Item provider helpers

    private static func loadData(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
        await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(for: type) { data, _ in continuation.resume(returning: data) }
        }
    }

    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { url, _ in continuation.resume(returning: url) }
        }
    }

    private static func loadString(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: String.self) { text, _ in continuation.resume(returning: text) }
        }
    }

    private static func read(_ url: URL) -> Data? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try? Data(contentsOf: url, options: .mappedIfSafe)
    }
}

/// HEIC/PNG/JPEG → JPEG without metadata (no location), ≤ 2048 px on the long
/// edge (`CaptureUploader.maxImagePixelSize`: the server's PNG re-encode must stay
/// under 10 MB) and ≤ 10 MB.
enum ImageConverter {
    static func jpeg(from data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        for (pixels, quality) in [(CaptureUploader.maxImagePixelSize, 0.85), (1536, 0.75)] {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return nil }
            if output.length <= CaptureUploader.maxFileBytes { return output as Data }
        }
        return nil
    }
}
