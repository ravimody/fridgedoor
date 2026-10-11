import FridgedoorKit
import SwiftUI

/// An open item: check circle, title, quantity, due/Later and reminder lines, assignee.
/// The check circle and the rest of the row are separate controls, so VoiceOver,
/// Voice Control and Full Keyboard Access each get a labeled "Mark … done" button.
struct OpenItemRow<Actions: View>: View {
    let item: ListItem
    let zone: TimeZone
    let reminder: Reminder?
    /// Checked while the completion animation plays, or while a checked grocery
    /// stays in place until "Clear checked".
    let isChecked: Bool
    let isBusy: Bool
    let onToggle: () -> Void
    let onOpen: () -> Void
    /// Custom VoiceOver actions for the row (mirror the swipes and context menu).
    @ViewBuilder let actions: () -> Actions

    @Environment(PlannerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .listTitle, spacing: 6) {
            Button(action: onToggle) { CheckCircle(checked: isChecked) }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .padding(.leading, -8)
                .accessibilityLabel(isChecked ? "Mark “\(item.title)” not done" : "Mark “\(item.title)” done")
            Button(action: onOpen) {
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        titleLine
                        details
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let assigneeId = item.assigneeId, !typeSize.isAccessibilitySize {
                        PersonAvatar(personId: assigneeId, size: 26)
                    }
                }
                .padding(.vertical, 6)
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Opens details.")
            .accessibilityActions(actions)
        }
        .animation(.snappy, value: isChecked)
    }

    @ViewBuilder private var titleLine: some View {
        let title = Text(item.title)
            .font(.body)
            .foregroundStyle(isChecked ? Color.muted : Color.ink)
            .strikethrough(isChecked, color: .muted)
            .alignmentGuide(.listTitle) { $0[.firstTextBaseline] * 0.64 }
        if let quantity = item.quantity {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 2) { title; QuantityTag(text: quantity) }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) { title; Spacer(minLength: 0); QuantityTag(text: quantity) }
            }
        } else {
            title
        }
    }

    @ViewBuilder private var details: some View {
        let due = item.kind == .todo ? DueLabel.make(item, zone: zone) : nil
        let avatarBelow = typeSize.isAccessibilitySize && item.assigneeId != nil
        if due != nil || reminder != nil || avatarBelow {
            VStack(alignment: .leading, spacing: 3) {
                if avatarBelow, let assigneeId = item.assigneeId {
                    Label {
                        Text(store.person(assigneeId)?.firstName ?? "Assigned")
                    } icon: {
                        PersonAvatar(personId: assigneeId, size: 22)
                    }
                    .foregroundStyle(Color.muted)
                }
                detailLabels(due)
            }
            .font(.subheadline)
            .opacity(isChecked ? 0.6 : 1)
        }
    }

    @ViewBuilder private func detailLabels(_ due: DueLabel?) -> some View {
        if let due {
            Label(due.text, systemImage: due.systemImage)
                .foregroundStyle(due.color)
                .fontWeight(due.tone == .warning ? .semibold : .regular)
        }
        if let reminder, let at = reminder.due {
            Label("Reminder " + TimeLabels.relativeDayInSentence(at, in: zone) + " · " + TimeLabels.time(at, in: zone), systemImage: "bell")
                .foregroundStyle(Color.muted)
        }
    }

    private var accessibilityText: String {
        var parts = [item.title]
        if let quantity = item.quantity { parts.append("quantity \(quantity)") }
        if item.kind == .todo, let due = DueLabel.make(item, zone: zone) { parts.append(due.text) }
        if let at = reminder?.due { parts.append("Reminder \(TimeLabels.dateTime(at, in: zone))") }
        if let assigneeId = item.assigneeId { parts.append(store.assigneeLabel(assigneeId)) }
        if isChecked { parts.append("Done") }
        return parts.joined(separator: ", ")
    }
}

struct QuantityTag: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color.muted)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Color.soft, in: .capsule)
            .fixedSize()
    }
}

/// A finished item with its timestamps and Reopen.
struct CompletedItemRow: View {
    let item: ListItem
    let zone: TimeZone
    let isBusy: Bool
    let onReopen: () -> Void

    var body: some View {
        HStack(alignment: .listTitle, spacing: 6) {
            Button(action: onReopen) { CheckCircle(checked: true) }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .padding(.leading, -8)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(ListCopy.titleWithQuantity(item))
                    .foregroundStyle(Color.muted)
                    .strikethrough(color: .muted)
                    .alignmentGuide(.listTitle) { $0[.firstTextBaseline] * 0.64 }
                ForEach(lines, id: \.self) { line in
                    Text(line).font(.caption).foregroundStyle(Color.muted)
                }
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Reopen", action: onReopen)
                .buttonStyle(PlannerButtonStyle(kind: .quiet, size: .small))
                .disabled(isBusy)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(([ListCopy.titleWithQuantity(item), "Done"] + lines).joined(separator: ", "))
        .accessibilityAction(named: "Reopen", onReopen)
    }

    private var lines: [String] {
        var lines: [String] = []
        if let done = item.completedDate { lines.append("Completed \(TimeLabels.dateTime(done, in: zone))") }
        if let added = item.createdDate { lines.append("Added \(TimeLabels.dateTime(added, in: zone))") }
        if let due = item.dueDate(in: zone) {
            lines.append("Due \(item.isAllDayDue ? TimeLabels.day(due, in: zone) : TimeLabels.dateTime(due, in: zone))")
        }
        return lines
    }
}

/// An add the server hasn't confirmed yet.
struct PendingAddRow: View {
    let pending: PendingListAdd
    var body: some View {
        HStack(spacing: 6) {
            ProgressView().frame(width: 44, height: 44).padding(.leading, -8)
            Text(pending.quantity.map { "\(pending.title) · \($0)" } ?? pending.title)
                .foregroundStyle(Color.muted)
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Adding \(pending.title)")
    }
}

/// A sans section header inside a list ("Overdue", "Produce"), with an optional
/// trailing control. Rows are sans, so their headers are too (DESIGN.md → Type).
struct ListSectionHeader<Trailing: View>: View {
    let title: String
    var tint: Color = .ink
    @ViewBuilder var trailing: () -> Trailing

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At accessibility sizes a trailing control ("Move to today") wraps under the title.
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(spacing: 6))
        layout {
            Text(title).foregroundStyle(tint).accessibilityAddTraits(.isHeader)
            if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
            trailing()
        }
        .font(.subheadline.weight(.semibold))
        .textCase(nil)
        .frame(minHeight: 32)
    }
}

extension ListSectionHeader where Trailing == EmptyView {
    init(_ title: String, tint: Color = .ink) {
        self.init(title: title, tint: tint) { EmptyView() }
    }
}

/// A collapsible section header ("Completed 4", "Later 2") with a chevron that rotates open.
struct DisclosureHeader: View {
    let title: String
    var systemImage: String?
    let count: Int
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                if let systemImage { Image(systemName: systemImage).foregroundStyle(Color.muted) }
                Text(title).foregroundStyle(Color.ink)
                Text("\(count)").monospacedDigit().foregroundStyle(Color.muted)
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundStyle(Color.muted)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .accessibilityLabel("\(title), \(count) \(count == 1 ? "item" : "items")")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Hides these items" : "Shows these items")
    }
}

extension VerticalAlignment {
    /// Centers the check circle on a row's first title line, however many lines follow.
    private enum ListTitle: AlignmentID {
        static func defaultValue(in context: ViewDimensions) -> CGFloat { context[VerticalAlignment.center] }
    }
    static let listTitle = VerticalAlignment(ListTitle.self)
}
