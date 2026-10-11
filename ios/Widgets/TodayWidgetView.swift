import FridgedoorKit
import SwiftUI
import WidgetKit

struct TodayWidgetView: View {
    let entry: TodayEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                content(TodayModel(snapshot: snapshot, date: entry.date))
            } else {
                SignedOutView(family: family)
            }
        }
        .containerBackground(Color.paper, for: .widget)
        .widgetURL(URL(string: "fridgedoor://home"))
    }

    @ViewBuilder private func content(_ model: TodayModel) -> some View {
        switch family {
        case .systemSmall: SmallTodayView(model: model)
        case .systemMedium: MediumTodayView(model: model)
        case .systemLarge, .systemExtraLarge: LargeTodayView(model: model)
        case .accessoryRectangular: RectangularTodayView(model: model)
        case .accessoryInline: InlineTodayView(model: model)
        case .accessoryCircular: CircularTodayView(model: model)
        @unknown default: SmallTodayView(model: model)
        }
    }
}

/// What a widget entry shows at its date.
struct TodayModel {
    let snapshot: WidgetSnapshot
    let date: Date
    let remaining: [WidgetSnapshot.Entry]

    init(snapshot: WidgetSnapshot, date: Date) {
        self.snapshot = snapshot
        self.date = date
        remaining = snapshot.remaining(at: date)
    }

    var zone: TimeZone { snapshot.timeZone }
    var timed: [WidgetSnapshot.Entry] { remaining.filter { !$0.allDay } }
    /// The next timed thing, else the first remaining item.
    var next: WidgetSnapshot.Entry? { timed.first ?? remaining.first }
    var later: WidgetSnapshot.Entry? { snapshot.nextLater(than: date) }
    var isStale: Bool { snapshot.isStale(at: date) }

    var weekday: String { date.formatted(Date.FormatStyle(timeZone: zone).weekday(.wide)) }
    var dayLabel: String { date.formatted(Date.FormatStyle(timeZone: zone).weekday(.abbreviated).month(.abbreviated).day()) }
    var updatedLabel: String { "Updated \(snapshot.generatedAt.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone)))" }

    func time(_ entry: WidgetSnapshot.Entry) -> String {
        if entry.kind == "task" {
            return (entry.start ?? date) < snapshot.calendar.startOfDay(for: date) ? "Earlier" : "Any time"
        }
        if entry.allDay { return "All day" }
        return entry.start?.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone)) ?? ""
    }

    func link(_ entry: WidgetSnapshot.Entry) -> URL {
        entry.link.flatMap(URL.init(string:)) ?? URL(string: "fridgedoor://home")!
    }

    static func symbol(_ entry: WidgetSnapshot.Entry) -> String {
        switch entry.kind {
        case "task": "checkmark.circle"
        case "reminder": "bell"
        default: entry.allDay ? "sun.max" : "calendar"
        }
    }
}

// MARK: Home Screen

struct WidgetEyebrow: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.bold))
            .tracking(1.3)
            .foregroundStyle(Color.plannerAccent)
            .widgetAccentable()
            .lineLimit(1)
    }
}

private struct CountChip: View {
    let count: Int
    let symbol: String
    let label: String
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).imageScale(.small)
            Text("\(count)").monospacedDigit()
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Color.muted)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(count) \(label)")
    }
}

private struct Counts: View {
    let snapshot: WidgetSnapshot
    var links = false
    var body: some View {
        HStack(spacing: 12) {
            chip(CountChip(count: snapshot.openTodoCount, symbol: "checklist", label: "open to-dos"), "fridgedoor://todos")
            chip(CountChip(count: snapshot.openGroceryCount, symbol: "basket", label: "groceries"), "fridgedoor://groceries")
        }
    }
    @ViewBuilder private func chip(_ view: CountChip, _ url: String) -> some View {
        if links, let url = URL(string: url) { Link(destination: url) { view } } else { view }
    }
}

private struct EntryRow: View {
    let model: TodayModel
    let entry: WidgetSnapshot.Entry
    var body: some View {
        // The check button sits outside the Link so a tap on it checks the to-do off.
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(model.time(entry))
                .font(.caption.monospacedDigit())
                .foregroundStyle(entry.kind == "task" && model.time(entry) == "Earlier" ? Color.warning : Color.muted)
                .frame(width: 62, alignment: .leading)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if entry.kind == "task", entry.id.hasPrefix("todo:") {
                // Dated to-dos check off right here (the intent runs in the app).
                Button(intent: CheckListItemIntent(itemId: String(entry.id.dropFirst(5)), list: .todo, done: true)) {
                    Image(systemName: "circle").font(.caption).foregroundStyle(Color.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mark \(entry.title) done")
            } else {
                Image(systemName: TodayModel.symbol(entry))
                    .font(.caption2)
                    .foregroundStyle(entry.kind == "event" ? Color.plannerAccent : Color.muted)
                    .widgetAccentable()
                    .accessibilityHidden(true)
            }
            Link(destination: model.link(entry)) {
                HStack {
                    Text(entry.title)
                        .font(.subheadline)
                        .foregroundStyle(Color.ink)
                        .lineLimit(1)
                        .privacySensitive(entry.isPrivate == true)
                    Spacer(minLength: 0)
                }
            }
        }
        .invalidatableContent()
    }
}

private struct AllClear: View {
    let model: TodayModel
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Nothing else today").font(.serif(.headline)).foregroundStyle(Color.ink)
            if let later = model.later, let start = later.start {
                Text("Tomorrow · \(later.allDay ? "" : start.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: model.zone)) + " ")\(later.title)")
                    .font(.caption).foregroundStyle(Color.muted).lineLimit(2)
                    .privacySensitive(later.isPrivate == true)
            }
        }
    }
}

struct SmallTodayView: View {
    let model: TodayModel
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            WidgetEyebrow(text: "Today · \(model.dayLabel)")
            Spacer(minLength: 2)
            if let next = model.next {
                Text(model.time(next))
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color.muted)
                Text(next.title)
                    .font(.serif(.title3))
                    .foregroundStyle(Color.ink)
                    .lineLimit(3)
                    .minimumScaleFactor(0.85)
                    .privacySensitive(next.isPrivate == true)
                if model.remaining.count > 1 {
                    Text("+\(model.remaining.count - 1) more today").font(.caption).foregroundStyle(Color.muted)
                }
            } else {
                AllClear(model: model)
            }
            Spacer(minLength: 4)
            Counts(snapshot: model.snapshot)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct MediumTodayView: View {
    let model: TodayModel
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                WidgetEyebrow(text: "Today")
                Text(model.weekday).font(.serif(.title2)).foregroundStyle(Color.ink).lineLimit(1).minimumScaleFactor(0.7)
                Text(model.date.formatted(Date.FormatStyle(timeZone: model.zone).month(.wide).day()))
                    .font(.caption).foregroundStyle(Color.muted)
                Spacer(minLength: 4)
                if model.snapshot.attentionCount > 0 {
                    AttentionTab(count: model.snapshot.attentionCount, compact: true)
                }
                Counts(snapshot: model.snapshot, links: true)
            }
            .frame(width: 104, alignment: .leading)
            VStack(alignment: .leading, spacing: 7) {
                if model.remaining.isEmpty {
                    Spacer(minLength: 0)
                    AllClear(model: model)
                    Spacer(minLength: 0)
                } else {
                    ForEach(model.remaining.prefix(4)) { EntryRow(model: model, entry: $0) }
                    if model.remaining.count > 4 {
                        Text("+\(model.remaining.count - 4) more").font(.caption).foregroundStyle(Color.muted)
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

private struct AttentionTab: View {
    let count: Int
    var compact = false
    var body: some View {
        Link(destination: URL(string: "fridgedoor://home")!) {
            HStack(spacing: 5) {
                Image(systemName: "sparkles")
                Text(compact ? "\(count) to decide" : count == 1 ? "1 decision waiting" : "\(count) decisions waiting")
                    .lineLimit(1)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.attentionInk)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.attention, in: UnevenRoundedRectangle(topLeadingRadius: 3, bottomLeadingRadius: 10, bottomTrailingRadius: 10, topTrailingRadius: 10, style: .continuous))
            .widgetAccentable()
        }
    }
}

struct LargeTodayView: View {
    let model: TodayModel
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    WidgetEyebrow(text: "Fridgedoor · Today")
                    Text(model.date.formatted(Date.FormatStyle(timeZone: model.zone).weekday(.wide).month(.wide).day()))
                        .font(.serif(.title2)).foregroundStyle(Color.ink).lineLimit(1).minimumScaleFactor(0.75)
                }
                Spacer(minLength: 0)
            }
            if model.snapshot.attentionCount > 0 { AttentionTab(count: model.snapshot.attentionCount) }
            Rectangle().fill(Color.line).frame(height: 1)
            if model.remaining.isEmpty {
                AllClear(model: model).padding(.top, 4)
            } else {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(model.remaining.prefix(8)) { EntryRow(model: model, entry: $0) }
                }
                if model.remaining.count > 8 {
                    Text("+\(model.remaining.count - 8) more today").font(.caption).foregroundStyle(Color.muted)
                }
            }
            Spacer(minLength: 0)
            HStack {
                Counts(snapshot: model.snapshot, links: true)
                Spacer()
                if model.isStale { Text(model.updatedLabel).font(.caption2).foregroundStyle(Color.muted) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: Lock Screen

struct RectangularTodayView: View {
    let model: TodayModel
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let next = model.next {
                HStack(spacing: 4) {
                    Image(systemName: TodayModel.symbol(next))
                    Text(model.time(next)).monospacedDigit()
                }
                .font(.caption.weight(.semibold))
                .widgetAccentable()
                Text(next.title)
                    .font(.headline)
                    .lineLimit(1)
                    .privacySensitive()
                Text(model.remaining.count > 1 ? "+\(model.remaining.count - 1) more · \(model.snapshot.openTodoCount) to-dos" : "\(model.snapshot.openTodoCount) to-dos · \(model.snapshot.openGroceryCount) groceries")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Text("Nothing else today").font(.headline).widgetAccentable()
                Text("\(model.snapshot.openTodoCount) to-dos · \(model.snapshot.openGroceryCount) groceries")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct InlineTodayView: View {
    let model: TodayModel
    var body: some View {
        if let next = model.timed.first, let start = next.start {
            // Inline widgets render one line of text; the title is redacted when locked.
            Label {
                Text("\(start.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: model.zone))) \(next.title)").privacySensitive()
            } icon: { Image(systemName: "calendar") }
        } else {
            Label("\(model.remaining.count) left today · \(model.snapshot.openTodoCount) to-dos", systemImage: "checklist")
        }
    }
}

struct CircularTodayView: View {
    let model: TodayModel
    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "calendar").font(.caption)
                Text("\(model.remaining.count)")
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .minimumScaleFactor(0.6)
                    .widgetAccentable()
            }
        }
        .accessibilityLabel("\(model.remaining.count) things left today")
    }
}

// MARK: Signed out

struct SignedOutView: View {
    let family: WidgetFamily
    var message = "Today's plans will show up here."
    var body: some View {
        switch family {
        case .accessoryInline:
            Label("Open Fridgedoor", systemImage: "person.crop.circle")
        case .accessoryCircular:
            ZStack { AccessoryWidgetBackground(); Image(systemName: "person.crop.circle").font(.title3) }
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Text("Fridgedoor").font(.headline)
                Text("Open the app to sign in").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        default:
            VStack(alignment: .leading, spacing: 6) {
                WidgetEyebrow(text: "Fridgedoor")
                Spacer(minLength: 0)
                Image(systemName: "person.crop.circle.badge.questionmark").font(.title2).foregroundStyle(Color.plannerAccent)
                Text("Open Fridgedoor to sign in").font(.serif(.headline)).foregroundStyle(Color.ink)
                Text(message).font(.caption).foregroundStyle(Color.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
