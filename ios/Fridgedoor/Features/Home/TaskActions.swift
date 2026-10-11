import FridgedoorKit
import SwiftUI

/// Done + Later for an open to-do: Tomorrow, This weekend, Next week or Pick a date,
/// in the member's timezone. Delete lives in the row's context menu.
struct TaskActionsRow: View {
    let task: ListItem
    @Environment(HomeState.self) private var home

    var body: some View {
        FlowLayout(spacing: 8) {
            Button {
                home.complete(task)
            } label: {
                Label("Done", systemImage: "checkmark")
            }
            .buttonStyle(PlannerButtonStyle(kind: .secondary, size: .small))
            LaterMenu(task: task) {
                Label("Later", systemImage: "moon.zzz")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.plannerAccent)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Color.soft, in: .capsule)
                    .contentShape(.capsule)
            }
            if home.isBusy("task:\(task.id)") { ProgressView().controlSize(.small) }
        }
        .disabled(home.isBusy("task:\(task.id)"))
    }
}

/// The Later menu (moves a to-do out of today), shared by timeline rows and review cards.
struct LaterMenu<MenuLabel: View>: View {
    let task: ListItem
    @ViewBuilder var label: () -> MenuLabel
    @Environment(HomeState.self) private var home
    @Environment(PlannerStore.self) private var store

    var body: some View {
        Menu {
            Section("Later") {
                Button("Tomorrow", systemImage: "sunrise") { home.snooze(task, days: 1) }
                if let weekend = LaterDates.weekend(from: .now, calendar: store.calendar) {
                    Button("This weekend", systemImage: "sun.max") { home.snooze(task, to: weekend) }
                }
                if let nextWeek = LaterDates.nextWeek(from: .now, calendar: store.calendar) {
                    Button("Next week", systemImage: "calendar") { home.snooze(task, to: nextWeek) }
                }
                Button("Pick a date…", systemImage: "calendar.day.timeline.left") { home.datePickerTask = task }
            }
        } label: {
            label()
        }
        .accessibilityLabel("Later")
    }
}

/// Quick "Later" dates in the member's calendar.
enum LaterDates {
    /// The coming Saturday (next week's if today is already the weekend).
    static func weekend(from now: Date, calendar: Calendar) -> Date? {
        let today = calendar.startOfDay(for: now)
        return calendar.nextDate(after: today, matching: DateComponents(weekday: 7), matchingPolicy: .nextTime)
    }

    /// The coming Monday.
    static func nextWeek(from now: Date, calendar: Calendar) -> Date? {
        calendar.nextDate(after: calendar.startOfDay(for: now), matching: DateComponents(weekday: 2), matchingPolicy: .nextTime)
    }
}

/// Graphical date picker for "Choose a date", limited to tomorrow onward.
struct SnoozeDateSheet: View {
    let task: ListItem
    let zone: TimeZone
    var onSave: (Date) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date

    init(task: ListItem, zone: TimeZone, onSave: @escaping (Date) -> Void) {
        self.task = task; self.zone = zone; self.onSave = onSave
        let calendar = PlannerDates.calendar(zone)
        _date = State(initialValue: calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: .now)) ?? .now)
    }

    private var tomorrow: Date {
        let calendar = PlannerDates.calendar(zone)
        return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: .now)) ?? .now
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(task.title).font(.serif(.title3)).foregroundStyle(Color.ink)
                Text("It leaves today until then and stays on your to-do list.")
                    .font(.subheadline).foregroundStyle(Color.muted)
                DatePicker("Date", selection: $date, in: tomorrow..., displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .environment(\.timeZone, zone)
                    .tint(Color.plannerAccent)
            }
            .padding(20)
            .frame(maxHeight: .infinity, alignment: .top)
            .plannerBackground()
            .navigationTitle("Later")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", role: .confirm) { onSave(date); dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Leading round checkbox for a to-do row (Done).
struct TaskCheckbox: View {
    let task: ListItem
    @Environment(HomeState.self) private var home
    @State private var checked = false

    var body: some View {
        Button {
            withAnimation(.snappy) { checked = true }
            home.complete(task)
        } label: {
            ZStack {
                Circle().strokeBorder(checked ? Color.plannerAccent : Color.muted.opacity(0.7), lineWidth: 1.5)
                if checked || home.isBusy("task:\(task.id)") {
                    Circle().fill(Color.plannerAccent).padding(1)
                    Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Color.onAccent)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .frame(width: 26, height: 26)
            .frame(width: 44, height: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(home.isBusy("task:\(task.id)"))
        .accessibilityLabel("Mark “\(task.title)” done")
        .onChange(of: home.isBusy("task:\(task.id)")) { _, busy in if !busy { checked = false } }
    }
}
