import Foundation

/// What a server says about itself before anyone signs in.
public struct ServerStatus: Equatable, Sendable {
    /// The owner hasn't finished first-run setup in a browser yet.
    public let setupRequired: Bool
    /// The address the server believes it is reached at (`APP_ORIGIN`), if it says.
    public let publicURL: URL?
    /// `/healthz` answered "degraded" (the background worker isn't running).
    public let isDegraded: Bool
}

/// Checks that an address really is a Fridgedoor server, using the two public
/// endpoints: `GET /healthz` and `GET /dashboard/api/v1/auth/status`.
public enum ServerProbe {
    private struct Health: Decodable { let status: String }
    private struct AuthStatus: Decodable { let setupRequired: Bool; let publicUrl: String? }

    public static func check(_ server: URL, using session: URLSession = .shared) async throws -> ServerStatus {
        let (healthData, healthResponse) = try await get(server, "healthz", using: session)
        // 503 + {"status":"degraded"} still means a Fridgedoor server is answering.
        guard let health = try? PlannerClient.decodeEnvelope(Health.self, from: healthData),
              let code = (healthResponse as? HTTPURLResponse)?.statusCode, code == 200 || code == 503 else {
            throw PlannerError.notAServer
        }
        let (statusData, statusResponse) = try await get(server, "dashboard/api/v1/auth/status", using: session)
        guard (statusResponse as? HTTPURLResponse)?.statusCode == 200,
              let status = try? PlannerClient.decodeEnvelope(AuthStatus.self, from: statusData) else {
            throw PlannerError.notAServer
        }
        return ServerStatus(setupRequired: status.setupRequired,
                            publicURL: status.publicUrl.flatMap { try? ServerAddress.normalize($0).url },
                            isDegraded: health.status != "ok")
    }

    private static func get(_ server: URL, _ path: String, using session: URLSession) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: server.appending(path: path))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 10
        do {
            return try await session.data(for: request)
        } catch let error as URLError {
            throw PlannerError.connection(error)
        }
    }
}

public extension PlannerError {
    static let notAServer = PlannerError(code: "NOT_A_FRIDGEDOOR_SERVER")
    static let serverUnreachable = PlannerError(code: "SERVER_UNREACHABLE")
    static let insecureBlocked = PlannerError(code: "INSECURE_CONNECTION_BLOCKED")
    static let certificateProblem = PlannerError(code: "CERTIFICATE_PROBLEM")

    /// Explains why a server address didn't connect, more specifically than `perform`'s "offline".
    static func connection(_ error: URLError) -> PlannerError {
        switch error.code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff: .offline
        case .appTransportSecurityRequiresSecureConnection: .insecureBlocked
        case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired: .certificateProblem
        default: .serverUnreachable
        }
    }
}
