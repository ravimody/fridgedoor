import FridgedoorKit
import SwiftUI

/// Native editor for a plan's facts. Starts from the pending update when there is
/// one (web `pendingFacts ?? facts`) and saves through `PATCH /plans/:id`. For
/// plans already on Google Calendar, saving also queues the calendar update.
struct PlanEditorSheet: View {
    /// The live plan. The sheet's content is rebuilt on every store refresh, so this
    /// can move to a newer revision while the user is still editing.
    let plan: PlanSummary
    /// Called with the saved plan after a successful save.
    var onSaved: (PlanSummary) -> Void = { _ in }

    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    /// The plan as it was when the sheet opened; the draft was built from it and saves against its revision.
    @State private var base: PlanSummary
    @State private var draft: PlanDraft
    @State private var newParticipant = ""
    @State private var newTask = ""
    @State private var saving = false
    @State private var validation: String?
    @State private var confirmDiscard = false
    @State private var savedCount = 0
    /// Typing a category of your own instead of picking one of the usual ones.
    @State private var customCategory = false
    @FocusState private var focus: Field?

    private enum Field: Hashable { case title, category, location, notes, participant, task }
    /// Picker tag for "Other…" (never saved; real categories are lower-case words).
    private static let otherCategory = "\u{0}other"

    private static let categories = ["general", "school", "activities", "health", "social", "household", "travel", "work", "family"]

    init(plan: PlanSummary, memberZone: TimeZone, onSaved: @escaping (PlanSummary) -> Void = { _ in }) {
        self.plan = plan
        self.onSaved = onSaved
        _base = State(initialValue: plan)
        let draft = PlanDraft(facts: plan.effectiveFacts, timeZone: memberZone)
        _draft = State(initialValue: draft)
        _customCategory = State(initialValue: !Self.categories.contains(draft.category) && !draft.category.isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let validation {
                    Section {
                        Label(validation, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(Color.danger)
                            .font(.subheadline)
                    }
                    .listRowBackground(Color.danger.opacity(0.1))
                    .accessibilityAddTraits(.updatesFrequently)
                }
                detailsSection
                timeSection
                peopleSection
                notesSection
                tasksSection
                if !stillNeeds.isEmpty {
                    Section {
                        Text("Still needs \(stillNeeds.map(Self.fieldLabel).formatted(.list(type: .and))).")
                            .font(.footnote)
                            .foregroundStyle(Color.muted)
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.paper)
            .navigationTitle("Edit plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .interactiveDismissDisabled(draft.isDirty)
            .confirmationDialog("Discard changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
            .onChange(of: draft) { validation = nil }
        }
        .sensoryFeedback(.success, trigger: savedCount)
    }

    /// Unresolved fields left after saving: a time you've set clears the time-related ones (`PlanDraft.facts()`).
    private var stillNeeds: [String] {
        let timeSet = draft.timeEdited && draft.timeMode != .unresolved
        return draft.unresolvedFields.filter { !(timeSet && PlanFacts.timeFieldMarkers.contains($0)) }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { if draft.isDirty { confirmDiscard = true } else { dismiss() } }
        }
        ToolbarItem(placement: .confirmationAction) {
            if saving {
                ProgressView()
            } else {
                Button("Save") { save() }
                    .fontWeight(.semibold)
                    .disabled(!draft.isDirty)
                    .accessibilityHint(base.hasCalendarEvent ? "Saves your corrections and updates the household calendar event" : "")
            }
        }
        ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("Done") { focus = nil }
        }
    }

    // MARK: Sections

    private var detailsSection: some View {
        Section {
            TextField("Title", text: $draft.title, axis: .vertical)
                .font(.body.weight(.semibold))
                .focused($focus, equals: .title)
                .submitLabel(.next)
            Picker("Category", selection: categorySelection) {
                ForEach(Self.categories, id: \.self) { Text(PlanText.categoryLabel($0)).tag($0) }
                Text("Other…").tag(Self.otherCategory)
            }
            .pickerStyle(.menu)
            if customCategory {
                TextField("Category name", text: $draft.category)
                    .focused($focus, equals: .category)
                    .textInputAutocapitalization(.never)
            }
            HStack {
                Image(systemName: "mappin.and.ellipse").foregroundStyle(Color.muted)
                TextField("Location", text: $draft.location, axis: .vertical)
                    .focused($focus, equals: .location)
                    .textContentType(.fullStreetAddress)
            }
        } header: {
            Text("Details")
        } footer: {
            if base.hasCalendarEvent {
                Text("Saving updates the household calendar event too.")
            } else if base.isPrivate {
                Text("Only you can see this until you share it.")
            }
        }
        .plannerRows()
    }

    /// The picker shows labels ("School") and saves the stored value ("school").
    private var categorySelection: Binding<String> {
        Binding(get: { customCategory ? Self.otherCategory : draft.category }, set: { value in
            if value == Self.otherCategory {
                customCategory = true
                if Self.categories.contains(draft.category) { draft.category = "" }
                focus = .category
            } else {
                customCategory = false
                draft.category = value
            }
        })
    }

    // MARK: When

    /// Date (optional); then at most one of "Add a time" (Starts/Ends), "All day" or
    /// "It's a deadline". A date with none of them is a known day with the time still
    /// unresolved, exactly as before: an empty time stays unresolved. Maps onto
    /// `PlanDraft.TimeMode`; nothing is converted until the user touches a control.
    private var timeSection: some View {
        Section {
            Toggle(isOn: hasDateBinding) { Label("Date", systemImage: "calendar") }
            if hasDate {
                DatePicker("Date", selection: dayBinding, displayedComponents: .date)
                Toggle(isOn: kindBinding(.timed)) { Label("Add a time", systemImage: "clock") }
                if draft.timeMode == .timed {
                    DatePicker("Starts", selection: startBinding, displayedComponents: .hourAndMinute)
                    DatePicker("Ends", selection: timeBinding(\.end), in: draft.start..., displayedComponents: [.date, .hourAndMinute])
                } else if draft.timeMode == .unresolved && draft.knowsStart {
                    // A start without an end (e.g. "starts around 3"): keep it until the user adds the end.
                    DatePicker("Starts", selection: timeBinding(\.hintStart), displayedComponents: .hourAndMinute)
                    Button("Add an end time") { draft.setTimeMode(.timed) }
                        .frame(minHeight: 44)
                }
                Toggle(isOn: kindBinding(.allDay)) { Label("All day", systemImage: "sun.max") }
                if draft.timeMode == .allDay {
                    DatePicker("Last day", selection: timeBinding(\.lastDay), in: draft.firstDay..., displayedComponents: .date)
                }
                Toggle(isOn: kindBinding(.deadline)) { Label("It's a deadline", systemImage: "flag") }
                if draft.timeMode == .deadline {
                    DatePicker("Due by", selection: timeBinding(\.due), displayedComponents: .hourAndMinute)
                }
            }
        } header: {
            Text("When")
        } footer: {
            if let footer = timeFooter { Text(footer) }
        }
        .environment(\.timeZone, draft.timeZone)
        .plannerRows()
    }

    private var timeFooter: String? {
        var parts: [String] = []
        if draft.timeMode == .deadline { parts.append("Deadlines stay off the calendar. Add a time instead to put it there.") }
        if draft.timeZone.identifier != store.timeZone.identifier {
            parts.append("Times are in \(draft.timeZone.localizedName(for: .generic, locale: .current) ?? draft.timeZone.identifier).")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private var hasDate: Bool { draft.timeMode != .unresolved || draft.knowsDate || draft.knowsStart }

    private var calendar: Calendar { PlannerDates.calendar(draft.timeZone) }

    /// Turning the date off clears the time too; turning it on knows the day, not the time.
    private var hasDateBinding: Binding<Bool> {
        Binding(get: { hasDate }, set: { on in
            draft.setTimeMode(.unresolved)
            draft.knowsDate = on
            draft.knowsStart = false
            draft.timeEdited = true
        })
    }

    /// The day, whichever kind of time holds it. Moving it keeps the time of day (and duration).
    private var dayBinding: Binding<Date> {
        Binding(get: {
            switch draft.timeMode {
            case .timed: calendar.startOfDay(for: draft.start)
            case .allDay: draft.firstDay
            case .deadline: calendar.startOfDay(for: draft.due)
            case .unresolved: draft.knowsStart ? calendar.startOfDay(for: draft.hintStart) : draft.hintDay
            }
        }, set: { newValue in
            let calendar = calendar
            let day = calendar.startOfDay(for: newValue)
            func move(_ date: Date) -> Date {
                let parts = calendar.dateComponents([.hour, .minute], from: date)
                return calendar.date(bySettingHour: parts.hour ?? 9, minute: parts.minute ?? 0, second: 0, of: day) ?? day
            }
            switch draft.timeMode {
            case .timed:
                let length = draft.end.timeIntervalSince(draft.start)
                draft.start = move(draft.start)
                draft.end = draft.start.addingTimeInterval(length)
            case .allDay:
                let span = calendar.dateComponents([.day], from: draft.firstDay, to: draft.lastDay).day ?? 0
                draft.firstDay = day
                draft.lastDay = calendar.date(byAdding: .day, value: span, to: day) ?? day
            case .deadline:
                draft.due = move(draft.due)
            case .unresolved:
                draft.hintDay = day
                if draft.knowsStart { draft.hintStart = move(draft.hintStart) }
            }
            draft.timeEdited = true
        })
    }

    /// Keep the duration when the start moves, like Calendar.
    private var startBinding: Binding<Date> {
        Binding(get: { draft.start }, set: { new in
            let length = draft.end.timeIntervalSince(draft.start)
            draft.start = new
            if length > 0 { draft.end = new.addingTimeInterval(length) }
            draft.timeEdited = true
        })
    }

    /// One switch per kind of time; turning one on turns the others off, turning it off
    /// leaves just the day (time unresolved).
    private func kindBinding(_ mode: PlanDraft.TimeMode) -> Binding<Bool> {
        Binding(get: { draft.timeMode == mode || (mode == .timed && draft.timeMode == .unresolved && draft.knowsStart) }, set: { on in
            if on {
                draft.setTimeMode(mode)
            } else {
                let day = dayBinding.wrappedValue
                draft.setTimeMode(.unresolved)
                draft.hintDay = day
                draft.knowsDate = true
                draft.knowsStart = false
            }
            draft.timeEdited = true
        })
    }

    private var peopleSection: some View {
        Section("Who") {
            ForEach(Array(draft.participants.enumerated()), id: \.offset) { index, name in
                Label(name, systemImage: "person")
                    .swipeActions { Button("Delete", systemImage: "trash", role: .destructive) { draft.participants.remove(at: index) } }
            }
            .onDelete { draft.participants.remove(atOffsets: $0) }
            if draft.participants.count < 10 {
                HStack {
                    TextField("Add a person", text: $newParticipant)
                        .focused($focus, equals: .participant)
                        .textContentType(.name)
                        .submitLabel(.done)
                        .onSubmit(addParticipant)
                    if !newParticipant.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button("Add", action: addParticipant)
                            .buttonStyle(.borderless)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                }
            }
        }
        .plannerRows()
    }

    private var notesSection: some View {
        Section("Notes") {
            TextField("Anything worth remembering", text: $draft.notes, axis: .vertical)
                .lineLimit(3...10)
                .focused($focus, equals: .notes)
        }
        .plannerRows()
    }

    private var tasksSection: some View {
        Section {
            ForEach($draft.tasks) { $task in
                HStack(alignment: .firstTextBaseline) {
                    Image(systemName: "circle").foregroundStyle(Color.muted).font(.footnote)
                    TextField("Something to prepare", text: $task.text, axis: .vertical)
                }
            }
            .onDelete { draft.tasks.remove(atOffsets: $0) }
            .onMove { draft.tasks.move(fromOffsets: $0, toOffset: $1) }
            if draft.tasks.count < 20 {
                HStack {
                    Image(systemName: "plus.circle.fill").foregroundStyle(Color.plannerAccent)
                    TextField("Add something to prepare", text: $newTask)
                        .focused($focus, equals: .task)
                        .submitLabel(.done)
                        .onSubmit(addTask)
                }
            }
        } header: {
            HStack {
                Text("To prepare")
                Spacer()
                if draft.tasks.count > 1 { EditButton().font(.caption.weight(.semibold)) }
            }
        }
        .plannerRows()
    }

    // MARK: Actions

    private func timeBinding<Value>(_ keyPath: WritableKeyPath<PlanDraft, Value>) -> Binding<Value> {
        Binding(get: { draft[keyPath: keyPath] }, set: { draft[keyPath: keyPath] = $0; draft.timeEdited = true })
    }

    private func addParticipant() {
        let name = newParticipant.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, draft.participants.count < 10 else { return }
        if !draft.participants.contains(name) { draft.participants.append(name) }
        newParticipant = ""
        focus = .participant
    }

    private func addTask() {
        let text = newTask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, draft.tasks.count < 20 else { return }
        draft.tasks.append(PlanDraft.PrepTask(text: text))
        newTask = ""
        focus = .task
    }

    private func save() {
        // Pick up any half-typed person/task rather than silently dropping it.
        addParticipant(); addTask(); focus = nil
        let facts: PlanFacts
        do { facts = try draft.facts() } catch { validation = error.localizedDescription; return }
        // Never save a draft built from an older revision over a newer one.
        guard plan.revision == base.revision else { changedElsewhere(); return }
        saving = true
        Task {
            defer { saving = false }
            do {
                let next = try await store.savePlan(base, facts: facts, updateCalendar: base.hasCalendarEvent)
                savedCount += 1
                app.show(base.hasCalendarEvent ? "Saved. Updating the household calendar…" : "Saved your changes.")
                onSaved(next)
                dismiss()
            } catch let error as PlanCalendarError {
                app.showPlanError(error)
                if let next = try? await store.reloadPlan(base.id) { onSaved(next) }
                dismiss()
            } catch let error as PlannerError where error.isStale {
                changedElsewhere()
            } catch {
                validation = PlanErrorCopy.message(for: error)
            }
        }
    }

    /// Someone else changed it: never overwrite their edit. Reload and let the user look again.
    private func changedElsewhere() {
        app.show("This plan changed elsewhere. Review the latest details before editing again.", isError: true)
        Task { if let next = try? await store.reloadPlan(base.id) { onSaved(next) } }
        dismiss()
    }

    static func fieldLabel(_ field: String) -> String {
        switch field {
        case "date": "the date"
        case "start": "a start time"
        case "end": "an end time"
        case "time": "a time"
        case "timezone": "a timezone"
        default: field.replacingOccurrences(of: "_", with: " ")
        }
    }
}
