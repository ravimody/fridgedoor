import FridgedoorKit
import SwiftUI
import WidgetKit

/// Suggestions waiting on you, each with the one thing a tap can do: "Add" (to the
/// household calendar) or "Save"; ones that still need a time open the app.
struct DecisionsWidget: Widget {
    static let kind = "Decisions"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: SnapshotProvider()) { entry in
            DecisionsWidgetView(entry: entry)
        }
        .configurationDisplayName("Decisions")
        .description("Suggestions from email that need you. Add them to the calendar or save them in a tap.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular])
    }
}

struct DecisionsWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                content(snapshot.decisions ?? [])
            } else {
                SignedOutView(family: family, message: "Suggestions that need you will show up here.")
            }
        }
        .containerBackground(Color.paper, for: .widget)
        .widgetURL(URL(string: "fridgedoor://home"))
    }

    @ViewBuilder private func content(_ rows: [WidgetSnapshot.DecisionRow]) -> some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text("\(rows.count)").font(.title2.weight(.semibold)).monospacedDigit()
                    Image(systemName: "sparkles").font(.caption2)
                }
            }
            .accessibilityLabel("\(rows.count) decisions waiting")
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text(rows.isEmpty ? "No decisions" : rows.count == 1 ? "1 decision" : "\(rows.count) decisions").font(.headline).widgetAccentable()
                // Lock Screen: private titles stay hidden.
                Text(rows.first.map { $0.isPrivate ? "Private plan" : $0.title } ?? "You're all caught up")
                    .font(.caption)
                    .lineLimit(2)
                    .privacySensitive()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .systemSmall:
            VStack(alignment: .leading, spacing: 4) {
                WidgetEyebrow(text: "Decisions")
                Spacer(minLength: 0)
                Text("\(rows.count)")
                    .font(.system(size: 40, weight: .regular, design: .serif))
                    .foregroundStyle(rows.isEmpty ? Color.muted : Color.attentionInk)
                    .widgetAccentable()
                Text(rows.isEmpty ? "All caught up" : "waiting on you")
                    .font(.caption)
                    .foregroundStyle(Color.muted)
                if let first = rows.first {
                    Text(first.title).font(.footnote.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(2).privacySensitive(first.isPrivate)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        default:
            let limit = family == .systemMedium ? 2 : 5
            VStack(alignment: .leading, spacing: family == .systemMedium ? 8 : 10) {
                HStack {
                    WidgetEyebrow(text: "Decisions")
                    Text("\(rows.count)").font(.caption2.weight(.bold).monospacedDigit()).foregroundStyle(Color.muted)
                    Spacer(minLength: 0)
                }
                if rows.isEmpty {
                    WidgetEmpty(symbol: "checkmark.seal", title: "All caught up", message: "New suggestions from email will show up here.")
                } else {
                    ForEach(rows.prefix(limit)) { DecisionWidgetRow(row: $0) }
                    Spacer(minLength: 0)
                    if rows.count > limit {
                        Text("+\(rows.count - limit) more in Fridgedoor").font(.caption2).foregroundStyle(Color.muted)
                    }
                }
            }
        }
    }
}

private struct DecisionWidgetRow: View {
    let row: WidgetSnapshot.DecisionRow

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Link(destination: URL(string: "fridgedoor://plans/\(row.id)")!) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        if row.isPrivate { Image(systemName: "lock").font(.caption2).foregroundStyle(Color.muted) }
                        Text(row.title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1)
                    }
                    Text(row.detail).font(.caption).foregroundStyle(Color.muted).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .privacySensitive(row.isPrivate)
            action
        }
        .invalidatableContent()
    }

    @ViewBuilder private var action: some View {
        switch row.action {
        case .calendar?:
            Button(intent: DecidePlanIntent(planId: row.id, action: .calendar)) { pill("Add", systemImage: "calendar.badge.plus", primary: true) }
                .buttonStyle(.plain)
                .accessibilityLabel("Add \(row.title) to the calendar")
        case .keep?:
            Button(intent: DecidePlanIntent(planId: row.id, action: .keep)) { pill("Save", systemImage: "bookmark", primary: false) }
                .buttonStyle(.plain)
                .accessibilityLabel("Save \(row.title)")
        case nil:
            Link(destination: URL(string: "fridgedoor://plans/\(row.id)")!) { pill("Set time", systemImage: "clock", primary: false) }
                .accessibilityLabel("Set a time for \(row.title)")
        }
    }

    private func pill(_ title: String, systemImage: String, primary: Bool) -> some View {
        Label(title, systemImage: systemImage)
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .foregroundStyle(primary ? Color.onAccent : Color.plannerAccent)
            .background(primary ? Color.plannerAccent : Color.soft, in: .capsule)
            .widgetAccentable()
    }
}

/// Four shortcuts in one widget: Ask the planner, add a grocery, add a to-do, and today.
struct QuickActionsWidget: Widget {
    static let kind = "QuickActions"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: SnapshotProvider()) { _ in
            QuickActionsView()
        }
        .configurationDisplayName("Quick actions")
        .description("Ask the planner, add a grocery or a to-do, or open today.")
        .supportedFamilies([.systemSmall, .systemMedium])
        // Every tile is a button that opens the iPhone app: no use in CarPlay or on
        // HomeView (which follows CarPlay's widget rules), where widget buttons are off.
        .disfavoredLocations([.carPlay], for: [.systemSmall, .systemMedium])
    }
}

struct QuickActionsView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let tiles = [
            Tile(title: "Ask", symbol: "sparkles", intent: .compose),
            Tile(title: "Grocery", symbol: "basket", intent: .grocery),
            Tile(title: "To-do", symbol: "checklist", intent: .todo),
            Tile(title: "Today", symbol: "sun.max", intent: .today),
        ]
        Group {
            if family == .systemSmall {
                Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                    GridRow { tile(tiles[0]); tile(tiles[1]) }
                    GridRow { tile(tiles[2]); tile(tiles[3]) }
                }
            } else {
                HStack(spacing: 8) { ForEach(tiles, id: \.title) { tile($0) } }
            }
        }
        .containerBackground(Color.paper, for: .widget)
    }

    private struct Tile { let title: String; let symbol: String; let intent: Target }
    private enum Target { case compose, grocery, todo, today }

    @ViewBuilder private func tile(_ tile: Tile) -> some View {
        let label = VStack(spacing: 6) {
            Image(systemName: tile.symbol).font(.title3).foregroundStyle(Color.plannerAccent).widgetAccentable()
            Text(tile.title).font(.caption.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.card, in: .rect(cornerRadius: 14, style: .continuous))
        switch tile.intent {
        case .compose: Button(intent: OpenComposerIntent()) { label }.buttonStyle(.plain)
        case .grocery: Button(intent: OpenListAddIntent(.grocery)) { label }.buttonStyle(.plain).accessibilityLabel("Add a grocery")
        case .todo: Button(intent: OpenListAddIntent(.todo)) { label }.buttonStyle(.plain).accessibilityLabel("Add a to-do")
        case .today: Button(intent: OpenPlannerLinkIntent(path: "home")) { label }.buttonStyle(.plain).accessibilityLabel("Open today")
        }
    }
}
