import AppIntents
import FridgedoorKit
import SwiftUI
import WidgetKit

/// One entry: the snapshot the app last wrote. The list and Decisions widgets change
/// only when the app (or a widget button) writes a new snapshot, so a single entry with
/// an hourly re-read is enough; the Undo bar expires on its own via a second entry.
struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { SnapshotEntry(date: .now, snapshot: .sample()) }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: .now, snapshot: SharedContainer.readSnapshot() ?? (context.isPreview ? .sample() : nil)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let now = Date.now
        let snapshot = SharedContainer.readSnapshot()
        var entries = [SnapshotEntry(date: now, snapshot: snapshot)]
        // Drop the Undo bar when its window closes.
        if let checked = snapshot?.undoable(at: now) {
            entries.append(SnapshotEntry(date: checked.at.addingTimeInterval(WidgetSnapshot.undoWindow), snapshot: snapshot))
        }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3600))))
    }
}

/// Small header: an eyebrow title, a count, and an optional "+" that opens the app ready to add.
struct WidgetListHeader: View {
    let title: String
    var count: Int?
    var add: ListKind?
    @Environment(\.widgetFamily) private var family

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            WidgetEyebrow(text: title)
            if let count {
                Text("\(count)")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(Color.muted)
            }
            Spacer(minLength: 0)
            if let add {
                Button(intent: OpenListAddIntent(add)) {
                    Image(systemName: "plus")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.onAccent)
                        .frame(width: 24, height: 24)
                        .background(Color.plannerAccent, in: .circle)
                }
                .buttonStyle(.plain)
                .widgetAccentable()
                .accessibilityLabel(add == .grocery ? "Add a grocery" : "Add a to-do")
            }
        }
    }
}

/// A row you can check off: the circle runs the intent (in the app, in the background);
/// the title opens the list.
struct CheckRow: View {
    let row: WidgetSnapshot.ListRow
    let list: ListKind
    var showsDetail = true
    var compact = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button(intent: CheckListItemIntent(itemId: row.id, list: list, done: true)) {
                Image(systemName: "circle")
                    .font(compact ? .footnote : .subheadline)
                    .foregroundStyle(row.overdue == true ? Color.warning : Color.muted)
                    .frame(minWidth: 20)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Mark \(row.title) done")
            Link(destination: URL(string: list == .grocery ? "fridgedoor://groceries" : "fridgedoor://todos")!) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(row.title)
                        .font(compact ? .footnote : .subheadline)
                        .foregroundStyle(Color.ink)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let assignee = row.assignee {
                        Text(assignee)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.onAccent)
                            .frame(width: 16, height: 16)
                            .background(Color.muted, in: .circle)
                            .accessibilityLabel("Assigned to someone else")
                    }
                    if showsDetail, let detail = row.detail {
                        Text(detail)
                            .font(.caption2)
                            .foregroundStyle(row.overdue == true ? Color.warning : Color.muted)
                            .lineLimit(1)
                    }
                }
            }
        }
        .invalidatableContent()
    }
}

/// "Checked Bananas · Undo" for a little while after a widget check-off.
struct UndoBar: View {
    let checked: WidgetSnapshot.Checked
    let list: ListKind

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.muted).font(.caption)
            Text("Checked \(checked.title)")
                .font(.caption)
                .foregroundStyle(Color.muted)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button(intent: CheckListItemIntent(itemId: checked.id, list: list, done: false)) {
                Text("Undo").font(.caption.weight(.semibold)).foregroundStyle(Color.plannerAccent)
            }
            .buttonStyle(.plain)
            .widgetAccentable()
        }
    }
}

/// Calm empty state for a widget.
struct WidgetEmpty: View {
    let symbol: String
    let title: String
    var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Spacer(minLength: 0)
            Image(systemName: symbol).font(.title3).foregroundStyle(Color.plannerAccent).widgetAccentable()
            Text(title).font(.serif(.headline)).foregroundStyle(Color.ink)
            if let message { Text(message).font(.caption).foregroundStyle(Color.muted) }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension WidgetSnapshot {
    /// The undoable check-off for one list.
    func undoable(for list: ListKind, at date: Date) -> Checked? {
        undoable(at: date).flatMap { $0.kind == list.rawValue ? $0 : nil }
    }

    /// Rows grouped by section, in order, capped at `limit` rows in total.
    static func sections(_ rows: [ListRow], limit: Int) -> [(title: String, rows: [ListRow])] {
        var result: [(title: String, rows: [ListRow])] = []
        for row in rows.prefix(limit) {
            let title = row.section ?? ""
            if result.last?.title == title { result[result.count - 1].rows.append(row) } else { result.append((title, [row])) }
        }
        return result
    }
}
