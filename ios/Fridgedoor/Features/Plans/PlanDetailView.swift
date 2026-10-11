import FridgedoorKit
import SwiftUI
import UIKit

/// One plan: where it stands, its facts, reminders, source and history, with the
/// decision bar pinned at the bottom until it's decided (DESIGN.md → Decisions).
/// Action rules mirror the web `PlanDetail.tsx` and the server's `plan-decisions.ts` /
/// `calendar-actions.ts`; calendar success is only shown once the server reports it.
struct PlanDetailView: View {
    let planId: String

    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var fetched: PlanSummary?
    @State private var loadError: PlannerError?
    @State private var history: [HistoryEntry]?
    @State private var historyFailed = false
    @State private var evidence: PlanSourceRow.Phase = .loading
    @State private var sheet: SheetKind?
    @State private var appleDraft: AppleCalendarDraft?
    @State private var confirmRemove = false
    @State private var removing = false
    @State private var titleScrolledAway = false
    @State private var succeeded = 0
    @State private var warned = 0

    private enum SheetKind: String, Identifiable { case edit, remind, setTime; var id: String { rawValue } }

    /// The freshest copy we have: the store's list or our own fetch (which also covers dismissed plans).
    private var plan: PlanSummary? {
        switch (store.plan(planId), fetched) {
        case let (cached?, loaded?): cached.revision >= loaded.revision ? cached : loaded
        case let (cached?, nil): cached
        case let (nil, loaded?): loaded
        case (nil, nil): nil
        }
    }

    var body: some View {
        Group {
            if let plan {
                content(plan)
            } else if let loadError {
                ContentUnavailableView {
                    Label("Plan unavailable", systemImage: "calendar.badge.exclamationmark")
                } description: {
                    Text(loadError.code == "NOT_FOUND" ? "This plan was removed or isn't shared with you." : loadError.userMessage)
                } actions: {
                    Button("Retry") { Task { await load() } }.buttonStyle(.plannerSecondary)
                }
            } else {
                ProgressView("Loading plan…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .plannerBackground()
        .navigationTitle(plan?.effectiveFacts.title ?? "Plan")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar(plan) }
        .task(id: planId) { await load() }
        .task(id: actionPollKey) { await pollCalendarAction() }
        .onChange(of: plan?.revision) { old, new in
            // Decisions made from the pinned bar change the plan; keep the log in step.
            if old != nil, old != new { Task { await loadHistory() } }
        }
        .onChange(of: plan?.calendarAction) { old, new in
            // Haptic only on a real transition we watched (whoever noticed it first: our poll or the store's).
            guard let old, let new, old.actionId == new.actionId, old.isInFlight, !new.isInFlight else { return }
            if new.state == "succeeded" { succeeded += 1 } else { warned += 1 }
        }
        .sheet(item: $sheet) { kind in
            if let plan {
                switch kind {
                case .edit:
                    PlanEditorSheet(plan: plan, memberZone: store.timeZone) { next in
                        fetched = next
                        Task { await loadHistory() }
                    }
                case .remind:
                    ReminderEditorSheet(parentType: "plan", parentId: plan.id, title: plan.effectiveFacts.title, anchor: plan.reminderAnchor)
                case .setTime:
                    SetTimeSheet(plan: plan)
                }
            }
        }
        .sheet(item: $appleDraft) { draft in
            AppleCalendarEditor(draft: draft) { action in
                appleDraft = nil
                if action == .saved { app.show("Added to Apple Calendar on this iPhone.") }
            }
            .ignoresSafeArea()
        }
        .confirmationDialog("Remove from the household calendar?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove from calendar", role: .destructive) { removeFromCalendar() }
        } message: {
            Text("“\(plan?.effectiveFacts.title ?? "This plan")” will be removed from the shared Google Calendar for everyone.")
        }
        .sensoryFeedback(.success, trigger: succeeded)
        .sensoryFeedback(.warning, trigger: warned)
    }

    // MARK: Content

    private func content(_ plan: PlanSummary) -> some View {
        let facts = plan.effectiveFacts
        let showsBar = store.decision(for: plan).primary != nil
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(plan, facts)
                notices(plan)
                if let action = plan.calendarAction, !plan.isClosed, action.isInFlight || action.outcome == .needsAttention {
                    CalendarStatusCard(action: action)
                }
                if !plan.isClosed {
                    PendingUpdateCard(plan: plan, zone: store.timeZone)
                }
                factsCard(plan, facts)
                remindersCard(plan)
                PlanFactCard {
                    if plan.sourceSummary.count > 0 {
                        PlanSourceRow(state: evidence) { Task { await loadEvidence() } }
                    } else if plan.sourceSummary.kind == "manual" {
                        PlanFactRow(systemImage: "hand.point.up.left", text: "Added by hand or from a request")
                    }
                    PlanHistoryRow(entries: history, failed: historyFailed, zone: store.timeZone, actor: { actorName($0, plan) }) {
                        Task { await loadHistory() }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
            .animation(.snappy, value: plan)
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > 90
        } action: { _, scrolledAway in
            titleScrolledAway = scrolledAway
        }
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom) {
            // Pinned until decided; the composer accessory and tab bar sit below it.
            if showsBar {
                PlanDecisionBar(plan: plan, style: .prominent, offersDetails: false)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: showsBar)
    }

    private func header(_ plan: PlanSummary, _ facts: PlanFacts) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(PlanText.categoryLabel(facts.category))
            Text(facts.title)
                .font(.serif(.largeTitle))
                .foregroundStyle(plan.isClosed ? Color.muted : Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .textSelection(.enabled)
            PlanStatusLine(plan: plan)
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private func notices(_ plan: PlanSummary) -> some View {
        if plan.possibleDuplicate && !plan.isClosed {
            Label("Possible duplicate of another household plan.", systemImage: "square.on.square")
                .font(.subheadline)
                .plannerCard(.soft, padding: 12)
        }
        if plan.isClosed {
            Label(plan.status == "archived" ? "Archived. It no longer appears on Home." : "Dismissed. It won't come back unless its details change.",
                  systemImage: plan.status == "archived" ? "archivebox" : "eye.slash")
                .font(.subheadline)
                .foregroundStyle(Color.muted)
                .plannerCard(.soft, padding: 12)
        }
    }

    // MARK: Facts

    private func factsCard(_ plan: PlanSummary, _ facts: PlanFacts) -> some View {
        // The pending-update diff above already shows what changed; don't repeat it here.
        let changed = Set(plan.isClosed ? [] : plan.pendingFacts?.changedFields(from: plan.facts) ?? [])
        return PlanFactCard {
            if !changed.contains(.time) { whenRow(plan, facts) }
            if let location = facts.location, !changed.contains(.location) {
                Menu {
                    if let url = PlanText.mapsURL(for: location) {
                        Button("Open in Maps", systemImage: "mappin.and.ellipse") { openURL(url) }
                    }
                    Button("Copy address", systemImage: "doc.on.doc") { UIPasteboard.general.string = location; app.show("Address copied.") }
                } label: {
                    PlanFactRow(systemImage: "mappin.and.ellipse", text: location) { PlanRowDisclosure() }
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows map options")
            }
            if !facts.participants.isEmpty, !changed.contains(.participants) {
                PlanFactRow(systemImage: "person.2", text: facts.participants.formatted(.list(type: .and)))
            }
            if let notes = facts.notes, !changed.contains(.notes) {
                PlanFactRow(systemImage: "text.alignleft", text: notes)
                    .textSelection(.enabled)
            }
            if !facts.preparationTasks.isEmpty, !changed.contains(.preparationTasks) {
                preparationRow(facts.preparationTasks)
            }
        }
    }

    @ViewBuilder
    private func whenRow(_ plan: PlanSummary, _ facts: PlanFacts) -> some View {
        let when = whenText(facts)
        if when.needsTime && plan.canEdit {
            Button { sheet = .setTime } label: {
                PlanFactRow(systemImage: "clock", text: when.text, secondary: when.secondary) { PlanRowDisclosure(value: "Set", emphasized: true) }
            }
            .buttonStyle(.plain)
            .accessibilityHint("Sets the time")
        } else {
            PlanFactRow(systemImage: facts.time?.isDeadline == true ? "flag" : "clock", text: when.text, secondary: when.secondary)
        }
    }

    /// The When row: what's known, and what's still missing ("Start time not set").
    private func whenText(_ facts: PlanFacts) -> (text: String, secondary: String?, needsTime: Bool) {
        let zone = store.timeZone
        let timeMarkers = facts.unresolvedFields.contains { PlanFacts.timeFieldMarkers.contains($0) }
        switch facts.time {
        case nil:
            return ("No date yet", "Date and time not set", true)
        case let .unresolved(dateHint, startHint, missing)?:
            if let start = PlannerDates.instant(startHint) {
                return ("\(TimeLabels.relativeDay(start, in: zone)) · \(TimeLabels.time(start, in: zone))", missing == ["end"] ? "End time not set" : "Time not confirmed", true)
            }
            if let day = PlannerDates.day(dateHint, in: zone) {
                return (TimeLabels.relativeDay(day, in: zone), "Start time not set", true)
            }
            return ("No date yet", "Date and time not set", true)
        case let time?:
            let label = TimeLabels.plan(time, in: zone)
            if timeMarkers && !time.isDeadline { return (label, "Time not confirmed", true) }
            return (label, zoneNote(time), false)
        }
    }

    private func zoneNote(_ time: NormalizedTime) -> String? {
        guard let zone = time.timezoneIdentifier, zone != store.member.timezone, let other = TimeZone(identifier: zone) else { return nil }
        return "Shown in your time zone · set in \(other.localizedName(for: .shortGeneric, locale: .current) ?? zone)"
    }

    /// "To prepare" items; each can become a to-do (long-press, or the VoiceOver action).
    private func preparationRow(_ tasks: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: "checklist")
                .foregroundStyle(Color.muted)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text("To prepare")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.muted)
                    .accessibilityAddTraits(.isHeader)
                ForEach(Array(tasks.enumerated()), id: \.offset) { _, task in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "circle").font(.caption).foregroundStyle(Color.muted).accessibilityHidden(true)
                        Text(task).foregroundStyle(Color.ink).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minHeight: 32)
                    .contentShape(.rect)
                    .contextMenu {
                        Button("Add to To do", systemImage: "checklist") { addToTodo(task) }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAction(named: "Add to To do") { addToTodo(task) }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: Reminders

    @ViewBuilder
    private func remindersCard(_ plan: PlanSummary) -> some View {
        let reminders = store.reminders(for: plan.id).sorted { $0.dueAt < $1.dueAt }
        if !reminders.isEmpty || !plan.isClosed {
            PlanFactCard {
                ForEach(reminders) { reminder in reminderRow(reminder) }
                if !plan.isClosed {
                    Button { sheet = .remind } label: {
                        PlanFactRow(systemImage: reminders.isEmpty ? "bell" : "plus", text: reminders.isEmpty ? "Remind me" : "Add a reminder") {
                            PlanRowDisclosure(value: reminders.isEmpty ? "None" : nil)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func reminderRow(_ reminder: Reminder) -> some View {
        let zone = store.timeZone
        let when = reminder.due.map { "\(TimeLabels.relativeDay($0, in: zone)) · \(TimeLabels.time($0, in: zone))" } ?? "Reminder"
        return PlanFactRow(systemImage: "bell", text: when, secondary: reminder.offsetMinutes.map { "\(ReminderText.offsetLabel($0)) · moves with the plan" }) {
            Menu {
                Button("Snooze 15 minutes", systemImage: "moon.zzz") {
                    reminderAction { try await store.snoozeReminder(reminder, until: .now.addingTimeInterval(15 * 60)) }
                }
                Button("Done", systemImage: "checkmark") { reminderAction { try await store.completeReminder(reminder) } }
                Button("Cancel reminder", systemImage: "bell.slash", role: .destructive) { reminderAction { try await store.cancelReminder(reminder) } }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.plannerAccent)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Reminder actions")
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private func toolbar(_ plan: PlanSummary?) -> some ToolbarContent {
        ToolbarItem(placement: .principal) {
            // The title appears in the bar once the large one has scrolled away.
            Text(plan?.effectiveFacts.title ?? "")
                .font(.headline)
                .lineLimit(1)
                .opacity(titleScrolledAway ? 1 : 0)
                .accessibilityHidden(!titleScrolledAway)
        }
        if let plan {
            if plan.canEdit {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { sheet = .edit }
                }
            }
            ToolbarItem(placement: .primaryAction) { actionsMenu(plan) }
        }
    }

    private func actionsMenu(_ plan: PlanSummary) -> some View {
        let facts = plan.effectiveFacts
        return Menu {
            ShareLink(item: PlanText.summary(facts, in: store.timeZone), subject: Text(facts.title), preview: SharePreview(facts.title)) {
                Label("Share…", systemImage: "square.and.arrow.up")
            }
            Button("Copy details", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = PlanText.summary(facts, in: store.timeZone)
                app.show("Plan details copied.")
            }
            if let draft = AppleCalendarDraft(facts: facts, memberZone: store.timeZone) {
                Button("Add to Apple Calendar", systemImage: "square.and.arrow.up.on.square") { appleDraft = draft }
            }
            if let location = facts.location, let url = PlanText.mapsURL(for: location) {
                Button("Open in Maps", systemImage: "mappin.and.ellipse") { openURL(url) }
            }
            if plan.hasCalendarEvent, !plan.isClosed, let url = URL(string: "https://calendar.google.com/") {
                Button("Open Google Calendar", systemImage: "arrow.up.right.square") { openURL(url) }
            }
            if !plan.isClosed {
                Button("Remind me", systemImage: "bell") { sheet = .remind }
            }
            if canRemoveFromCalendar(plan) {
                Divider()
                Button("Remove from calendar", systemImage: "calendar.badge.minus", role: .destructive) { confirmRemove = true }
            } else if plan.calendarAction == nil && !plan.isClosed {
                Divider()
                Button("Dismiss", systemImage: "eye.slash") {
                    store.dismissWithUndo(plan, app: app)
                    dismiss()
                }
            }
        } label: {
            Label("Plan actions", systemImage: "ellipsis")
        }
        .disabled(removing)
    }

    private func canRemoveFromCalendar(_ plan: PlanSummary) -> Bool {
        plan.hasCalendarEvent && plan.calendarAction?.state == "succeeded" && plan.calendarAction?.kind != "cancel" && plan.canEdit
    }

    /// History actors in household words: the email the plan came from, "You", or a first name.
    private func actorName(_ entry: HistoryEntry, _ plan: PlanSummary) -> String {
        let label = entry.actorLabel
        // The server labels unattributed entries "System" (`repos/plans.ts` history).
        if label == "System" { return plan.sourceSummary.kind == "email" ? "From email" : "The planner" }
        if label == store.member.displayName { return "You" }
        if let person = store.household.first(where: { $0.displayName == label }) { return person.firstName }
        return label.split(separator: " ").first.map(String.init) ?? label
    }

    // MARK: Loading

    private func load() async {
        do {
            fetched = try await store.reloadPlan(planId)
            loadError = nil
        } catch {
            if plan == nil { loadError = error as? PlannerError ?? .decoding }
        }
        async let historyLoad: Void = loadHistory()
        async let evidenceLoad: Void = loadEvidence()
        _ = await (historyLoad, evidenceLoad)
    }

    private func loadHistory() async {
        do { history = try await store.client.planHistory(planId); historyFailed = false }
        catch { if history == nil { historyFailed = true } }
    }

    private func loadEvidence() async {
        guard let plan, plan.sourceSummary.count > 0 else { return }
        if case .loaded = evidence {} else { evidence = .loading }
        do { evidence = .loaded(try await store.client.planEvidence(planId)) }
        catch let error as PlannerError where error.code == "NOT_FOUND" || error.code == "FORBIDDEN" { evidence = .notVisible }
        catch { evidence = .failed }
    }

    /// Changes whenever the in-flight action or its state changes, restarting the poll.
    private var actionPollKey: String? {
        guard let action = plan?.calendarAction, action.isInFlight else { return nil }
        return "\(action.actionId):\(action.state)"
    }

    /// Polls the action itself (web: every second) and reloads the plan when its state moves.
    private func pollCalendarAction() async {
        guard let action = plan?.calendarAction, action.isInFlight else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled, let status = try? await store.client.actionStatus(action.actionId), status.state != action.state else { continue }
            guard let next = try? await store.reloadPlan(planId) else { continue }
            fetched = next
            await loadHistory()
            return
        }
    }

    // MARK: Mutations

    private func removeFromCalendar() {
        guard !removing, let plan else { return }
        removing = true
        Task {
            defer { removing = false }
            do {
                try await store.applyPlan(plan, kind: "cancel", idempotencyKey: "cancel:\(plan.id):\(plan.revision)")
                app.show("Removing “\(plan.effectiveFacts.title)” from the household calendar…")
            } catch {
                warned += 1
                app.showPlanError(error)
            }
            if let next = try? await store.reloadPlan(planId) { fetched = next }
        }
    }

    private func addToTodo(_ task: String) {
        Task {
            do {
                let item = try await store.addListItem(.todo, title: task)
                app.show("Added “\(task)” to To do.", action: Toast.Action(label: "Undo") {
                    Task { try? await store.deleteListItem(item) }
                })
            } catch {
                app.show(error)
            }
        }
    }

    private func reminderAction(_ work: @escaping () async throws -> Void) {
        Task {
            do { try await work() } catch { app.showPlanError(error) }
        }
    }
}
