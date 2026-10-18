import FridgedoorKit
import SwiftUI
import UIKit

/// Every assistant request from the last seven days, newest first, grouped by
/// day, searchable, with swipe-to-delete. Answered questions sit on top (web
/// `PlannerArchive history`).
struct RequestHistoryView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(ComposerModel.self) private var composer
    @State private var query = ""
    @State private var pendingDelete: AssistantRun?

    private var runs: [AssistantRun] {
        let sorted = store.runs.sorted { (PlannerDates.instant($0.createdAt) ?? .distantPast) > (PlannerDates.instant($1.createdAt) ?? .distantPast) }
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return sorted }
        return sorted.filter { run in
            let haystack = [run.text, run.result?.reply ?? ""] + (run.result?.items.map(\.title) ?? []) + (run.result?.knowledge.map { "\($0.key) \($0.value ?? "")" } ?? [])
            return haystack.contains { $0.localizedCaseInsensitiveContains(needle) }
        }
    }

    private var answered: [Clarification] { query.isEmpty ? store.clarifications.filter { $0.state == "answered" } : [] }

    private var days: [(label: String, runs: [AssistantRun])] {
        var groups: [(label: String, runs: [AssistantRun])] = []
        for run in runs {
            let label = PlannerDates.instant(run.createdAt).map { TimeLabels.relativeDay($0, in: store.timeZone) } ?? "Earlier"
            if groups.last?.label == label { groups[groups.count - 1].runs.append(run) } else { groups.append((label, [run])) }
        }
        return groups
    }

    var body: some View {
        List {
            if !answered.isEmpty {
                Section("Answered questions") {
                    ForEach(answered) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.question).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                            if let answer = item.answer { Text(answer).font(.subheadline).foregroundStyle(Color.muted) }
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
                .plannerRows()
            }
            ForEach(days, id: \.label) { day in
                Section(day.label) {
                    ForEach(day.runs) { run in
                        NavigationLink(value: Route.request(run.id)) { RequestRow(run: run) }
                            .swipeActions(edge: .trailing) {
                                Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = run }
                            }
                            .swipeActions(edge: .leading) {
                                if run.state == "failed" {
                                    Button("Retry", systemImage: "arrow.clockwise") { retry(run) }.tint(.plannerAccent)
                                }
                            }
                            .contextMenu {
                                Button("Copy request", systemImage: "doc.on.doc") { UIPasteboard.general.string = run.text }
                                Button("Ask again", systemImage: "arrow.uturn.forward") { composer.open(prefill: run.text) }
                                if run.state == "failed" { Button("Retry", systemImage: "arrow.clockwise") { retry(run) } }
                                Divider()
                                Button("Delete request", systemImage: "trash", role: .destructive) { pendingDelete = run }
                            }
                    }
                }
                .plannerRows()
            }
            if !runs.isEmpty {
                Section {} footer: {
                    Text("Private requests are retained for seven days. Saved items and calendar events are kept when a request is deleted.")
                }
            }
        }
        .plannerList()
        .overlay { emptyState }
        .navigationTitle("Requests")
        .searchable(text: $query, prompt: "Search requests")
        .refreshable { await store.refresh([.runs, .plans, .clarifications]) }
        .confirmationDialog("Delete this request?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible, presenting: pendingDelete) { run in
            Button("Delete request", role: .destructive) { delete(run) }
        } message: { _ in
            Text("Saved items and calendar events are kept.")
        }
    }

    @ViewBuilder private var emptyState: some View {
        if runs.isEmpty && answered.isEmpty {
            if !store.hasLoaded {
                ProgressView()
            } else if let error = store.refreshError, store.runs.isEmpty {
                ErrorBanner(message: error.userMessage) { Task { await store.refresh([.runs]) } }.padding(20)
            } else if !query.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                EmptyState(systemImage: "sparkles", title: "No requests yet", message: "Ask the planner from the bar below. Requests are kept for seven days.")
                    .padding(20)
            }
        }
    }

    private func retry(_ run: AssistantRun) {
        Task { if await performRequestAction(app, { try await store.retryRequest(run) }) { announceRequestChange("Trying again.") } }
    }

    private func delete(_ run: AssistantRun) {
        Task { if await performRequestAction(app, { try await store.deleteRequest(run) }) { app.show("Request deleted.") } }
    }
}

/// Requests row: a short title, the request as typed underneath (C-11), status
/// chips and time.
struct RequestRow: View {
    let run: AssistantRun
    @Environment(PlannerStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if run.captureId != nil { Image(systemName: "paperclip").font(.caption).foregroundStyle(Color.muted).accessibilityLabel("With attachment") }
                Text(run.shortTitle).font(.body.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(2)
                Spacer(minLength: 4)
                if let date = PlannerDates.instant(run.createdAt) {
                    Text(TimeLabels.time(date, in: store.timeZone)).font(.caption).foregroundStyle(Color.muted)
                }
            }
            if let prompt = run.promptSubtitle {
                Text(prompt).font(.subheadline).foregroundStyle(Color.muted).lineLimit(2)
            }
            RequestStatusChips(run: run, limit: 3)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
