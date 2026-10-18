import FridgedoorKit
import SwiftUI
import WidgetKit

// Watch-face complications and Smart Stack card. They read the payload the watch
// app saved from the iPhone; tapping one opens the watch app.

struct WatchEntry: TimelineEntry {
    let date: Date
    let payload: WatchPayload?

    var snapshot: WidgetSnapshot? { payload?.snapshot }
    var next: WidgetSnapshot.Entry? { snapshot?.remaining(at: date).first }
    var decisions: Int { payload?.decisionCount ?? 0 }
}

struct WatchProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchEntry { WatchEntry(date: .now, payload: nil) }

    func getSnapshot(in context: Context, completion: @escaping (WatchEntry) -> Void) {
        completion(WatchEntry(date: .now, payload: context.isPreview ? WatchSample.payload : WatchPayload.stored()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchEntry>) -> Void) {
        let payload = WatchPayload.stored()
        // Change as events end and at midnight, like the iPhone's Today widget.
        let dates = payload?.snapshot.timelineDates(from: .now) ?? [.now]
        completion(Timeline(entries: dates.map { WatchEntry(date: $0, payload: payload) }, policy: .never))
    }
}

struct WatchComplicationView: View {
    let entry: WatchEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular: circular
        case .accessoryCorner: corner
        case .accessoryInline: inline
        default: rectangular
        }
    }

    /// Next thing today, and how many decisions wait.
    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let next = entry.next, let zone = entry.snapshot?.timeZone {
                Text(timeLabel(next, zone: zone))
                    .font(.headline)
                    .widgetAccentable()
                Text(next.title)
                    .font(.body)
                    .lineLimit(entry.decisions > 0 ? 1 : 2)
                    .privacySensitive(next.isPrivate == true)
            } else {
                Text("Fridgedoor").font(.headline).widgetAccentable()
                Text(entry.payload == nil ? "Open on iPhone" : "Nothing else today")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            if entry.decisions > 0 {
                Label(entry.decisions == 1 ? "1 decision" : "\(entry.decisions) decisions", systemImage: "questionmark.bubble")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.clear }
    }

    /// Decisions waiting, otherwise what's left today.
    private var circular: some View {
        let left = entry.snapshot?.remaining(at: entry.date).count ?? 0
        return ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: entry.decisions > 0 ? "questionmark.bubble" : "calendar")
                    .font(.footnote)
                    .widgetAccentable()
                Text("\(entry.decisions > 0 ? entry.decisions : left)")
                    .font(.title3.weight(.semibold))
            }
        }
        .accessibilityLabel(entry.decisions > 0 ? "\(entry.decisions) decisions waiting" : "\(left) left today")
        .containerBackground(for: .widget) { Color.clear }
    }

    private var corner: some View {
        Image(systemName: entry.decisions > 0 ? "questionmark.bubble" : "calendar")
            .font(.title3)
            .widgetAccentable()
            .widgetLabel {
                if let next = entry.next, let zone = entry.snapshot?.timeZone {
                    Text("\(timeLabel(next, zone: zone)) \(next.isPrivate == true ? "Busy" : next.title)")
                } else {
                    Text("Nothing else today")
                }
            }
            .containerBackground(for: .widget) { Color.clear }
    }

    private var inline: some View {
        Group {
            if let next = entry.next, let zone = entry.snapshot?.timeZone {
                Text("\(timeLabel(next, zone: zone)) \(next.isPrivate == true ? "Busy" : next.title)")
            } else if entry.decisions > 0 {
                Text(entry.decisions == 1 ? "1 decision waiting" : "\(entry.decisions) decisions waiting")
            } else {
                Text("Nothing else today")
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private func timeLabel(_ next: WidgetSnapshot.Entry, zone: TimeZone) -> String {
        guard let start = next.start, !next.allDay else { return next.kind == "task" ? "To-do" : "Today" }
        if next.kind == "event", let end = next.end, start <= entry.date, entry.date < end { return "Now" }
        return start.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone))
    }
}

struct TodayComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "dev.fridgedoor.watch.today", provider: WatchProvider()) { entry in
            WatchComplicationView(entry: entry)
        }
        .configurationDisplayName("Today")
        .description("What's next today and what's waiting on you.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryCorner, .accessoryInline])
    }
}

@main
struct FridgedoorWatchWidgets: WidgetBundle {
    var body: some Widget { TodayComplication() }
}

/// Gallery preview content (never real household data).
enum WatchSample {
    static var payload: WatchPayload {
        let now = Date.now
        let start = Calendar.current.date(byAdding: .hour, value: 2, to: now) ?? now
        let snapshot = WidgetSnapshot(generatedAt: now, memberName: "Sam", timezone: TimeZone.current.identifier,
                                      entries: [.init(id: "sample", title: "Soccer practice", start: start, end: start.addingTimeInterval(3600), allDay: false, kind: "event")],
                                      attentionCount: 1, openTodoCount: 0, openGroceryCount: 0)
        return WatchPayload(snapshot: snapshot, brief: nil, decisions: [.init(id: "sample", title: "Book fair", detail: "Tomorrow · All day", action: .keep, isPrivate: false)], questions: [])
    }
}
