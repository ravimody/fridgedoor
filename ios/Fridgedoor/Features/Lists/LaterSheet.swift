import FridgedoorKit
import SwiftUI

/// "Later" for a to-do: quick picks (Tomorrow, This weekend, Next week) apply in one tap;
/// "Pick a date…" opens a calendar in the same sheet. Used by the swipe, the context
/// menu and VoiceOver, so there's one way to push a to-do to another day.
struct LaterSheet: View {
    let item: ListItem
    let zone: TimeZone
    let onPick: (Date) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var picking = false
    @State private var date: Date
    @State private var detent: PresentationDetent = .medium

    init(item: ListItem, zone: TimeZone, onPick: @escaping (Date) -> Void) {
        self.item = item; self.zone = zone; self.onPick = onPick
        _date = State(initialValue: LaterOption.tomorrow.date(in: zone))
    }

    private var tomorrow: Date { LaterOption.tomorrow.date(in: zone) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(LaterOption.distinct(in: zone), id: \.option) { pick in
                        Button {
                            choose(pick.date)
                        } label: {
                            HStack {
                                Label(pick.option.label, systemImage: pick.option.systemImage)
                                    .foregroundStyle(Color.ink)
                                Spacer()
                                Text(dayLabel(pick.date)).foregroundStyle(Color.muted)
                            }
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(pick.option.label), \(TimeLabels.day(pick.date, in: zone, style: .complete))")
                    }
                    Button {
                        withAnimation(.snappy) {
                            picking.toggle()
                            detent = picking ? .large : .medium
                        }
                    } label: {
                        HStack {
                            Label("Pick a date…", systemImage: "calendar").foregroundStyle(Color.ink)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.muted)
                                .rotationEffect(.degrees(picking ? 90 : 0))
                        }
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(picking ? "Expanded" : "Collapsed")
                    if picking {
                        DatePicker("Date", selection: $date, in: tomorrow..., displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .tint(Color.plannerAccent)
                    }
                } header: {
                    Text(item.title)
                        .font(.headline)
                        .foregroundStyle(Color.ink)
                        .textCase(nil)
                        .lineLimit(2)
                } footer: {
                    Text("It leaves your morning brief until then. Its reminders move to 9 AM that day.")
                }
                .plannerRows()
            }
            .plannerList()
            .navigationTitle("Later")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                if picking {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save", role: .confirm) { choose(date) }
                    }
                }
            }
        }
        .environment(\.timeZone, zone)
        .environment(\.calendar, PlannerDates.calendar(zone))
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
    }

    private func choose(_ day: Date) {
        dismiss()
        onPick(day)
    }

    /// "Sun" for tomorrow (the row already says Tomorrow), otherwise "Sat, Oct 17".
    private func dayLabel(_ day: Date) -> String {
        let relative = TimeLabels.relativeDay(day, in: zone)
        return relative == "Tomorrow" ? day.formatted(Date.FormatStyle(timeZone: zone).weekday(.abbreviated)) : relative
    }
}
