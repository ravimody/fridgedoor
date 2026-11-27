import Foundation
import Security
import Synchronization
import Testing
@testable import FridgedoorKit

/// Before first unlock the Keychain refuses reads: that must not look like signing out.
@Suite struct AuthSessionKeychainTests {
    private final class FakeKeychain: Sendable {
        let next = Mutex<KeychainRead>(.locked)
        var store: KeychainStore {
            var store = KeychainStore(service: "dev.fridgedoor.tests.\(UUID().uuidString)")
            store.readOverride = { _ in self.next.withLock { $0 } }
            return store
        }
    }

    private static let credentials = Credentials(
        accessToken: "access", accessTokenExpiresAt: "2099-01-01T00:00:00Z", refreshToken: "refresh", refreshTokenExpiresAt: "2099-01-01T00:00:00Z",
        member: Member(id: "m1", householdId: "h1", displayName: "Alex Rivera", timezone: "America/New_York"))

    @Test func classifiesKeychainStatuses() {
        #expect(KeychainRead(status: errSecItemNotFound, result: nil) == .absent)
        #expect(KeychainRead(status: errSecInteractionNotAllowed, result: nil) == .locked)
        #expect(KeychainRead(status: errSecMissingEntitlement, result: nil) == .failed(errSecMissingEntitlement))
        #expect(KeychainRead(status: errSecSuccess, result: Data("x".utf8) as CFData) == .found(Data("x".utf8)))
    }

    @Test func unreadableKeychainIsNotSignedOutAndIsReadAgain() async throws {
        let keychain = FakeKeychain()
        let auth = AuthSession(baseURL: URL(string: "https://fridgedoor.example.test")!, keychain: keychain.store)
        #expect(await auth.isSignedIn == false)
        #expect(await auth.credentialsUnavailable)
        await #expect(throws: PlannerError.sessionLocked) { try await auth.accessToken() }

        // The phone was unlocked: the stored session is picked up without a relaunch.
        let data = try JSONEncoder().encode(Self.credentials)
        keychain.next.withLock { $0 = .found(data) }
        #expect(await auth.member?.id == "m1")
        #expect(await auth.credentialsUnavailable == false)
        #expect(try await auth.accessToken() == "access")
    }

    @Test(arguments: [KeychainRead.absent, .failed(errSecMissingEntitlement)])
    func missingOrBrokenKeychainItemIsSignedOut(read: KeychainRead) async {
        let keychain = FakeKeychain()
        keychain.next.withLock { $0 = read }
        let auth = AuthSession(baseURL: URL(string: "https://fridgedoor.example.test")!, keychain: keychain.store)
        #expect(await auth.credentialsUnavailable == false)
        await #expect(throws: PlannerError.signedOut) { try await auth.accessToken() }
    }
}
