import FridgedoorKit
import SwiftUI

/// "When does it start?" — the one missing fact for most suggestions, asked on its
/// own instead of through the full editor. Saves the time and decides in one tap:
/// "Add to calendar · …" at the bottom, or "Save" (no calendar) in the toolbar.
struct SetTimeSheet: View {
    let plan: PlanSummary

    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var day: Date
    @State private var start: Date
    @State private var minutes = 60
    /// The start the plan already suggests (minute of day), offered first among the chips.
    @State private var hint: Int?
    @State private var showsWheel = false
    @State private var busy = false
    @State private var seeded = false
    @State private var detent: PresentationDetent = Self.defaultDetent

    /// Tall enough for the day, start chips, length chips and the add button without covering any.
    private static let defaultDetent = PresentationDetent.fraction(0.75)

    private static let commonStarts = [9 * 60, 12 * 60, 15 * 60 + 30, 18 * 60]
    private static let commonLengths = [15, 30, 60, 120]

    init(plan: PlanSummary) {
        self.plan = plan
        _day = State(initialValue: .now)
        _start = State(initialValue: .now)
    }

    /// The store's copy when it's newer, so a save never goes out against a stale revision.
    private var live: PlanSummary {
        guard let cached = store.plan(plan.id), cached.revision >= plan.revision else { return plan }
        return cached
    }
    private var zone: TimeZone { store.timeZone }
    private var calendar: Calendar { PlannerDates.calendar(zone) }
    private var startDate: Date { combine(day, start) }
    private var endDate: Date { startDate.addingTimeInterval(TimeInterval(minutes * 60)) }
    private var knowsDay: Bool {
        switch plan.effectiveFacts.time {
        case let .unresolved(dateHint, startHint, _)?: dateHint != nil || startHint != nil
        case .none: false
        default: true
        }
    }
    /// Adding needs Google set up, a shared plan not already on the calendar, and nothing
    /// else unresolved (the server refuses the calendar while any field is).
    private var canAdd: Bool {
        let plan = live
        let otherMissing = plan.effectiveFacts.unresolvedFields.contains { !PlanFacts.timeFieldMarkers.contains($0) }
        return (store.googleReady || store.connection == nil) && !plan.isPrivate && !plan.hasCalendarEvent && !otherMissing
    }
    private var range: String { "\(TimeLabels.time(startDate, in: zone))–\(TimeLabels.time(endDate, in: zone))" }
    private var summary: String { "\(TimeLabels.relativeDay(startDate, in: zone)) · \(range)" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if knowsDay {
                        LabeledContent("Day", value: TimeLabels.relativeDay(day, in: zone))
                    } else {
                        DatePicker("Day", selection: $day, displayedComponents: .date)
                            .environment(\.timeZone, zone)
                    }
                } header: {
                    Text(plan.effectiveFacts.title).textCase(nil).font(.headline).foregroundStyle(Color.ink)
                }
                .plannerRows()
                Section("Starts") {
                    ChipRow(options: startOptions, selection: Binding(get: { showsWheel ? nil : minuteOfDay(start) }, set: { value in
                        if let value { start = time(at: value); showsWheel = false }
                    }), label: { TimeLabels.time(time(at: $0), in: zone) }, otherSelected: showsWheel) { showsWheel = true }
                    if showsWheel {
                        DatePicker("Start time", selection: $start, displayedComponents: .hourAndMinute)
                            .datePickerStyle(.wheel)
                            .labelsHidden()
                            .environment(\.timeZone, zone)
                            .frame(maxWidth: .infinity)
                    }
                }
                .plannerRows()
                Section {
                    ChipRow(options: lengthOptions, selection: Binding(get: { minutes }, set: { if let value = $0 { minutes = value } }),
                            label: Self.lengthLabel, spokenLabel: Self.spokenLength)
                } header: {
                    Text("Length")
                } footer: {
                    if !canAdd { Text(summary) }
                }
                .plannerRows()
                if canAdd {
                    // In the form rather than a bottom inset, so it never covers the chips or the wheel.
                    Section {
                        Button { save(addToCalendar: true) } label: {
                            HStack(spacing: 8) {
                                if busy { ProgressView().tint(Color.onAccent) } else { Image(systemName: "calendar.badge.plus").accessibilityHidden(true) }
                                Text("Add to calendar · \(summary)").lineLimit(2).minimumScaleFactor(0.85)
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PlannerButtonStyle(kind: .primary, size: .large))
                        .accessibilityLabel("Add to calendar, \(summary)")
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.paper)
            .navigationTitle(knowsDay ? "When does it start?" : "When is it?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Save") { save(addToCalendar: false) }
                            .accessibilityHint(live.hasCalendarEvent ? "Saves the time and updates the household calendar" : canAdd ? "Saves the time without adding it to the calendar" : "")
                    }
                }
            }
            .disabled(busy)
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([Self.defaultDetent, .large], selection: $detent)
        .onChange(of: showsWheel) { if showsWheel { detent = .large } }
        .presentationDragIndicator(.visible)
        .onAppear {
            // Seeded here rather than in init: the member's timezone comes from the store.
            guard !seeded else { return }
            seeded = true
            let seed = SetTimeSheet.initial(for: plan.effectiveFacts.time, zone: zone)
            (day, start) = (seed.day, seed.start ?? time(at: Self.commonStarts[2], on: seed.day))
            hint = seed.start.map(minuteOfDay)
            if let length = seed.minutes, length > 0, length <= 12 * 60 { minutes = length }
        }
    }

    // MARK: Options

    /// The plan's own start first (when it has one), then common times.
    private var startOptions: [Int] {
        var options = Self.commonStarts
        if let hint, !options.contains(hint) { options.append(hint) }
        return options.sorted()
    }

    /// Common lengths, plus the plan's current one when it's something else.
    private var lengthOptions: [Int] {
        var options = Self.commonLengths
        if !options.contains(minutes) { options.append(minutes) }
        return options.sorted()
    }

    private static func lengthLabel(_ minutes: Int) -> String {
        if minutes < 60 { return "\(minutes) min" }
        return minutes % 60 == 0 ? "\(minutes / 60) hr" : "\(minutes / 60) hr \(minutes % 60) min"
    }

    private static func spokenLength(_ minutes: Int) -> String {
        Duration.seconds(minutes * 60).formatted(.units(allowed: [.hours, .minutes], width: .wide))
    }

    private func minuteOfDay(_ date: Date) -> Int {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    }

    private func time(at minuteOfDay: Int, on day: Date? = nil) -> Date {
        let base = day ?? self.day
        return calendar.date(bySettingHour: minuteOfDay / 60, minute: minuteOfDay % 60, second: 0, of: base) ?? base
    }

    private func combine(_ day: Date, _ time: Date) -> Date {
        let parts = calendar.dateComponents([.hour, .minute], from: time)
        return calendar.date(bySettingHour: parts.hour ?? 9, minute: parts.minute ?? 0, second: 0, of: day) ?? day
    }

    /// The day to show, the start the plan already suggests (if any), and its current length.
    private static func initial(for time: NormalizedTime?, zone: TimeZone) -> (day: Date, start: Date?, minutes: Int?) {
        let calendar = PlannerDates.calendar(zone)
        let today = calendar.startOfDay(for: .now)
        switch time {
        case let .unresolved(dateHint, startHint, _)?:
            if let start = PlannerDates.instant(startHint) { return (calendar.startOfDay(for: start), start, nil) }
            return (PlannerDates.day(dateHint, in: zone) ?? today, nil, nil)
        case let .deadline(at, _)?:
            let date = PlannerDates.instant(at) ?? today
            return (calendar.startOfDay(for: date), PlannerDates.instant(at), nil)
        case let .allDay(startDate, _)?:
            return (PlannerDates.day(startDate, in: zone) ?? today, nil, nil)
        case let .timed(start, end, _)?:
            guard let s = PlannerDates.instant(start) else { return (today, nil, nil) }
            let length = PlannerDates.instant(end).map { Int($0.timeIntervalSince(s) / 60) }
            return (calendar.startOfDay(for: s), s, length)
        case nil:
            return (today, nil, nil)
        }
    }

    // MARK: Save

    private func save(addToCalendar: Bool) {
        guard !busy else { return }
        busy = true
        let title = plan.effectiveFacts.title
        let when = "\(TimeLabels.relativeDayInSentence(startDate, in: zone)), \(range)"
        Task {
            defer { busy = false }
            do {
                let plan = live
                try await store.setTime(plan, start: startDate, end: endDate, addToCalendar: addToCalendar)
                if addToCalendar {
                    app.show("Adding “\(title)” to the household calendar…")
                } else if plan.hasCalendarEvent {
                    app.show("Moved “\(title)” to \(when). Updating the household calendar…")
                } else {
                    app.show("Saved “\(title)” for \(when).")
                }
                dismiss()
            } catch {
                app.showPlanError(error)
            }
        }
    }
}

/// A wrapping row of single-choice chips, with an optional trailing "Other…" chip.
/// Each chip is at least 44pt tall.
struct ChipRow<Value: Hashable>: View {
    let options: [Value]
    @Binding var selection: Value?
    let label: (Value) -> String
    /// What VoiceOver reads when the visible label is abbreviated ("1 hr" → "1 hour").
    var spokenLabel: ((Value) -> String)?
    var otherSelected = false
    var onOther: (() -> Void)?

    init(options: [Value], selection: Binding<Value?>, label: @escaping (Value) -> String, otherSelected: Bool = false,
         onOther: (() -> Void)? = nil, spokenLabel: ((Value) -> String)? = nil) {
        self.options = options; _selection = selection; self.label = label; self.spokenLabel = spokenLabel
        self.otherSelected = otherSelected; self.onOther = onOther
    }

    var body: some View {
        FlowLayout {
            ForEach(options, id: \.self) { option in
                chip(label(option), spoken: spokenLabel?(option), selected: selection == option) { selection = option }
            }
            if let onOther { chip("Other…", spoken: "Other time", selected: otherSelected, action: onOther) }
        }
        .padding(.vertical, 4)
    }

    private func chip(_ title: String, spoken: String?, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .foregroundStyle(selected ? Color.onAccent : Color.plannerAccent)
                .background(selected ? Color.plannerAccent : Color.soft, in: .capsule)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken ?? title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
