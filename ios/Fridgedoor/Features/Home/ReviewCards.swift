import FridgedoorKit
import SwiftUI

/// A routine or upcoming item from the morning brief (decisions use `DecisionsSection`).
/// Non-task cards dismiss by swipe, menu, context menu or VoiceOver action; task
/// cards resolve with Done / Later instead. The ⋯ menu and long-press offer the same items.
struct ReviewCard: View {
    let item: DailyOverviewItem
    @Environment(PlannerStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(HomeState.self) private var home

    private var zone: TimeZone { store.timeZone }
    private var tasks: [ListItem] {
        (item.targets ?? []).filter { $0.kind == "task" }.compactMap { target in store.todos.first { $0.id == target.id && !$0.isCompleted } }
    }
    private var plan: PlanSummary? { item.planTargetId.flatMap(store.plan) }
    private var canDismiss: Bool { !item.isTask }
    private let ink = Color.ink

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Label(item.categoryLabel, systemImage: item.categorySymbol)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.plannerAccent)
                    .labelStyle(.titleAndIcon)
                if item.priority == "important" {
                    Badge("Important", style: .attention)
                }
                Spacer(minLength: 0)
                if canDismiss { optionsMenu }
            }
            titleButton
            if let label = HomeTime.review(item.normalizedTime, in: zone) {
                Text(label).font(.caption.weight(.medium)).foregroundStyle(ink.opacity(0.8))
            }
            if !item.detail.isEmpty, item.detail != item.displayTitle {
                Text(item.detail).font(.subheadline).foregroundStyle(ink.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(tasks) { task in TaskActionsRow(task: task).padding(.top, 4) }
        }
        .plannerCard(.soft, padding: 16)
        .overlay {
            if home.isBusy("review:\(item.id)") { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(14) }
        }
        .contentShape(.contextMenuPreview, shape)
        .contextMenu { contextMenu }
        .swipeToDismiss(enabled: canDismiss, cornerRadius: 16) { home.dismiss(item) }
        .accessibilityElement(children: .contain)
    }

    private var shape: some Shape { RoundedRectangle(cornerRadius: 16, style: .continuous) }

    @ViewBuilder private var titleButton: some View {
        let title = Text(item.displayTitle)
            .font(.serif(.title3))
            .foregroundStyle(ink)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
        if hasDestination {
            Button(action: open) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    title
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(ink.opacity(0.6))
                }
            }
            .buttonStyle(.plain)
            .accessibilityHint(item.isTask ? "Opens To do" : "Opens details")
        } else {
            title.accessibilityAddTraits(.isHeader)
        }
    }

    private var optionsMenu: some View {
        Menu { contextMenu } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(ink.opacity(0.7))
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .padding(.vertical, -6)
        .accessibilityLabel("Actions for \(item.displayTitle)")
    }

    @ViewBuilder private var contextMenu: some View {
        if hasDestination {
            Button(item.isTask ? "Open To do" : "Open details", systemImage: item.isTask ? "checklist" : "info.circle", action: open)
        }
        if let draft = CalendarDraft(title: item.displayTitle, time: item.normalizedTime) {
            Button("Add to Apple Calendar", systemImage: "square.and.arrow.up.on.square") { home.calendarDraft = draft }
        }
        ShareLink(item: shareText(title: item.displayTitle, time: item.normalizedTime, location: plan?.facts.location, zone: zone)) {
            Label("Share", systemImage: "square.and.arrow.up")
        }
        if canDismiss {
            Divider()
            Button("Dismiss", systemImage: "eye.slash", role: .destructive) { home.dismiss(item) }
        }
    }

    private var hasDestination: Bool { item.planTargetId != nil || item.isTask }

    private func open() {
        if let id = item.planTargetId { router.open(.plan(id)) } else if item.isTask { router.tab = .todo }
    }
}

/// A personal reminder that applies to the selected day.
struct ReminderCard: View {
    let reminder: Reminder
    let title: String
    let now: Date
    @Environment(PlannerStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(HomeState.self) private var home

    private var busy: Bool { home.isBusy("reminder:\(reminder.id)") }
    private var isOverdue: Bool { (reminder.due ?? .distantFuture) < now }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: isOverdue ? "bell.badge.fill" : "bell.fill")
                    .font(.body)
                    .foregroundStyle(isOverdue ? Color.warning : Color.plannerAccent)
                    .frame(width: 32, height: 32)
                    .background((isOverdue ? Color.warning : Color.plannerAccent).opacity(0.12), in: .circle)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                    Text(HomeTime.reminder(reminder, in: store.timeZone, now: now))
                        .font(.caption)
                        .foregroundStyle(isOverdue ? Color.warning : Color.muted)
                }
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.small) }
            }
            HStack(spacing: 8) {
                Button("Done", systemImage: "checkmark") { home.completeReminder(reminder) }
                    .buttonStyle(PlannerButtonStyle(kind: .secondary, size: .small))
                Button("Snooze 15 minutes", systemImage: "moon.zzz") { home.snoozeReminder(reminder) }
                    .buttonStyle(PlannerButtonStyle(kind: .quiet, size: .small))
                Spacer(minLength: 0)
                Menu {
                    if reminder.parentType == "plan" {
                        Button("Open plan", systemImage: "info.circle") { router.open(.plan(reminder.parentId)) }
                    }
                    Button("Cancel reminder", systemImage: "bell.slash", role: .destructive) { home.cancelReminder(reminder) }
                } label: {
                    Image(systemName: "ellipsis").font(.body.weight(.semibold)).foregroundStyle(Color.muted)
                        .frame(width: 44, height: 36).contentShape(.rect)
                }
                .accessibilityLabel("More reminder options")
            }
            .labelStyle(.titleAndIcon)
        }
        .plannerCard(.plain, padding: 14)
        .disabled(busy)
        .accessibilityElement(children: .contain)
    }
}
