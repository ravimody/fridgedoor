import FridgedoorKit
import SwiftUI

/// Home's "Decisions": everything waiting on you, as compact rows with one action
/// each (DESIGN.md → Decisions). Finite: a few rows, then "Show N more"; when the
/// queue is empty it says so in one line instead of showing a section.
struct DecisionsSection: View {
    let snapshot: HomeSnapshot
    @State private var expanded = false

    private static let collapsedCount = 3

    private var rows: [DecisionItem] {
        snapshot.attention.map(DecisionItem.review) + snapshot.clarifications.map(DecisionItem.question) + snapshot.pendingRequests.map(DecisionItem.request)
    }

    var body: some View {
        let rows = rows
        if rows.isEmpty {
            Label("No decisions waiting", systemImage: "checkmark.circle")
                .font(.subheadline)
                .foregroundStyle(Color.muted)
                .padding(.top, 14)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HomeModuleHeading(title: "Decisions", note: rows.count == 1 ? "1 waiting" : "\(rows.count) waiting")
                VStack(spacing: 0) {
                    let visible = expanded ? rows : Array(rows.prefix(Self.collapsedCount))
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, row in
                        switch row {
                        case .review(let item): DecisionRow(item: item)
                        case .question(let clarification): QuestionRow(clarification: clarification)
                        case .request(let run): RequestDecisionRow(run: run)
                        }
                        if index < visible.count - 1 || rows.count > Self.collapsedCount {
                            Divider().overlay(Color.line).padding(.leading, 58)
                        }
                    }
                    if rows.count > Self.collapsedCount {
                        Button {
                            withAnimation(.snappy) { expanded.toggle() }
                        } label: {
                            Text(expanded ? "Show fewer" : "Show \(rows.count - Self.collapsedCount) more")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.plannerAccent)
                    }
                }
                .background(Color.card, in: .rect(cornerRadius: 18, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line, lineWidth: 1) }
                .clipShape(.rect(cornerRadius: 18, style: .continuous))
                .animation(.smooth, value: rows.map(\.id))
            }
        }
    }
}

private enum DecisionItem: Identifiable {
    case review(DailyOverviewItem)
    case question(Clarification)
    case request(AssistantRun)

    var id: String {
        switch self {
        case .review(let item): "review:\(item.id)"
        case .question(let clarification): "question:\(clarification.id)"
        case .request(let run): "request:\(run.id)"
        }
    }
}

/// Something you asked the planner that came back with proposals to decide on.
private struct RequestDecisionRow: View {
    let run: AssistantRun
    @Environment(PlannerStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        Button { router.open(.request(run.id)) } label: {
            HStack(alignment: .top, spacing: 12) {
                DecisionGlyph(systemImage: "sparkles")
                VStack(alignment: .leading, spacing: 3) {
                    Text(store.reviewTitle(for: run))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.ink)
                        .multilineTextAlignment(.leading)
                    Text(["From your request", store.reviewLabel(for: run)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(Color.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text("Review")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.plannerAccent)
                    .frame(minHeight: 32)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(Color.card)
        .accessibilityHint("Opens the request")
    }
}

/// The leading teal glyph shared by decision rows.
private struct DecisionGlyph: View {
    let systemImage: String
    var body: some View {
        Image(systemName: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.attentionInk)
            .frame(width: 32, height: 32)
            .background(Color.attention, in: .circle)
            .accessibilityHidden(true)
    }
}

/// A morning-review decision: a plan to decide, a deadline, or a to-do that's due.
private struct DecisionRow: View {
    let item: DailyOverviewItem
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(HomeState.self) private var home

    private var plan: PlanSummary? { item.planTargetId.flatMap(store.plan) }
    private var tasks: [ListItem] {
        (item.targets ?? []).filter { $0.kind == "task" }.compactMap { target in store.todos.first { $0.id == target.id && !$0.isCompleted } }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            DecisionGlyph(systemImage: item.categorySymbol)
            VStack(alignment: .leading, spacing: 8) {
                Button(action: open) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.displayTitle)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.ink)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(Color.muted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint(item.isTask ? "Opens To do" : "Opens details")
                if let plan {
                    PlanDecisionBar(plan: plan, style: .regular)
                } else if !tasks.isEmpty {
                    ForEach(tasks) { TaskActionsRow(task: $0) }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color.card)
        .overlay { if home.isBusy("review:\(item.id)") { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(12) } }
        .contextMenu { menu }
        .swipeToDismiss(enabled: !item.isTask, cornerRadius: 0) { dismiss() }
        .accessibilityElement(children: .contain)
    }

    /// When and why, in one or two short lines ("Fri, Oct 16 · Needs a start time").
    private var subtitle: String {
        var parts: [String] = []
        let decision = plan.map { store.decision(for: $0) }
        if decision?.primary == .setTime, let day = HomeSchedule.start(item.normalizedTime, in: store.timeZone) {
            // The status already says the time is missing; just name the day.
            parts.append(TimeLabels.relativeDay(day, in: store.timeZone))
        } else if let time = HomeTime.review(item.normalizedTime, in: store.timeZone) {
            parts.append(time)
        }
        if let decision { parts.append(decision.status) }
        else if !item.detail.isEmpty, item.detail != item.displayTitle { parts.append(item.detail) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var menu: some View {
        Button(item.isTask ? "Open To do" : "Open details", systemImage: item.isTask ? "checklist" : "info.circle", action: open)
        if let draft = CalendarDraft(title: item.displayTitle, time: item.normalizedTime) {
            Button("Add to Apple Calendar", systemImage: "square.and.arrow.up.on.square") { home.calendarDraft = draft }
        }
        ShareLink(item: shareText(title: item.displayTitle, time: item.normalizedTime, location: plan?.facts.location, zone: store.timeZone)) {
            Label("Share", systemImage: "square.and.arrow.up")
        }
        if !item.isTask {
            Divider()
            Button("Dismiss", systemImage: "eye.slash", role: .destructive) { dismiss() }
        }
    }

    /// An open plan is dismissed itself (with Undo); anything else only leaves the brief.
    private func dismiss() {
        if let plan, plan.calendarAction == nil, !plan.isClosed { store.dismissWithUndo(plan, app: app) } else { home.dismiss(item) }
    }

    private func open() {
        if let id = item.planTargetId { router.open(.plan(id)) } else if item.isTask { router.tab = .todo }
    }
}

/// An open clarification. "Answer" reveals a short field in place.
private struct QuestionRow: View {
    let clarification: Clarification
    @Environment(HomeState.self) private var home
    @State private var answering = false
    @State private var answer = ""
    @FocusState private var focused: Bool

    private var busy: Bool { home.isBusy("clarification:\(clarification.id)") }
    private var trimmed: String { answer.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            DecisionGlyph(systemImage: "questionmark.bubble")
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(clarification.question)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(clarification.reason)
                        .font(.caption)
                        .foregroundStyle(Color.muted)
                        .lineLimit(answering ? nil : 2)
                }
                .accessibilityElement(children: .combine)
                if answering {
                    TextField("Your answer", text: $answer, axis: .vertical)
                        .lineLimit(1...4)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(save)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(Color.paper, in: .rect(cornerRadius: 12, style: .continuous))
                        .onChange(of: answer) { _, value in if value.utf16.count > 500 { answer = value.prefix(utf16Count: 500) } }
                        .disabled(busy)
                }
                HStack(spacing: 8) {
                    if answering {
                        Button("Save answer", action: save)
                            .buttonStyle(PlannerButtonStyle(kind: .primary, size: .small))
                            .disabled(busy || trimmed.isEmpty)
                    } else {
                        Button("Answer") { answering = true; focused = true }
                            .buttonStyle(PlannerButtonStyle(kind: .primary, size: .small))
                    }
                    Spacer(minLength: 0)
                    if busy { ProgressView().controlSize(.small) }
                    Menu {
                        Button("Dismiss question", systemImage: "eye.slash", role: .destructive) { home.dismiss(clarification) }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.plannerAccent)
                            .frame(width: 44, height: 44)
                            .contentShape(.rect)
                    }
                    .accessibilityLabel("Question actions")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color.card)
        .contextMenu {
            Button("Dismiss question", systemImage: "eye.slash", role: .destructive) { home.dismiss(clarification) }
        }
        .accessibilityAction(named: "Dismiss question") { home.dismiss(clarification) }
    }

    private func save() {
        guard !trimmed.isEmpty else { return }
        focused = false
        Task { if await home.answer(clarification, text: trimmed) { answer = ""; answering = false } }
    }
}

/// Serif module heading with a quiet trailing note (Home's sections).
struct HomeModuleHeading: View {
    let title: String
    var note: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.serif(.title2)).foregroundStyle(Color.ink).accessibilityAddTraits(.isHeader)
            Spacer()
            if let note { Text(note).font(.caption).foregroundStyle(Color.muted) }
        }
        .padding(.top, 28)
        .padding(.bottom, 10)
    }
}
