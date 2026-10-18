import Foundation
import ImageIO
import PDFKit
import UIKit
import UniformTypeIdentifiers

/// A photo or PDF waiting to be sent with the next request. The server accepts
/// one capture per request, so choosing another replaces it.
struct ComposerAttachment: Identifiable, Equatable, Sendable {
    enum Kind: Sendable { case photo, pdf }
    let id = UUID()
    let kind: Kind
    let data: Data
    let filename: String
    let mimeType: String
    let preview: UIImage?
    let pageCount: Int?

    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file) }
    var detail: String {
        switch kind {
        case .photo: "Photo · \(sizeLabel)"
        case .pdf: "PDF · \(pageCount.map { "\($0) page\($0 == 1 ? "" : "s") · " } ?? "")\(sizeLabel)"
        }
    }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
}

enum AttachmentError: LocalizedError {
    case tooLarge, tooManyPages, locked, unreadable

    var errorDescription: String? {
        switch self {
        case .tooLarge: "Choose a photo or PDF smaller than 10 MB."
        case .tooManyPages: "PDFs can have up to 10 pages."
        case .locked: "That PDF is password-protected. Unlock it first."
        case .unreadable: "That file couldn't be read. Use a photo, screenshot or PDF."
        }
    }
}

/// Prepares attachments on the client so the server's limits (`services/captures.ts`)
/// never surprise anyone: 10 MB, 20 MP images, 10-page PDFs, and no HEIC (the server
/// may lack a HEIF decoder, `UNSUPPORTED_HEIC_CONVERSION`). Photos are re-encoded
/// as JPEG, which also drops location metadata before anything leaves the phone.
enum AttachmentProcessor {
    static let maxBytes = 10 * 1024 * 1024
    static let maxPdfPages = 10
    /// Long-edge cap for every image (camera, library, files). The server re-encodes
    /// each image as PNG (compression 9) and rejects the result over 10 MB
    /// (`CAPTURE_TOO_LARGE`): a 4096 px photo becomes ~15-17 MB as PNG, 2048 px ~4 MB.
    /// The JPEG we upload being small is not enough; the server's PNG must fit too.
    static let maxPixelSize = 2048

    static func photo(from data: Data, name: String? = nil) throws -> ComposerAttachment {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { throw AttachmentError.unreadable }
        let type = (CGImageSourceGetType(source) as String?).flatMap { UTType($0) }
        let base = (name.map { ($0 as NSString).deletingPathExtension } ?? "").nilIfBlank ?? "photo"
        // Screenshots and other PNGs keep crisp text (an iPhone screenshot is under
        // 2048² pixels); everything else becomes JPEG.
        if type == .png, data.count <= maxBytes, pixelCount(source) <= maxPixelSize * maxPixelSize {
            return ComposerAttachment(kind: .photo, data: data, filename: "\(base).png", mimeType: "image/png", preview: thumbnail(source, size: 240), pageCount: nil)
        }
        for (size, quality) in [(maxPixelSize, 0.85), (1600, 0.75)] {
            guard let image = thumbnail(source, size: size)?.cgImage, let jpeg = encodeJPEG(image, quality: quality) else { throw AttachmentError.unreadable }
            if jpeg.count <= maxBytes {
                return ComposerAttachment(kind: .photo, data: jpeg, filename: "\(base).jpg", mimeType: "image/jpeg", preview: thumbnail(source, size: 240), pageCount: nil)
            }
        }
        throw AttachmentError.tooLarge
    }

    /// Camera captures arrive as `UIImage`; render with orientation applied, then encode.
    static func photo(from image: UIImage) throws -> ComposerAttachment {
        let longest = max(image.size.width * image.scale, image.size.height * image.scale)
        let scale = min(1, CGFloat(maxPixelSize) / max(longest, 1))
        let target = CGSize(width: image.size.width * image.scale * scale, height: image.size.height * image.scale * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        guard let data = rendered.jpegData(compressionQuality: 0.85) else { throw AttachmentError.unreadable }
        return try photo(from: data, name: "camera")
    }

    static func file(at url: URL) throws -> ComposerAttachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let type = UTType(filenameExtension: url.pathExtension)
        // Images get re-encoded (and shrink), so only PDFs are rejected on size up front.
        if type?.conforms(to: .pdf) == true, size > maxBytes { throw AttachmentError.tooLarge }
        guard size <= 50 * 1024 * 1024, let data = try? Data(contentsOf: url) else { throw size > 50 * 1024 * 1024 ? AttachmentError.tooLarge : AttachmentError.unreadable }
        if type?.conforms(to: .pdf) == true || data.starts(with: Data("%PDF-".utf8)) { return try pdf(data, name: url.lastPathComponent) }
        return try photo(from: data, name: url.lastPathComponent)
    }

    static func pdf(_ data: Data, name: String) throws -> ComposerAttachment {
        guard data.count <= maxBytes else { throw AttachmentError.tooLarge }
        guard let document = PDFDocument(data: data) else { throw AttachmentError.unreadable }
        if document.isLocked { throw AttachmentError.locked }
        guard document.pageCount > 0 else { throw AttachmentError.unreadable }
        guard document.pageCount <= maxPdfPages else { throw AttachmentError.tooManyPages }
        let preview = document.page(at: 0)?.thumbnail(of: CGSize(width: 240, height: 320), for: .mediaBox)
        let filename = name.lowercased().hasSuffix(".pdf") ? name : "\(name).pdf"
        return ComposerAttachment(kind: .pdf, data: data, filename: filename, mimeType: "application/pdf", preview: preview, pageCount: document.pageCount)
    }

    private static func pixelCount(_ source: CGImageSource) -> Int {
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let width = properties?[kCGImagePropertyPixelWidth] as? Int ?? .max / 2
        let height = properties?[kCGImagePropertyPixelHeight] as? Int ?? 2
        return width.multipliedReportingOverflow(by: height).overflow ? .max : width * height
    }

    private static func thumbnail(_ source: CGImageSource, size: Int) -> UIImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: size,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }

    private static func encodeJPEG(_ image: CGImage, quality: Double) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? output as Data : nil
    }
}
