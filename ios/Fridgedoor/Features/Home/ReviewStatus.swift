import FridgedoorKit
import SwiftUI

/// One quiet line about the daily brief: when it was prepared, or which
/// channel is incomplete (size limit, delayed sync, unavailable data). Tap for
/// details and Refresh. Coverage notices are kept separate from household actions.
struct ReviewStatusLine: View {
    let overview: DailyView
    @Environment(PlannerStore.self) private var store
    @Environment(HomeState.self) private var home
    @State private var showDetails = false

    var body: some View {
        Button { showDetails = true } label: {
            HStack(spacing: 8) {
                if isUpdating {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: incomplete.isEmpty ? "checkmark.seal" : "exclamationmark.circle")
                        .foregroundStyle(incomplete.isEmpty ? Color.muted : Color.warning)
                }
                Text(summary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
            }
            .font(.footnote)
            .foregroundStyle(Color.muted)
            .padding(.vertical, 6)
            .padding(.horizontal, 12)
            .background(Color.soft.opacity(0.7), in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows brief details")
        .sheet(isPresented: $showDetails) { ReviewDetailsSheet() }
    }

    private var isUpdating: Bool { home.refreshingReview || overview.errorCode == "DAILY_OVERVIEW_UPDATING" }
    private var incomplete: [DailyCoverage] { overview.incompleteCoverage }

    private var summary: String {
        if isUpdating { return "Updating your brief…" }
        if !incomplete.isEmpty { return incomplete.map(\.shortNotice).joined(separator: " · ") }
        if overview.state == "fallback" { return "Daily brief is off" }
        if let generated = PlannerDates.instant(overview.generatedAt) {
            return "Brief · \(TimeLabels.time(generated, in: store.timeZone))"
        }
        return "Brief details"
    }
}

struct ReviewDetailsSheet: View {
    @Environment(PlannerStore.self) private var store
    @Environment(HomeState.self) private var home
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let overview = store.dailyOverview {
                    Section {
                        if let generated = PlannerDates.instant(overview.generatedAt) {
                            LabeledContent("Prepared", value: TimeLabels.dateTime(generated, in: store.timeZone))
                        } else {
                            LabeledContent("Prepared", value: overview.state == "fallback" ? "Daily brief is off" : "Not yet")
                        }
                        if overview.state == "unavailable", let summary = overview.result?.summary {
                            Text(summary).font(.subheadline).foregroundStyle(Color.muted)
                        }
                    }
                    if let coverage = overview.coverage, !coverage.isEmpty {
                        Section("What it checked") {
                            ForEach(coverage, id: \.channel) { entry in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Label(entry.channel.capitalized, systemImage: entry.symbol)
                                            .foregroundStyle(Color.ink)
                                        Spacer()
                                        Text(entry.statusLabel)
                                            .font(.subheadline)
                                            .foregroundStyle(entry.isIncomplete ? Color.warning : Color.muted)
                                    }
                                    if let notice = entry.longNotice {
                                        Text(notice).font(.footnote).foregroundStyle(Color.muted)
                                    }
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                    Section {
                        if store.dailySettings?.enabled == true {
                            Button {
                                home.refreshReview()
                            } label: {
                                HStack {
                                    Label(isUpdating ? "Updating…" : "Refresh brief", systemImage: "arrow.clockwise")
                                    Spacer()
                                    if isUpdating { ProgressView() }
                                }
                            }
                            .disabled(isUpdating)
                        } else {
                            Button("Turn on the daily brief in Settings", systemImage: "gearshape") {
                                dismiss()
                                router.open(.settings)
                            }
                        }
                    } footer: {
                        Text("Dismissing an item only hides it from today's brief. To change what becomes a suggestion, use Teach suggestions in Settings.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.paper)
            .navigationTitle("Daily brief")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done", role: .confirm) { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Color.paper)
    }

    private var isUpdating: Bool { home.refreshingReview || store.dailyOverview?.errorCode == "DAILY_OVERVIEW_UPDATING" }
}

extension DailyView {
    var incompleteCoverage: [DailyCoverage] { (coverage ?? []).filter(\.isIncomplete) }
}

extension DailyCoverage {
    var isIncomplete: Bool { ["stale", "unavailable", "truncated"].contains(status) }

    var shortNotice: String {
        let name = channel.prefix(1).uppercased() + channel.dropFirst()
        return "\(name): " + (status == "truncated" ? "brief limit reached" : status == "stale" ? "sync delayed" : "data unavailable")
    }

    var statusLabel: String {
        switch status {
        case "fresh": "Up to date"
        case "stale": "Sync delayed"
        case "truncated": "Limit reached"
        case "unavailable": "Unavailable"
        case "disabled": "Not connected"
        default: status.capitalized
        }
    }

    var longNotice: String? {
        switch status {
        case "truncated": "\(omittedCount ?? 0) \(channel) items were outside the brief’s size limit."
        case "stale": "The last \(channel) sync is older than expected; recent changes may be missing."
        case "unavailable": "\(channel.prefix(1).uppercased() + channel.dropFirst()) data could not be loaded for this brief."
        default: nil
        }
    }

    var symbol: String {
        switch channel {
        case "calendar": "calendar"
        case "email": "envelope"
        case "plans": "tray.full"
        case "tasks": "checklist"
        case "reminders": "bell"
        case "knowledge": "books.vertical"
        default: "circle.dashed"
        }
    }
}
