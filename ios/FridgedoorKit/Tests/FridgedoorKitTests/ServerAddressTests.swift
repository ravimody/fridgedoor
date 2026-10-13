import Foundation
import Testing
@testable import FridgedoorKit

/// Server-address normalization, pairing links and the pre-sign-in server check.
@Suite struct ServerAddressTests {
    func normalized(_ input: String) throws -> ServerAddress.Normalized { try ServerAddress.normalize(input) }

    @Test(arguments: [
        ("fridgedoor.example.com", "https://fridgedoor.example.com"),
        ("  Fridgedoor.Example.COM  \n", "https://fridgedoor.example.com"),
        ("https://fridgedoor.example.com/", "https://fridgedoor.example.com"),
        ("https://fridgedoor.example.com/dashboard/settings?tab=1#x", "https://fridgedoor.example.com"),
        ("HTTPS://fridgedoor.example.com:443", "https://fridgedoor.example.com"),
        ("https://fridgedoor.example.com:8443/", "https://fridgedoor.example.com:8443"),
        ("https://user:secret@fridgedoor.example.com", "https://fridgedoor.example.com"),
        ("fridgedoor.example.com.", "https://fridgedoor.example.com"),
        ("//fridgedoor.example.com", "https://fridgedoor.example.com"),
        ("our-planner.fly.dev", "https://our-planner.fly.dev"),
        ("planner.up.railway.app/dashboard", "https://planner.up.railway.app"),
        ("nas.tail1234.ts.net", "https://nas.tail1234.ts.net"),
    ])
    func normalizesToOrigin(input: String, expected: String) throws {
        let result = try normalized(input)
        #expect(result.url.absoluteString == expected)
        #expect(!result.isInsecure)
    }

    @Test func noSchemeLocalHostOffersHTTPFallback() throws {
        let result = try normalized("192.168.1.20:8080")
        #expect(result.url.absoluteString == "https://192.168.1.20:8080")
        #expect(result.fallback?.absoluteString == "http://192.168.1.20:8080")
        #expect(result.displayName == "192.168.1.20:8080")

        // A public host gets no http fallback, and neither does an explicit scheme.
        #expect(try normalized("fridgedoor.example.com").fallback == nil)
        #expect(try normalized("https://192.168.1.20:8080").fallback == nil)
        #expect(try normalized("localhost:8899").fallback?.absoluteString == "http://localhost:8899")
    }

    @Test(arguments: [
        "http://192.168.1.20:8080", "http://10.0.0.5", "http://172.20.1.1:8080", "http://127.0.0.1:8899",
        "http://localhost:8899", "http://fridgedoor.local:8080", "http://nas.tail1234.ts.net:8080",
        "http://100.101.102.103:8080", "http://planner:8080", "http://planner.home.arpa", "http://planner.lan",
        "http://[fd12:3456::1]:8080", "http://[::1]:8899", "http://169.254.10.1",
    ])
    func allowsHTTPForLocalHosts(input: String) throws {
        let result = try normalized(input)
        #expect(result.isInsecure)
        #expect(result.url.scheme == "http")
        #expect(result.fallback == nil)
    }

    @Test func keepsIPv6Brackets() throws {
        let result = try normalized("http://[FD12:3456::1]:8080/dashboard")
        #expect(result.url.absoluteString == "http://[fd12:3456::1]:8080")
        #expect(result.displayName == "[fd12:3456::1]:8080")
    }

    @Test func dropsDefaultHTTPPort() throws {
        #expect(try normalized("http://192.168.1.20:80/").url.absoluteString == "http://192.168.1.20")
    }

    @Test(arguments: [
        ("", ServerAddress.Problem.empty),
        ("   ", .empty),
        ("http://fridgedoor.example.com", .insecureRemote),
        ("http://8.8.8.8:8080", .insecureRemote),
        ("http://172.32.0.1", .insecureRemote),
        ("http://100.128.0.1", .insecureRemote),
        ("ftp://fridgedoor.example.com", .unsupportedScheme),
        ("fridgedoor://pair?server=x", .unsupportedScheme),
        ("mailto:alex@example.com", .unsupportedScheme),
        ("fridge door.example.com", .invalid),
        ("https://", .invalid),
        ("https://exa_mple.com", .invalid),
        ("://example.com", .invalid),
        ("https://..example.com", .invalid),
    ])
    func rejects(input: String, problem: ServerAddress.Problem) {
        #expect(throws: problem) { try ServerAddress.normalize(input) }
    }

    @Test func classifiesLocalHosts() {
        #expect(ServerAddress.isLocal(host: "192.168.1.50"))
        #expect(ServerAddress.isLocal(host: "FRIDGEDOOR.LOCAL."))
        #expect(ServerAddress.isLocal(host: "fe80::1"))
        #expect(!ServerAddress.isLocal(host: "fridgedoor.example.com"))
        #expect(!ServerAddress.isLocal(host: "2001:db8::1"))
        #expect(!ServerAddress.isLocal(host: "local.example.com"))
        #expect(!ServerAddress.isLocal(host: "192.168.1"))
        #expect(!ServerAddress.isLocal(host: "notts.net"))
    }

    // MARK: Pairing links

    @Test func parsesPairingLinkFromServer() throws {
        // The exact shape the server's `pairingLink(origin, code)` produces.
        let link = try PairingLink.parse(URL(string: "fridgedoor://pair?server=https%3A%2F%2Ffridgedoor.example.com&code=Zx9-abc_123")!)
        #expect(link.server.url.absoluteString == "https://fridgedoor.example.com")
        #expect(link.server.displayName == "fridgedoor.example.com")
        #expect(link.code == "Zx9-abc_123")
        #expect(!link.server.isInsecure)
    }

    @Test func parsesLANPairingLinkAndScannedText() throws {
        let link = try PairingLink.parse("  fridgedoor://pair?server=http%3A%2F%2F192.168.1.20%3A8080&code=abc%2Bdef \n")
        #expect(link.server.url.absoluteString == "http://192.168.1.20:8080")
        #expect(link.server.isInsecure)
        #expect(link.code == "abc+def")
    }

    @Test func normalizesPairingServerOrigin() throws {
        let link = try PairingLink.parse(URL(string: "FRIDGEDOOR://pair?code=c1&server=https://Fridgedoor.Example.com/dashboard/")!)
        #expect(link.server.url.absoluteString == "https://fridgedoor.example.com")
    }

    @Test func rejectsBrokenPairingLinks() {
        #expect(throws: PairingLink.Problem.missingCode) { try PairingLink.parse(URL(string: "fridgedoor://pair?server=https%3A%2F%2Fa.example.com")!) }
        #expect(throws: PairingLink.Problem.missingCode) { try PairingLink.parse(URL(string: "fridgedoor://pair?server=https%3A%2F%2Fa.example.com&code=%20")!) }
        #expect(throws: PairingLink.Problem.invalidServer(.empty)) { try PairingLink.parse(URL(string: "fridgedoor://pair?code=abc")!) }
        #expect(throws: PairingLink.Problem.invalidServer(.insecureRemote)) {
            try PairingLink.parse(URL(string: "fridgedoor://pair?server=http%3A%2F%2Fevil.example.com&code=abc")!)
        }
        #expect(throws: PairingLink.Problem.invalidServer(.unsupportedScheme)) {
            try PairingLink.parse(URL(string: "fridgedoor://pair?server=javascript%3Aalert(1)&code=abc")!)
        }
        #expect(throws: PairingLink.Problem.notPairingLink) { try PairingLink.parse(URL(string: "fridgedoor://plans/p1")!) }
        #expect(throws: PairingLink.Problem.notPairingLink) { try PairingLink.parse(URL(string: "https://pair?server=a&code=b")!) }
        #expect(throws: PairingLink.Problem.notPairingLink) { try PairingLink.parse("not a link") }
        #expect(throws: PairingLink.Problem.missingCode) {
            try PairingLink.parse(URL(string: "fridgedoor://pair?server=a.example.com&code=\(String(repeating: "x", count: 201))")!)
        }
    }

    @Test func recognizesPairingLinksForRouting() {
        #expect(PairingLink.isPairingLink(URL(string: "fridgedoor://pair")!))
        #expect(PairingLink.isPairingLink(URL(string: "fridgedoor://PAIR?code=x")!))
        #expect(!PairingLink.isPairingLink(URL(string: "fridgedoor://plans/pair")!))
        #expect(!PairingLink.isPairingLink(URL(string: "fridgedoor://auth/callback?code=x")!))
    }

    // MARK: Server check

    @Test func probeAcceptsFridgedoorServer() async throws {
        let session = StubProtocol.session(routes: [
            "/healthz": (200, #"{"data":{"status":"ok"}}"#),
            "/dashboard/api/v1/auth/status": (200, #"{"data":{"setupRequired":false,"accessMode":false,"publicUrl":"https://Fridgedoor.example.com/"}}"#),
        ])
        let status = try await ServerProbe.check(URL(string: "https://probe-ok.example.com")!, using: session)
        #expect(status == ServerStatus(setupRequired: false, publicURL: URL(string: "https://fridgedoor.example.com"), isDegraded: false))
    }

    @Test func probeReportsSetupAndDegradedWorker() async throws {
        let session = StubProtocol.session(routes: [
            "/healthz": (503, #"{"data":{"status":"degraded"}}"#),
            "/dashboard/api/v1/auth/status": (200, #"{"data":{"setupRequired":true,"accessMode":false,"publicUrl":"http://192.168.1.20:8080"}}"#),
        ])
        let status = try await ServerProbe.check(URL(string: "http://192.168.1.20:8080")!, using: session)
        #expect(status.setupRequired)
        #expect(status.isDegraded)
    }

    @Test func probeAcceptsServerBehindSignInGateway() async throws {
        let session = StubProtocol.session(routes: [
            "/healthz": (200, #"{"data":{"status":"ok"}}"#),
            "/dashboard/api/v1/auth/status": (302, "https://team.cloudflareaccess.com/cdn-cgi/access/login"),
            "/cdn-cgi/access/login": (200, "<html>Sign in</html>"),
        ])
        let status = try await ServerProbe.check(URL(string: "https://gated.example.com")!, using: session)
        #expect(status == ServerStatus(setupRequired: false, publicURL: nil, isDegraded: false))
        // A redirect on the same host is not a gateway.
        let sameHost = StubProtocol.session(routes: [
            "/healthz": (200, #"{"data":{"status":"ok"}}"#),
            "/dashboard/api/v1/auth/status": (302, "https://same.example.com/login"),
            "/login": (200, "<html>Log in</html>"),
        ])
        await #expect(throws: PlannerError.notAServer) { try await ServerProbe.check(URL(string: "https://same.example.com")!, using: sameHost) }
    }

    @Test func probeRejectsOtherServers() async {
        let html = StubProtocol.session(routes: ["/healthz": (200, "<html>Welcome to nginx</html>")])
        await #expect(throws: PlannerError.notAServer) { try await ServerProbe.check(URL(string: "https://nginx.example.com")!, using: html) }
        let missingStatus = StubProtocol.session(routes: ["/healthz": (200, #"{"data":{"status":"ok"}}"#)])
        await #expect(throws: PlannerError.notAServer) { try await ServerProbe.check(URL(string: "https://other.example.com")!, using: missingStatus) }
    }

    @Test func mapsConnectionFailures() {
        #expect(PlannerError.connection(URLError(.appTransportSecurityRequiresSecureConnection)) == .insecureBlocked)
        #expect(PlannerError.connection(URLError(.serverCertificateUntrusted)) == .certificateProblem)
        #expect(PlannerError.connection(URLError(.cannotFindHost)) == .serverUnreachable)
        #expect(PlannerError.connection(URLError(.notConnectedToInternet)) == .offline)
    }
}

/// Serves canned responses by path. Each test gets its own session and routes.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    typealias Routes = [String: (Int, String)]
    private static let lock = NSLock()
    nonisolated(unsafe) private static var tables: [String: Routes] = [:]

    static func session(routes: Routes) -> URLSession {
        let id = UUID().uuidString
        lock.withLock { tables[id] = routes }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Stub": id]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let id = request.value(forHTTPHeaderField: "X-Stub") ?? ""
        let route = Self.lock.withLock { Self.tables[id]?[url.path()] } ?? (404, #"{"error":{"code":"NOT_FOUND"}}"#)
        // A 302 route's body is the redirect target.
        if route.0 == 302, let target = URL(string: route.1) {
            let redirect = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": route.1])!
            var next = URLRequest(url: target)
            next.setValue(id, forHTTPHeaderField: "X-Stub")
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: redirect)
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: route.0, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(route.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
