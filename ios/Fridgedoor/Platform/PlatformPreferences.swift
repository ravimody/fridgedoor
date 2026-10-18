import Foundation
import Observation
import FridgedoorKit

/// Per-device notification preferences (UserDefaults, not synced). Someone who
/// also enabled the web app's Web Push on this phone can turn the app's local
/// alerts off here to avoid duplicates.
@MainActor @Observable
final class PlatformPreferences {
    static let shared = PlatformPreferences()

    private let defaults = UserDefaults.standard
    private enum Key {
        static let reminderAlerts = "platform.reminderAlerts"
        static let digestAlerts = "platform.digestAlerts"
        static let eveningAlerts = "platform.eveningAlerts"
        static let serverDigest = "platform.serverDigest"
        static let serverDigestFetchedAt = "platform.serverDigestFetchedAt"
        static let askedForAlerts = "platform.askedForAlerts"
    }

    /// "Reminder alerts on this iPhone". On by default.
    var reminderAlerts: Bool {
        didSet { defaults.set(reminderAlerts, forKey: Key.reminderAlerts) }
    }

    /// Explicit per-device choice for the morning alert; `nil` means on. The alert says
    /// what the day holds, so it is useful even without the AI morning brief.
    var digestAlertsOverride: Bool? {
        didSet { defaults.set(digestAlertsOverride, forKey: Key.digestAlerts) }
    }

    /// Last `GET morning-digest` response, so alerts can be rescheduled offline.
    var serverDigest: MorningDigestStatus? {
        didSet { defaults.set(serverDigest.flatMap { try? JSONEncoder().encode($0) }, forKey: Key.serverDigest) }
    }

    var serverDigestFetchedAt: Date? {
        didSet { defaults.set(serverDigestFetchedAt, forKey: Key.serverDigestFetchedAt) }
    }

    /// Whether the full (non-provisional) notification prompt was already shown.
    var askedForAlerts: Bool {
        didSet { defaults.set(askedForAlerts, forKey: Key.askedForAlerts) }
    }

    var digestAlerts: Bool { digestAlertsOverride ?? true }

    /// "Tomorrow" at 8 PM, only when tomorrow has something on it. Off by default.
    var eveningAlerts: Bool {
        didSet { defaults.set(eveningAlerts, forKey: Key.eveningAlerts) }
    }

    private init() {
        reminderAlerts = defaults.object(forKey: Key.reminderAlerts) as? Bool ?? true
        digestAlertsOverride = defaults.object(forKey: Key.digestAlerts) as? Bool
        eveningAlerts = defaults.bool(forKey: Key.eveningAlerts)
        serverDigest = defaults.data(forKey: Key.serverDigest).flatMap { try? JSONDecoder().decode(MorningDigestStatus.self, from: $0) }
        serverDigestFetchedAt = defaults.object(forKey: Key.serverDigestFetchedAt) as? Date
        askedForAlerts = defaults.bool(forKey: Key.askedForAlerts)
    }

    /// Account-specific state is dropped on sign-out; device choices stay.
    func resetAccountState() {
        serverDigest = nil
        serverDigestFetchedAt = nil
    }
}
