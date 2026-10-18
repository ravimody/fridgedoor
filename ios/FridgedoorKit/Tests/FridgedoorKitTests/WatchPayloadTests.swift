import Foundation
import Testing
@testable import FridgedoorKit

/// What the iPhone sends the Apple Watch, and what the watch sends back.
@Suite struct WatchPayloadTests {
    // 2026-10-10 10:00 New York.
    let now = PlannerDates.instant("2026-10-10T14:00:00Z")!

    var snapshot: WidgetSnapshot {
        WidgetSnapshot(generatedAt: now, memberName: "Alex", timezone: "America/New_York", entries: [], attentionCount: 3, openTodoCount: 0, openGroceryCount: 0)
    }

    func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(json.utf8)) }

    func plan(_ id: String, status: String = "proposed", time: String, saved: Bool = false) throws -> PlanSummary {
        try decode(PlanSummary.self, """
        {"id":"\(id)","revision":1,"visibility":"shared","status":"\(status)","facts":{"title":"Plan \(id)","category":"school","participants":[],"time":\(time),"preparationTasks":[],"unresolvedFields":[]},"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z","sourceSummary":{"kind":"email","count":1,"available":true},"possibleDuplicate":false\(saved ? ",\"savedInPlanner\":true" : "")}
        """)
    }

    var plans: [PlanSummary] {
        get throws {
            [try plan("p1", time: #"{"kind":"all_day","startDate":"2026-10-11","endDateExclusive":"2026-10-12"}"#),
             try plan("p2", time: #"{"kind":"unresolved","dateHint":"2026-10-12","missing":["start","end"]}"#),
             try plan("p3", status: "dismissed", time: #"{"kind":"all_day","startDate":"2026-10-11","endDateExclusive":"2026-10-12"}"#),
             try plan("p4", time: #"{"kind":"all_day","startDate":"2026-10-11","endDateExclusive":"2026-10-12"}"#),
             try plan("p5", status: "accepted", time: #"{"kind":"all_day","startDate":"2026-10-11","endDateExclusive":"2026-10-12"}"#),
             try plan("p6", time: #"{"kind":"all_day","startDate":"2026-10-11","endDateExclusive":"2026-10-12"}"#, saved: true)]
        }
    }

    func daily(_ summary: String, generatedAt: String, state: String = "ready") throws -> DailyView {
        let items = try decode([DailyOverviewItem].self, """
        [{"refs":["c1"],"category":"decision","headline":"Book fair","detail":"","priority":"important","targets":[{"kind":"plan","id":"p1"}]},
         {"refs":["c2"],"category":"decision","headline":"Conference","detail":"","priority":"important","sourceRefs":["s2"],"targets":[{"kind":"plan","id":"p2"}]},
         {"refs":["c3"],"category":"decision","headline":"Dismissed","detail":"","priority":"important","targets":[{"kind":"plan","id":"p3"}]},
         {"refs":["c6"],"category":"decision","headline":"Accepted already","detail":"","priority":"important","targets":[{"kind":"plan","id":"p5"}]},
         {"refs":["c7"],"category":"deadline","headline":"Saved, still a suggestion","detail":"","priority":"important","targets":[{"kind":"plan","id":"p6"}]},
         {"refs":["c4"],"category":"deadline","headline":"Slip due","title":"Permission slip","detail":"Due Monday","priority":"important"},
         {"refs":["c5"],"category":"today","headline":"Routine","detail":"","priority":"routine","targets":[{"kind":"plan","id":"p4"}]}]
        """)
        return DailyView(state: state, result: DailyOverviewResult(summary: summary, items: [], questions: []), items: items, generatedAt: generatedAt,
                         coverage: nil, revision: 1, errorCode: nil, refreshing: nil, undoToken: nil)
    }

    func payload(_ daily: DailyView?) throws -> WatchPayload {
        WatchPayload(snapshot: snapshot, daily: daily, clarifications: try clarifications(), plans: try plans, googleReady: false, now: now)
    }

    func clarifications() throws -> [Clarification] {
        try JSONDecoder().decode([Clarification].self, from: Data("""
        [{"id":"q1","question":"Who drives Friday?","reason":"r","state":"open","revision":3,"createdAt":"2026-10-10T11:00:00Z"},
         {"id":"q3","question":"What time is the conference?","reason":"r","sourceRefs":["s2"],"state":"open","revision":1,"createdAt":"2026-10-10T11:00:00Z"},
         {"id":"q2","question":"Answered already","reason":"r","state":"answered","answer":"Me","revision":2,"createdAt":"2026-10-09T11:00:00Z"}]
        """.utf8))
    }

    @Test func showsWhatHomeShows() throws {
        let payload = try payload(try daily("Two things today.", generatedAt: "2026-10-10T10:50:00Z"))
        #expect(payload.brief?.summary == "Two things today.")
        // Brief decisions and deadlines whose suggestion is still open; routine items and dismissed or saved plans are left out.
        #expect(payload.decisions.map(\.id) == ["p1", "p2", "brief:c4"])
        #expect(payload.decisions.map(\.action) == [.keep, nil, nil])
        #expect(payload.decisions.last?.title == "Permission slip")
        // q3 asks for the time p2's row already needs; the answered one isn't open.
        #expect(payload.questions == [.init(id: "q1", text: "Who drives Friday?", revision: 3)])
        #expect(payload.decisionCount == 4)
    }

    @Test func leavesOutAnOldOrUnreadyBrief() throws {
        // 11 PM New York yesterday is a different local day, even though it's the same UTC date.
        #expect(try payload(try daily("Old", generatedAt: "2026-10-10T03:00:00Z")).brief == nil)
        #expect(try payload(try daily("Brief off", generatedAt: "2026-10-10T10:50:00Z", state: "fallback")).brief == nil)
        #expect(try payload(try daily("Your morning review", generatedAt: "2026-10-10T10:50:00Z")).brief == nil)
        // Without a brief, only the planner's questions wait (as on Home).
        let none = try payload(nil)
        #expect(none.decisions.isEmpty)
        #expect(none.questions.map(\.id) == ["q1", "q3"])
    }

    @Test func removingADecisionUpdatesTheRightList() throws {
        let payload = try payload(try daily("Two things today.", generatedAt: "2026-10-10T10:50:00Z"))
        let decided = payload.removing(decision: "p1")
        #expect(decided.decisions.map(\.id) == ["p2", "brief:c4"])
        #expect(decided.questions.count == 1)
        let answered = payload.removing(decision: "q1")
        #expect(answered.questions.isEmpty)
        #expect(answered.decisions.count == 3)
    }

    @Test func survivesTransport() throws {
        let payload = try payload(try daily("Two things today.", generatedAt: "2026-10-10T10:50:00Z"))
        #expect(WatchPayload.decode(try payload.encoded()) == payload)
        #expect(payload.sameContent(as: WatchPayload(snapshot: snapshot, brief: payload.brief, decisions: payload.decisions, questions: payload.questions)))
        #expect(!payload.sameContent(as: payload.removing(decision: "q1")))

        for command in [WatchCommand.decide(planId: "p1", choice: .calendar), .answer(questionId: "q1", text: "Sam", revision: 3), .dismiss(questionId: "q1", revision: 3), .refresh] {
            #expect(WatchCommand(message: try command.message()) == command)
        }
        #expect(WatchCommand(message: ["other": 1]) == nil)
        #expect(WatchReply(message: WatchReply.ok.message) == .ok)
        #expect(WatchReply(message: WatchReply(error: "Nope").message).error == "Nope")
    }

    @Test func dropsPayloadsBuiltBeforeTheLatestSignOut() {
        let signedOut = now.addingTimeInterval(60)
        let context = WatchPayload.signedOutContext(at: signedOut)
        #expect(WatchPayload.signedOutAt(in: context) == signedOut)
        // An older iPhone build sent no time: signed out on arrival.
        #expect(WatchPayload.signedOutAt(in: ["signedOut": true], receivedAt: now) == now)
        #expect(WatchPayload.signedOutAt(in: [WatchPayload.contextKey: Data()]) == nil)

        let payload = WatchPayload(snapshot: snapshot, brief: nil, decisions: [], questions: [])
        #expect(payload.predates(signOut: signedOut))
        #expect(!payload.predates(signOut: now.addingTimeInterval(-60)))
        #expect(!payload.predates(signOut: nil))
    }
}
