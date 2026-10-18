import FridgedoorKit
import SwiftUI

/// What can be decided about a plan right now, and how to describe where it stands.
/// Every screen that offers a plan decision uses this (DESIGN.md → Decisions), so
/// the order and words never change: the outcome verb, then Save, then •••.
/// The primary is never a dead end: when something is missing it is the missing step.
struct PlanDecision {
    enum Action: Hashable {
        case addToCalendar, setTime, addDetails, save, share, applyUpdate, review, retry, removeFromCalendar, openGoogleCalendar
        case setUpGoogle(String)

        var label: String {
            switch self {
            case .addToCalendar: "Add to calendar"
            case .setTime: "Set time"
            case .addDetails: "Add details"
            case .save: "Save"
            case .share: "Share with household"
            case .applyUpdate: "Apply update"
            case .review: "Review"
            case .retry: "Retry"
            case .removeFromCalendar: "Remove from calendar"
            case .openGoogleCalendar: "Open Google Calendar"
            case .setUpGoogle(let label): label
            }
        }

        var systemImage: String {
            switch self {
            case .addToCalendar: "calendar.badge.plus"
            case .setTime: "clock"
            case .addDetails: "square.and.pencil"
            case .save: "bookmark"
            case .share: "person.2"
            case .applyUpdate: "arrow.triangle.2.circlepath"
            case .review: "pencil"
            case .retry: "arrow.clockwise"
            case .removeFromCalendar: "calendar.badge.minus"
            case .openGoogleCalendar: "arrow.up.right.square"
            case .setUpGoogle: "link"
            }
        }
    }

    enum Tone { case attention, neutral, progress, problem }

    let primary: Action?
    let secondary: Action?
    /// Where the plan stands, in a few words. Privacy isn't part of it: `PlanStatusLine` adds "Only you".
    let status: String
    let tone: Tone

    init(plan: PlanSummary, googleReady: Bool, googleSetupLabel: String) {
        let facts = plan.effectiveFacts
        let saved = plan.savedInPlanner == true
        let deadline = facts.time?.isDeadline == true
        // The server (`plan-decisions.ts`) refuses the calendar while any field is unresolved.
        let timeMarkers = facts.unresolvedFields.contains { PlanFacts.timeFieldMarkers.contains($0) }
        let timeReady = (facts.time?.isCalendarReady ?? false) && !timeMarkers
        let otherMissing = facts.unresolvedFields.contains { !PlanFacts.timeFieldMarkers.contains($0) }
        // Setting the time is the missing step until the time is ready; after that, any other gap needs the editor.
        let missingStep: Action? = deadline ? nil : !timeReady ? .setTime : otherMissing ? .addDetails : nil
        let needs = missingStep.map { $0 == .setTime ? Self.missingTimeStatus(facts.time) : "Needs details" }

        if plan.isClosed {
            let removed = plan.status == "archived" && plan.calendarAction?.kind == "cancel"
            (primary, secondary, tone) = (nil, nil, .neutral)
            status = removed ? "Removed from household calendar" : plan.status == "archived" ? "Archived" : "Dismissed"
            return
        }

        if let action = plan.calendarAction {
            let kind = action.kind ?? "create"
            switch action.state {
            case "succeeded" where plan.pendingFacts != nil:
                if plan.changeKind == "cancel" {
                    (primary, secondary, status) = (.removeFromCalendar, .review, "On household calendar · cancellation suggested")
                } else if let missingStep {
                    // The new details can't go to Google yet; completing them updates the event.
                    (primary, secondary, status) = (missingStep, nil, "On household calendar · update pending")
                } else {
                    (primary, secondary, status) = (.applyUpdate, .review, "On household calendar · update pending")
                }
                tone = .attention
            case "succeeded":
                (primary, secondary, tone) = (nil, nil, .neutral)
                status = kind == "cancel" ? "Removed from household calendar" : "On household calendar"
            case "needs_reauth":
                // Once Google is reconnected, the original change can be retried.
                (primary, secondary, tone) = (googleReady ? .retry : .setUpGoogle("Reconnect Google"), nil, .problem)
                status = "Reconnect Google to finish the calendar change"
            case "conflict":
                (primary, secondary, status, tone) = (.openGoogleCalendar, nil, "Changed in Google Calendar · check it there", .problem)
            case "failed":
                (primary, secondary, status, tone) = (.retry, nil, "Couldn't update Google Calendar", .problem)
            case "canceled":
                (primary, secondary, status, tone) = (nil, nil, "Calendar change was canceled", .problem)
            default:
                (primary, secondary, tone) = (nil, nil, .progress)
                status = kind == "cancel" ? "Removing from household calendar…" : kind == "update" ? "Updating household calendar…" : "Adding to household calendar…"
            }
            return
        }

        if plan.pendingFacts != nil && saved {
            (primary, secondary, status, tone) = (.applyUpdate, .review, "Saved · update pending", .attention)
            return
        }

        tone = needs == nil ? .neutral : .attention
        if plan.isPrivate {
            // Private drafts: keep them to yourself, or share (adding to the calendar shares too).
            status = needs ?? (saved ? "Saved" : "Suggested")
            if let missingStep {
                (primary, secondary) = (missingStep, saved ? .share : .save)
            } else {
                (primary, secondary) = saved ? (.share, nil) : (.save, .share)
            }
            return
        }

        let save: Action? = saved ? nil : .save
        if deadline {
            // Deadlines aren't calendar events; ••• offers "Set a time…" to turn one into an event.
            (primary, secondary, status) = (save, nil, saved ? "Saved" : "Suggested")
        } else if let missingStep, let needs {
            (primary, secondary, status) = (missingStep, save, needs)
        } else if !googleReady {
            (primary, secondary) = saved ? (.setUpGoogle(googleSetupLabel), nil) : (.save, .setUpGoogle(googleSetupLabel))
            status = saved ? "Saved · not on calendar" : "Suggested"
        } else {
            (primary, secondary, status) = (.addToCalendar, save, saved ? "Saved · not on calendar" : "Suggested")
        }
    }

    private static func missingTimeStatus(_ time: NormalizedTime?) -> String {
        switch time {
        case let .unresolved(dateHint, startHint, missing)?:
            if startHint != nil { return missing == ["end"] ? "Needs an end time" : "Needs a start time" }
            return dateHint == nil ? "Needs a date" : "Needs a start time"
        case nil: return "Needs a date"
        default: return "Needs a start time"
        }
    }
}

extension PlannerStore {
    /// Web Home gating: an active Google connection with a chosen destination calendar.
    var googleReady: Bool { connection?.status == "active" && destination?.ownCalendarSelectionId != nil }
    var googleSetupLabel: String { connection?.status == "active" ? "Choose a calendar" : "Connect Google" }

    func decision(for plan: PlanSummary) -> PlanDecision {
        PlanDecision(plan: plan, googleReady: googleReady || connection == nil, googleSetupLabel: googleSetupLabel)
    }
}

/// The plan decision control. `.compact` shows only the primary action (Home rows),
/// `.regular` the primary and Save, `.prominent` the same at full size in a floating
/// glass bar (Plan detail pins it to the bottom). ••• always holds Edit, Set a time,
/// Apple Calendar, details, and Dismiss (with Undo) or Remove from calendar (confirmed).
struct PlanDecisionBar: View {
    enum Style { case compact, regular, prominent }

    let plan: PlanSummary
    var style: Style = .regular
    /// False on Plan detail itself: no "Open details", Review opens the editor, and Dismiss leaves the page.
    var offersDetails = true

    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var busy: PlanDecision.Action?
    @State private var showsSetTime = false
    @State private var showsEditor = false
    @State private var appleDraft: AppleCalendarDraft?
    @State private var confirm: Confirm?
    @State private var succeeded = 0

    private enum Confirm: Identifiable { case share, addPrivate, remove; var id: Self { self } }

    var body: some View {
        let decision = store.decision(for: plan)
        container(decision)
            .disabled(busy != nil)
            .sheet(isPresented: $showsSetTime) { SetTimeSheet(plan: plan) }
            .sheet(isPresented: $showsEditor) { PlanEditorSheet(plan: plan, memberZone: store.timeZone) }
            .sheet(item: $appleDraft) { draft in
                AppleCalendarEditor(draft: draft) { action in
                    appleDraft = nil
                    if action == .saved { app.show("Added to Apple Calendar on this iPhone.") }
                }
                .ignoresSafeArea()
            }
            .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible, presenting: confirm) { kind in
                switch kind {
                case .share: Button("Share with household") { run(.share) }
                case .addPrivate: Button("Share and add to calendar") { run(.addToCalendar) }
                case .remove: Button("Remove from calendar", role: .destructive) { run(.removeFromCalendar) }
                }
            } message: { kind in
                switch kind {
                case .share, .addPrivate: Text("Everyone in the household will see its title, time, place, people and notes.")
                case .remove: Text("“\(plan.effectiveFacts.title)” will be removed from the shared Google Calendar for everyone.")
                }
            }
            .sensoryFeedback(.success, trigger: succeeded)
    }

    // MARK: Layout

    @ViewBuilder
    private func container(_ decision: PlanDecision) -> some View {
        if style == .prominent {
            // A floating control, so it gets the navigation glass (DESIGN.md → Surfaces).
            buttons(decision)
                .padding(6)
                .glassEffect(.regular, in: .rect(cornerRadius: 30, style: .continuous))
        } else {
            buttons(decision)
        }
    }

    @ViewBuilder
    private func buttons(_ decision: PlanDecision) -> some View {
        let secondary = style == .compact ? nil : decision.secondary
        if dynamicTypeSize.isAccessibilitySize {
            // Stack instead of squeezing three controls into one line.
            VStack(alignment: .leading, spacing: 4) {
                if let primary = decision.primary {
                    actionButton(primary, prominent: true)
                }
                HStack(spacing: 8) {
                    if let secondary { actionButton(secondary, prominent: false) }
                    Spacer(minLength: 0)
                    moreMenu(decision)
                }
            }
        } else {
            HStack(spacing: 8) {
                if let primary = decision.primary {
                    actionButton(primary, prominent: true)
                }
                if let secondary { actionButton(secondary, prominent: false) }
                if style != .prominent || decision.primary == nil { Spacer(minLength: 0) }
                moreMenu(decision)
            }
        }
    }

    private func actionButton(_ action: PlanDecision.Action, prominent: Bool) -> some View {
        let isBusy = busy == action
        let large = style == .prominent
        return Button { tap(action) } label: {
            HStack(spacing: 6) {
                if isBusy {
                    ProgressView().controlSize(.small).tint(prominent ? Color.onAccent : Color.plannerAccent)
                } else if large || prominent {
                    Image(systemName: action.systemImage).accessibilityHidden(true)
                }
                Text(label(for: action)).lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
            }
            .frame(maxWidth: large && prominent ? .infinity : nil)
        }
        .buttonStyle(DecisionButtonStyle(prominent: prominent, large: large))
        .accessibilityValue(isBusy ? "In progress" : "")
    }

    /// "Share with Sam" in a two-person household (it fits the bar); otherwise the action's label.
    private func label(for action: PlanDecision.Action) -> String {
        let others = store.household.filter { $0.id != store.member.id }
        if action == .share, others.count == 1, let name = others.first?.firstName { return "Share with \(name)" }
        return action.label
    }

    private func moreMenu(_ decision: PlanDecision) -> some View {
        let shown = [decision.primary, decision.secondary]
        return Menu {
            if offersDetails {
                Button("Open details", systemImage: "info.circle") { router.open(.plan(plan.id)) }
            }
            if plan.canEdit {
                Button("Edit", systemImage: "pencil") { showsEditor = true }
                if !isTimed, !shown.contains(.setTime) {
                    Button("Set a time…", systemImage: "clock") { showsSetTime = true }
                }
                if plan.isPrivate, !shown.contains(.share) {
                    Button("Share with household", systemImage: "person.2") { confirm = .share }
                }
            }
            if let draft = AppleCalendarDraft(facts: plan.effectiveFacts, memberZone: store.timeZone) {
                Button("Add to Apple Calendar", systemImage: "square.and.arrow.up.on.square") { appleDraft = draft }
            }
            if canRemoveFromCalendar {
                if !shown.contains(.removeFromCalendar) {
                    Divider()
                    Button("Remove from calendar", systemImage: "calendar.badge.minus", role: .destructive) { confirm = .remove }
                }
            } else if plan.calendarAction == nil && !plan.isClosed {
                Divider()
                // Undoable, so not styled as destructive (DESIGN.md → Decisions).
                Button("Dismiss", systemImage: "eye.slash") { dismissPlan() }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.plannerAccent)
                .frame(width: 44, height: 44)
                .background { if style == .prominent { Circle().fill(Color.soft) } }
                .contentShape(.circle)
        }
        .accessibilityLabel("Plan actions")
    }

    private var isTimed: Bool { if case .timed? = plan.effectiveFacts.time { true } else { false } }
    private var canRemoveFromCalendar: Bool {
        plan.hasCalendarEvent && plan.calendarAction?.state == "succeeded" && plan.calendarAction?.kind != "cancel" && plan.canEdit
    }

    private var confirmTitle: String {
        switch confirm {
        case .share: "Share with the household?"
        case .addPrivate: "Share it to add it to the calendar?"
        case .remove: "Remove from the household calendar?"
        case nil: ""
        }
    }

    // MARK: Actions

    private func tap(_ action: PlanDecision.Action) {
        switch action {
        case .setTime: showsSetTime = true
        case .addDetails: showsEditor = true
        case .share: confirm = .share
        case .addToCalendar where plan.isPrivate: confirm = .addPrivate
        case .removeFromCalendar: confirm = .remove
        case .setUpGoogle: router.open(.settings)
        case .openGoogleCalendar: if let url = URL(string: "https://calendar.google.com/") { openURL(url) }
        case .review: if offersDetails { router.open(.plan(plan.id)) } else { showsEditor = true }
        default: run(action)
        }
    }

    private func dismissPlan() {
        store.dismissWithUndo(plan, app: app)
        // On Plan detail the plan is gone, so leave; Undo restores it wherever the user lands.
        if !offersDetails { dismiss() }
    }

    private func run(_ action: PlanDecision.Action) {
        guard busy == nil else { return }
        busy = action
        let title = plan.effectiveFacts.title
        Task {
            defer { busy = nil }
            // Act on the freshest revision we have; the caller's copy can be a refresh behind.
            let current = store.plan(plan.id) ?? plan
            do {
                switch action {
                case .addToCalendar:
                    var target = current
                    if current.isPrivate { target = try await store.sharePlan(current) }
                    try await store.decide(target, choice: "calendar")
                    // The store announces success once Google confirms; never claim it here.
                    app.show("Adding “\(title)” to the household calendar…")
                case .save:
                    try await store.decide(current, choice: "keep")
                    app.show("Saved “\(title)”.")
                case .share:
                    _ = try await store.sharePlan(current)
                    app.show("Shared “\(title)” with the household.")
                case .applyUpdate:
                    if current.hasCalendarEvent {
                        try await store.applyPlan(current, kind: "update", idempotencyKey: "update:\(current.id):\(current.revision)")
                        app.show("Updating the household calendar…")
                    } else if let pending = current.pendingFacts {
                        _ = try await store.savePlan(current, facts: pending, updateCalendar: false)
                        app.show("Update applied.")
                    }
                case .retry:
                    try await store.retryCalendarAction(current)
                    app.show("Trying the calendar change again…")
                case .removeFromCalendar:
                    try await store.applyPlan(current, kind: "cancel", idempotencyKey: "cancel:\(current.id):\(current.revision)")
                    app.show("Removing “\(title)” from the household calendar…")
                default:
                    return
                }
                succeeded += 1
            } catch {
                app.showPlanError(error)
            }
        }
    }
}

/// Decision buttons: capsules like `PlannerButtonStyle`, with a hit area of at least
/// 44pt even where the capsule itself is smaller (DESIGN.md → Accessibility).
private struct DecisionButtonStyle: ButtonStyle {
    let prominent: Bool
    let large: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(large ? .body.weight(.semibold) : .subheadline.weight(.semibold))
            .padding(.horizontal, large ? 18 : 14)
            .padding(.vertical, 6)
            .frame(minHeight: large ? 48 : 36)
            .foregroundStyle(prominent ? Color.onAccent : Color.plannerAccent)
            .background(prominent ? Color.plannerAccent : Color.soft, in: .capsule)
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
            .padding(.vertical, large ? 0 : 4)
            .contentShape(.rect)
    }
}

/// One line saying where a plan stands, colored by what it needs from you
/// (teal only when it needs you). Private plans add "Only you" with a lock.
struct PlanStatusLine: View {
    let plan: PlanSummary
    @Environment(PlannerStore.self) private var store

    var body: some View {
        let decision = store.decision(for: plan)
        PlanFlowLayout(spacing: 8) {
            status(decision)
            if plan.isPrivate {
                iconText("lock", "Only you")
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func status(_ decision: PlanDecision) -> some View {
        switch decision.tone {
        case .attention:
            HStack(spacing: 6) {
                Circle().frame(width: 6, height: 6).accessibilityHidden(true)
                Text(decision.status)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.attentionInk)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Color.attention, in: .capsule)
        case .problem:
            iconText("exclamationmark.triangle.fill", decision.status)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.danger)
        case .progress:
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text(decision.status)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.muted)
            .accessibilityAddTraits(.updatesFrequently)
        case .neutral:
            Group {
                if let symbol = neutralSymbol {
                    iconText(symbol, decision.status)
                } else {
                    Text(decision.status)
                }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.muted)
        }
    }

    /// An HStack rather than `Label`: inside List rows `Label` takes the list's icon-column
    /// style, which collapses to the icon (and a tall frame) in this flow layout.
    private func iconText(_ symbol: String, _ text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).imageScale(.small)
            Text(text)
        }
    }

    private var neutralSymbol: String? {
        if plan.status == "dismissed" { return "eye.slash" }
        if plan.status == "archived" { return plan.calendarAction?.kind == "cancel" ? "calendar.badge.minus" : "archivebox" }
        if plan.calendarAction?.state == "succeeded" { return plan.calendarAction?.kind == "cancel" ? "calendar.badge.minus" : "calendar" }
        if plan.savedInPlanner == true { return "bookmark" }
        return nil
    }
}
