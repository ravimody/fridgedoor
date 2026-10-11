import FridgedoorKit
import SwiftUI

/// "Remind me" sheet for a plan or list item. Personal to the signed-in member.
///
/// `anchor` is the plan's start/deadline when known. For plans, the 15 min / 1 h /
/// 1 day choices are saved as `offsetMinutes` so the server moves the reminder when
/// the plan's time changes (`services/reminders.ts`). The anchor is re-derived from
/// the cached plan when possible, because offsets only work for timed plans and
/// deadlines. List items get the same choices as fixed times.
struct ReminderEditorSheet: View {
    let parentType: String // plan | list_item
    let parentId: String
    let title: String
    var anchor: Date?

    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var customDate: Date?
    @State private var savingChoice: String?
    @State private var saved = 0
    /// The last attempted reminder body (parent, due time, offset) and its idempotency key,
    /// so retrying an unchanged reminder after a lost response can't create a duplicate.
    @State private var lastAttempt: (body: String, key: String)?

    private struct Choice: Identifiable {
        let id: String
        let label: String
        let date: Date
        var offsetMinutes: Int?
    }

    var body: some View {
        NavigationStack {
            List {
                if !relativeChoices.isEmpty {
                    Section {
                        ForEach(relativeChoices) { choice in choiceButton(choice) }
                    } header: {
                        Text(isDeadline ? "Before it's due" : "Before it starts")
                    } footer: {
                        if parentType == "plan" { Text("These move with the plan if its time changes.") }
                    }
                    .plannerRows()
                }
                Section("Quick picks") {
                    ForEach(quickChoices) { choice in choiceButton(choice) }
                }
                .plannerRows()
                Section {
                    DatePicker("Remind me at", selection: customBinding, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                        .environment(\.timeZone, store.timeZone)
                    Button {
                        save(Choice(id: "custom", label: "Custom", date: customBinding.wrappedValue))
                    } label: {
                        HStack {
                            Label("Remind me then", systemImage: "bell")
                            Spacer()
                            if savingChoice == "custom" { ProgressView() }
                        }
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                    }
                    .disabled(savingChoice != nil)
                } header: {
                    Text("Choose a time")
                } footer: {
                    Label("Only you · \(zoneName)", systemImage: "lock")
                }
                .plannerRows()
            }
            .plannerList()
            .navigationTitle("Remind me")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .top) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Color.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal)
                    .padding(.bottom, 4)
                    .background(Color.paper)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.paper)
        .sensoryFeedback(.success, trigger: saved)
    }

    private func choiceButton(_ choice: Choice) -> some View {
        Button { save(choice) } label: {
            HStack {
                Text(choice.label).foregroundStyle(Color.ink)
                Spacer()
                if savingChoice == choice.id {
                    ProgressView()
                } else {
                    Text(when(choice.date)).font(.subheadline).foregroundStyle(Color.muted)
                }
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .disabled(savingChoice != nil)
        .accessibilityLabel("\(choice.label), \(when(choice.date))")
    }

    // MARK: Choices

    /// Offsets need the plan's live time; fall back to the caller's anchor for list items.
    private var resolvedAnchor: Date? {
        if parentType == "plan", let plan = store.plan(parentId) { return plan.reminderAnchor }
        return anchor
    }

    private var isDeadline: Bool {
        parentType == "plan" ? store.plan(parentId)?.facts.time?.isDeadline == true : true
    }

    private var relativeChoices: [Choice] {
        guard let anchor = resolvedAnchor else { return [] }
        let usesOffset = parentType == "plan"
        return [(-15, "15 minutes before"), (-60, "1 hour before"), (-1440, "1 day before")].compactMap { minutes, label in
            let date = anchor.addingTimeInterval(TimeInterval(minutes * 60))
            guard date > .now.addingTimeInterval(60) else { return nil }
            return Choice(id: "offset\(minutes)", label: label, date: date, offsetMinutes: usesOffset ? minutes : nil)
        }
    }

    private var quickChoices: [Choice] {
        let calendar = store.calendar
        let now = Date.now
        var choices = [Choice(id: "hour", label: "In 1 hour", date: roundedToQuarter(now.addingTimeInterval(3600)))]
        let later = roundedToQuarter(now.addingTimeInterval(3 * 3600))
        if calendar.isDate(later, inSameDayAs: now) { choices.append(Choice(id: "later", label: "Later today", date: later)) }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)),
           let morning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) {
            choices.append(Choice(id: "tomorrow", label: "Tomorrow morning", date: morning))
        }
        return choices
    }

    private var customBinding: Binding<Date> {
        Binding(get: { customDate ?? defaultCustomDate }, set: { customDate = $0 })
    }

    private var defaultCustomDate: Date {
        if let anchor = resolvedAnchor, anchor.addingTimeInterval(-3600) > .now { return anchor.addingTimeInterval(-3600) }
        return quickChoices.last?.date ?? .now.addingTimeInterval(3600)
    }

    private func roundedToQuarter(_ date: Date) -> Date {
        let quarter: TimeInterval = 15 * 60
        return Date(timeIntervalSinceReferenceDate: (date.timeIntervalSinceReferenceDate / quarter).rounded(.up) * quarter)
    }

    private var zoneName: String {
        store.timeZone.localizedName(for: .shortGeneric, locale: .current) ?? store.member.timezone
    }

    private func when(_ date: Date) -> String {
        "\(TimeLabels.relativeDay(date, in: store.timeZone)) · \(TimeLabels.time(date, in: store.timeZone))"
    }

    // MARK: Save

    private func save(_ choice: Choice) {
        guard savingChoice == nil else { return }
        guard choice.date > .now else { app.show("Choose a future reminder time.", isError: true); return }
        savingChoice = choice.id
        let body = "\(parentType):\(parentId):\(PlannerDates.offsetString(choice.date, timeZone: store.timeZone)):\(choice.offsetMinutes.map(String.init) ?? "-")"
        let key = lastAttempt.flatMap { $0.body == body ? $0.key : nil } ?? UUID().uuidString
        lastAttempt = (body, key)
        Task {
            defer { savingChoice = nil }
            do {
                try await store.addReminder(parentType: parentType, parentId: parentId, at: choice.date, offsetMinutes: choice.offsetMinutes, idempotencyKey: key)
                saved += 1
                app.show("Reminder set for \(TimeLabels.relativeDayInSentence(choice.date, in: store.timeZone)) at \(TimeLabels.time(choice.date, in: store.timeZone)).")
                dismiss()
            } catch {
                app.showPlanError(error)
            }
        }
    }
}
