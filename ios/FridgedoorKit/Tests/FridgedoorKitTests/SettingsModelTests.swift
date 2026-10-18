import Foundation
import Testing
@testable import FridgedoorKit

/// Payloads captured from the synthetic preview server (`dev:native`).
@Suite struct SettingsModelTests {
    private func decode<T: Decodable & Sendable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(Envelope<T>.self, from: Data(json.utf8)).data
    }

    @Test func decodesDestinationWithBooleanActive() throws {
        let destination = try decode(Destination?.self, #"{"data":{"id":"51ff","name":"Family","active":true,"ownCalendarSelectionId":"cdd3"}}"#)
        #expect(destination?.active == true)
        #expect(try decode(Destination?.self, #"{"data":null}"#) == nil)
    }

    @Test func decodesSourceCalendarsAndDestinationEligibility() throws {
        let calendars = try decode([SourceCalendar].self, #"""
        {"data":[{"id":"a","name":"Alex (personal)","selected":true,"classification":"personal","accessRole":"owner","isDestination":false,"sync":{"lastSuccessAt":"2026-10-10T15:39:12.913Z","error":null,"stale":false,"imported":4,"upcoming":4}},
        {"id":"b","name":"Work","selected":true,"classification":"work","accessRole":"owner"},
        {"id":"c","name":"Holidays","selected":false,"classification":"household","accessRole":"reader","isDestination":false}]}
        """#)
        #expect(calendars.map(\.canBeDestination) == [true, false, false])
        #expect(calendars[0].sync?.upcoming == 4)
    }

    @Test func eligibleDestinationIgnoresIneligibleSavedChoice() throws {
        let calendars = try decode([SourceCalendar].self, #"""
        {"data":[{"id":"a","name":"Personal","selected":true,"classification":"personal","accessRole":"owner"},
        {"id":"b","name":"Household","selected":false,"classification":"household","accessRole":"writer"},
        {"id":"c","name":"Shared","selected":true,"classification":"household","accessRole":"reader"}]}
        """#)
        #expect(calendars.eligibleDestination("a") == "a")
        // Unselected or read-only: no longer a valid choice, so it compares equal to "none".
        #expect(calendars.eligibleDestination("b") == "")
        #expect(calendars.eligibleDestination("c") == "")
        #expect(calendars.eligibleDestination("missing") == "")
        #expect(calendars.eligibleDestination(nil) == "")
        // An unselected destination still receives events; a read-only one can't.
        #expect(calendars.map(\.isWritableNonWork) == [true, true, false])
    }

    @Test func decodesConnectionWithExtraFields() throws {
        let status = try decode(ConnectionStatus.self, #"{"data":{"connected":true,"id":"0c8d","email":"alex@example.com","status":"active","generation":1,"disclosure_version":"v1","consented_at":"2026-10-10T15:39:12.882Z","revision":2,"syncLastSuccessAt":"2026-10-10T15:39:12.908Z","syncErrorCode":null,"analysisPending":0,"providerRevoke":"accepted"}}"#)
        #expect(status.revision == 2)
        let disconnected = try decode(ConnectionStatus.self, #"{"data":{"connected":false,"status":"disconnected","generation":0,"revision":0,"syncLastSuccessAt":null,"syncErrorCode":null,"analysisPending":0}}"#)
        #expect(disconnected.email == nil)
        #expect(status.isGoogle)
        let mailbox = try decode(ConnectionStatus.self, #"{"data":{"connected":true,"provider":"imap","email":"sam@example.org","status":"active","generation":1,"revision":1,"syncLastSuccessAt":null,"syncErrorCode":null,"analysisPending":0}}"#)
        #expect(!mailbox.isGoogle)
    }

    @Test func decodesSettingsStatuses() throws {
        let ai = try decode(BackgroundAiStatus.self, #"{"data":{"provider":"fake","model":"preview","failuresLastDay":0,"available":true,"enabled":true,"revision":1,"connectionActive":true,"attemptsLastDay":0,"attemptsLastHour":0,"volumeWarning":false,"pausedForVolume":false,"dailyLimit":3000,"hourlyLimit":500,"pending":0,"lastProcessedAt":null}}"#)
        #expect(ai.hourlyLimit == 500)
        let digest = try decode(MorningDigestStatus.self, #"{"data":{"enabled":true,"localTime":"07:00","revision":1,"timezone":"America/New_York","available":false,"devices":1,"lastDelivery":{"date":"2026-10-09","accepted":1,"pending":0}}}"#)
        #expect(digest.lastDelivery?.accepted == 1)
        let sessions = try decode(NativeSessionsResponse.self, #"{"data":{"currentId":"x","sessions":[{"id":"x","label":"iPhone","createdAt":"2026-10-10T15:39:21.008Z","lastUsedAt":null}]}}"#)
        #expect(sessions.sessions.first?.id == sessions.currentId)
        let credentials = try decode(CaptureCredentialsResponse.self, #"{"data":{"credentials":[{"id":"c1","label":"Phone shortcut","status":"active","createdAt":"2026-10-10T00:00:00.000Z","revokedAt":null,"lastUsedAt":null}]}}"#)
        #expect(credentials.credentials?.count == 1)
    }

    @Test func decodesTrialPayloads() throws {
        let list = try decode(TrialList.self, #"""
        {"data":{"items":[{"id":"t1","facts":{"title":"Picture day","category":"school","participants":[],"time":{"kind":"all_day","startDate":"2026-10-12","endDateExclusive":"2026-10-13"},"preparationTasks":["Pick a shirt"],"unresolvedFields":[]},"observedAt":"2026-10-09T09:39:12.921Z","value":"not_useful","reason":"","revision":2,"source":{"sender":null,"excerpt":null,"available":false}},
        {"id":"t2","facts":{"title":"Fundraiser","category":"school","participants":[],"preparationTasks":[],"unresolvedFields":[]},"observedAt":"2026-10-06T21:39:12.953Z","value":null,"reason":"","revision":1}],"expiresAt":null}}
        """#)
        #expect(list.items.map(\.value) == [.notUseful, nil])
        #expect(try decode(TrialSummaryRecord?.self, #"{"data":null}"#) == nil)
        let learning = try decode(TrialLearning.self, #"{"data":{"enabled":false,"revision":0,"preferences":[],"generatedAt":null}}"#)
        #expect(learning.preferences.isEmpty)
    }

    @Test func encodesTrialVoteWireValue() throws {
        let data = try JSONEncoder().encode(["value": TrialVote.notUseful])
        #expect(String(decoding: data, as: UTF8.self) == #"{"value":"not_useful"}"#)
    }
}
