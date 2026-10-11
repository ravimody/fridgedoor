import FridgedoorKit
import SwiftUI
import WidgetKit

/// Groceries you can check off from the Home Screen: in store-walk (aisle) order, with
/// "+" to open the list ready to type and a short-lived Undo after a check-off.
struct GroceriesWidget: Widget {
    static let kind = "Groceries"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: SnapshotProvider()) { entry in
            ListWidgetView(entry: entry, list: .grocery)
        }
        .configurationDisplayName("Groceries")
        .description("Check off groceries as you shop, in aisle order.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}

/// Open to-dos (overdue and today first) you can check off from the Home Screen.
struct ToDoWidget: Widget {
    static let kind = "ToDo"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: SnapshotProvider()) { entry in
            ListWidgetView(entry: entry, list: .todo)
        }
        .configurationDisplayName("To do")
        .description("Overdue and today's to-dos first. Tap the circle to check one off.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}

struct ListWidgetView: View {
    let entry: SnapshotEntry
    let list: ListKind
    @Environment(\.widgetFamily) private var family

    private var title: String { list == .grocery ? "Groceries" : "To do" }
    private var link: URL { URL(string: list == .grocery ? "fridgedoor://groceries" : "fridgedoor://todos")! }

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                content(snapshot)
            } else {
                SignedOutView(family: family, message: list == .grocery ? "Your grocery list will show up here." : "Your to-dos will show up here.")
            }
        }
        .containerBackground(Color.paper, for: .widget)
        .widgetURL(link)
    }

    @ViewBuilder private func content(_ snapshot: WidgetSnapshot) -> some View {
        let rows = (list == .grocery ? snapshot.groceries : snapshot.todos) ?? []
        let count = list == .grocery ? snapshot.openGroceryCount : snapshot.openTodoCount
        let undo = snapshot.undoable(for: list, at: entry.date)
        switch family {
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("\(title) · \(count)").font(.headline).widgetAccentable()
                Text(rows.isEmpty ? (list == .grocery ? "Nothing on the list" : "Nothing open") : rows.prefix(3).map(\.title).joined(separator: ", "))
                    .font(.caption)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .systemSmall:
            VStack(alignment: .leading, spacing: 6) {
                WidgetListHeader(title: title, count: count, add: list)
                if rows.isEmpty {
                    WidgetEmpty(symbol: list == .grocery ? "basket" : "checkmark.circle", title: list == .grocery ? "All set" : "All done")
                } else {
                    ForEach(rows.prefix(4)) { CheckRow(row: $0, list: list, showsDetail: false, compact: true) }
                    Spacer(minLength: 0)
                    if rows.count > 4 { more(rows.count - 4) }
                }
            }
        case .systemMedium:
            VStack(alignment: .leading, spacing: 6) {
                WidgetListHeader(title: title, count: count, add: list)
                if rows.isEmpty {
                    WidgetEmpty(symbol: list == .grocery ? "basket" : "checkmark.circle", title: list == .grocery ? "Nothing on the list" : "Nothing open",
                                message: list == .grocery ? "Tap + to add something." : "Enjoy it.")
                } else if list == .todo {
                    // To-dos need their full title and due label: one column.
                    let shown = Array(rows.prefix(undo == nil ? 4 : 3))
                    ForEach(shown) { CheckRow(row: $0, list: list, compact: true) }
                    Spacer(minLength: 0)
                    if let undo { UndoBar(checked: undo, list: list) } else if rows.count > shown.count { more(rows.count - shown.count) }
                } else {
                    let shown = Array(rows.prefix(undo == nil ? 8 : 6))
                    let half = (shown.count + 1) / 2
                    HStack(alignment: .top, spacing: 14) {
                        VStack(alignment: .leading, spacing: 6) { ForEach(shown.prefix(half)) { CheckRow(row: $0, list: list, compact: true) } }
                        VStack(alignment: .leading, spacing: 6) { ForEach(shown.dropFirst(half)) { CheckRow(row: $0, list: list, compact: true) } }
                    }
                    Spacer(minLength: 0)
                    if let undo { UndoBar(checked: undo, list: list) } else if rows.count > shown.count { more(rows.count - shown.count) }
                }
            }
        default:
            VStack(alignment: .leading, spacing: 6) {
                WidgetListHeader(title: title, count: count, add: list)
                if rows.isEmpty {
                    WidgetEmpty(symbol: list == .grocery ? "basket" : "checkmark.circle", title: list == .grocery ? "Nothing on the list" : "Nothing open",
                                message: list == .grocery ? "Tap + to add something." : "Enjoy it.")
                } else {
                    let limit = undo == nil ? 11 : 10
                    ForEach(WidgetSnapshot.sections(rows, limit: limit), id: \.title) { section in
                        Text(section.title.uppercased())
                            .font(.caption2.weight(.semibold))
                            .tracking(0.8)
                            .foregroundStyle(section.title == "Overdue" ? Color.warning : Color.muted)
                            .padding(.top, 2)
                        ForEach(section.rows) { CheckRow(row: $0, list: list) }
                    }
                    Spacer(minLength: 0)
                    if let undo { UndoBar(checked: undo, list: list) } else if rows.count > limit { more(rows.count - limit) }
                }
            }
        }
    }

    private func more(_ count: Int) -> some View {
        Text("+\(count) more").font(.caption2).foregroundStyle(Color.muted)
    }
}
