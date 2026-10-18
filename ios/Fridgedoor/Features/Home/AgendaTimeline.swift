import FridgedoorKit
import SwiftUI

/// The day's schedule as a timeline: a time column, a rail with a dot per row,
/// and a card. Calendar and task rows are never dismissable.
struct AgendaTimeline: View {
    let entries: [AgendaEntry]
    let day: Date
    let isToday: Bool
    let now: Date
    let zone: TimeZone
    /// In the evening, events that have already ended fold into one "N earlier today" row.
    var foldsPast = false
    @ScaledMetric(relativeTo: .caption) private var timeWidth: CGFloat = 58
    @State private var showsPast = false
    @Environment(\.dynamicTypeSize) private var typeSize
    /// At accessibility sizes the time sits above each card; the rail would leave no room for titles.
    private var stacked: Bool { typeSize.isAccessibilitySize }

    private var folded: [AgendaEntry] { foldsPast && !showsPast ? entries.filter(isPast) : [] }
    private var visible: [AgendaEntry] { entries.filter { !folded.contains($0) } }

    var body: some View {
        VStack(spacing: 0) {
            if foldsPast, entries.contains(where: isPast) {
                Button {
                    withAnimation(.snappy) { showsPast.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text(showsPast ? "Hide earlier" : "\(folded.count) earlier today")
                        Image(systemName: "chevron.down").rotationEffect(.degrees(showsPast ? 180 : 0))
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.muted)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.leading, stacked ? 0 : timeWidth + 28)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                switch row {
                case .now:
                    NowMarker(timeWidth: stacked ? 0 : timeWidth, label: TimeLabels.time(now, in: zone))
                case .entry(let entry):
                    AgendaRow(entry: entry, day: day, zone: zone, timeWidth: timeWidth,
                              isFirst: index == 0, isLast: index == rows.count - 1,
                              isPast: isPast(entry), stacked: stacked)
                }
            }
        }
    }

    private enum Row: Identifiable {
        case now
        case entry(AgendaEntry)
        var id: String { if case .entry(let entry) = self { entry.id } else { "now" } }
    }

    /// On today, a "now" marker sits before the first timed item that hasn't ended.
    private var rows: [Row] {
        let entries = visible
        var rows = entries.map(Row.entry)
        guard isToday else { return rows }
        let timed = entries.enumerated().filter { if case .timed = $0.element.time { true } else { false } }
        guard let first = timed.first?.offset else { return rows }
        if let next = timed.first(where: { !isPast($0.element) }) {
            if next.offset > first || isPast(entries[first]) || !folded.isEmpty { rows.insert(.now, at: next.offset) }
        } else if let last = timed.last?.offset {
            rows.insert(.now, at: last + 1)
        }
        return rows
    }

    private func isPast(_ entry: AgendaEntry) -> Bool {
        guard isToday, case let .timed(_, end, _) = entry.time, let e = PlannerDates.instant(end) else { return false }
        return e < now
    }
}

private struct NowMarker: View {
    let timeWidth: CGFloat
    let label: String

    var body: some View {
        // A zero time width means the stacked (accessibility-size) layout: no rail.
        HStack(spacing: timeWidth == 0 ? 8 : 0) {
            Text("Now")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.plannerAccent)
                .frame(width: timeWidth == 0 ? nil : timeWidth, alignment: .trailing)
            if timeWidth > 0 {
                ZStack {
                    Rectangle().fill(Color.line).frame(width: 1)
                    Circle().fill(Color.plannerAccent).frame(width: 8, height: 8)
                }
                .frame(width: 28)
            }
            Rectangle().fill(Color.plannerAccent.opacity(0.7)).frame(height: 1.5)
        }
        .frame(minHeight: 18)
        .accessibilityElement()
        .accessibilityLabel("Now, \(label)")
    }
}

private struct AgendaRow: View {
    let entry: AgendaEntry
    let day: Date
    let zone: TimeZone
    let timeWidth: CGFloat
    let isFirst: Bool
    let isLast: Bool
    let isPast: Bool
    var stacked = false
    @Environment(Router.self) private var router
    @Environment(HomeState.self) private var home

    var body: some View {
        if stacked {
            VStack(alignment: .leading, spacing: 4) {
                Text(HomeTime.column(entry, day: day, in: zone))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(entry.isCarriedOver ? Color.warning : Color.muted)
                card
            }
            .padding(.vertical, 5)
            .opacity(isPast ? 0.6 : 1)
        } else {
            railLayout
        }
    }

    private var railLayout: some View {
        HStack(alignment: .top, spacing: 0) {
            Text(HomeTime.column(entry, day: day, in: zone))
                .font(.caption.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(entry.isCarriedOver ? Color.warning : Color.muted)
                .multilineTextAlignment(.trailing)
                .minimumScaleFactor(0.8)
                .lineLimit(2)
                .frame(width: timeWidth, alignment: .trailing)
                .padding(.top, 17)
            Color.clear.frame(width: 28, height: 1)
            card
                .padding(.vertical, 5)
        }
        // The rail is a background so it always spans the row's full height.
        .background(alignment: .topLeading) { rail.padding(.leading, timeWidth) }
        .opacity(isPast ? 0.6 : 1)
    }

    private var rail: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                Rectangle().fill(isFirst ? .clear : Color.line).frame(width: 1, height: 22)
                Rectangle().fill(isLast ? .clear : Color.line).frame(width: 1).frame(maxHeight: .infinity)
            }
            dot.padding(.top, 17)
        }
        .frame(width: 28)
        .frame(maxHeight: .infinity)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var dot: some View {
        switch entry.source {
        case .task:
            Circle().strokeBorder(entry.isCarriedOver ? Color.warning : Color.muted, lineWidth: 2)
                .frame(width: 11, height: 11)
                .background(Circle().fill(Color.paper))
        case .plan:
            Circle().strokeBorder(Color.plannerAccent, lineWidth: 2).frame(width: 11, height: 11).background(Circle().fill(Color.paper))
        case .calendar:
            Circle().fill(entry.isHouseholdCalendar ? Color.plannerAccent : Color.muted)
                .frame(width: 11, height: 11)
                .overlay(Circle().strokeBorder(Color.paper, lineWidth: 2))
        }
    }

    @ViewBuilder private var card: some View {
        let content = VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 10) {
                if let task = entry.task { TaskCheckbox(task: task) }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(entry.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let task = entry.task {
                            LaterMenu(task: task) {
                                Image(systemName: "moon.zzz")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Color.plannerAccent)
                                    .frame(width: 44, height: 44)
                                    .contentShape(.rect)
                            }
                            .padding(.vertical, -10)
                            .disabled(home.isBusy("task:\(task.id)"))
                        } else if isNavigable {
                            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Color.muted)
                        }
                    }
                    .contentShape(.rect)
                    .onTapGesture { if entry.task != nil { open() } }
                    if let detail = detailLine { Text(detail).font(.caption).foregroundStyle(Color.muted) }
                    HStack(spacing: 6) {
                        Image(systemName: originSymbol).imageScale(.small)
                        Text(entry.origin)
                        if entry.isTentative { Badge("Tentative", style: .warning) }
                    }
                    .font(.caption2)
                    .foregroundStyle(Color.muted)
                }
            }
        }
        .plannerCard(.plain, padding: 14)

        Group {
            if isNavigable, entry.task == nil {
                Button(action: open) { content }
                    .buttonStyle(CardPressStyle())
            } else {
                content
            }
        }
        .contextMenu { menu }
        .accessibilityElement(children: entry.task == nil ? .combine : .contain)
        .accessibilityHint(entry.task == nil && isNavigable ? "Opens details" : "")
        .accessibilityActions {
            if let task = entry.task {
                Button("Done") { home.complete(task) }
                Button("Later: tomorrow") { home.snooze(task, days: 1) }
                Button("Open To do") { open() }
            }
        }
    }

    private var isNavigable: Bool { entry.planId != nil || entry.task != nil }

    private var detailLine: String? {
        [HomeTime.detail(entry, day: day, in: zone), entry.location?.nilIfBlank].compactMap { $0 }.joined(separator: " · ").nilIfBlank
    }

    private var originSymbol: String {
        switch entry.source {
        case .task: "checklist"
        case .plan(let plan): plan.calendarAction?.state == "succeeded" ? "calendar" : plan.isPrivate ? "lock" : "tray.full"
        case .calendar(let item): item.visibility == "shared" ? "person.2" : "person"
        }
    }

    private func open() {
        if let planId = entry.planId { router.open(.plan(planId)) } else if entry.task != nil { router.tab = .todo }
    }

    @ViewBuilder private var menu: some View {
        if let planId = entry.planId {
            Button("Open details", systemImage: "info.circle") { router.open(.plan(planId)) }
        }
        if let task = entry.task {
            Button("Open To do", systemImage: "checklist") { router.tab = .todo }
            LaterMenu(task: task) { Label("Later", systemImage: "moon.zzz") }
        }
        if case .plan = entry.source, let draft = CalendarDraft(title: entry.title, time: entry.time, location: entry.location) {
            // Kept privately in the planner: offer the phone's own calendar.
            Button("Add to Apple Calendar", systemImage: "square.and.arrow.up.on.square") { home.calendarDraft = draft }
        }
        ShareLink(item: shareText(title: entry.title, time: entry.time, location: entry.location, zone: zone)) {
            Label("Share", systemImage: "square.and.arrow.up")
        }
        Button("Copy", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = shareText(title: entry.title, time: entry.time, location: entry.location, zone: zone)
        }
        if let task = entry.task {
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) { home.delete(task) }
        }
    }
}

/// Subtle press feedback for tappable cards.
struct CardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}
