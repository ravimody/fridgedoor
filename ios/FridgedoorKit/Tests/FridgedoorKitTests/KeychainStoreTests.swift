import Foundation
import Security
import Testing
@testable import FridgedoorKit

/// Writes update the existing item in place; a delete of nothing is not an error.
@Suite struct KeychainStoreTests {
    private let store = KeychainStore(service: "dev.fridgedoor.tests.\(UUID().uuidString)")

    /// Some test hosts (a locked or sandboxed keychain) can't write at all.
    private static let keychainWritable: Bool = {
        let probe = KeychainStore(service: "dev.fridgedoor.tests.probe.\(UUID().uuidString)")
        defer { probe.set(nil, for: "probe") }
        return probe.set(Data("probe".utf8), for: "probe")
    }()

    @Test(.enabled(if: keychainWritable)) func updatesInPlaceAndDeletes() {
        defer { store.set(nil, for: "item") }
        #expect(store.write(Data("one".utf8), for: "item") == errSecSuccess)
        #expect(store.write(Data("two".utf8), for: "item") == errSecSuccess)
        #expect(store.data("item") == Data("two".utf8))
        #expect(store.write(nil, for: "item") == errSecSuccess)
        #expect(store.data("item") == nil)
        #expect(store.write(nil, for: "item") == errSecSuccess)
    }
}
