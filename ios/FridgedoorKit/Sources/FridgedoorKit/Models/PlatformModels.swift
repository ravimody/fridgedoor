import Foundation

// Wire models for the iOS platform integrations (notifications, Share extension
// credential). Field names match the server responses exactly.

/// `GET /morning-digest`: the member's morning review alert preference.
public struct MorningDigestStatus: Codable, Hashable, Sendable {
    public struct Delivery: Codable, Hashable, Sendable {
        public let date: String
        public let accepted: Int?
        public let pending: Int?
    }
    public let enabled: Bool
    /// `HH:mm` in `timezone`.
    public let localTime: String
    public let revision: Int
    public let timezone: String
    /// Whether the server can send Web Push (unrelated to this app's local alerts).
    public let available: Bool?
    public let devices: Int?
    public let lastDelivery: Delivery?

    public init(enabled: Bool, localTime: String, revision: Int, timezone: String, available: Bool? = nil, devices: Int? = nil, lastDelivery: Delivery? = nil) {
        self.enabled = enabled; self.localTime = localTime; self.revision = revision; self.timezone = timezone
        self.available = available; self.devices = devices; self.lastDelivery = lastDelivery
    }

    /// `(hour, minute)` parsed from `localTime`, or 07:00 if malformed.
    public var hourMinute: (hour: Int, minute: Int) {
        let parts = localTime.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else { return (7, 0) }
        return (parts[0], parts[1])
    }
}

/// `POST /capture/v1/items` receipt. `202` means "saved for review", never "added".
public struct CaptureReceipt: Codable, Hashable, Sendable {
    public let captureId: String
    public let status: String // queued | ready | …
}

public extension String {
    /// The longest prefix of whole characters that fits in `limit` UTF-16 code
    /// units: zod's `.max()` counts UTF-16, and this never splits a surrogate pair
    /// or grapheme cluster.
    func prefix(utf16Count limit: Int) -> String {
        guard utf16.count > limit else { return self }
        var used = 0
        var end = startIndex
        for character in self {
            used += character.utf16.count
            guard used <= limit else { break }
            end = index(after: end)
        }
        return String(self[..<end])
    }
}
