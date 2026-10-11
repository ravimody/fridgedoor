import FridgedoorKit
import SwiftUI

// Rows and cards used by `PlanDetailView`. Each is a pure function of its inputs plus
// closures; network work stays in the detail view.

/// A card of compact rows separated by hairlines (Plan detail's facts, reminders, source).
struct PlanFactCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(rows) { row in
                    if row.id != rows.first?.id {
                        Divider().overlay(Color.line).padding(.leading, 52)
                    }
                    row
                }
            }
        }
        .plannerCard(padding: 0)
    }
}

/// One compact fact: icon, value, optional meta line, optional trailing accessory.
/// Always at least 44pt tall, so a whole row can be a tap target.
struct PlanFactRow<Trailing: View>: View {
    let systemImage: String
    let text: String
    var secondary: String?
    var trailing: Trailing

    init(systemImage: String, text: String, secondary: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.systemImage = systemImage; self.text = text; self.secondary = secondary; self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(Color.muted)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(text).foregroundStyle(Color.ink)
                if let secondary {
                    Text(secondary).font(.subheadline).foregroundStyle(Color.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .multilineTextAlignment(.leading)
            trailing
        }
        .font(.body)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(.rect)
    }
}

extension PlanFactRow where Trailing == EmptyView {
    init(systemImage: String, text: String, secondary: String? = nil) {
        self.init(systemImage: systemImage, text: text, secondary: secondary) { EmptyView() }
    }
}

/// Trailing "value ›" for a row that opens something.
struct PlanRowDisclosure: View {
    var value: String?
    var emphasized = false

    var body: some View {
        HStack(spacing: 4) {
            if let value {
                Text(value)
                    .font(emphasized ? .body.weight(.semibold) : .body)
                    .foregroundStyle(emphasized ? Color.plannerAccent : Color.muted)
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(emphasized ? Color.plannerAccent : Color.muted)
                .accessibilityHidden(true)
        }
    }
}

/// Google Calendar write status, shown only while it's in progress or needs you.
/// Never says "Added" until the server reports `succeeded`; the decision bar holds the fix.
struct CalendarStatusCard: View {
    let action: CalendarActionRef

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if action.isInFlight {
                ProgressView()
            } else {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.danger).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.weight(.semibold)).contentTransition(.opacity)
                Text(detail).font(.subheadline).foregroundStyle(Color.muted)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
        .plannerCard(action.isInFlight ? .soft : .plain)
        .animation(.snappy, value: action.state)
    }

    private var title: String {
        if action.isInFlight { return action.state == "reconciling" ? "Checking with Google Calendar…" : "Waiting for Google Calendar" }
        switch action.state {
        case "conflict": return "Changed in Google Calendar"
        case "needs_reauth": return "Google needs reconnecting"
        case "canceled": return "Calendar change canceled"
        default: return "Google Calendar didn't confirm"
        }
    }

    private var detail: String {
        if action.isInFlight { return "You can leave this screen. It keeps going." }
        return action.guidance ?? "Nothing was changed in Google Calendar."
    }
}

/// Current vs. proposed details when an update is waiting (`pendingFacts`). The diff
/// only: the decision bar holds Apply update and Review.
struct PendingUpdateCard: View {
    let plan: PlanSummary
    let zone: TimeZone

    var body: some View {
        if let pending = plan.pendingFacts {
            let changes = pending.changedFields(from: plan.facts)
            let isCancel = plan.changeKind == "cancel"
            VStack(alignment: .leading, spacing: 12) {
                Text(isCancel ? "Cancellation suggested" : "Update pending")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Text(isCancel
                     ? "A newer message says this was canceled."
                     : plan.hasCalendarEvent ? "Google Calendar still shows the earlier details." : "A newer message changed this plan.")
                    .font(.subheadline)
                ForEach(changes, id: \.self) { field in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(field.label).font(.caption.weight(.semibold))
                        Text(value(field, plan.facts))
                            .strikethrough()
                            .accessibilityLabel("Was \(value(field, plan.facts))")
                        Text(value(field, pending))
                            .fontWeight(.semibold)
                            .accessibilityLabel("Now \(value(field, pending))")
                    }
                    .font(.subheadline)
                }
                if changes.isEmpty && !isCancel {
                    Text("No visible differences.").font(.subheadline)
                }
            }
            .plannerCard(.attention)
        }
    }

    private func value(_ field: PlanFacts.Field, _ facts: PlanFacts) -> String {
        switch field {
        case .title: facts.title
        case .time: TimeLabels.plan(facts.time, in: zone)
        case .location: facts.location ?? "No location"
        case .participants: facts.participants.isEmpty ? "No one listed" : facts.participants.formatted(.list(type: .and))
        case .category: PlanText.categoryLabel(facts.category)
        case .notes: facts.notes ?? "No notes"
        case .preparationTasks: facts.preparationTasks.isEmpty ? "None" : facts.preparationTasks.joined(separator: "; ")
        }
    }
}

/// The source email in one row (`GET /plans/:id/evidence`, owner only): sender and first
/// line, private to you. Tap to read the whole message.
struct PlanSourceRow: View {
    enum Phase: Equatable { case loading, loaded(Evidence), notVisible, failed }
    let state: Phase
    var retry: () -> Void

    @State private var expanded = false

    var body: some View {
        switch state {
        case .loading:
            PlanFactRow(systemImage: "envelope", text: "Source email") { ProgressView() }
        case .failed:
            PlanFactRow(systemImage: "envelope", text: "The source email couldn't be loaded") {
                Button("Retry", action: retry)
                    .font(.body.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
            }
        case .notVisible:
            PlanFactRow(systemImage: "envelope", text: "From someone else's email", secondary: "Only they can see the original.")
        case .loaded(let evidence):
            if evidence.availability == "available" {
                available(evidence)
            } else {
                PlanFactRow(systemImage: "clock.badge.xmark", text: Self.unavailableCopy(evidence.availability))
            }
        }
    }

    @ViewBuilder
    private func available(_ evidence: Evidence) -> some View {
        let text = evidence.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let firstLine = text.split(whereSeparator: \.isNewline).first.map { String($0).trimmingCharacters(in: .whitespaces) }
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                PlanFactRow(systemImage: "envelope", text: evidence.sender ?? "Source email", secondary: firstLine.map { "“\($0)”" }) {
                    HStack(spacing: 10) {
                        Label("Only you", systemImage: "lock")
                            .font(.caption)
                            .foregroundStyle(Color.muted)
                        if !text.isEmpty {
                            Image(systemName: "chevron.down")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Color.muted)
                                .rotationEffect(.degrees(expanded ? 180 : 0))
                                .accessibilityHidden(true)
                        }
                    }
                }
                .lineLimit(expanded ? nil : 1)
            }
            .buttonStyle(.plain)
            .disabled(text.isEmpty)
            .accessibilityHint(text.isEmpty ? "" : expanded ? "Hides the message" : "Shows the whole message")
            if expanded && !text.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if !evidence.labels.isEmpty {
                        PlanFlowLayout(spacing: 6) {
                            ForEach(evidence.labels, id: \.self) { Badge(Self.labelName($0)) }
                        }
                    }
                    Text(text)
                        .font(.callout)
                        .foregroundStyle(Color.ink)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Color.soft, in: .rect(cornerRadius: 12))
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            }
        }
    }

    static func unavailableCopy(_ availability: String) -> String {
        switch availability {
        case "expired": "The original email has expired from the planner's private store."
        case "deleted": "The original was deleted, or its Google connection changed."
        case "incomplete": "Only part of the original could be kept, so it isn't shown."
        default: "The original source is unavailable."
        }
    }

    static func labelName(_ label: String) -> String {
        let trimmed = label.hasPrefix("CATEGORY_") ? String(label.dropFirst("CATEGORY_".count)) : label
        return PlanText.categoryLabel(trimmed)
    }
}

/// History in one row: the latest change, tap for the full log (`GET /plans/:id/history`).
struct PlanHistoryRow: View {
    let entries: [HistoryEntry]?
    let failed: Bool
    let zone: TimeZone
    /// Who did it, in household words ("From email", "You", "Sam").
    let actor: (HistoryEntry) -> String
    var retry: () -> Void

    @State private var expanded = false
    private let symbol = "clock.arrow.circlepath"

    var body: some View {
        if failed {
            PlanFactRow(systemImage: symbol, text: "History couldn't be loaded") {
                Button("Retry", action: retry)
                    .font(.body.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
            }
        } else if let entries, let latest = entries.first {
            VStack(alignment: .leading, spacing: 0) {
                Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                    PlanFactRow(systemImage: symbol, text: "History", secondary: summary(latest)) {
                        Image(systemName: "chevron.down")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.muted)
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                            .accessibilityHidden(true)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityHint(expanded ? "Hides the full history" : "Shows the full history")
                if expanded {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(entries) { entry in line(entry) }
                    }
                    .padding(.leading, 52)
                    .padding(.trailing, 16)
                    .padding(.bottom, 12)
                }
            }
        } else if entries != nil {
            PlanFactRow(systemImage: symbol, text: "History", secondary: "Nothing yet")
        } else {
            PlanFactRow(systemImage: symbol, text: "History") { ProgressView() }
        }
    }

    /// "Suggested yesterday · From email".
    private func summary(_ entry: HistoryEntry) -> String {
        guard let date = PlannerDates.instant(entry.createdAt) else { return "\(entry.readableLabel) · \(actor(entry))" }
        return "\(entry.readableLabel) \(TimeLabels.relativeDayInSentence(date, in: zone, preposition: "on")) · \(actor(entry))"
    }

    private func line(_ entry: HistoryEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: Self.symbol(for: entry))
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .frame(width: 18)
                .accessibilityHidden(true)
            Text("\(Text(entry.readableLabel).foregroundStyle(Color.ink))\(Text(" · \(actor(entry)) · \(stamp(entry.createdAt))").foregroundStyle(Color.muted))")
                .font(.subheadline)
        }
        .accessibilityElement(children: .combine)
    }

    /// DESIGN.md symbols where they differ from FridgedoorKit's defaults.
    private static func symbol(for entry: HistoryEntry) -> String {
        entry.type == "suggestion_dismissed" ? "eye.slash" : entry.systemImage
    }

    private func stamp(_ iso: String) -> String {
        guard let date = PlannerDates.instant(iso) else { return "" }
        return "\(TimeLabels.relativeDay(date, in: zone)), \(TimeLabels.time(date, in: zone))"
    }
}

/// Reminder offsets in words ("1 hour before").
enum ReminderText {
    static func offsetLabel(_ minutes: Int) -> String {
        let value = abs(minutes)
        let amount = value % 1440 == 0 ? "\(value / 1440) day\(value == 1440 ? "" : "s")" : value % 60 == 0 ? "\(value / 60) hour\(value == 60 ? "" : "s")" : "\(value) minutes"
        return minutes <= 0 ? "\(amount) before" : "\(amount) after"
    }
}
