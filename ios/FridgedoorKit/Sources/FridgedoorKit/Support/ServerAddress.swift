import Foundation

/// Turns what someone types (or a pairing link carries) into the origin of a
/// Fridgedoor server: `https://fridgedoor.example.com`, `http://192.168.1.20:8080`.
///
/// - No scheme means https. For a local host (LAN address, `.local`, Tailscale…)
///   typed without a scheme, `fallback` offers the same address over http, since
///   home servers often have no certificate.
/// - Paths, queries, fragments and credentials are dropped; default ports too.
/// - Plain http is only allowed for hosts that can't be reached from the open
///   internet (see `isLocal(host:)`), and is flagged so the UI can warn.
public enum ServerAddress {
    public enum Problem: Error, Equatable, Sendable {
        case empty
        case invalid
        /// Something other than http or https (`ftp://`, `fridgedoor://`…).
        case unsupportedScheme
        /// `http://` to a public host: tokens would cross the internet unencrypted.
        case insecureRemote
    }

    public struct Normalized: Equatable, Sendable {
        /// The origin, without a trailing slash.
        public let url: URL
        /// Plain http (allowed only for local hosts).
        public let isInsecure: Bool
        /// The http variant to try if `url` doesn't answer: set only when no scheme
        /// was typed and the host is local.
        public let fallback: URL?

        public var host: String { url.host(percentEncoded: false) ?? url.absoluteString }
        /// Host plus a non-default port, for "Connect to …?" copy.
        public var displayName: String { Self.displayName(for: url) }

        public static func displayName(for url: URL) -> String {
            let host = url.host(percentEncoded: false) ?? url.absoluteString
            let shown = host.contains(":") ? "[\(host)]" : host
            return url.port.map { "\(shown):\($0)" } ?? shown
        }
    }

    public static func normalize(_ input: String) throws(Problem) -> Normalized {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw .empty }
        guard !trimmed.contains(where: \.isWhitespace) else { throw .invalid }

        let lowered = trimmed.lowercased()
        let typedScheme: Bool
        let candidate: String
        if let range = lowered.range(of: "://") {
            typedScheme = true
            let scheme = lowered[..<range.lowerBound]
            guard scheme == "http" || scheme == "https" else { throw scheme.isEmpty ? .invalid : .unsupportedScheme }
            candidate = trimmed
        } else if lowered.hasPrefix("//") {
            typedScheme = false
            candidate = "https:" + trimmed
        } else if let colon = lowered.firstIndex(of: ":"), isSchemeLike(lowered[..<colon]), !looksLikePort(lowered[lowered.index(after: colon)...]) {
            // "mailto:x", "fridgedoor:pair": a scheme, just without slashes.
            throw .unsupportedScheme
        } else {
            typedScheme = false
            candidate = "https://" + trimmed
        }

        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              var host = components.host?.lowercased(), !host.isEmpty else { throw .invalid }
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        while host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty, isValidHost(host) else { throw .invalid }

        let local = isLocal(host: host)
        if scheme == "http", !local { throw .insecureRemote }

        func origin(_ scheme: String) throws(Problem) -> URL {
            var origin = URLComponents()
            origin.scheme = scheme
            origin.host = host.contains(":") ? "[\(host)]" : host
            if let port = components.port, port != (scheme == "https" ? 443 : 80) { origin.port = port }
            guard let url = origin.url else { throw .invalid }
            return url
        }

        let url = try origin(scheme)
        let fallback = !typedScheme && local ? try origin("http") : nil
        return Normalized(url: url, isInsecure: scheme == "http", fallback: fallback)
    }

    /// Hosts where plain http is acceptable: loopback, private and link-local
    /// addresses, Tailscale (100.64/10 and `*.ts.net`, both already encrypted by
    /// WireGuard), single-label names and the local-only suffixes.
    public static func isLocal(host rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        while host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty else { return false }
        if host.contains(":") { return isLocalIPv6(host) }
        if let octets = ipv4Octets(host) { return isLocalIPv4(octets) }
        if host == "localhost" || !host.contains(".") { return true }
        return localSuffixes.contains { host.hasSuffix(".\($0)") }
    }

    static let localSuffixes = ["local", "localhost", "lan", "home.arpa", "internal", "ts.net"]

    // MARK: Helpers

    private static func isSchemeLike(_ text: Substring) -> Bool {
        guard let first = text.first, first.isLetter else { return false }
        return text.allSatisfy { $0.isLetter || $0.isNumber || "+-.".contains($0) }
    }

    /// The text after a colon starts with a port number ("8080", "8080/path").
    private static func looksLikePort(_ text: Substring) -> Bool {
        let digits = text.prefix { $0.isNumber }
        return !digits.isEmpty && (digits.count == text.count || "/?#".contains(text[digits.endIndex]))
    }

    private static func isValidHost(_ host: String) -> Bool {
        if host.contains(":") { return host.allSatisfy { $0.isHexDigit || $0 == ":" || $0 == "." } }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-."))
        return host.unicodeScalars.allSatisfy(allowed.contains) && !host.hasPrefix(".") && !host.contains("..")
    }

    private static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let octets = parts.compactMap { part -> Int? in
            guard !part.isEmpty, part.count <= 3, part.allSatisfy(\.isNumber), let value = Int(part), value <= 255 else { return nil }
            return value
        }
        return octets.count == 4 ? octets : nil
    }

    private static func isLocalIPv4(_ o: [Int]) -> Bool {
        switch (o[0], o[1]) {
        case (127, _), (10, _), (192, 168), (169, 254): true
        case (172, 16...31): true
        case (100, 64...127): true // Tailscale / carrier-grade NAT
        default: false
        }
    }

    private static func isLocalIPv6(_ host: String) -> Bool {
        if host == "::1" { return true }
        let first = host.split(separator: ":", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard let value = UInt16(first, radix: 16), !first.isEmpty else { return false }
        return value & 0xFE00 == 0xFC00 // fc00::/7 unique local
            || value & 0xFFC0 == 0xFE80 // fe80::/10 link local
    }
}

/// `fridgedoor://pair?server=<origin>&code=<one-time code>`, shown as a QR code by
/// the web app's Settings → iPhone page. The server is untrusted input: the app
/// names it and asks before exchanging the code.
public struct PairingLink: Equatable, Sendable, Identifiable {
    public enum Problem: Error, Equatable, Sendable {
        /// Not a `fridgedoor://pair` link at all.
        case notPairingLink
        case missingCode
        case invalidServer(ServerAddress.Problem)
    }

    public let server: ServerAddress.Normalized
    public let code: String

    public var id: String { "\(server.url.absoluteString) \(code)" }

    public init(server: ServerAddress.Normalized, code: String) { self.server = server; self.code = code }

    /// Whether `url` is meant as a pairing link (valid or not), so the app can
    /// explain a broken one instead of treating it as navigation.
    public static func isPairingLink(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "fridgedoor" else { return false }
        let first = url.host(percentEncoded: false) ?? url.pathComponents.first { $0 != "/" }
        return first?.lowercased() == "pair"
    }

    public static func parse(_ url: URL) throws(Problem) -> PairingLink {
        guard isPairingLink(url) else { throw .notPairingLink }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let code = value("code"), !code.isEmpty, code.count <= 200 else { throw .missingCode }
        let server: ServerAddress.Normalized
        do { server = try ServerAddress.normalize(value("server") ?? "") } catch { throw .invalidServer(error) }
        return PairingLink(server: server, code: code)
    }

    /// Parses scanned or pasted text (a QR payload is a string, not a URL).
    public static func parse(_ text: String) throws(Problem) -> PairingLink {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw .notPairingLink }
        return try parse(url)
    }
}
