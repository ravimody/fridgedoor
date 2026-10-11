import Foundation

/// Store sections for the Groceries list, in a typical walk through the store.
/// `GroceryAisle.of("Baby spinach")` sorts an item from a keyword table; the
/// assistant can do this better later, but a table covers the common items.
public enum GroceryAisle: String, CaseIterable, Sendable, Identifiable {
    case produce, dairy, bakery, meat, pantry, frozen, drinks, snacks, household, personalCare, other

    public var id: Self { self }

    public var title: String {
        switch self {
        case .produce: "Produce"
        case .dairy: "Dairy & eggs"
        case .bakery: "Bakery"
        case .meat: "Meat & seafood"
        case .pantry: "Pantry"
        case .frozen: "Frozen"
        case .drinks: "Drinks"
        case .snacks: "Snacks"
        case .household: "Household"
        case .personalCare: "Personal care"
        case .other: "Other"
        }
    }

    /// The aisle for an item title. Multi-word phrases win ("peanut butter" is pantry,
    /// not dairy), then "frozen", then the last recognized word ("chicken broth" → broth).
    public static func of(_ title: String) -> GroceryAisle {
        let words = normalizedWords(title)
        guard !words.isEmpty else { return .other }
        let padded = " " + words.joined(separator: " ")
        for (phrase, aisle) in phrases where padded.contains(" " + phrase) { return aisle }
        if words.contains("frozen") { return .frozen }
        for word in words.reversed() {
            for candidate in singulars(word) {
                if let aisle = keywords[candidate] { return aisle }
            }
        }
        return .other
    }

    // MARK: Table

    /// Checked in order; a phrase matches at a word start, so "paper towel" also matches "paper towels".
    private static let phrases: [(String, GroceryAisle)] = [
        ("hot dog bun", .bakery), ("hamburger bun", .bakery), ("english muffin", .bakery),
        ("half and half", .dairy), ("sour cream", .dairy), ("cream cheese", .dairy),
        ("ice cream", .frozen), ("ice pop", .frozen),
        ("peanut butter", .pantry), ("almond butter", .pantry), ("coconut milk", .pantry), ("baking soda", .pantry),
        ("baking powder", .pantry), ("tomato paste", .pantry), ("tomato sauce", .pantry), ("canned", .pantry),
        ("black pepper", .pantry), ("coffee bean", .drinks),
        ("green bean", .produce), ("snap pea", .produce),
        ("hot dog", .meat),
        ("paper towel", .household), ("toilet paper", .household), ("trash bag", .household), ("garbage bag", .household),
        ("dish soap", .household), ("dishwasher", .household), ("plastic wrap", .household), ("dryer sheet", .household),
        ("fabric softener", .household), ("light bulb", .household), ("coffee filter", .household),
        ("body wash", .personalCare), ("hand soap", .personalCare), ("lip balm", .personalCare), ("band aid", .personalCare),
        ("cotton swab", .personalCare), ("baby wipe", .personalCare),
    ]

    private static let keywords: [String: GroceryAisle] = {
        let table: [GroceryAisle: [String]] = [
            .produce: [
                "apple", "banana", "orange", "lemon", "lime", "grape", "berry", "strawberry", "blueberry", "raspberry",
                "blackberry", "avocado", "tomato", "potato", "onion", "garlic", "ginger", "carrot", "celery", "cucumber",
                "lettuce", "spinach", "kale", "arugula", "cabbage", "broccoli", "cauliflower", "pepper", "zucchini", "squash",
                "mushroom", "corn", "pear", "peach", "plum", "cherry", "mango", "pineapple", "melon", "watermelon",
                "cantaloupe", "kiwi", "herb", "cilantro", "parsley", "basil", "mint", "dill", "scallion", "leek", "shallot",
                "asparagus", "sprout", "beet", "radish", "salad", "greens", "fruit", "veggie", "vegetable", "clementine",
                "grapefruit", "pomegranate", "fig", "jalapeno", "eggplant", "yam", "artichoke", "apricot", "nectarine",
                "tofu", "romaine",
            ],
            .dairy: [
                "milk", "egg", "butter", "cheese", "yogurt", "yoghurt", "cream", "creamer", "cheddar", "mozzarella",
                "parmesan", "feta", "ricotta", "brie", "kefir", "ghee", "margarine", "buttermilk",
            ],
            .bakery: [
                "bread", "bagel", "baguette", "bun", "croissant", "muffin", "tortilla", "pita", "naan", "loaf", "sourdough",
                "brioche", "cake", "pie", "donut", "doughnut", "scone", "roll",
            ],
            .meat: [
                "chicken", "beef", "pork", "turkey", "ham", "bacon", "sausage", "steak", "lamb", "salmon", "tuna", "shrimp",
                "fish", "cod", "tilapia", "halibut", "crab", "lobster", "scallop", "meatball", "prosciutto", "salami",
                "pepperoni", "chorizo", "thigh", "breast", "drumstick", "rib", "brisket", "mince",
            ],
            .pantry: [
                "rice", "pasta", "spaghetti", "penne", "noodle", "flour", "sugar", "salt", "oil", "vinegar", "sauce", "ketchup",
                "mustard", "mayo", "mayonnaise", "honey", "syrup", "jam", "jelly", "cereal", "oat", "oatmeal", "granola",
                "bean", "lentil", "chickpea", "broth", "stock", "soup", "spice", "cinnamon", "paprika", "cumin", "vanilla",
                "yeast", "quinoa", "couscous", "salsa", "breadcrumb", "cornstarch", "nutella", "pickle", "olive",
            ],
            .frozen: ["ice", "popsicle", "sorbet", "gelato", "waffle", "pizza", "fries", "nugget"],
            .drinks: [
                "water", "seltzer", "soda", "juice", "coffee", "tea", "beer", "wine", "kombucha", "lemonade", "cola", "coke",
                "sprite", "gatorade",
            ],
            .snacks: [
                "chip", "crisp", "cracker", "pretzel", "popcorn", "cookie", "candy", "chocolate", "nut", "almond", "cashew",
                "peanut", "pistachio", "bar", "gum", "jerky", "goldfish", "raisin",
            ],
            .household: [
                "tissue", "napkin", "foil", "detergent", "laundry", "bleach", "sponge", "cleaner", "battery",
                "bulb", "ziploc", "parchment", "filter", "candle", "trash", "garbage",
            ],
            .personalCare: [
                "shampoo", "conditioner", "toothpaste", "toothbrush", "floss", "deodorant", "soap", "lotion", "sunscreen",
                "razor", "diaper", "wipe", "tampon", "vitamin", "medicine", "ibuprofen", "tylenol", "advil", "bandaid",
                "mouthwash", "chapstick",
            ],
        ]
        var result: [String: GroceryAisle] = [:]
        for (aisle, words) in table { for word in words { result[word] = aisle } }
        return result
    }()

    /// Lowercased, accent-free words with punctuation removed ("Jalapeños!" → ["jalapenos"]).
    static func normalizedWords(_ text: String) -> [String] {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .replacingOccurrences(of: "-", with: " ")
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    /// The word and its plausible singular forms: "berries" → berries, berry, berrie, berri.
    private static func singulars(_ word: String) -> [String] {
        var forms = [word]
        if word.hasSuffix("ies"), word.count > 4 { forms.append(String(word.dropLast(3)) + "y") }
        if word.hasSuffix("ves"), word.count > 4 { forms.append(String(word.dropLast(3)) + "f") }
        if word.hasSuffix("es"), word.count > 3 { forms.append(String(word.dropLast(2))) }
        if word.hasSuffix("s"), word.count > 2 { forms.append(String(word.dropLast())) }
        return forms
    }
}

// MARK: - Duplicates

public extension GroceryEntry {
    /// Whether two list titles name the same thing: case, accents, spacing and a
    /// simple plural are ignored ("Lemons" = "lemon", "Tomatoes" = "tomato").
    static func titlesMatch(_ a: String, _ b: String) -> Bool {
        let x = GroceryAisle.normalizedWords(a).joined(separator: " ")
        let y = GroceryAisle.normalizedWords(b).joined(separator: " ")
        guard !x.isEmpty, !y.isEmpty else { return false }
        return x == y || x + "s" == y || y + "s" == x || x + "es" == y || y + "es" == x
    }

    /// The sum of two plain-number quantities ("2" + "1.5" → "3.5"), or nil if either
    /// is missing or has a unit ("2 lb", "1 dozen") and can't be added safely.
    static func summedQuantity(_ a: String?, _ b: String?) -> String? {
        guard let x = plainNumber(a), let y = plainNumber(b) else { return nil }
        return NSDecimalNumber(decimal: x + y).stringValue
    }

    private static func plainNumber(_ text: String?) -> Decimal? {
        guard let text = text?.trimmingCharacters(in: .whitespaces),
              text.range(of: #"^\d{1,6}(\.\d{1,3})?$"#, options: .regularExpression) != nil
        else { return nil }
        return Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
    }
}

public extension Array where Element == ListItem {
    /// The open item with the same title, if any (`GroceryEntry.titlesMatch`).
    func openDuplicate(of title: String) -> ListItem? {
        first { !$0.isCompleted && GroceryEntry.titlesMatch($0.title, title) }
    }
}
