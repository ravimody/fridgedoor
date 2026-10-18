import Foundation

/// Endpoints used by the iOS platform integrations (local notifications, the
/// Share extension's capture-only credential).
public extension PlannerClient {
    func morningDigestStatus() async throws -> MorningDigestStatus { try await get("morning-digest") }

    // Capture-credential endpoints live in PlannerClient+Settings.swift.

    func revokeCaptureCredential(_ id: String) async throws {
        _ = try await send(.delete, "capture-credentials/\(id)", as: DeletedResponse.self)
    }
}
