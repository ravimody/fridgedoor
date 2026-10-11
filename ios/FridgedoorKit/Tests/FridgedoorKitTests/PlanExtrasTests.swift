import Foundation
import Testing
@testable import FridgedoorKit

@Suite struct PlanExtrasTests {
    let zone = TimeZone(identifier: "America/New_York")!

    func plan(status: String = "proposed", saved: Bool = false, action: CalendarActionRef? = nil, facts: PlanFacts? = nil, pending: PlanFacts? = nil) throws -> PlanSummary {
        let base = facts ?? PlanFacts(title: "Soccer", time: .timed(start: "2026-10-11T17:30:00-04:00", end: "2026-10-11T18:30:00-04:00", timezone: "America/New_York"))
        func object(_ value: some Encodable) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }
        var wire: [String: Any] = [
            "id": "p1", "revision": 2, "visibility": "shared", "status": status, "facts": try object(base), "changeKind": "new",
            "createdAt": "2026-10-10T00:00:00Z", "updatedAt": "2026-10-10T00:00:00Z", "possibleDuplicate": false, "savedInPlanner": saved,
            "sourceSummary": ["kind": "manual", "count": 0, "available": false],
        ]
        if let pending { wire["pendingFacts"] = try object(pending) }
        if let action { wire["calendarAction"] = try object(action) }
        return try JSONDecoder().decode(PlanSummary.self, from: JSONSerialization.data(withJSONObject: wire))
    }

    @Test func calendarOutcomeMatchesWebLabels() {
        #expect(CalendarOutcome(state: "succeeded", kind: "create").label == "Added to Google Calendar")
        #expect(CalendarOutcome(state: "succeeded", kind: "cancel") == .removed)
        #expect(CalendarOutcome(state: "succeeded", kind: "update") == .updated)
        #expect(CalendarOutcome(state: "running", kind: "create") == .pending)
        #expect(CalendarOutcome(state: "needs_reauth", kind: nil) == .needsAttention)
    }

    @Test func archiveBucketsFollowPlannerArchive() throws {
        #expect(try plan().needsDecision)
        #expect(try !plan(saved: true).needsDecision)
        #expect(try plan(saved: true).isSaved)
        let added = CalendarActionRef(actionId: "a", state: "succeeded", kind: "create")
        #expect(try plan(action: added).isSaved)
        #expect(try !plan(action: added).needsDecision)
        #expect(try plan(action: added, pending: PlanFacts(title: "Soccer moved")).needsDecision)
        #expect(try plan(action: CalendarActionRef(actionId: "a", state: "pending", kind: "create")).needsDecision)
        #expect(try !plan(status: "dismissed", saved: true).isSaved)
    }

    @Test func calendarEditingRules() throws {
        let running = try plan(action: CalendarActionRef(actionId: "a", state: "running", kind: "update"))
        #expect(running.isCalendarBusy && !running.canEdit && running.hasCalendarEvent)
        let failedCreate = try plan(action: CalendarActionRef(actionId: "a", state: "failed", kind: "create"))
        #expect(!failedCreate.hasCalendarEvent && failedCreate.calendarAction!.isRetryable)
        #expect(!CalendarActionRef(actionId: "a", state: "conflict", kind: "update").isRetryable)
        let deadline = try plan(facts: PlanFacts(title: "Slip", time: .deadline(at: "2026-10-12T09:00:00-04:00", timezone: "America/New_York")))
        #expect(!deadline.canAddToCalendar)
        #expect(deadline.reminderAnchor != nil)
        let unresolved = try plan(facts: PlanFacts(title: "Conference", time: .timed(start: "2026-10-12T09:00:00-04:00", end: "2026-10-12T10:00:00-04:00", timezone: "America/New_York"), unresolvedFields: ["location"]))
        #expect(!unresolved.canAddToCalendar)
    }

    @Test func historyLabelsAreReadable() throws {
        let json = #"[{"id":"1","type":"suggestion_updated","actorLabel":"System","safePayload":{"changeKind":"cancel"},"createdAt":"2026-10-10T00:00:00Z"},{"id":"2","type":"calendar_sync_started","actorLabel":"Sam","safePayload":{},"createdAt":"2026-10-10T00:00:00Z"}]"#
        let entries = try JSONDecoder().decode([HistoryEntry].self, from: Data(json.utf8))
        #expect(entries.map(\.readableLabel) == ["Cancellation suggested", "Calendar sync started"])
    }

    @Test func changedFieldsDiffsPendingUpdate() {
        let current = PlanFacts(title: "Soccer", location: "Field 3", notes: "Bring water")
        let pending = PlanFacts(title: "Soccer", location: "Field 5", notes: "Bring water")
        #expect(pending.changedFields(from: current) == [.location])
    }

    // MARK: Draft

    @Test func untouchedDraftIsClean() throws {
        let facts = PlanFacts(title: "Soccer", time: .unresolved(dateHint: "2026-10-12", startHint: nil, missing: ["start", "end"]), unresolvedFields: ["start"])
        let draft = PlanDraft(facts: facts, timeZone: zone)
        #expect(!draft.isDirty)
        #expect(try draft.facts() == facts)
    }

    @Test func timedDraftValidatesAndClearsTimeMarkers() throws {
        var draft = PlanDraft(facts: PlanFacts(title: "Conference", time: .unresolved(dateHint: "2026-10-12", startHint: nil, missing: ["start", "end"]), unresolvedFields: ["start", "end", "location"]), timeZone: zone)
        draft.setTimeMode(.timed)
        draft.start = PlannerDates.instant("2026-10-12T15:00:00-04:00")!
        draft.end = PlannerDates.instant("2026-10-12T14:00:00-04:00")!
        #expect(throws: PlanDraft.ValidationError.endBeforeStart) { try draft.facts() }
        draft.end = PlannerDates.instant("2026-10-12T16:00:00-04:00")!
        let facts = try draft.facts()
        #expect(facts.time == .timed(start: "2026-10-12T15:00:00-04:00", end: "2026-10-12T16:00:00-04:00", timezone: "America/New_York"))
        #expect(facts.unresolvedFields == ["location"])
    }

    @Test func allDayDraftUsesExclusiveEnd() throws {
        var draft = PlanDraft(facts: PlanFacts(title: "Picture day", time: .allDay(startDate: "2026-10-14", endDateExclusive: "2026-10-15")), timeZone: zone)
        #expect(PlannerDates.dayString(draft.lastDay, in: zone) == "2026-10-14")
        draft.timeEdited = true
        draft.lastDay = PlannerDates.day("2026-10-16", in: zone)!
        #expect(try draft.facts().time == .allDay(startDate: "2026-10-14", endDateExclusive: "2026-10-17"))
        draft.lastDay = PlannerDates.day("2026-10-13", in: zone)!
        #expect(throws: PlanDraft.ValidationError.allDayEndBeforeStart) { try draft.facts() }
    }

    @Test func draftEncodesStrictFacts() throws {
        var draft = PlanDraft(facts: PlanFacts(title: "Dinner", location: "Harbor Grill", notes: "x"), timeZone: zone)
        draft.location = "  "
        draft.notes = ""
        draft.tasks.append(.init(text: "  "))
        draft.tasks.append(.init(text: "Book a sitter"))
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try draft.facts())) as! [String: Any]
        #expect(Set(encoded.keys) == ["title", "category", "participants", "preparationTasks", "unresolvedFields"])
        #expect(encoded["preparationTasks"] as? [String] == ["Book a sitter"])
    }

    @Test func draftCapsCountUTF16UnitsLikeTheServer() throws {
        // 150 emoji are 150 Characters but 300 UTF-16 units; zod's `.max(200)` rejects them.
        var draft = PlanDraft(facts: PlanFacts(title: String(repeating: "🎉", count: 100)), timeZone: zone)
        #expect(try draft.facts().title.utf16.count == 200)
        draft.title = String(repeating: "🎉", count: 150)
        #expect(throws: PlanDraft.ValidationError.tooLong("The title")) { try draft.facts() }
    }
}
