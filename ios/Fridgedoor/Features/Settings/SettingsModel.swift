import Foundation
import Observation
import FridgedoorKit

/// Settings data that isn't part of the app-wide `PlannerStore` (which already holds
/// the Google connection, destination, assistant and daily-AI settings). Owned by
/// `SettingsView` and shared with its pushed pages through the environment.
@MainActor @Observable
final class SettingsModel {
    enum Part: CaseIterable { case sessions, policy, calendars, backgroundAi, digest, push, credentials }

    let client: PlannerClient
    private let store: PlannerStore

    var sessions: NativeSessionsResponse?
    var policy: SourcePolicy?
    var backgroundAi: BackgroundAiStatus?
    var digest: MorningDigestStatus?
    var pushDevices: [PushSubscription] = []
    var pushConfig: PushConfig?
    var credentials: [CaptureCredential] = []
    /// The Share extension's own capture credential on this iPhone, if provisioned.
    private(set) var shareCredentialId: String?
    private(set) var failed: Set<Part> = []
    private(set) var loaded: Set<Part> = []

    /// Calendar rows including unsaved edits; `savedCalendars` is the last server copy.
    var calendars: [SourceCalendar] = []
    private(set) var savedCalendars: [SourceCalendar] = []
    /// Selection id of the calendar chosen for new events (unsaved until "Save calendar choices").
    var destinationChoice = ""
    var calendarNotice: (text: String, tone: SettingsNotice.Tone)?
    private(set) var isSavingCalendars = false

    init(store: PlannerStore) {
        self.store = store
        self.client = store.client
    }

    /// Active credentials made for Shortcuts: everything except this iPhone's Share sheet.
    var shortcutCredentials: [CaptureCredential] { credentials.filter { $0.status == "active" && $0.id != shareCredentialId } }
    var shareCredential: CaptureCredential? { credentials.first { $0.status == "active" && $0.id == shareCredentialId } }

    var hasUnsavedCalendarChanges: Bool {
        calendars.map(\.selection) != savedCalendars.map(\.selection) || effectiveDestinationChoice != effectiveSavedDestination
    }

    /// The chosen destination, or "" if it is no longer writable (unselected, read-only, or work).
    var effectiveDestinationChoice: String { calendars.eligibleDestination(destinationChoice) }

    /// The saved destination as the server's calendars allow it now, or "" if it is no
    /// longer eligible. Comparing against this (not the raw saved id) keeps an ineligible
    /// saved destination from reading as a permanent unsaved change.
    private var effectiveSavedDestination: String { savedCalendars.eligibleDestination(store.destination?.ownCalendarSelectionId) }

    /// The saved destination can no longer receive events (gone, read-only or work); the
    /// person must choose another.
    var savedDestinationIneligible: Bool {
        guard let saved = store.destination?.ownCalendarSelectionId, !saved.isEmpty, !savedCalendars.isEmpty else { return false }
        return !savedCalendars.contains { $0.id == saved && $0.isWritableNonWork }
    }

    func load(_ parts: Set<Part> = Set(Part.allCases)) async {
        await withDiscardingTaskGroup { group in
            for part in parts { group.addTask { await self.loadPart(part) } }
        }
    }

    private func loadPart(_ part: Part) async {
        if await fetch(part) { failed.remove(part); loaded.insert(part) } else { failed.insert(part) }
    }

    private func fetch(_ part: Part) async -> Bool {
        do {
            switch part {
            case .sessions: sessions = try await client.nativeSessions()
            case .policy: policy = try await client.sourcePolicy()
            case .backgroundAi: backgroundAi = try await client.backgroundAi()
            case .digest: digest = try await client.morningDigest()
            case .push:
                async let devices = client.pushSubscriptions()
                async let config = client.pushConfig()
                (pushDevices, pushConfig) = try await (devices, config)
            case .credentials:
                credentials = try await client.captureCredentials()
                shareCredentialId = SharedContainer.captureCredential.flatMap { $0.serverURL == client.baseURL ? $0.id : nil }
            case .calendars: try await loadCalendars()
            }
            return true
        } catch {
            return false
        }
    }

    // MARK: Calendars

    /// Mirrors the web: only an active connection lists calendars. A reload while the
    /// person has unsaved edits only refreshes sync status, preserving their choices.
    private func loadCalendars() async throws {
        // On a cold launch straight into Settings the store may not know the connection yet.
        if store.connection == nil { await store.refresh([.connection, .destination]) }
        guard store.connection?.status == "active" else {
            calendars = []; savedCalendars = []; destinationChoice = ""
            return
        }
        let fresh = try await client.sourceCalendars()
        if loaded.contains(.calendars), hasUnsavedCalendarChanges {
            mergeSyncStatus(fresh)
        } else {
            calendars = fresh
            savedCalendars = fresh
            destinationChoice = store.destination?.ownCalendarSelectionId ?? ""
        }
    }

    private func mergeSyncStatus(_ fresh: [SourceCalendar]) {
        calendars = calendars.map { calendar in
            guard let match = fresh.first(where: { $0.id == calendar.id }) else { return calendar }
            var next = calendar
            if let sync = match.sync { next.sync = sync }
            next.isDestination = match.isDestination ?? false
            return next
        }
    }

    /// "Refresh sync status": updates sync details without touching unsaved choices.
    func refreshCalendarStatus() async {
        do {
            mergeSyncStatus(try await client.sourceCalendars())
            calendarNotice = ("Sync status refreshed. Unsaved choices are unchanged.", .success)
        } catch {
            calendarNotice = ("Couldn't refresh sync status. Try again shortly.", .warning)
        }
    }

    func discardCalendarChanges() {
        calendars = savedCalendars
        destinationChoice = store.destination?.ownCalendarSelectionId ?? ""
        calendarNotice = nil
    }

    /// Saves sources first, then the destination (which needs the connection revision).
    /// The notices follow the web/README wording, including the partial-save case.
    @discardableResult
    func saveCalendars() async -> Bool {
        guard !isSavingCalendars, loaded.contains(.calendars) else { return false }
        isSavingCalendars = true
        calendarNotice = nil
        defer { isSavingCalendars = false }
        let choice = effectiveDestinationChoice
        var sourcesSaved = false
        do {
            let saved = try await client.saveSourceCalendars(calendars.map(\.selection))
            sourcesSaved = true
            calendars = saved
            savedCalendars = saved
            if !choice.isEmpty, choice != store.destination?.ownCalendarSelectionId {
                guard let revision = store.connection?.revision else { throw PlannerError(code: "STALE_REVISION", status: 409) }
                let destination = try await client.saveDestination(selectionId: choice, expectedRevision: revision)
                store.destination = destination
                await store.refresh([.connection, .destination])
                if let fresh = try? await client.sourceCalendars() { calendars = fresh; savedCalendars = fresh }
            }
            destinationChoice = choice
            calendarNotice = choice.isEmpty
                ? ("Calendar sources saved. Choose a writable destination to add plans to Google Calendar.", .info)
                : ("Calendar choices saved.", .success)
            return true
        } catch {
            calendarNotice = sourcesSaved
                ? ("Sources saved, but the destination could not be saved. Pull to refresh and try again.", .warning)
                : ("Calendar choices could not be saved. Pull to refresh and try again.", .warning)
            if (error as? PlannerError)?.isStale == true { await store.refresh([.connection, .destination]) }
            return false
        }
    }
}

extension SourceCalendar {
    var selection: CalendarSelection { CalendarSelection(id: id, selected: selected, classification: classification) }
}

/// Copy for a failed settings change: specific server codes first, then the screen's fallback.
func settingsErrorMessage(_ error: Error, fallback: String) -> String {
    guard let error = error as? PlannerError else { return fallback }
    if error.isStale { return "This setting changed on another device. It's been refreshed — check it and try again." }
    switch error.code {
    case "OFFLINE", "SIGNED_OUT", "UNAUTHENTICATED", "PUSH_UNAVAILABLE", "AI_UNAVAILABLE", "AI_DISABLED", "DISCLOSURE_REQUIRED", "CONSENT_REQUIRED", "UNDO_UNAVAILABLE", "NOT_FOUND":
        return error.userMessage
    case "BACKGROUND_AI_UNAVAILABLE": return "Background AI isn't available on the server."
    default: return fallback
    }
}
