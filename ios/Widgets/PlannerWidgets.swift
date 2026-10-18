import FridgedoorKit
import SwiftUI
import WidgetKit

@main
struct PlannerWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        GroceriesWidget()
        ToDoWidget()
        DecisionsWidget()
        QuickActionsWidget()
        AskPlannerControl()
        AddGroceryControl()
        AddToDoControl()
    }
}

/// "Today": what's left on the household agenda plus open counts. Reads the
/// snapshot the app writes to the App Group after each refresh; entries advance
/// on their own as events end and at midnight (member timezone).
struct TodayWidget: Widget {
    static let kind = "Today"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
        }
        .configurationDisplayName("Today")
        .description("What's left today, with open to-dos and groceries.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline, .accessoryCircular])
    }
}

struct TodayEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry { TodayEntry(date: .now, snapshot: .sample()) }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        // The gallery shows sample data until the app has written a real snapshot.
        let snapshot = SharedContainer.readSnapshot() ?? (context.isPreview ? .sample() : nil)
        completion(TodayEntry(date: .now, snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        let now = Date.now
        guard let snapshot = SharedContainer.readSnapshot() else {
            completion(Timeline(entries: [TodayEntry(date: now, snapshot: nil)], policy: .after(now.addingTimeInterval(3600))))
            return
        }
        let entries = snapshot.timelineDates(from: now).map { TodayEntry(date: $0, snapshot: snapshot) }
        // Re-read hourly too: background refresh may have written a newer snapshot.
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3600))))
    }
}

extension WidgetSnapshot {
    /// Gallery / placeholder content.
    static func sample(now: Date = .now) -> WidgetSnapshot {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        func at(_ hour: Int, _ minute: Int = 0, day: Int = 0) -> Date {
            calendar.date(byAdding: .day, value: day, to: calendar.date(bySettingHour: hour, minute: minute, second: 0, of: today) ?? today) ?? today
        }
        let next = max(calendar.component(.hour, from: now) + 1, 8)
        return WidgetSnapshot(generatedAt: now, memberName: "Alex", timezone: TimeZone.current.identifier, entries: [
            .init(id: "s1", title: "Recycling pickup", start: today, end: calendar.date(byAdding: .day, value: 1, to: today), allDay: true, kind: "event"),
            .init(id: "s2", title: "Pay the water bill", start: today, end: nil, allDay: true, kind: "task"),
            .init(id: "s3", title: "Soccer practice", start: at(min(next, 21)), end: at(min(next, 21) + 1), allDay: false, kind: "event"),
            .init(id: "s4", title: "Dinner with the Okafors", start: at(min(next + 1, 22), 30), end: at(23, 30), allDay: false, kind: "event"),
            .init(id: "s5", title: "School drop-off", start: at(7, 45, day: 1), end: at(8, 15, day: 1), allDay: false, kind: "event"),
        ], attentionCount: 2, openTodoCount: 4, openGroceryCount: 7,
        groceries: [
            .init(id: "g1", title: "Bananas", detail: "1 bunch", section: "Produce"),
            .init(id: "g2", title: "Baby spinach", section: "Produce"),
            .init(id: "g3", title: "Oat milk", detail: "2 cartons", section: "Dairy & eggs"),
            .init(id: "g4", title: "Eggs", detail: "1 dozen", section: "Dairy & eggs"),
            .init(id: "g5", title: "Sourdough bread", section: "Bakery"),
            .init(id: "g6", title: "Coffee beans", section: "Pantry"),
            .init(id: "g7", title: "Paper towels", section: "Household"),
        ],
        todos: [
            .init(id: "t1", title: "Pay the water bill", detail: "Overdue", section: "Overdue", overdue: true),
            .init(id: "t2", title: "Call the plumber", detail: "Today", section: "Today"),
            .init(id: "t3", title: "Order a birthday gift", detail: "Mon", section: "Coming up", assignee: "J"),
            .init(id: "t4", title: "Schedule an oil change", detail: "Wed", section: "Coming up"),
        ],
        decisions: [
            .init(id: "d1", title: "Book fair volunteer shift", detail: "Tue · 2:00 PM", action: .calendar, isPrivate: false),
            .init(id: "d2", title: "Parent-teacher conference", detail: "Fri, Oct 16 · needs a time", action: nil, isPrivate: false),
        ])
    }
}
