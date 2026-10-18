import FridgedoorKit
import SwiftUI

/// Household facts: private, revisioned facts the planner uses, with suggested updates,
/// change history and Revert (`docs/features/household-facts.md`).
struct KnowledgeView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @State private var query = ""
    @State private var editing: KnowledgeEditorSheet.Target?
    @State private var forgetting: KnowledgeFact?
    @State private var confirmDisableAssistant = false
    @State private var busyIds: Set<String> = []
    @State private var feedback = 0

    static let limit = 50
    /// The fact count stays hidden until it's close enough to the limit to matter.
    static let showCountFrom = 40

    var body: some View {
        List {
            if !store.hasLoaded && store.knowledge.isEmpty {
                Section { HStack { Spacer(); ProgressView(); Spacer() } }.listRowBackground(Color.clear)
            } else {
                if let error = store.refreshError, store.knowledge.isEmpty {
                    Section { ErrorBanner(message: error.userMessage) { Task { await refresh() } } }
                        .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
                if !pendingProposals.isEmpty && query.isEmpty { proposalsSection }
                factsSection
                if !store.knowledgeHistory.isEmpty && query.isEmpty { historySection }
                if store.assistantSettings?.consent == true && query.isEmpty {
                    Section {
                        Button("Turn off Ask the planner for my account", role: .destructive) { confirmDisableAssistant = true }
                            .frame(maxWidth: .infinity, minHeight: 44)
                    } footer: {
                        Text("Stops new requests. Your facts stay until you forget them.")
                    }
                    .plannerRows()
                }
            }
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Household facts")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "School, food, names…")
        .refreshable { await refresh() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add fact", systemImage: "plus") { editing = .new }
                    .disabled(atLimit)
            }
        }
        .sheet(item: $editing) { target in
            KnowledgeEditorSheet(target: target)
        }
        .confirmationDialog("Forget “\(forgetting.map { humanKey($0.key) } ?? "")”?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible, presenting: forgetting) { fact in
            Button("Forget", role: .destructive) { Task { await forget(fact) } }
        } message: { _ in
            Text("The planner stops using it right away and its change history is removed, so this can't be undone. An old email won't bring it back.")
        }
        .confirmationDialog("Turn off Ask the planner?", isPresented: $confirmDisableAssistant, titleVisibility: .visible) {
            Button("Turn off", role: .destructive) { Task { await disableAssistant() } }
        }
        .sensoryFeedback(.success, trigger: feedback)
    }

    // MARK: Sections

    private var pendingProposals: [KnowledgeProposal] { store.knowledgeProposals.filter { $0.status == "pending" } }

    private var proposalsSection: some View {
        Section("Suggested updates") {
            ForEach(pendingProposals) { proposal in
                ProposalRow(proposal: proposal, current: currentValue(proposal), busy: busyIds.contains(proposal.id)) { decision in
                    Task { await decide(proposal, decision) }
                }
            }
        }
        .plannerRows()
    }

    private var factsSection: some View {
        Section {
            if store.knowledge.isEmpty {
                EmptyState(systemImage: "books.vertical", title: "No facts yet", message: "Facts the planner should remember, like pickup times or allergies. Only you can see them. Add one with +, or tell the planner.")
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            } else if filteredFacts.isEmpty {
                ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
            }
            ForEach(filteredFacts) { fact in
                Button { editing = .edit(fact) } label: { FactRow(fact: fact, today: today) }
                    .buttonStyle(.plain)
                    .disabled(busyIds.contains(fact.key))
                    .swipeActions(edge: .trailing) {
                        Button("Forget", systemImage: "trash", role: .destructive) { forgetting = fact }
                    }
                    .swipeActions(edge: .leading) {
                        Button("Edit", systemImage: "pencil") { editing = .edit(fact) }.tint(.plannerAccent)
                    }
                    .contextMenu {
                        Button("Edit", systemImage: "pencil") { editing = .edit(fact) }
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = fact.value }
                        Button("Forget", systemImage: "trash", role: .destructive) { forgetting = fact }
                    }
            }
            // On the rows, not the section: the empty states above stay clear.
            .plannerRows()
        } header: {
            HStack {
                Text("Facts")
                Spacer()
                if store.knowledge.count >= Self.showCountFrom {
                    Text("\(store.knowledge.count) of \(Self.limit)").monospacedDigit()
                }
            }
        } footer: {
            if atLimit {
                Text("You've reached the \(Self.limit)-fact limit. Forget a fact you no longer need to add another.")
            } else if store.knowledge.count >= Self.showCountFrom {
                Text("You can keep up to \(Self.limit) facts. Forget ones you no longer need to make room.")
            } else if !store.knowledge.isEmpty {
                Label("Only you. Include dates for changes, like switching schools.", systemImage: "lock")
            }
        }
    }

    private var historySection: some View {
        Section {
            ForEach(store.knowledgeHistory.prefix(5)) { change in
                KnowledgeChangeRow(change: change, canRevert: canUndo(change) && !busyIds.contains(change.id), busy: busyIds.contains(change.id)) {
                    Task { await undo(change) }
                }
            }
            if store.knowledgeHistory.count > 5 {
                NavigationLink("All recent changes") { KnowledgeHistoryView(canUndo: canUndo, undo: undo) }
            }
        } header: {
            Text("Recent changes")
        } footer: {
            Text("Swipe a change to revert it, for 30 days while it's the latest edit.")
        }
        .plannerRows()
    }

    // MARK: Derived

    private var filteredFacts: [KnowledgeFact] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return store.knowledge }
        return store.knowledge.filter { "\(humanKey($0.key)) \($0.key) \($0.value)".lowercased().contains(needle) }
    }

    private var atLimit: Bool { store.knowledge.count >= Self.limit }

    /// Member-local `yyyy-MM-dd`, compared lexically with `validFrom`/`validUntil` like the web.
    private var today: String { PlannerDates.dayString(.now, in: store.timeZone) }

    private func currentValue(_ proposal: KnowledgeProposal) -> String? {
        store.knowledge.first { $0.key == proposal.targetKeys.first }?.value
    }

    func canUndo(_ change: KnowledgeChangeEntry) -> Bool {
        guard let fact = store.knowledge.first(where: { $0.key == change.key }), fact.revision == change.resultRevision,
              let until = PlannerDates.instant(change.undoUntil) else { return false }
        return until > .now
    }

    // MARK: Actions

    private func refresh() async { await store.refresh([.knowledge, .knowledgeHistory, .knowledgeProposals, .assistantSettings]) }

    private func forget(_ fact: KnowledgeFact) async {
        busyIds.insert(fact.key)
        defer { busyIds.remove(fact.key) }
        do {
            try await store.client.forgetKnowledge(key: fact.key, expectedRevision: fact.revision)
            store.invalidateInFlightRefresh()
            store.knowledge.removeAll { $0.key == fact.key }
            feedback += 1
            app.show("Forgot “\(humanKey(fact.key))”.")
        } catch {
            app.show(error)
        }
        await refresh()
    }

    func undo(_ change: KnowledgeChangeEntry) async {
        guard let fact = store.knowledge.first(where: { $0.key == change.key }) else { return }
        busyIds.insert(change.id)
        defer { busyIds.remove(change.id) }
        do {
            try await store.client.undoKnowledgeChange(change.id, expectedRevision: fact.revision)
            feedback += 1
            app.show("Reverted “\(humanKey(change.key))”.")
        } catch {
            app.show(error)
        }
        await refresh()
    }

    private func decide(_ proposal: KnowledgeProposal, _ decision: String) async {
        busyIds.insert(proposal.id)
        defer { busyIds.remove(proposal.id) }
        do {
            try await store.client.decideKnowledgeProposal(proposal.id, decision: decision)
            feedback += 1
            app.show(decision == "accept" ? "Saved “\(humanKey(proposal.targetKeys.first ?? ""))” to Household facts." : "Dismissed the suggested update.")
        } catch let error as PlannerError where error.code == "KNOWLEDGE_LIMIT" {
            app.show("You can keep up to \(Self.limit) facts. Forget one to accept this.", isError: true)
        } catch {
            app.show(error)
        }
        await refresh()
    }

    private func disableAssistant() async {
        do {
            store.assistantSettings = try await store.client.setAssistant(enabled: false)
            app.show("Ask the planner is off for your account.")
        } catch {
            app.show(error)
        }
    }
}

/// `school_pickup_time` → "School pickup time".
func humanKey(_ key: String) -> String {
    let spaced = key.replacingOccurrences(of: "_", with: " ")
    return spaced.prefix(1).uppercased() + spaced.dropFirst()
}

// MARK: Rows

/// Where a suggested update came from, in words: the server only sends opaque
/// evidence ids, so name the kind of source rather than the id.
func knowledgeSourceLabel(_ refs: [String]) -> (text: String, systemImage: String)? {
    guard !refs.isEmpty else { return nil }
    let emails = refs.filter { $0.localizedCaseInsensitiveContains("email") || $0.localizedCaseInsensitiveContains("mail") }.count
    if emails == refs.count { return (emails == 1 ? "From an email" : "From \(emails) emails", "envelope") }
    if refs.contains(where: { $0.localizedCaseInsensitiveContains("request") || $0.localizedCaseInsensitiveContains("run") }) {
        return ("From a request", "bubble.left")
    }
    return ("From your recent plans and email", "tray.full")
}

private struct FactRow: View {
    let fact: KnowledgeFact
    let today: String
    @Environment(PlannerStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(humanKey(fact.key)).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
            Text(fact.value).font(.subheadline).foregroundStyle(Color.ink).fixedSize(horizontal: false, vertical: true)
            if !badges.isEmpty {
                // Wraps onto more lines at large text instead of squeezing.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) { badgeViews }
                    VStack(alignment: .leading, spacing: 4) { badgeViews }
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Edit")
    }

    @ViewBuilder private var badgeViews: some View {
        ForEach(badges, id: \.text) { Badge($0.text, style: $0.style, systemImage: $0.image) }
    }

    private var badges: [(text: String, style: Badge.Style, image: String?)] {
        var result: [(text: String, style: Badge.Style, image: String?)] = []
        if let from = fact.validFrom, from > today {
            result.append(("From \(dayLabel(from))", .neutral, "calendar.badge.clock"))
        }
        if let until = fact.validUntil {
            result.append(("Until \(dayLabel(until))", .neutral, "hourglass"))
        }
        if fact.confirmation == "unconfirmed" {
            result.append(("Unconfirmed", .warning, "questionmark.circle"))
        }
        switch fact.provenance {
        case "source": result.append(("From email", .neutral, "envelope"))
        case "maintenance": result.append(("Suggested update", .neutral, "wand.and.stars"))
        default: break
        }
        return result
    }

    private func dayLabel(_ value: String) -> String {
        PlannerDates.day(value, in: store.timeZone).map { TimeLabels.day($0, in: store.timeZone) } ?? value
    }
}

/// One suggested update as an ordinary row (not an attention card): what would change,
/// why, where it came from, and the verb that applies it.
private struct ProposalRow: View {
    let proposal: KnowledgeProposal
    let current: String?
    let busy: Bool
    let decide: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(proposal.targetKeys.map(humanKey).joined(separator: ", "))
                    .font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                Spacer(minLength: 8)
                if busy { ProgressView() } else if isNew { Badge("New", style: .neutral) }
            }
            change
            Text(proposal.reason).font(.subheadline).foregroundStyle(Color.muted)
            if let source = knowledgeSourceLabel(proposal.provenanceRefs) {
                Label(source.text, systemImage: source.systemImage).font(.caption).foregroundStyle(Color.muted)
            }
            HStack(spacing: 10) {
                Button(applyLabel) { decide("accept") }.buttonStyle(.plannerPrimary)
                Button("Dismiss") { decide("dismiss") }.buttonStyle(PlannerButtonStyle(kind: .quiet))
            }
            .disabled(busy)
            .padding(.top, 2)
        }
        .padding(.vertical, 6)
    }

    /// A new fact shows just the fact; an update shows what it replaces.
    @ViewBuilder private var change: some View {
        if proposal.operation == "archive" {
            Text(current ?? "This fact").strikethrough().foregroundStyle(Color.muted)
                .font(.subheadline)
                .accessibilityLabel("Forget: \(current ?? "this fact")")
        } else if isNew {
            Text(proposal.proposedValue ?? "").font(.subheadline).foregroundStyle(Color.ink)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                if let current { Text(current).strikethrough().foregroundStyle(Color.muted) }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "arrow.turn.down.right").foregroundStyle(Color.muted).accessibilityHidden(true)
                    Text(proposal.proposedValue ?? "").foregroundStyle(Color.ink)
                }
            }
            .font(.subheadline)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Now: \(current ?? "nothing"). Suggested: \(proposal.proposedValue ?? "")")
        }
    }

    private var isNew: Bool { proposal.operation == "add" || (current == nil && proposal.operation != "archive") }

    private var applyLabel: String {
        switch proposal.operation {
        case "archive": "Forget"
        case "merge": "Merge"
        default: isNew ? "Add" : "Update"
        }
    }
}

struct KnowledgeChangeRow: View {
    let change: KnowledgeChangeEntry
    let canRevert: Bool
    let busy: Bool
    let revert: () -> Void
    @Environment(PlannerStore.self) private var store

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(humanKey(change.key)).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                Text(summary).font(.subheadline).foregroundStyle(Color.ink).lineLimit(3)
                Text("\(origin) · \(PlannerDates.instant(change.createdAt).map { TimeLabels.dateTime($0, in: store.timeZone) } ?? "")")
                    .font(.caption).foregroundStyle(Color.muted)
            }
            Spacer(minLength: 6)
            if busy { ProgressView() }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .swipeActions(edge: .trailing) {
            if canRevert {
                Button("Revert", systemImage: "arrow.uturn.backward", action: revert).tint(.plannerAccent)
            }
        }
        .contextMenu {
            if canRevert {
                Button("Revert", systemImage: "arrow.uturn.backward", action: revert)
            }
        }
    }

    private var summary: String {
        switch (change.before, change.after) {
        case (nil, let after?): "Added: \(after)"
        case (let before?, nil): "Forgot: \(before)"
        case (let before?, let after?): "\(before) → \(after)"
        default: "Changed"
        }
    }

    private var origin: String {
        switch change.origin {
        case "review": "From a request"
        case "maintenance": "Suggested update"
        default: "You"
        }
    }
}

private struct KnowledgeHistoryView: View {
    let canUndo: (KnowledgeChangeEntry) -> Bool
    let undo: (KnowledgeChangeEntry) async -> Void
    @Environment(PlannerStore.self) private var store
    @State private var busy: String?

    var body: some View {
        List {
            Section {
                ForEach(store.knowledgeHistory) { change in
                    KnowledgeChangeRow(change: change, canRevert: canUndo(change) && busy == nil, busy: busy == change.id) {
                        Task { busy = change.id; await undo(change); busy = nil }
                    }
                }
            } footer: {
                Text("Swipe a change to revert it, for 30 days while it's the latest edit.")
            }
            .plannerRows()
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Recent changes")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh([.knowledge, .knowledgeHistory]) }
    }
}
