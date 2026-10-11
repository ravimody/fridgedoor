import Foundation
import Testing
@testable import FridgedoorKit

@Suite struct ListsExtrasTests {
    @Test(arguments: [
        ("2 avocados", "Avocados", "2"),
        ("milk x2", "Milk", "2"),
        ("Milk × 3", "Milk", "3"),
        ("eggs 2x", "Eggs", "2"),
        ("1 dozen eggs", "Eggs", "1 dozen"),
        ("2lb chicken thighs", "Chicken thighs", "2 lb"),
        ("2 cans of tomatoes", "Tomatoes", "2 cans"),
        ("a bag of chips", "Chips", "1 bag"),
        ("two cartons oat milk", "Oat milk", "2 cartons"),
        ("half gallon milk", "Milk", "½ gallon"),
        ("flour (5 lb)", "Flour", "5 lb"),
        ("3 large eggs", "Large eggs", "3"),
    ])
    func parsesGroceryQuantities(input: String, title: String, quantity: String) {
        #expect(GroceryEntry.parse(input) == GroceryEntry(title: title, quantity: quantity))
    }

    @Test(arguments: ["2% milk", "Kix cereal", "Size 4 diapers", "7-grain bread", "Bananas", "box"])
    func leavesPlainTitlesAlone(input: String) {
        let parsed = GroceryEntry.parse(input)
        #expect(parsed.quantity == nil)
        #expect(parsed.title.lowercased() == input.lowercased())
    }

    @Test func capitalizesAndTrims() {
        #expect(GroceryEntry.parse("  sourdough   bread ") == GroceryEntry(title: "Sourdough bread", quantity: nil))
        #expect(GroceryEntry.parse("") == GroceryEntry(title: "", quantity: nil))
    }

    @Test func capsTitleInUTF16UnitsLikeTheServer() {
        // Each emoji is one Character but two UTF-16 units; the server counts units.
        let title = GroceryEntry.parse(String(repeating: "🍎", count: 150)).title
        #expect(title == String(repeating: "🍎", count: 100))
        // Never split a character to hit the limit exactly.
        let odd = GroceryEntry.parse("A" + String(repeating: "🍎", count: 150)).title
        #expect(odd.utf16.count == GroceryEntry.maxTitle - 1)
    }

    private let zone = TimeZone(identifier: "America/New_York")!
    private func item(_ id: String, kind: ListKind = .todo, due: String? = nil, created: String = "2026-10-01T12:00:00.000Z", completed: String? = nil, title: String? = nil) -> ListItem {
        ListItem(id: id, kind: kind, title: title ?? id, quantity: nil, assigneeId: nil, dueTime: due, snoozedUntil: nil, completedAt: completed, revision: 1, createdAt: created)
    }

    @Test func dueStateUsesMemberTimezone() throws {
        // 2026-10-10 23:30 in New York is already the 11th in UTC.
        let now = try #require(PlannerDates.instant("2026-10-11T03:30:00Z"))
        #expect(item("a", due: "2026-10-10").dueState(in: zone, now: now) == .today)
        #expect(item("b", due: "2026-10-09").dueState(in: zone, now: now) == .overdue)
        #expect(item("c", due: "2026-10-11").dueState(in: zone, now: now) == .upcoming)
        #expect(item("d", due: "2026-10-10T22:00:00-04:00").dueState(in: zone, now: now) == .overdue)
        #expect(item("e").dueState(in: zone, now: now) == TaskDueState.none)
    }

    @Test func ordersOpenTodosByDueThenCreated() {
        let items = [
            item("undated-new", created: "2026-10-05T12:00:00.000Z"),
            item("later", due: "2026-10-20"),
            item("overdue", due: "2026-10-01"),
            item("undated-old", created: "2026-09-01T12:00:00.000Z"),
            item("done", due: "2026-09-01", completed: "2026-10-02T12:00:00.000Z"),
        ]
        #expect(items.openOrdered(in: zone).map(\.id) == ["overdue", "later", "undated-old", "undated-new"])
    }

    @Test func buyAgainSkipsOpenAndDuplicateTitles() {
        let items = [
            item("milk-open", kind: .grocery, title: "Milk"),
            item("milk-done", kind: .grocery, completed: "2026-10-03T12:00:00.000Z", title: "milk"),
            item("eggs-old", kind: .grocery, completed: "2026-10-01T12:00:00.000Z", title: "Eggs"),
            item("eggs-new", kind: .grocery, completed: "2026-10-04T12:00:00.000Z", title: "Eggs"),
            item("bread", kind: .grocery, completed: "2026-10-02T12:00:00.000Z", title: "Bread"),
        ]
        #expect(items.buyAgainSuggestions().map(\.id) == ["eggs-new", "bread"])
        #expect(items.completedOrdered().map(\.id) == ["eggs-new", "milk-done", "bread", "eggs-old"])
    }
}
