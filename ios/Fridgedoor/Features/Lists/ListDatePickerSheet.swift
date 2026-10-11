import FridgedoorKit
import SwiftUI

/// "Choose a date…" for a new to-do's due date.
/// The calendar runs in the member timezone so the picked day matches the server's.
struct ListDatePickerSheet: View {
    let title: String
    let zone: TimeZone
    let minimum: Date
    let confirmLabel: String
    let onSave: (Date) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var date: Date

    init(title: String, zone: TimeZone, minimum: Date, initial: Date? = nil, confirmLabel: String, onSave: @escaping (Date) -> Void) {
        self.title = title; self.zone = zone; self.minimum = minimum
        self.confirmLabel = confirmLabel; self.onSave = onSave
        _date = State(initialValue: max(initial ?? minimum, minimum))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                DatePicker("Date", selection: $date, in: minimum..., displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .tint(Color.plannerAccent)
                    .padding(.horizontal, 20)
            }
            .background(Color.paper)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmLabel, role: .confirm) { onSave(date); dismiss() }
                }
            }
        }
        .environment(\.timeZone, zone)
        .environment(\.calendar, PlannerDates.calendar(zone))
        .presentationDetents([.large])
    }
}
