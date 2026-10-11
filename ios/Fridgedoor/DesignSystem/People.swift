import FridgedoorKit
import SwiftUI

/// One color per person, the same on every screen and every device: people are
/// ordered by id so each member always lands on the same swatch.
enum PersonColor {
    static let swatches: [Color] = [
        Color(light: 0x455A7A, dark: 0xACBFD9), // slate (the app accent)
        Color(light: 0x8A5A3C, dark: 0xE2B38F), // clay
        Color(light: 0x4E7358, dark: 0xA9D3B4), // sage
        Color(light: 0x6E5378, dark: 0xCDB2D8), // plum
    ]

    static func color(for id: String, in household: [HouseholdPerson]) -> Color {
        let ordered = household.map(\.id).sorted()
        let index = ordered.firstIndex(of: id) ?? abs(id.hashValue)
        return swatches[index % swatches.count]
    }
}

extension PlannerStore {
    func person(_ id: String?) -> HouseholdPerson? {
        guard let id else { return nil }
        return household.first { $0.id == id }
    }

    func personColor(_ id: String) -> Color { PersonColor.color(for: id, in: household) }

    /// "you" for the signed-in member, otherwise their first name.
    func personName(_ id: String) -> String {
        if id == member.id { return "you" }
        return person(id)?.firstName ?? "someone else"
    }
}

/// Initial in the person's color. Reads as the person's name for VoiceOver.
struct PersonAvatar: View {
    let personId: String
    var size: CGFloat = 24
    @Environment(PlannerStore.self) private var store
    @ScaledMetric private var scale: CGFloat = 1

    var body: some View {
        let name = store.person(personId)?.displayName ?? "?"
        Text(String(name.prefix(1)).uppercased())
            .font(.system(size: size * 0.48 * scale, weight: .semibold, design: .serif))
            .foregroundStyle(Color.onAccent)
            .frame(width: size * scale, height: size * scale)
            .background(store.personColor(personId), in: .circle)
            .accessibilityLabel(personId == store.member.id ? "Assigned to you" : "Assigned to \(name)")
    }
}
