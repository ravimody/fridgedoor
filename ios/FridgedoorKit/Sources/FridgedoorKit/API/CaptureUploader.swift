import Foundation

/// Sends one item to the capture-only endpoint (`POST /capture/v1/items`) with the
/// Share extension's credential. The credential can only queue items for the
/// owner's review — it cannot read plans or apply changes.
///
/// Wire rules (`server/src/routes/shortcut-capture.ts`): JSON with
/// `clientCaptureId` + `text` (≤ 8000 UTF-16 units, as zod counts), or multipart with exactly the
/// `clientCaptureId` and `file` fields; `Idempotency-Key` must equal `clientCaptureId`.
public struct CaptureUploader: Sendable {
    public static let maxFileBytes = 10 * 1024 * 1024
    /// Long-edge cap for shared photos. The server re-encodes images as PNG and
    /// rejects results over 10 MB; a 4096 px photo becomes ~15-17 MB as PNG.
    public static let maxImagePixelSize = 2048
    public static let maxTextLength = 8000

    public let credential: SharedContainer.CaptureCredential
    private let urlSession: URLSession

    public init(credential: SharedContainer.CaptureCredential, urlSession: URLSession = .shared) {
        self.credential = credential; self.urlSession = urlSession
    }

    /// Text (with any shared URL inlined, as the Shortcut does so the assistant can look it up).
    public func send(text: String, clientCaptureId: UUID = UUID()) async throws -> CaptureReceipt {
        struct Body: Encodable { let clientCaptureId: String; let text: String }
        let id = clientCaptureId.uuidString.lowercased()
        var request = request(id: id)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(clientCaptureId: id, text: text.prefix(utf16Count: Self.maxTextLength)))
        request.timeoutInterval = 30
        return try await perform(request)
    }

    /// A JPEG/PNG/HEIC image or PDF, ≤ 10 MB.
    public func send(file: Data, filename: String, mimeType: String, clientCaptureId: UUID = UUID()) async throws -> CaptureReceipt {
        guard file.count <= Self.maxFileBytes else { throw PlannerError(code: "CAPTURE_TOO_LARGE", status: 413) }
        let id = clientCaptureId.uuidString.lowercased()
        let boundary = "planner-\(UUID().uuidString)"
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"clientCaptureId\"\r\n\r\n\(id)\r\n".utf8))
        let safeName = filename.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(file)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = request(id: id)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 120
        return try await perform(request)
    }

    private func request(id: String) -> URLRequest {
        var request = URLRequest(url: credential.serverURL.appending(path: "capture/v1/items"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(id, forHTTPHeaderField: "Idempotency-Key")
        return request
    }

    private func perform(_ request: URLRequest) async throws -> CaptureReceipt {
        let (data, response) = try await PlannerClient.perform(request, using: urlSession)
        try PlannerClient.check(data: data, response: response)
        return try PlannerClient.decodeEnvelope(CaptureReceipt.self, from: data)
    }
}

public extension SharedContainer {
    /// Stores (or clears) the Share extension credential. Returns false when the
    /// shared Keychain group is unavailable (e.g. a provisioning profile without
    /// Keychain Sharing), so the caller can revoke what it just created.
    @discardableResult
    static func storeCaptureCredential(_ credential: CaptureCredential?) -> Bool {
        guard sharedKeychain.setValue(credential, for: "share-capture") else { return false }
        guard let credential else { return true }
        return captureCredential?.id == credential.id
    }
}

public extension PlannerError {
    /// Copy for the Share extension, which only ever talks to the capture endpoint.
    var captureMessage: String {
        switch code {
        case "CAPTURE_CREDENTIAL_INVALID", "HTTP_401": "Sharing was turned off for this iPhone. Open Fridgedoor to turn it back on."
        case "CAPTURE_TOO_LARGE": "That's too large to send (10 MB limit)."
        case "UNSUPPORTED_OR_CORRUPT_FILE", "UNSUPPORTED_HEIC_CONVERSION": "The planner can't read that file. Try a photo, screenshot or PDF."
        case "CAPTURE_IDEMPOTENCY_CONFLICT": "That was already sent with different content."
        case "VALIDATION", "CAPTURE_INPUT_REQUIRED", "CAPTURE_TEXT_TOO_LONG": "There's nothing the planner can read in that."
        case "OFFLINE": "You're offline. Try again when you're connected."
        default: userMessage
        }
    }
}
