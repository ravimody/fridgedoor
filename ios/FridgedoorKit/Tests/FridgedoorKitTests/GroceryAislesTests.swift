import Foundation
import Testing
@testable import FridgedoorKit

@Suite struct GroceryAislesTests {
    @Test(arguments: [
        ("Baby spinach", GroceryAisle.produce), ("Apples", .produce), ("Blueberries", .produce), ("Tomatoes", .produce),
        ("Green beans", .produce), ("Jalapeños", .produce),
        ("Oat milk", .dairy), ("Eggs", .dairy), ("Sour cream", .dairy), ("Greek yogurt", .dairy),
        ("Sourdough bread", .bakery), ("Hot dog buns", .bakery), ("Loaves", .bakery),
        ("Chicken thighs", .meat), ("Hot dogs", .meat), ("Salmon", .meat),
        ("Peanut butter", .pantry), ("Chicken broth", .pantry), ("Black beans", .pantry), ("Canned tomatoes", .pantry),
        ("Kix cereal", .pantry), ("Baking soda", .pantry),
        ("Ice cream", .frozen), ("Frozen peas", .frozen), ("Frozen strawberries", .frozen),
        ("Sparkling water", .drinks), ("Coffee beans", .drinks), ("Apple juice", .drinks),
        ("Tortilla chips", .snacks), ("Granola bars", .snacks), ("Cookies", .snacks),
        ("Paper towels", .household), ("Dish soap", .household), ("Coffee filters", .household), ("Trash bags", .household),
        ("Toothpaste", .personalCare), ("Hand soap", .personalCare), ("Size 4 diapers", .personalCare),
        ("Birthday candles for the cake", .bakery), ("Gift card", .other), ("", .other), ("!!!", .other),
    ])
    func sortsIntoAisles(title: String, aisle: GroceryAisle) {
        #expect(GroceryAisle.of(title) == aisle)
    }

    @Test func aisleOrderIsTheStoreWalk() {
        #expect(GroceryAisle.allCases.first == .produce)
        #expect(GroceryAisle.allCases.last == .other)
        #expect(GroceryAisle.dairy.title == "Dairy & eggs")
    }

    @Test(arguments: [
        ("Lemons", "lemon", true), ("  Coffee   filters ", "coffee filters", true), ("Tomato", "Tomatoes", true),
        ("Jalapeño", "jalapeno", true), ("Milk", "Oat milk", false), ("Pay the water bill", "pay the water bill", true),
        ("Eggs", "Eggplant", false), ("", "", false),
    ])
    func matchesDuplicateTitles(a: String, b: String, match: Bool) {
        #expect(GroceryEntry.titlesMatch(a, b) == match)
    }

    @Test func sumsOnlyPlainNumbers() {
        #expect(GroceryEntry.summedQuantity("2", "2") == "4")
        #expect(GroceryEntry.summedQuantity("1.5", "2") == "3.5")
        #expect(GroceryEntry.summedQuantity(" 3", "1 ") == "4")
        #expect(GroceryEntry.summedQuantity("2 lb", "1") == nil)
        #expect(GroceryEntry.summedQuantity("1 dozen", "1 dozen") == nil)
        #expect(GroceryEntry.summedQuantity(nil, "2") == nil)
        #expect(GroceryEntry.summedQuantity("½", "1") == nil)
    }

    @Test func findsOpenDuplicatesOnly() {
        func item(_ id: String, _ title: String, done: Bool = false) -> ListItem {
            ListItem(id: id, kind: .grocery, title: title, quantity: nil, assigneeId: nil, dueTime: nil, snoozedUntil: nil,
                     completedAt: done ? "2026-10-09T12:00:00Z" : nil, revision: 1, createdAt: "2026-10-01T12:00:00Z")
        }
        let items = [item("a", "Lemons", done: true), item("b", "Lemon"), item("c", "Milk")]
        #expect(items.openDuplicate(of: "lemons")?.id == "b")
        #expect(items.openDuplicate(of: "Bread") == nil)
        #expect([item("a", "Lemons", done: true)].openDuplicate(of: "Lemons") == nil)
    }
}
