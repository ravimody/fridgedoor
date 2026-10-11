import Foundation
import FridgedoorKit
import UIKit

/// Provisions the Share extension's capture-only credential. The extension can't
/// see the app's session (that stays in the app-only Keychain group); it gets a
/// separate credential that can only queue items for review.
@MainActor
enum ShareCredentialManager {
    private static var inFlight = false

    /// Whether the shared Keychain group works in this build (it may not with a
    /// free personal team's provisioning).
    private(set) static var isAvailable = true

    /// Ensures this device has an active credential for `client`'s server and member.
    static func ensure(_ client: PlannerClient) async {
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }

        if let existing = SharedContainer.captureCredential, existing.serverURL == client.baseURL {
            // Still active for this member? (It may have been revoked from the web's Settings,
            // or belong to someone who signed out without revoking.)
            guard let rows = try? await client.captureCredentials() else { return } // offline: keep it
            if rows.contains(where: { $0.id == existing.id && $0.status == "active" }) { return }
        }

        let label = "iPhone Share (\(UIDevice.current.name))"
        guard let receipt = try? await client.createCaptureCredential(label: label) else { return }
        let credential = SharedContainer.CaptureCredential(id: receipt.id, token: receipt.token, serverURL: client.baseURL)
        if SharedContainer.storeCaptureCredential(credential) {
            isAvailable = true
        } else {
            // No shared Keychain: don't leave an unusable credential active on the server.
            isAvailable = false
            try? await client.revokeCaptureCredential(receipt.id)
        }
    }

    /// Revokes this device's credential on the server (best effort) and forgets it.
    static func revoke(_ client: PlannerClient?) async {
        if let client, let existing = SharedContainer.captureCredential, existing.serverURL == client.baseURL {
            try? await client.revokeCaptureCredential(existing.id)
        }
        SharedContainer.storeCaptureCredential(nil)
    }
}
