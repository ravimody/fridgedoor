import FridgedoorKit
import SwiftUI

/// Wraps chips onto as many lines as they need (Dynamic Type safe).
struct PlanFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(for: subviews, width: proposal.width ?? .infinity)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(for: subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func rows(for subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width { rows.append(Row()) }
            var row = rows[rows.count - 1]
            row.width += (row.indices.isEmpty ? 0 : spacing) + min(size.width, width)
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows.filter { !$0.indices.isEmpty }
    }
}

/// A compact plan row for lists: sans title, one line of when and where, and one
/// status line (DESIGN.md → Type; no chip soup).
struct PlanRow: View {
    let plan: PlanSummary
    /// False where the list already says it ("Saved", "On calendar"): the status line then
    /// only appears when it says something else (needs you, a problem, private).
    var showsNeutralStatus = true
    @Environment(PlannerStore.self) private var store

    var body: some View {
        let facts = plan.effectiveFacts
        let decision = store.decision(for: plan)
        let tone = decision.tone
        // When the status already says the time is missing, name just the day.
        let when = decision.primary == .setTime
            ? HomeSchedule.start(facts.time, in: store.timeZone).map { TimeLabels.relativeDay($0, in: store.timeZone) }
            : TimeLabels.plan(facts.time, in: store.timeZone)
        VStack(alignment: .leading, spacing: 4) {
            Text(facts.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(plan.isClosed ? Color.muted : Color.ink)
                .strikethrough(plan.status == "archived" && plan.calendarAction?.kind == "cancel", color: .muted)
            Text([when, facts.location].compactMap(\.self).joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(Color.muted)
                .lineLimit(2)
            if showsNeutralStatus || tone != .neutral || plan.isPrivate {
                PlanStatusLine(plan: plan)
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
        .contentShape(.rect)
    }
}

enum PlanText {
    /// Plain-text summary for ShareLink / copy.
    static func summary(_ facts: PlanFacts, in zone: TimeZone) -> String {
        var lines = [facts.title, TimeLabels.plan(facts.time, in: zone)]
        if let location = facts.location { lines.append(location) }
        if !facts.participants.isEmpty { lines.append("With " + facts.participants.formatted(.list(type: .and))) }
        if let notes = facts.notes { lines.append(""); lines.append(notes) }
        if !facts.preparationTasks.isEmpty {
            lines.append("")
            lines.append("To prepare:")
            lines += facts.preparationTasks.map { "• \($0)" }
        }
        return lines.joined(separator: "\n")
    }

    static func mapsURL(for location: String) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [URLQueryItem(name: "q", value: location)]
        return components?.url
    }

    /// Sentence case for a stored category: "school" → "School", "after_school" → "After school".
    static func categoryLabel(_ category: String) -> String {
        let words = category.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return "General" }
        return first.uppercased() + words.dropFirst().lowercased()
    }
}
