import Foundation
import Testing
@testable import FridgedoorKit

/// Ports `web/src/features/Home/outcomes.test.ts` plus native helpers.
@Suite struct AssistantOutcomeTests {
    private static let event = #"{"kind":"event","title":"Gathering","quantity":null,"start":null,"end":null,"location":null,"notes":null}"#
    private static let grocery = #"{"kind":"grocery","title":"Gathering","quantity":null,"start":null,"end":null,"location":null,"notes":null}"#

    private func run(state: String = "succeeded", items: [String] = [], knowledge: [String] = [], reviews: [String] = [], sources: [String] = []) throws -> AssistantRun {
        let sourceJSON = String(data: try JSONEncoder().encode(sources), encoding: .utf8)!
        let json = """
        {"id":"r","text":"fixture","state":"\(state)","createdAt":"2026-09-13T12:00:00Z","captureId":null,"applied":false,"planIds":[],"errorCode":null,"feedback":null,"metrics":null,
         "reviews":[\(reviews.joined(separator: ","))],
         "result":{"reply":"A reply","items":[\(items.joined(separator: ","))],"knowledge":[\(knowledge.joined(separator: ","))],"sources":\(sourceJSON),"assumptions":[],"followups":[]}}
        """
        return try JSONDecoder().decode(AssistantRun.self, from: Data(json.utf8))
    }

    private func plan(id: String, actionState: String, kind: String = "create") throws -> PlanSummary {
        let json = """
        {"id":"\(id)","revision":1,"visibility":"shared","status":"accepted","facts":{"title":"Gathering","category":"general","participants":[],"preparationTasks":[],"unresolvedFields":[]},
         "changeKind":null,"createdAt":"2026-09-13T12:00:00Z","updatedAt":"2026-09-13T12:00:00Z","sourceSummary":{"kind":"assistant","count":1,"available":true},
         "possibleDuplicate":false,"pendingFacts":null,"savedInPlanner":true,"calendarAction":{"actionId":"a","state":"\(actionState)","kind":"\(kind)"}}
        """
        return try JSONDecoder().decode(PlanSummary.self, from: Data(json.utf8))
    }

    @Test func plainReplyNeedsNoApprovalAndProcessingIsHonest() throws {
        #expect(try run().outcomes() == [.reply])
        #expect(try run(state: "running").outcomes() == [.working])
        #expect(try run(state: "queued").outcomes() == [.working])
        #expect(try run(state: "failed").outcomes() == [.needsAttention])
    }

    @Test func mixedListAdditionAndEventProposalStaySeparate() throws {
        let added = #"{"target":"item:0","state":"saved","planId":null,"automatic":true}"#
        let mixed = try run(items: [Self.grocery, Self.event], reviews: [added])
        #expect(mixed.outcomes() == [.needsReview, .added])
        #expect(mixed.automaticItems.map(\.index) == [0])
        let undone = #"{"target":"item:0","state":"dismissed","planId":null,"automatic":true,"undoneAt":"2026-09-13T12:00:01Z"}"#
        #expect(try run(items: [Self.grocery, Self.event], reviews: [undone]).outcomes() == [.needsReview, .undone])
    }

    @Test func keptEventsDifferFromQueuedConfirmedAndFailedCalendarWrites() throws {
        let kept = #"{"target":"item:0","state":"kept","planId":"p"}"#
        #expect(try run(items: [Self.event], reviews: [kept]).outcomes() == [.saved])
        let requested = try run(items: [Self.event], reviews: [#"{"target":"item:0","state":"calendar","planId":"p"}"#])
        #expect(requested.outcomes() == [.calendarPending])
        let cases: [(String, RequestOutcome)] = [("pending", .calendarPending), ("succeeded", .calendarAdded), ("conflict", .needsAttention), ("needs_reauth", .needsAttention), ("failed", .needsAttention)]
        for (state, expected) in cases {
            #expect(requested.outcomes(plans: [try plan(id: "p", actionState: state)]) == [expected])
        }
        #expect(RequestOutcome.calendar(state: "succeeded", kind: "cancel") == .calendarRemoved)
        #expect(RequestOutcome.calendar(state: "succeeded", kind: "update") == .calendarUpdated)
    }

    @Test func confirmedRemovalSurvivesArchivedPlanMissingFromList() throws {
        let review = #"{"target":"item:0","state":"calendar","planId":"archived","calendarAction":{"state":"succeeded","kind":"cancel"}}"#
        #expect(try run(items: [Self.event], reviews: [review]).outcomes() == [.calendarRemoved])
    }

    @Test func knowledgeOutcomes() throws {
        let fact = #"{"operation":"set","key":"art_class","value":"Thursdays"}"#
        #expect(try run(knowledge: [fact]).outcomes() == [.needsReview])
        #expect(try run(knowledge: [fact], reviews: [#"{"target":"knowledge:0","state":"saved","planId":null}"#]).outcomes() == [.remembered])
        #expect(try run(knowledge: [fact], reviews: [#"{"target":"knowledge:0","state":"dismissed","planId":null}"#]).outcomes() == [.dismissed])
    }

    @Test func labelsMatchWebCopy() {
        #expect(RequestOutcome.added.label == "Added to household lists")
        #expect(RequestOutcome.calendarPending.label == "Waiting for Google Calendar")
        #expect(RequestOutcome.reply.label == "Reply ready")
        #expect(RequestOutcome.remembered.label == "Household facts updated")
    }

    @Test func applyAllOnlyForUnreviewedResults() throws {
        #expect(try run(items: [Self.event]).canApplyAll)
        #expect(try !run().canApplyAll)
        #expect(try !run(items: [Self.event], reviews: [#"{"target":"item:0","state":"kept","planId":"p"}"#]).canApplyAll)
    }

    @Test func onlyHttpSourcesBecomeLinks() throws {
        let links = try run(sources: ["https://example.com/recipe", "javascript:alert(1)", "http://school.example.org", "file:///etc/passwd", "not a url", "mailto:a@b.c"]).sourceLinks
        #expect(links.map(\.absoluteString) == ["https://example.com/recipe", "http://school.example.org"])
    }

    @Test func detectsPastedLinks() {
        #expect(AssistantLinks.firstLink(in: "Make this https://cooking.example.com/pasta tonight")?.host() == "cooking.example.com")
        #expect(AssistantLinks.firstLink(in: "Drinks with Bob on Monday at 6") == nil)
    }

    @Test func pauseDetectorMatchesWebThresholds() {
        var detector = PauseDetector()
        // 300 ms of speech, then quiet: ends after 1.5 s of quiet.
        for _ in 0..<6 { #expect(detector.feed(rms: 0.05, milliseconds: 50) == nil) }
        for _ in 0..<29 { #expect(detector.feed(rms: 0.001, milliseconds: 50) == nil) }
        #expect(detector.feed(rms: 0.001, milliseconds: 50) == .speechEnded)

        var silent = PauseDetector()
        for _ in 0..<199 { #expect(silent.feed(rms: 0.001, milliseconds: 50) == nil) }
        #expect(silent.feed(rms: 0.001, milliseconds: 50) == .noSpeech)

        // A blip shorter than 250 ms is not speech.
        var blip = PauseDetector()
        for _ in 0..<4 { _ = blip.feed(rms: 0.05, milliseconds: 50) }
        #expect(!blip.heardSpeech)
    }

    @Test func editedItemEncodesEveryNullableKey() throws {
        let item = AssistantItem(kind: "event", title: "Dinner")
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as! [String: Any]
        #expect(Set(object.keys) == ["kind", "title", "quantity", "start", "end", "location", "notes"])
        #expect(object["quantity"] is NSNull)
    }
}
