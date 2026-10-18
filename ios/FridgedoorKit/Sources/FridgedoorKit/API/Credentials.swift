import CryptoKit
import Foundation
import Security

public struct Credentials: Codable, Hashable, Sendable {
    public var accessToken: String
    public var accessTokenExpiresAt: String
    public var refreshToken: String
    public var refreshTokenExpiresAt: String
    public var member: Member

    var accessExpiry: Date { PlannerDates.instant(accessTokenExpiresAt) ?? .distantPast }
}

/// Response of `POST /native/v1/auth/token`.
struct TokenResponse: Decodable, Sendable {
    let accessToken: String
    let accessTokenExpiresAt: String
    let refreshToken: String
    let refreshTokenExpiresAt: String
    let member: Member

    var credentials: Credentials { Credentials(accessToken: accessToken, accessTokenExpiresAt: accessTokenExpiresAt, refreshToken: refreshToken, refreshTokenExpiresAt: refreshTokenExpiresAt, member: member) }
}

/// Generic-password Keychain storage. `accessGroup == nil` keeps an item in the
/// app's own group; the shared group is only for the capture-only credential
/// the Share extension needs — never the app's session tokens.
public struct KeychainStore: Sendable {
    public let service: String
    public let accessGroup: String?

    public init(service: String = "dev.fridgedoor", accessGroup: String? = nil) {
        self.service = service; self.accessGroup = accessGroup
    }

    private func query(_ account: String) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func data(_ account: String) -> Data? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess ? result as? Data : nil
    }

    /// Stores `data` (nil deletes it). An existing item is updated in place, so a failed
    /// write leaves the previous value rather than nothing. Returns the Keychain status.
    @discardableResult
    public func write(_ data: Data?, for account: String) -> OSStatus {
        guard let data else {
            let status = SecItemDelete(query(account) as CFDictionary)
            return status == errSecItemNotFound ? errSecSuccess : status
        }
        // Background refresh and notification actions run while the phone is locked.
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
        guard status == errSecItemNotFound else { return status }
        let item = query(account).merging(attributes) { _, new in new }
        return SecItemAdd(item as CFDictionary, nil)
    }

    /// `write` that reports only whether it worked.
    @discardableResult
    public func set(_ data: Data?, for account: String) -> Bool {
        write(data, for: account) == errSecSuccess
    }

    public func value<T: Decodable>(_ type: T.Type, for account: String) -> T? {
        data(account).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    @discardableResult
    public func setValue<T: Encodable>(_ value: T?, for account: String) -> Bool {
        set(value.flatMap { try? JSONEncoder().encode($0) }, for: account)
    }
}

public enum PKCE {
    public static func verifier() -> String { randomURLSafe(byteCount: 48) }
    public static func challenge(for verifier: String) -> String { base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    public static func state() -> String { randomURLSafe(byteCount: 24) }

    static func randomURLSafe(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        _ = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        return base64URL(Data(bytes))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
