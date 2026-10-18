import Foundation
import Testing
@testable import FridgedoorKit

/// Rows for the interactive Groceries, To do and Decisions widgets.
@Suite struct WidgetListTests {
    let member = Member(id: "m1", householdId: "h1", displayName: "Alex Rivera", timezone: "America/New_York")
    let household = [HouseholdPerson(id: "m1", displayName: "Alex Rivera"), HouseholdPerson(id: "m2", displayName: "Sam")]
    // 2026-10-10 10:00 New York (a Saturday).
    let now = PlannerDates.instant("2026-10-10T14:00:00Z")!

    func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(json.utf8)) }

    func plan(_ id: String, title: String, visibility: String = "shared", status: String = "proposed", time: String?, unresolved: String = "", saved: Bool = false) throws -> PlanSummary {
        let timeJSON = time.map { ",\"time\":\($0)" } ?? ""
        return try decode(PlanSummary.self, """
        {"id":"\(id)","revision":1,"visibility":"\(visibility)","status":"\(status)","facts":{"title":"\(title)","category":"school","participants":[]\(timeJSON),"preparationTasks":[],"unresolvedFields":[\(unresolved)]},"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z","sourceSummary":{"kind":"email","count":1,"available":true},"possibleDuplicate":false\(saved ? ",\"savedInPlanner\":true" : "")}
        """)
    }

    func snapshot(todos: [ListItem] = [], groceries: [ListItem] = [], plans: [PlanSummary] = [], googleReady: Bool = true) -> WidgetSnapshot {
        WidgetSnapshotBuilder.build(member: member, plans: plans, agenda: [], todos: todos, groceries: groceries, reminders: [], household: household, googleReady: googleReady, now: now)
    }

    @Test func groceriesFollowTheStoreWalkAndSkipCheckedItems() throws {
        let groceries = try decode([ListItem].self, """
        [{"id":"g1","kind":"grocery","title":"Paper towels","revision":1,"createdAt":"2026-10-01T00:00:00Z"},
         {"id":"g2","kind":"grocery","title":"Bananas","quantity":"1 bunch","revision":1,"createdAt":"2026-10-02T00:00:00Z"},
         {"id":"g3","kind":"grocery","title":"Eggs","quantity":"1 dozen","revision":1,"createdAt":"2026-10-03T00:00:00Z"},
         {"id":"g4","kind":"grocery","title":"Apples","revision":1,"createdAt":"2026-10-04T00:00:00Z","completedAt":"2026-10-09T00:00:00Z"}]
        """)
        let rows = try #require(snapshot(groceries: groceries).groceries)
        #expect(rows.map(\.id) == ["g2", "g3", "g1"])
        #expect(rows.first?.detail == "1 bunch")
        #expect(rows.first?.section == GroceryAisle.of("Bananas").title)
    }

    @Test func todosAreGroupedByWhenAndLeaveLaterAside() throws {
        let todos = try decode([ListItem].self, """
        [{"id":"t1","kind":"todo","title":"Pay the water bill","dueTime":"2026-10-09","revision":1,"createdAt":"2026-10-01T00:00:00Z"},
         {"id":"t2","kind":"todo","title":"Call the plumber","dueTime":"2026-10-10","revision":1,"createdAt":"2026-10-01T00:00:00Z"},
         {"id":"t3","kind":"todo","title":"Order a gift","dueTime":"2026-10-11","assigneeId":"m2","revision":1,"createdAt":"2026-10-01T00:00:00Z"},
         {"id":"t4","kind":"todo","title":"Clean the garage","snoozedUntil":"2026-10-17","revision":1,"createdAt":"2026-10-01T00:00:00Z"},
         {"id":"t5","kind":"todo","title":"Call the eye doctor","assigneeId":"m1","revision":1,"createdAt":"2026-10-01T00:00:00Z"}]
        """)
        let rows = try #require(snapshot(todos: todos).todos)
        #expect(rows.map(\.id) == ["t1", "t2", "t3", "t5"])
        #expect(rows.map(\.section) == ["Overdue", "Today", "Coming up", "No date"])
        #expect(rows[0].overdue == true)
        #expect(rows[2].detail == "Tomorrow")
        #expect(rows[2].assignee == "S")
        #expect(rows[3].assignee == nil)
    }

    @Test func decisionsOfferOnlyWhatOneTapCanDo() throws {
        let timed = "{\"kind\":\"timed\",\"start\":\"2026-10-13T14:00:00-04:00\",\"end\":\"2026-10-13T16:00:00-04:00\",\"timezone\":\"America/New_York\"}"
        let unresolved = "{\"kind\":\"unresolved\",\"dateHint\":\"2026-10-16\",\"missing\":[\"start\"]}"
        let deadline = "{\"kind\":\"deadline\",\"at\":\"2026-10-11T08:00:00-04:00\",\"timezone\":\"America/New_York\"}"
        let plans = [
            try plan("p1", title: "Book fair shift", time: timed),
            try plan("p2", title: "Conference", status: "needs_details", time: unresolved, unresolved: "\"start\""),
            try plan("p3", title: "Permission slip", time: deadline),
            try plan("p4", title: "Renew registration", visibility: "private", time: timed),
            try plan("p5", title: "Already on the calendar", status: "accepted", time: timed),
        ]
        let rows = try #require(snapshot(plans: plans).decisions)
        let byId = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        #expect(byId["p1"]?.action == .calendar)
        #expect(byId["p2"]?.action == nil)
        #expect(byId["p2"]?.detail == "Fri, Oct 16 · needs a time")
        #expect(byId["p3"]?.action == .keep)
        #expect(byId["p3"]?.detail.hasPrefix("Due tomorrow") == true)
        #expect(byId["p4"]?.action == .keep)
        #expect(byId["p4"]?.isPrivate == true)
        #expect(byId["p5"] == nil)
        // Soonest first.
        #expect(rows.first?.id == "p3")
        // Without Google, nothing goes to the calendar from the widget.
        #expect(try #require(snapshot(plans: plans, googleReady: false).decisions).first { $0.id == "p1" }?.action == .keep)
    }

    @Test func checkingOffUpdatesTheSnapshotAndOffersUndo() throws {
        let groceries = try decode([ListItem].self, """
        [{"id":"g1","kind":"grocery","title":"Bananas","revision":1,"createdAt":"2026-10-01T00:00:00Z"},
         {"id":"g2","kind":"grocery","title":"Eggs","revision":1,"createdAt":"2026-10-02T00:00:00Z"}]
        """)
        let base = snapshot(groceries: groceries)
        let checked = base.checking("g1", kind: "grocery", done: true, at: now)
        #expect(checked.groceries?.map(\.id) == ["g2"])
        #expect(checked.openGroceryCount == 1)
        #expect(checked.undoable(at: now.addingTimeInterval(60))?.title == "Bananas")
        #expect(checked.undoable(at: now.addingTimeInterval(WidgetSnapshot.undoWindow + 1)) == nil)

        let undone = checked.checking("g1", kind: "grocery", done: false, at: now)
        #expect(undone.lastChecked == nil)
        // A rebuilt snapshot keeps a fresh check-off so the widget's Undo survives refreshes.
        #expect(base.keepingCheck(from: checked, at: now.addingTimeInterval(30)).lastChecked?.id == "g1")
        #expect(!base.sameContent(as: checked))
    }

    @Test func oldSnapshotsWithoutListsStillDecode() throws {
        let json = """
        {"generatedAt":0,"memberName":"Alex","timezone":"America/New_York","entries":[],"attentionCount":0,"openTodoCount":2,"openGroceryCount":3}
        """
        let decoded = try decode(WidgetSnapshot.self, json)
        #expect(decoded.groceries == nil)
        #expect(decoded.lastChecked == nil)
    }
}
