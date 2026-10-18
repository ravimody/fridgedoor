import FridgedoorKit
import SwiftUI

// Building blocks shared by the composer thread and the request screens. Decision
// semantics mirror the web `Home.tsx` (`Request`, `ProposedItem`, `PlanCard`); plan
// decisions use the shared `PlanDecisionBar` (DESIGN.md → Decisions).

/// Runs an assistant action, reporting failures in plain language. Returns success.
@MainActor
func performRequestAction(_ app: AppModel, _ work: () async throws -> Void) async -> Bool {
    do {
        try await work()
        return true
    } catch let error as PlannerError {
        app.show(error.assistantMessage, isError: true)
        if error.isStale { await app.store?.refresh() }
        return false
    } catch {
        app.show(error.localizedDescription, isError: true)
        return false
    }
}

/// Reads a state change out for VoiceOver where the card itself shows the result.
@MainActor
func announceRequestChange(_ message: String) {
    AccessibilityNotification.Announcement(message).post()
}

// MARK: Status

/// Where a request stands, as small chips. Teal means it needs you; red only
/// for a request that couldn't finish (DESIGN.md → Surfaces and color).
struct RequestStatusChips: View {
    let run: AssistantRun
    var limit = Int.max
    @Environment(PlannerStore.self) private var store

    var body: some View {
        if run.state == "failed" {
            Badge("Couldn't finish", style: .danger, systemImage: "exclamationmark.triangle.fill")
        } else if run.isWorking {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Working…").font(.caption).foregroundStyle(Color.muted)
            }
            .accessibilityElement(children: .combine)
        } else {
            ChipFlowLayout(spacing: 6) {
                ForEach(run.outcomes(plans: store.plans).prefix(limit), id: \.self) { outcome in
                    Badge(Self.label(outcome), style: Self.style(outcome), systemImage: Self.symbol(outcome))
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// The app's words for each outcome (the web labels predate DESIGN.md).
    static func label(_ outcome: RequestOutcome) -> String {
        switch outcome {
        case .working: "Working…"
        case .calendarPending: "Waiting for Google Calendar"
        case .needsAttention: "Needs attention"
        case .needsReview: "Needs review"
        case .added: "Added to lists"
        case .saved: "Saved"
        case .calendarAdded: "On household calendar"
        case .calendarUpdated: "Updated on household calendar"
        case .calendarRemoved: "Removed from household calendar"
        case .remembered: "Saved to Household facts"
        case .undone: "Undone"
        case .dismissed: "Dismissed"
        case .reply: "Answered"
        }
    }

    private static func style(_ outcome: RequestOutcome) -> Badge.Style {
        switch outcome {
        case .needsAttention, .needsReview: .attention
        case .working, .calendarPending, .dismissed, .undone, .reply: .neutral
        default: .accent
        }
    }

    private static func symbol(_ outcome: RequestOutcome) -> String? {
        switch outcome {
        case .needsAttention: "exclamationmark.circle.fill"
        case .needsReview: "hand.raised.fill"
        case .working, .calendarPending: "hourglass"
        case .added, .saved, .remembered: "checkmark"
        case .calendarAdded, .calendarUpdated: "calendar.badge.checkmark"
        case .calendarRemoved: "calendar.badge.minus"
        case .undone: "arrow.uturn.backward"
        case .dismissed: "eye.slash"
        case .reply: "text.bubble"
        }
    }
}

// MARK: Reply

/// Markdown reply. Only http(s) links stay tappable.
enum ReplyMarkdown {
    static func render(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        var attributed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        let unsafe = attributed.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard let link = run.link else { return nil }
            return AssistantLinks.safeLinks([link.absoluteString]).isEmpty ? run.range : nil
        }
        for range in unsafe { attributed[range].link = nil }
        return attributed
    }
}

/// An assistant reply: prose as text, "; "-joined answers as readable rows.
struct ReplyBody: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(ReplyLayout.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let prose):
                    paragraph(prose)
                case let .list(lead, rows, tail):
                    if let lead { paragraph(lead) }
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                            if index > 0 { Divider().overlay(Color.line) }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ReplyMarkdown.render(row.title)).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                                if let detail = row.detail { Text(detail).font(.subheadline).foregroundStyle(Color.muted) }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10)
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .padding(.horizontal, 14)
                    .plannerCard(padding: 0)
                    if let tail { paragraph(tail) }
                }
            }
        }
        .tint(Color.plannerAccent)
    }

    private func paragraph(_ text: String) -> some View {
        Text(ReplyMarkdown.render(text))
            .font(.body)
            .foregroundStyle(Color.ink)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The reply, or — once something has been applied — a past-tense account of it,
/// with the assistant's own words a tap away (C-05).
struct RequestReplyView: View {
    let run: AssistantRun
    @Environment(PlannerStore.self) private var store
    @State private var showsReply: Bool?

    var body: some View {
        if let result = run.result {
            if let summary = run.appliedSummary(plans: store.plans) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(summary)
                        .font(.body)
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !result.reply.isEmpty {
                        // Answers (lists) stay open; action chatter ("I'll add…") stays tucked away.
                        let answer = ReplyLayout.blocks(result.reply).contains { if case .list = $0 { true } else { false } }
                        DisclosureGroup(isExpanded: Binding(get: { showsReply ?? answer }, set: { showsReply = $0 })) {
                            ReplyBody(text: result.reply).padding(.top, 6)
                        } label: {
                            Text("Reply").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                        }
                        .tint(Color.muted)
                    }
                }
            } else if !result.reply.isEmpty {
                ReplyBody(text: result.reply)
            }
        }
    }
}

/// What the assistant assumed, so a wrong guess is easy to spot.
struct RequestAssumptions: View {
    let assumptions: [String]

    var body: some View {
        if !assumptions.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Label("Assumed", systemImage: "info.circle").font(.subheadline.weight(.semibold))
                ForEach(assumptions, id: \.self) { Text($0).font(.subheadline) }
            }
            .foregroundStyle(Color.ink)
            .plannerCard(.soft, padding: 12)
            .accessibilityElement(children: .combine)
        }
    }
}

/// A request that couldn't finish: what to do next, with Try again (C-06).
struct RequestFailureCard: View {
    let run: AssistantRun
    /// Puts the request back in a composer to reword it.
    var rephrase: ((String) -> Void)?
    /// Called once a retry has been accepted.
    var retried: (() -> Void)?
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Couldn't finish", systemImage: "exclamationmark.triangle.fill")
                    .font(.headline)
                    .foregroundStyle(Color.danger)
                Text(run.failureMessage)
                    .font(.subheadline)
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            HStack(spacing: 8) {
                if run.canRetryFailure {
                    Button {
                        busy = true
                        Task {
                            if await performRequestAction(app, { try await store.retryRequest(run) }) { retried?() }
                            busy = false
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if busy { ProgressView().controlSize(.small).tint(Color.onAccent) } else { Image(systemName: "arrow.clockwise") }
                            Text("Try again")
                        }
                    }
                    .buttonStyle(PlannerButtonStyle(kind: .primary, size: .small))
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                if let rephrase, !run.text.isEmpty {
                    Button("Rephrase", systemImage: "pencil") { rephrase(run.text) }
                        .buttonStyle(.plannerQuiet)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                }
            }
            .disabled(busy)
        }
        .plannerCard()
    }
}

/// Everything the request proposed or did: list items, plans and Household facts.
struct RequestResultItems: View {
    let run: AssistantRun
    /// Section headings on the request screen; none in the composer thread.
    var headings = true

    var body: some View {
        if let result = run.result {
            if !result.items.isEmpty {
                if headings { SectionHeading(result.items.count == 1 ? "Item" : "Items", note: itemNote(result)) }
                ForEach(Array(result.items.enumerated()), id: \.offset) { index, item in
                    ProposedItemCard(run: run, item: item, index: index)
                        .id("\(run.id)-item-\(index)")
                }
            }
            if !result.knowledge.isEmpty {
                if headings { SectionHeading("Household facts") }
                ForEach(Array(result.knowledge.enumerated()), id: \.offset) { index, change in
                    KnowledgeChangeCard(run: run, change: change, index: index)
                }
            }
        }
    }

    private func itemNote(_ result: AssistantResult) -> String? {
        let open = result.items.indices.filter { run.review(for: "item:\($0)") == nil }.count
        return open > 0 ? "\(open) to review" : nil
    }
}

// MARK: Proposed items

/// One assistant item: a direct list add (with Undo), a plan made from it, a past
/// decision, or a proposal awaiting review. Proposals follow the plan decision
/// order: the outcome verb, then Save, then ••• (Edit, Dismiss).
struct ProposedItemCard: View {
    let run: AssistantRun
    let item: AssistantItem
    let index: Int
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(PlannerStore.self) private var store
    @State private var draft: AssistantItem
    @State private var editing = false
    /// The editor opened from "Set time" starts with the time switched on.
    @State private var editorAddsTime = false
    @State private var busy: Action?

    private enum Action: Hashable { case addToList, addToCalendar, setTime, save, setUpGoogle, undo, dismiss }

    init(run: AssistantRun, item: AssistantItem, index: Int) {
        self.run = run; self.item = item; self.index = index
        _draft = State(initialValue: item)
    }

    private var receipt: AssistantReview? { run.review(for: "item:\(index)") }

    var body: some View {
        if let receipt, receipt.automatic == true {
            automatic(receipt)
        } else if let planId = receipt?.planId, store.pendingDismissals[planId] != nil {
            resolvedRow(icon: "eye.slash", text: "\(item.title) · Dismissed")
        } else if let planId = receipt?.planId, let plan = store.plan(planId) {
            RequestPlanCard(plan: plan)
        } else if let planId = receipt?.planId {
            Button { router.open(.plan(planId)) } label: {
                resolvedRow(icon: "calendar", text: "\(item.title) · View plan", opens: true)
            }
            .buttonStyle(.plain)
        } else if let receipt, receipt.state != "draft" {
            resolvedRow(icon: receipt.state == "dismissed" ? "eye.slash" : receipt.state == "calendar" ? "hourglass" : "checkmark.circle",
                        text: "\(item.title) · \(receipt.state == "dismissed" ? "Dismissed" : receipt.state == "calendar" ? "Adding to calendar…" : receipt.state == "saved" ? "Added to \(listName)" : "Saved")")
        } else {
            proposal
        }
    }

    private var listName: String { item.kind == "grocery" ? "Groceries" : "To do" }

    private func automatic(_ receipt: AssistantReview) -> some View {
        HStack(spacing: 12) {
            Image(systemName: receipt.undoneAt == nil ? (item.kind == "grocery" ? "basket.fill" : "checklist") : "arrow.uturn.backward.circle")
                .foregroundStyle(receipt.undoneAt == nil ? Color.plannerAccent : Color.muted)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(receipt.undoneAt == nil ? "Added \(item.title)" : "Undone: \(item.title)")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                Text([item.quantity, listName].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Color.muted)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            if receipt.undoneAt == nil {
                Button {
                    busy = .undo
                    Task {
                        if await performRequestAction(app, { try await store.undoRequestAdds(run, indexes: [index]) }) {
                            announceRequestChange("Removed \(item.title) from \(listName).")
                        }
                        busy = nil
                    }
                } label: {
                    if busy == .undo { ProgressView().controlSize(.small) } else { Text("Undo") }
                }
                .buttonStyle(.plannerQuiet)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.rect)
                .disabled(busy != nil)
                .accessibilityLabel("Undo adding \(item.title)")
            }
        }
        .plannerCard(padding: 12)
        .sensoryFeedback(.impact(weight: .light), trigger: receipt.undoneAt)
    }

    private func resolvedRow(icon: String, text: String, opens: Bool = false) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(opens ? Color.plannerAccent : Color.muted).frame(width: 24).accessibilityHidden(true)
            Text(text).font(.subheadline).foregroundStyle(Color.ink).frame(maxWidth: .infinity, alignment: .leading)
            if opens { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Color.muted).accessibilityHidden(true) }
        }
        .frame(minHeight: 44)
        .plannerCard(.soft, padding: 12)
        .accessibilityElement(children: .combine)
    }

    private var proposal: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Label(kindLabel, systemImage: kindSymbol).font(.caption.weight(.semibold))
                    Spacer()
                    if draft != item { Badge("Edited", style: .neutral) }
                }
                Text(draft.title).font(.headline)
                VStack(alignment: .leading, spacing: 4) {
                    if let when = timeLabel { DetailRow(systemImage: "clock", text: when) }
                    if let quantity = draft.quantity, !quantity.isEmpty { DetailRow(systemImage: "number", text: quantity) }
                    if let location = draft.location, !location.isEmpty { DetailRow(systemImage: "mappin.and.ellipse", text: location) }
                    if let notes = draft.notes, !notes.isEmpty { DetailRow(systemImage: "text.alignleft", text: notes) }
                }
            }
            .accessibilityElement(children: .combine)
            decisionBar
        }
        .plannerCard(.attention)
        .sheet(isPresented: $editing) { AssistantItemEditor(item: $draft, timeZone: store.timeZone, addsTime: editorAddsTime) }
    }

    private var actions: (primary: Action, secondary: Action?) {
        guard draft.kind == "event" else { return (.addToList, nil) }
        guard store.googleReady || store.connection == nil else { return (.save, .setUpGoogle) }
        guard draft.start != nil, draft.end != nil else { return (.setTime, .save) }
        return (.addToCalendar, .save)
    }

    private var decisionBar: some View {
        let actions = actions
        return HStack(spacing: 8) {
            actionButton(actions.primary, prominent: true)
            if let secondary = actions.secondary { actionButton(secondary, prominent: false) }
            Spacer(minLength: 0)
            Menu {
                Button("Edit", systemImage: "pencil") { editorAddsTime = false; editing = true }
                Divider()
                Button("Dismiss", systemImage: "eye.slash", role: .destructive) { decide(.dismiss) }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.plannerAccent)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Suggestion actions")
        }
        .disabled(busy != nil)
    }

    private func actionButton(_ action: Action, prominent: Bool) -> some View {
        Button { tap(action) } label: {
            HStack(spacing: 6) {
                if busy == action { ProgressView().controlSize(.small).tint(prominent ? Color.onAccent : Color.plannerAccent) }
                else if prominent { Image(systemName: symbol(action)) }
                Text(label(action)).lineLimit(1)
            }
        }
        .buttonStyle(PlannerButtonStyle(kind: prominent ? .primary : .quiet, size: .small))
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    private func label(_ action: Action) -> String {
        switch action {
        case .addToList: "Add to \(draft.kind == "grocery" ? "Groceries" : "To do")"
        case .addToCalendar: PlanDecision.Action.addToCalendar.label
        case .setTime: PlanDecision.Action.setTime.label
        case .save: PlanDecision.Action.save.label
        case .setUpGoogle: store.googleSetupLabel
        case .undo: "Undo"
        case .dismiss: "Dismiss"
        }
    }

    private func symbol(_ action: Action) -> String {
        switch action {
        case .addToList: "plus"
        case .addToCalendar: PlanDecision.Action.addToCalendar.systemImage
        case .setTime: PlanDecision.Action.setTime.systemImage
        case .save: PlanDecision.Action.save.systemImage
        case .setUpGoogle: "link"
        case .undo: "arrow.uturn.backward"
        case .dismiss: "eye.slash"
        }
    }

    private var kindLabel: String { draft.kind == "event" ? "Event" : draft.kind == "grocery" ? "Grocery" : "To do" }
    private var kindSymbol: String { draft.kind == "event" ? "calendar" : draft.kind == "grocery" ? "basket" : "checklist" }

    private var timeLabel: String? {
        guard let start = PlannerDates.instant(draft.start) else { return nil }
        let zone = store.timeZone
        var label = "\(TimeLabels.relativeDay(start, in: zone)) · \(TimeLabels.time(start, in: zone))"
        if let end = PlannerDates.instant(draft.end) { label += " – \(TimeLabels.time(end, in: zone))" }
        return draft.kind == "event" ? label : "Due \(label)"
    }

    private func tap(_ action: Action) {
        switch action {
        case .addToList: decide(.save)
        case .addToCalendar: decide(.calendar)
        case .save: decide(.keep)
        case .setTime: editorAddsTime = true; editing = true
        case .setUpGoogle: router.open(.settings)
        case .undo, .dismiss: break
        }
    }

    private func decide(_ choice: AssistantReviewChoice) {
        // An edit can't leave the title blank (the editor won't save it); guard anyway.
        guard choice == .dismiss || !draft.title.trimmingCharacters(in: .whitespaces).isEmpty else { editing = true; return }
        busy = switch choice { case .save: .addToList; case .calendar: .addToCalendar; case .keep: .save; case .dismiss: .dismiss }
        let edited = draft != item && choice != .dismiss ? draft : nil
        let title = draft.title
        let list = draft.kind == "grocery" ? "Groceries" : "To do"
        Task {
            if await performRequestAction(app, { try await store.reviewRequest(run, target: .item, index: index, choice: choice, edited: edited) }) {
                // The card changes in place; VoiceOver hears what happened.
                switch choice {
                case .save: announceRequestChange("Added \(title) to \(list).")
                case .keep: announceRequestChange("Saved \(title).")
                case .calendar: announceRequestChange("Adding \(title) to the household calendar.")
                case .dismiss: announceRequestChange("Dismissed \(title).")
                }
            }
            busy = nil
        }
    }
}

/// A plan made from a request: where it stands and the shared decision bar.
struct RequestPlanCard: View {
    let plan: PlanSummary
    @Environment(Router.self) private var router
    @Environment(PlannerStore.self) private var store

    var body: some View {
        let facts = plan.effectiveFacts
        VStack(alignment: .leading, spacing: 10) {
            Button { router.open(.plan(plan.id)) } label: {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(facts.title).font(.headline).foregroundStyle(Color.ink).multilineTextAlignment(.leading)
                        Text(TimeLabels.plan(facts.time, in: store.timeZone)).font(.subheadline).foregroundStyle(Color.muted)
                        if let location = facts.location, !location.isEmpty { Text(location).font(.subheadline).foregroundStyle(Color.muted) }
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Color.muted)
                        .accessibilityHidden(true)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens plan details")
            PlanStatusLine(plan: plan)
            PlanDecisionBar(plan: plan, style: .regular)
        }
        .plannerCard()
    }
}

// MARK: Household facts

/// A fact the request wants to save or forget. Saved facts offer Undo while the
/// change can still be undone, and Review opens Household facts.
struct KnowledgeChangeCard: View {
    let run: AssistantRun
    let change: AssistantKnowledgeChange
    let index: Int
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(PlannerStore.self) private var store
    @State private var busy = false
    @State private var confirmForget = false
    @State private var undone = false

    private var forgets: Bool { change.operation == "delete" }
    private var title: String { humanKey(change.key) }

    var body: some View {
        let review = run.review(for: "knowledge:\(index)")
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Label(forgets ? "Forget" : "Household fact", systemImage: forgets ? "brain.filled.head.profile" : "brain.head.profile")
                    .font(.caption.weight(.semibold))
                Text(title).font(.headline)
                if let value = change.value, !value.isEmpty { Text(value).font(.subheadline) }
            }
            .foregroundStyle(review == nil ? Color.attentionInk : Color.ink)
            .accessibilityElement(children: .combine)
            if let review {
                resolved(review)
            } else {
                HStack(spacing: 8) {
                    Button(forgets ? "Forget" : "Save to Household facts") {
                        // Forgetting is permanent, so it asks first, like Household facts.
                        if forgets { confirmForget = true } else { decide(.save) }
                    }
                    .buttonStyle(PlannerButtonStyle(kind: .primary, size: .small))
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                    if busy { ProgressView() }
                    Spacer(minLength: 0)
                    Menu {
                        Button("Dismiss", systemImage: "eye.slash", role: .destructive) { decide(.dismiss) }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.plannerAccent)
                            .frame(width: 44, height: 44)
                            .contentShape(.rect)
                    }
                    .accessibilityLabel("Suggestion actions")
                }
                .disabled(busy)
                Label("Only you", systemImage: "lock").font(.caption).foregroundStyle(Color.muted)
            }
        }
        .plannerCard(review == nil ? .attention : .plain)
        .confirmationDialog("Forget “\(title)”?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { decide(.save) }
        } message: {
            Text("The planner stops using it right away and its change history is removed, so this can't be undone. An old email won't bring it back.")
        }
    }

    private func resolved(_ review: AssistantReview) -> some View {
        let dismissed = review.state == "dismissed"
        let status = dismissed ? "Dismissed" : forgets ? "Forgotten" : undone ? "Undone" : "Saved to Household facts"
        return HStack(spacing: 8) {
            Label(status, systemImage: dismissed ? "eye.slash" : undone ? "arrow.uturn.backward" : "checkmark")
                .font(.footnote.weight(.medium)).foregroundStyle(Color.muted)
            Spacer(minLength: 0)
            if !dismissed && !forgets && !undone, let entry = undoableEntry {
                Button("Undo") { undo(entry) }
                    .buttonStyle(.plannerQuiet)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                    .disabled(busy)
                    .accessibilityLabel("Undo saving \(title)")
            }
            if !dismissed {
                Button("Review") { router.open(.knowledge) }
                    .buttonStyle(.plannerQuiet)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                    .accessibilityHint("Opens Household facts")
            }
        }
    }

    /// The change this review made, while it can still be undone (as on Household facts).
    private var undoableEntry: KnowledgeChangeEntry? {
        guard let fact = store.knowledge.first(where: { $0.key == change.key }) else { return nil }
        // Only while this review's save is still the latest change to the fact; a later edit
        // (by hand or another request) must not be reverted from here.
        let entry = store.knowledgeHistory
            .filter { $0.key == change.key }
            .max { $0.createdAt < $1.createdAt }
        guard let entry, entry.origin == "review", entry.resultRevision == fact.revision,
              let until = PlannerDates.instant(entry.undoUntil), until > .now else { return nil }
        return entry
    }

    private func undo(_ entry: KnowledgeChangeEntry) {
        busy = true
        Task {
            if await performRequestAction(app, { try await store.undoKnowledgeChange(entry) }) {
                undone = true
                announceRequestChange("Undid saving \(title).")
            }
            busy = false
        }
    }

    private func decide(_ choice: AssistantReviewChoice) {
        busy = true
        Task {
            if await performRequestAction(app, { try await store.reviewRequest(run, target: .knowledge, index: index, choice: choice) }) {
                announceRequestChange(choice == .dismiss ? "Dismissed \(title)." : forgets ? "Forgot \(title)." : "Saved \(title) to Household facts.")
            }
            busy = false
        }
    }
}

// MARK: Editing

/// Edits an assistant item before saving it. Times are entered in the member's
/// timezone and sent as offset ISO strings; the strict schema needs every key.
struct AssistantItemEditor: View {
    @Binding var item: AssistantItem
    let timeZone: TimeZone
    var addsTime = false
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var quantity = ""
    @State private var location = ""
    @State private var notes = ""
    @State private var hasTime = false
    @State private var start = Date.now
    @State private var end = Date.now.addingTimeInterval(3600)

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                    if item.kind == "grocery" { TextField("Quantity (optional)", text: $quantity) }
                }
                if item.kind == "event" {
                    Section {
                        Toggle("Set a time", isOn: $hasTime.animation())
                        if hasTime {
                            DatePicker("Starts", selection: $start)
                            DatePicker("Ends", selection: $end, in: start...)
                        }
                    } footer: {
                        Text("Times are in \(timeZone.localizedName(for: .generic, locale: .current) ?? timeZone.identifier).")
                    }
                    Section {
                        TextField("Location", text: $location)
                        TextField("Notes", text: $notes, axis: .vertical).lineLimit(3...8)
                    }
                }
            }
            .environment(\.timeZone, timeZone)
            .scrollContentBackground(.hidden)
            .plannerBackground()
            .navigationTitle("Edit \(item.kind == "event" ? "event" : "item")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { save(); dismiss() }
                        .buttonStyle(.glassProminent)
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear(perform: load)
            .onChange(of: start) { _, value in if end <= value { end = value.addingTimeInterval(3600) } }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() {
        title = item.title; quantity = item.quantity ?? ""; location = item.location ?? ""; notes = item.notes ?? ""
        if let s = PlannerDates.instant(item.start) {
            hasTime = true; start = s
            end = PlannerDates.instant(item.end) ?? s.addingTimeInterval(3600)
        } else {
            // Default to the next whole hour in the member's day.
            let calendar = PlannerDates.calendar(timeZone)
            start = calendar.nextDate(after: .now, matching: DateComponents(minute: 0), matchingPolicy: .nextTime) ?? .now
            end = start.addingTimeInterval(3600)
            hasTime = addsTime && item.kind == "event"
        }
    }

    private func save() {
        var next = item
        next.title = title.trimmingCharacters(in: .whitespacesAndNewlines).clipped(utf16: 200)
        if item.kind == "grocery" { next.quantity = quantity.nilIfBlank.map { $0.clipped(utf16: 100) } }
        if item.kind == "event" {
            next.start = hasTime ? PlannerDates.offsetString(start, timeZone: timeZone) : nil
            next.end = hasTime ? PlannerDates.offsetString(max(end, start.addingTimeInterval(60)), timeZone: timeZone) : nil
            next.location = location.nilIfBlank.map { $0.clipped(utf16: 500) }
            next.notes = notes.nilIfBlank.map { $0.clipped(utf16: 1500) }
        }
        item = next
    }
}

/// Server limits are zod `.max(n)`, which counts UTF-16 code units (an emoji is 2+).
/// File-private on purpose; keeps whole Characters.
private extension String {
    func clipped(utf16 limit: Int) -> String {
        guard utf16.count > limit else { return self }
        var result = "", used = 0
        for character in self {
            used += character.utf16.count
            if used > limit { break }
            result.append(character)
        }
        return result
    }
}
