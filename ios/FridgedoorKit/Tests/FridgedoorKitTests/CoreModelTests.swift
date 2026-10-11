import Foundation
import Testing
@testable import FridgedoorKit

@Suite struct CoreModelTests {
    @Test func decodesEveryNormalizedTimeKindAndRoundTrips() throws {
        let json = """
        [{"kind":"timed","start":"2026-10-10T14:00:00.000Z","end":"2026-10-10T15:00:00.000Z","timezone":"America/New_York"},
         {"kind":"all_day","startDate":"2026-10-11","endDateExclusive":"2026-10-12"},
         {"kind":"deadline","at":"2026-10-12T21:00:00-04:00","timezone":"America/New_York"},
         {"kind":"unresolved","dateHint":"2026-10-13","missing":["start","end"]}]
        """
        let times = try JSONDecoder().decode([NormalizedTime].self, from: Data(json.utf8))
        #expect(times.map(\.kind) == ["timed", "all_day", "deadline", "unresolved"])
        let again = try JSONDecoder().decode([NormalizedTime].self, from: JSONEncoder().encode(times))
        #expect(again == times)
    }

    @Test func allDayOccursOnlyWithinExclusiveEnd() throws {
        let zone = TimeZone(identifier: "America/New_York")!
        let time = NormalizedTime.allDay(startDate: "2026-10-11", endDateExclusive: "2026-10-12")
        #expect(time.occurs(onDayStarting: PlannerDates.day("2026-10-11", in: zone)!, in: zone))
        #expect(!time.occurs(onDayStarting: PlannerDates.day("2026-10-12", in: zone)!, in: zone))
    }

    @Test func timedEventUsesMemberTimezoneForDay() throws {
        let zone = TimeZone(identifier: "America/New_York")!
        // 01:30 UTC on the 11th is 21:30 on the 10th in New York.
        let time = NormalizedTime.timed(start: "2026-10-11T01:30:00Z", end: "2026-10-11T02:30:00Z", timezone: "America/New_York")
        #expect(time.occurs(onDayStarting: PlannerDates.day("2026-10-10", in: zone)!, in: zone))
        #expect(!time.occurs(onDayStarting: PlannerDates.day("2026-10-11", in: zone)!, in: zone))
    }

    @Test func factsOmitEmptyOptionalStrings() throws {
        let facts = PlanFacts(title: "Dentist", location: "", notes: nil)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(facts)) as! [String: Any]
        #expect(object["location"] == nil)
        #expect(object["notes"] == nil)
        #expect(object["title"] as? String == "Dentist")
    }

    @Test func offsetStringUsesMemberZone() {
        let zone = TimeZone(identifier: "America/New_York")!
        let date = PlannerDates.instant("2026-10-10T13:00:00Z")!
        #expect(PlannerDates.offsetString(date, timeZone: zone) == "2026-10-10T09:00:00-04:00")
    }

    @Test func pkceChallengeMatchesRFC7636Example() {
        #expect(PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
}

@Suite struct EndpointURLTests {
    @Test func userTextStaysOnePathSegment() {
        let base = URL(string: "https://planner.example.test")!
        let url = PlannerClient.endpointURL(base: base, path: "assistant/knowledge/\(PlannerClient.pathSegment("Mom/Dad cell #2"))")
        #expect(url.absoluteString == "https://planner.example.test/native/v1/assistant/knowledge/Mom%2FDad%20cell%20%232")
        #expect(PlannerClient.endpointURL(base: base, path: "plans", query: ["status": "dismissed"]).absoluteString == "https://planner.example.test/native/v1/plans?status=dismissed")
    }
}
