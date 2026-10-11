import FridgedoorKit
import SwiftUI
import UIKit

/// One assistant request: what was asked, its processing state, the reply (or a
/// past-tense account once applied), and per-item review. Mirrors the web
/// `RequestDetail` / `Request` components.
struct RequestDetailView: View {
    let runId: String
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(ComposerModel.self) private var composer
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var showDetails = false

    var body: some View {
        Group {
            if let run = store.assistantRun(runId) {
                content(run)
            } else if !store.hasLoaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    EmptyState(systemImage: "clock.badge.xmark", title: "This request is unavailable", message: "Requests expire after seven days; saved items remain on Home.")
                        .padding(20)
                }
            }
        }
        .plannerBackground()
        .navigationTitle("Request")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh([.runs, .plans, .todos, .groceries, .connection, .destination]) }
    }

    private func content(_ run: AssistantRun) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(run)
                state(run)
                if let result = run.result { resultSections(run, result) }
                detailsSection(run)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 32)
            .animation(.snappy, value: run)
        }
        .toolbar { toolbar(run) }
        .confirmationDialog("Delete this request?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete request", role: .destructive) { delete(run) }
        } message: {
            Text("Saved items and calendar events are kept.")
        }
        .sensoryFeedback(.success, trigger: run.isWorking) { was, now in was && !now && run.state == "succeeded" }
    }

    // MARK: Sections

    private func header(_ run: AssistantRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Eyebrow("You asked")
                if let date = PlannerDates.instant(run.createdAt) {
                    Text("\(TimeLabels.relativeDay(date, in: store.timeZone)) · \(TimeLabels.time(date, in: store.timeZone))")
                        .font(.caption).foregroundStyle(Color.muted)
                }
            }
            Text(run.text.isEmpty ? "Photo or PDF" : run.text)
                .font(.serif(.title2))
                .foregroundStyle(Color.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if run.captureId != nil {
                Label("Photo or PDF attached", systemImage: "paperclip").font(.footnote).foregroundStyle(Color.muted)
            }
        }
        .padding(.top, 8)
    }

    @ViewBuilder private func state(_ run: AssistantRun) -> some View {
        if run.isWorking {
            HStack(spacing: 12) {
                ProgressView()
                VStack(alignment: .leading, spacing: 2) {
                    Text(run.state == "queued" ? "Waiting to start…" : "Working on it…").font(.headline)
                    Text("You can leave this screen; the planner keeps going.").font(.footnote).foregroundStyle(Color.muted)
                }
            }
            .plannerCard(.soft)
            .accessibilityElement(children: .combine)
        } else if run.state == "failed" {
            RequestFailureCard(run: run) { composer.open(prefill: $0) }
        } else {
            RequestStatusChips(run: run)
        }
    }

    @ViewBuilder private func resultSections(_ run: AssistantRun, _ result: AssistantResult) -> some View {
        RequestReplyView(run: run)
        RequestAssumptions(assumptions: result.assumptions)
        RequestResultItems(run: run)

        if run.canApplyAll && result.items.count + result.knowledge.count > 1 {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    busy = true
                    Task {
                        if await performRequestAction(app, { try await store.applyRequest(run) }) { app.show("Saved everything. Plans still need Add to calendar.") }
                        busy = false
                    }
                } label: { Label("Save all", systemImage: "tray.and.arrow.down").frame(maxWidth: .infinity) }
                    .buttonStyle(.plannerSecondary)
                    .disabled(busy)
                Text("Adds list items, saves events as private plans and saves Household facts. Nothing goes on the calendar.")
                    .font(.caption).foregroundStyle(Color.muted)
            }
        }

        if !result.followups.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeading("Ask a follow-up")
                FlowChips(items: result.followups) { composer.open(prefill: $0) }
            }
        }

        let links = run.sourceLinks
        if !links.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SectionHeading("Sources")
                ForEach(links, id: \.self) { url in
                    Link(destination: url) {
                        Label(url.host() ?? url.absoluteString, systemImage: "safari")
                            .font(.subheadline)
                            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                    }
                    .foregroundStyle(Color.plannerAccent)
                }
            }
        }

        feedback(run)
    }

    private func feedback(_ run: AssistantRun) -> some View {
        HStack(spacing: 10) {
            Text("Was this helpful?").font(.subheadline).foregroundStyle(Color.muted)
            Spacer()
            feedbackButton(run, .helpful, title: "Helpful", symbol: "hand.thumbsup")
            feedbackButton(run, .needsWork, title: "Needs work", symbol: "hand.thumbsdown")
        }
        .padding(.top, 8)
    }

    private func feedbackButton(_ run: AssistantRun, _ value: AssistantFeedback, title: String, symbol: String) -> some View {
        let selected = run.feedback == value.rawValue
        return Button {
            busy = true
            Task {
                if await performRequestAction(app, { try await store.requestFeedback(run, value) }) { app.show("Thanks for the feedback.") }
                busy = false
            }
        } label: {
            Image(systemName: selected ? "\(symbol).fill" : symbol)
                .frame(width: 44, height: 44)
                .background(selected ? Color.plannerAccent.opacity(0.15) : Color.soft, in: .circle)
        }
        .foregroundStyle(Color.plannerAccent)
        .disabled(busy || selected)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .sensoryFeedback(.selection, trigger: selected)
    }

    private func detailsSection(_ run: AssistantRun) -> some View {
        DisclosureGroup(isExpanded: $showDetails) {
            VStack(alignment: .leading, spacing: 8) {
                Text(run.text.isEmpty ? "Photo or PDF" : run.text).font(.footnote).foregroundStyle(Color.ink).textSelection(.enabled)
                Text("Run \(run.id)").font(.caption.monospaced()).foregroundStyle(Color.muted).textSelection(.enabled)
                if let metrics = run.metrics {
                    Text("\(metrics.model) · \((Double(metrics.durationMs) / 1000).formatted(.number.precision(.fractionLength(1))))s")
                        .font(.caption).foregroundStyle(Color.muted)
                }
                Button("Delete request", systemImage: "trash", role: .destructive) { confirmDelete = true }
                    .buttonStyle(PlannerButtonStyle(kind: .destructive, size: .small))
                    .disabled(busy)
                Text("Saved items and calendar events are kept. Private requests are retained for seven days.")
                    .font(.caption).foregroundStyle(Color.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
        } label: {
            Text("Request details").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
        }
        .tint(Color.muted)
        .padding(.top, 12)
    }

    // MARK: Toolbar & actions

    @ToolbarContentBuilder private func toolbar(_ run: AssistantRun) -> some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Copy request", systemImage: "doc.on.doc") { UIPasteboard.general.string = run.text }
                if let reply = run.result?.reply, !reply.isEmpty {
                    Button("Copy reply", systemImage: "text.bubble") { UIPasteboard.general.string = reply }
                    ShareLink(item: reply) { Label("Share reply", systemImage: "square.and.arrow.up") }
                }
                Button("Ask a follow-up", systemImage: "arrowshape.turn.up.left") { composer.open() }
                Divider()
                Button("Delete request", systemImage: "trash", role: .destructive) { confirmDelete = true }
            } label: {
                Label("Request actions", systemImage: "ellipsis")
            }
        }
    }

    private func delete(_ run: AssistantRun) {
        dismiss()
        Task {
            if await performRequestAction(app, { try await store.deleteRequest(run) }) { app.show("Request deleted.") }
        }
    }
}
