import Foundation

public enum HTTPMethod: String, Sendable { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

public struct PlannerError: Error, LocalizedError, Equatable, Sendable {
    public let code: String
    public let status: Int
    public let serverMessage: String?

    public init(code: String, status: Int = 0, serverMessage: String? = nil) { self.code = code; self.status = status; self.serverMessage = serverMessage }

    public static let signedOut = PlannerError(code: "SIGNED_OUT", status: 401)
    public static let offline = PlannerError(code: "OFFLINE")
    public static let decoding = PlannerError(code: "UNEXPECTED_RESPONSE")
    public static let pairingCodeInvalid = PlannerError(code: "PAIRING_CODE_INVALID", status: 401)
    public static let pairingCodeUsed = PlannerError(code: "PAIRING_CODE_USED", status: 401)
    public static let pairingCodeExpired = PlannerError(code: "PAIRING_CODE_EXPIRED", status: 401)

    public var isStale: Bool { code == "STALE_REVISION" || code == "STALE_CLIENT" || status == 409 }

    public var errorDescription: String? { userMessage }

    /// Human copy for every code a screen is likely to surface.
    public var userMessage: String {
        switch code {
        case "SIGNED_OUT", "UNAUTHENTICATED", "NATIVE_GRANT_INVALID": "Your session ended. Sign in again to continue."
        case "OFFLINE": "You're offline. Check your connection and try again."
        case "PAIRING_CODE_USED": "This code was already used. Make a new one in Settings → iPhone on the web."
        case "PAIRING_CODE_EXPIRED": "This code expired. Codes last 10 minutes; make a new one."
        case "PAIRING_CODE_INVALID": "That pairing code has expired or was already used. Make a new one in Fridgedoor on the web (Settings → iPhone) and scan it again."
        case "STALE_REVISION", "STALE_CLIENT": "This changed on another device. It's been refreshed — try again."
        case "IDEMPOTENCY_CONFLICT": "That request was already sent with different details."
        case "NOT_FOUND": "That item is no longer available."
        case "FORBIDDEN": "You don't have access to that."
        case "VALIDATION": "Some details aren't valid. Check them and try again."
        case "GOOGLE_NOT_CONFIGURED", "GOOGLE_CLIENT_CONFIGURATION_INCOMPLETE": "Google isn't set up on the server yet."
        case "NATIVE_UNSUPPORTED": "This step opens in Safari."
        case "ASSISTANT_CONSENT_REQUIRED": "Turn on the assistant in Settings first."
        case "TRANSCRIPTION_UNAVAILABLE": "Voice transcription isn't available on the server."
        case "TRANSCRIPTION_LIMIT": "Too many voice requests. Try again in a little while."
        case "CAPTURE_TOO_LARGE": "That file is too large (10 MB limit)."
        case "PUSH_UNAVAILABLE": "Notifications aren't configured on the server."
        case "AI_UNAVAILABLE", "AI_DISABLED": "The planner's AI features are turned off on the server."
        case "DISCLOSURE_REQUIRED", "CONSENT_REQUIRED": "Review and accept the disclosure first."
        case "UNDO_UNAVAILABLE": "Undo is no longer available."
        case "UNEXPECTED_RESPONSE": "The server sent something unexpected. Try again."
        case "NOT_A_FRIDGEDOOR_SERVER": "That address answered, but it isn't a Fridgedoor server. Check the address and try again."
        case "SERVER_UNREACHABLE": "Couldn't reach that server. Check the address, and that this iPhone is on the same network or VPN as the server."
        case "INSECURE_CONNECTION_BLOCKED": "iOS blocked the unencrypted connection to that address. Use the server's https address instead."
        case "CERTIFICATE_PROBLEM": "The server's security certificate isn't valid, so this iPhone won't connect. Check the server's https setup."
        default: status >= 500 ? "The planner server had a problem. Try again shortly." : "Something went wrong (\(code.replacingOccurrences(of: "_", with: " ").lowercased()))."
        }
    }
}

public struct EmptyResponse: Decodable, Sendable { public init() {} }

/// Thread-safe holder for the signed-in session. Refresh is single-flight: a
/// rotated refresh token presented twice revokes the whole session server-side.
public actor AuthSession {
    public nonisolated let baseURL: URL
    private let keychain: KeychainStore
    private let urlSession: URLSession
    private var credentials: Credentials?
    private var refreshTask: Task<Credentials, Error>?
    /// Bumped on every sign-out so a refresh already in flight can't write tokens back.
    private var generation = 0
    private var onSignOut: (@Sendable (_ expired: Bool) -> Void)?
    /// Keychain account for this server's tokens. Keyed by server so tokens issued
    /// by one server can never be presented to another.
    private let account: String

    private static let registry = Registry()
    private final class Registry: @unchecked Sendable {
        private let lock = NSLock()
        private var sessions: [URL: AuthSession] = [:]
        func session(for url: URL) -> AuthSession {
            lock.withLock {
                if let existing = sessions[url] { return existing }
                let created = AuthSession(baseURL: url)
                sessions[url] = created
                return created
            }
        }
    }

    /// The one session per server for this process. The app UI, App Intents,
    /// notification actions and background refresh must share it: two instances
    /// refreshing the same rotating token would revoke the whole session.
    public static func shared(for baseURL: URL) -> AuthSession { registry.session(for: baseURL) }

    public init(baseURL: URL, keychain: KeychainStore = KeychainStore(), urlSession: URLSession = .shared) {
        self.baseURL = baseURL; self.keychain = keychain; self.urlSession = urlSession
        self.account = Self.account(for: baseURL)
        self.credentials = keychain.value(Credentials.self, for: account)
    }

    static func account(for baseURL: URL) -> String { "native-session \(baseURL.absoluteString)" }

    public var member: Member? { credentials?.member }
    public var isSignedIn: Bool { credentials != nil }

    /// `expired` is false only for an explicit `signOut()`.
    public func setSignOutHandler(_ handler: @escaping @Sendable (_ expired: Bool) -> Void) { onSignOut = handler }

    /// Completes the PKCE handoff started in `ASWebAuthenticationSession`.
    public func exchange(code: String, verifier: String, deviceLabel: String) async throws -> Member {
        let body: [String: String] = ["grantType": "authorization_code", "code": code, "codeVerifier": verifier, "deviceLabel": deviceLabel]
        let tokens = try await tokenRequest(body)
        store(tokens.credentials)
        return tokens.member
    }

    /// Signs in with a one-time code from the web app's Settings → iPhone page. The server
    /// says why a code failed (`PAIRING_CODE_USED`, `PAIRING_CODE_EXPIRED`, `PAIRING_CODE_INVALID`);
    /// servers that predate those codes answer `NATIVE_GRANT_INVALID`, treated as invalid.
    public func pair(code: String, deviceLabel: String) async throws -> Member {
        let body: [String: String] = ["grantType": "pairing_code", "code": code, "deviceLabel": deviceLabel]
        let tokens: TokenResponse
        do { tokens = try await tokenRequest(body) } catch let error as PlannerError where error.code == "NATIVE_GRANT_INVALID" {
            throw PlannerError.pairingCodeInvalid
        }
        store(tokens.credentials)
        return tokens.member
    }

    public func accessToken() async throws -> String {
        if let refreshTask { return try await refreshTask.value.accessToken }
        guard let credentials else { throw PlannerError.signedOut }
        if credentials.accessExpiry.timeIntervalSinceNow > 60 { return credentials.accessToken }
        return try await refresh().accessToken
    }

    /// Refreshes unless another caller already did after `staleToken` was issued.
    public func refreshAfterRejection(of staleToken: String) async throws -> String {
        if let refreshTask { return try await refreshTask.value.accessToken }
        guard let credentials else { throw PlannerError.signedOut }
        if credentials.accessToken != staleToken { return credentials.accessToken }
        return try await refresh().accessToken
    }

    private func refresh() async throws -> Credentials {
        if let refreshTask { return try await refreshTask.value }
        // Another process (or an earlier launch) may have rotated the token already.
        if let stored = keychain.value(Credentials.self, for: account), stored.refreshToken != credentials?.refreshToken {
            credentials = stored
            if stored.accessExpiry.timeIntervalSinceNow > 60 { return stored }
        }
        guard let refreshToken = credentials?.refreshToken else { throw PlannerError.signedOut }
        let startedGeneration = generation
        let task = Task { [weak self] () throws -> Credentials in
            guard let self else { throw PlannerError.signedOut }
            return try await self.tokenRequest(["grantType": "refresh_token", "refreshToken": refreshToken]).credentials
        }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            let next = try await task.value
            guard generation == startedGeneration else { throw PlannerError.signedOut }
            store(next)
            return next
        } catch let error as PlannerError where error.code == "NATIVE_GRANT_INVALID" || error.status == 401 {
            if generation == startedGeneration { signOutLocally(expired: true) }
            throw PlannerError.signedOut
        }
    }

    public func updateMember(_ member: Member) {
        guard var current = credentials else { return }
        current.member = member
        store(current)
    }

    public func signOut() async {
        // A fresh token, so the server really revokes this session after a long idle.
        if credentials != nil, let token = try? await accessToken() {
            var request = URLRequest(url: baseURL.appending(path: "native/v1/auth/logout"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 10
            _ = try? await urlSession.data(for: request)
        }
        signOutLocally(expired: false)
    }

    private func signOutLocally(expired: Bool) {
        generation += 1
        let wasSignedIn = credentials != nil
        credentials = nil
        keychain.set(nil, for: account)
        if wasSignedIn { onSignOut?(expired) }
    }

    private func store(_ next: Credentials) {
        credentials = next
        keychain.setValue(next, for: account)
    }

    private func tokenRequest(_ body: [String: String]) async throws -> TokenResponse {
        var request = URLRequest(url: baseURL.appending(path: "native/v1/auth/token"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await PlannerClient.perform(request, using: urlSession)
        try PlannerClient.check(data: data, response: response)
        return try PlannerClient.decodeEnvelope(TokenResponse.self, from: data)
    }
}

/// Typed access to `/native/v1`. Feature endpoints live in `PlannerClient+<Area>.swift`.
public final class PlannerClient: Sendable {
    public let auth: AuthSession
    public var baseURL: URL { auth.baseURL }
    private let urlSession: URLSession

    public init(auth: AuthSession, urlSession: URLSession = .shared) {
        self.auth = auth; self.urlSession = urlSession
    }

    /// The equivalent page in the web dashboard (used for browser-only flows such as Google consent).
    public func webURL(_ path: String) -> URL { baseURL.appending(path: "dashboard/\(path)") }

    public func get<T: Decodable & Sendable>(_ path: String, query: [String: String] = [:], as type: T.Type = T.self) async throws -> T {
        try await request(.get, path, query: query, body: Optional<String>.none, as: type)
    }

    public func send<T: Decodable & Sendable, Body: Encodable & Sendable>(_ method: HTTPMethod, _ path: String, body: Body?, idempotencyKey: String? = nil, as type: T.Type = T.self) async throws -> T {
        try await request(method, path, body: body, idempotencyKey: idempotencyKey, as: type)
    }

    public func send<T: Decodable & Sendable>(_ method: HTTPMethod, _ path: String, idempotencyKey: String? = nil, as type: T.Type = T.self) async throws -> T {
        try await request(method, path, body: Optional<String>.none, idempotencyKey: idempotencyKey, as: type)
    }

    /// `multipart/form-data` upload with string fields and one `file` part.
    public func upload<T: Decodable & Sendable>(_ path: String, fields: [String: String], file: Data, filename: String, mimeType: String, idempotencyKey: String? = nil, as type: T.Type = T.self) async throws -> T {
        let boundary = "planner-\(UUID().uuidString)"
        var body = Data()
        for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        let safeName = filename.replacingOccurrences(of: "\"", with: "")
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(file)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let payload = body
        return try await authorized(as: type) { token in
            var request = URLRequest(url: self.url(path, query: [:]))
            request.httpMethod = "POST"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
            request.httpBody = payload
            request.timeoutInterval = 120
            return request
        }
    }

    private func request<T: Decodable & Sendable, Body: Encodable & Sendable>(_ method: HTTPMethod, _ path: String, query: [String: String] = [:], body: Body?, idempotencyKey: String? = nil, as type: T.Type) async throws -> T {
        let encoded = try body.map { try JSONEncoder().encode($0) }
        return try await authorized(as: type) { token in
            var request = URLRequest(url: self.url(path, query: query))
            request.httpMethod = method.rawValue
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let encoded { request.httpBody = encoded; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
            request.timeoutInterval = 30
            return request
        }
    }

    private func authorized<T: Decodable & Sendable>(as type: T.Type, _ build: @Sendable (String) -> URLRequest) async throws -> T {
        var token = try await auth.accessToken()
        var (data, response) = try await Self.perform(build(token), using: urlSession)
        if (response as? HTTPURLResponse)?.statusCode == 401 {
            token = try await auth.refreshAfterRejection(of: token)
            (data, response) = try await Self.perform(build(token), using: urlSession)
            if (response as? HTTPURLResponse)?.statusCode == 401 { throw PlannerError.signedOut }
        }
        try Self.check(data: data, response: response)
        if T.self == EmptyResponse.self, data.isEmpty || (response as? HTTPURLResponse)?.statusCode == 204 { return EmptyResponse() as! T }
        return try Self.decodeEnvelope(T.self, from: data)
    }

    private func url(_ path: String, query: [String: String]) -> URL { Self.endpointURL(base: baseURL, path: path, query: query) }

    /// `path` is treated as already percent-encoded: ids pass through, and user text in a
    /// path (e.g. a knowledge key) must go through `pathSegment(_:)` so `/` stays one segment.
    static func endpointURL(base: URL, path: String, query: [String: String] = [:]) -> URL {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let root = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
        var url = URL(string: "\(root)native/v1/\(trimmed)") ?? base.appending(path: "native/v1/\(trimmed)")
        if !query.isEmpty { url.append(queryItems: query.sorted(by: { $0.key < $1.key }).map { URLQueryItem(name: $0.key, value: $0.value) }) }
        return url
    }

    /// Percent-encodes user text for use as a single path segment.
    public static func pathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%;"))) ?? value
    }

    static func perform(_ request: URLRequest, using session: URLSession) async throws -> (Data, URLResponse) {
        do { return try await session.data(for: request) }
        catch let error as URLError where [.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost, .cannotFindHost, .dataNotAllowed].contains(error.code) { throw PlannerError.offline }
    }

    static func check(data: Data, response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw PlannerError.decoding }
        guard (200..<300).contains(http.statusCode) else {
            struct Body: Decodable { struct Inner: Decodable { let code: String?; let message: String? }; let error: Inner? }
            let body = try? JSONDecoder().decode(Body.self, from: data)
            throw PlannerError(code: body?.error?.code ?? "HTTP_\(http.statusCode)", status: http.statusCode, serverMessage: body?.error?.message)
        }
    }

    static func decodeEnvelope<T: Decodable & Sendable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(Envelope<T>.self, from: data).data }
        catch {
            #if DEBUG
            print("FridgedoorKit decode \(T.self) failed: \(error)")
            #endif
            throw PlannerError.decoding
        }
    }
}

public extension PlannerClient {
    func me() async throws -> Member { try await get("me", as: MeResponse.self).member }
    func meWithHousehold() async throws -> MeResponse { try await get("me", as: MeResponse.self) }
}
