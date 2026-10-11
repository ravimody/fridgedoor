import FridgedoorKit
import SwiftUI

/// Add or edit one fact (`POST assistant/knowledge`; `expectedRevision` 0 for new).
/// After saving, the toast offers Undo backed by the new history entry. Cancelling
/// with edits asks before discarding them.
struct KnowledgeEditorSheet: View {
    enum Target: Identifiable {
        case new
        case edit(KnowledgeFact)
        var id: String { if case .edit(let fact) = self { fact.key } else { "new" } }
        var fact: KnowledgeFact? { if case .edit(let fact) = self { fact } else { nil } }
    }

    let target: Target
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    @State private var value = ""
    @State private var busy = false
    @State private var errorText: String?
    @State private var confirmDiscard = false
    @FocusState private var focus: Field?

    private enum Field { case key, value }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let fact = target.fact {
                        LabeledContent("Fact", value: humanKey(fact.key))
                    } else {
                        TextField("Fact name, like Dietary preference", text: $key)
                            .focused($focus, equals: .key)
                            .submitLabel(.next)
                            .onSubmit { focus = .value }
                            .onChange(of: key) { _, next in if next.utf16.count > 80 { key = next.clipped(utf16: 80) } }
                    }
                } footer: {
                    if target.fact == nil, existing != nil {
                        Text("You already have this fact. Saving replaces its details.")
                    }
                }
                .plannerRows()
                Section {
                    TextField("A concise fact, with dates if relevant", text: $value, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focus, equals: .value)
                        .onChange(of: value) { _, next in if next.utf16.count > 500 { value = next.clipped(utf16: 500) } }
                } header: {
                    Text("Details")
                } footer: {
                    HStack(alignment: .top) {
                        Text("Include dates for changes, such as “Starts at Maple Grove Middle School on Sept 2”.")
                        Spacer()
                        Text("\(value.utf16.count)/500").monospacedDigit()
                    }
                }
                .plannerRows()
                if let fact = target.fact {
                    Section {
                        LabeledContent("Source", value: provenance(fact))
                        if fact.confirmation == "unconfirmed" {
                            Text("Saving confirms this fact.").font(.footnote).foregroundStyle(Color.muted)
                        }
                    }
                    .plannerRows()
                }
                if let errorText {
                    Section { SettingsNotice(text: errorText, tone: .warning) }
                }
            }
            .plannerList()
            .navigationTitle(target.fact == nil ? "Add a fact" : "Edit fact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if hasEdits { confirmDiscard = true } else { dismiss() } }
                        .disabled(busy)
                        .confirmationDialog("Discard changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                            Button("Discard changes", role: .destructive) { dismiss() }
                            Button("Keep editing", role: .cancel) {}
                        }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button("Save") { Task { await save() } }.disabled(!canSave)
                    }
                }
            }
            .onAppear {
                if let fact = target.fact { key = fact.key; value = fact.value; focus = .value } else { focus = .key }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(busy || hasEdits)
    }

    private var hasEdits: Bool {
        if let fact = target.fact { return value != fact.value }
        return !key.isEmpty || !value.isEmpty
    }

    private var trimmedKey: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedValue: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var existing: KnowledgeFact? { store.knowledge.first { $0.key == trimmedKey } }
    private var canSave: Bool {
        !busy && !trimmedKey.isEmpty && !trimmedValue.isEmpty && (target.fact.map { $0.value != trimmedValue || $0.confirmation == "unconfirmed" } ?? true)
    }

    private func provenance(_ fact: KnowledgeFact) -> String {
        switch fact.provenance {
        case "source": "From email"
        case "maintenance": "Suggested update"
        case "legacy": "Older fact"
        default: "You or the planner"
        }
    }

    private func save() async {
        busy = true; errorText = nil
        defer { busy = false }
        let key = trimmedKey
        // Edits send the revision this sheet opened with, so a newer edit elsewhere is a
        // STALE_REVISION rather than silently overwritten. A new fact whose name already
        // exists replaces it, like the web form.
        let revision = (target.fact ?? existing)?.revision ?? 0
        if revision == 0, store.knowledge.count >= KnowledgeView.limit {
            errorText = "You can keep up to \(KnowledgeView.limit) facts. Forget one you no longer need to add another."
            return
        }
        do {
            let saved = try await store.client.saveKnowledge(key: key, value: trimmedValue, expectedRevision: revision)
            store.invalidateInFlightRefresh()
            if let index = store.knowledge.firstIndex(where: { $0.key == saved.key }) { store.knowledge[index] = saved } else { store.knowledge.append(saved); store.knowledge.sort { $0.key < $1.key } }
            dismiss()
            await store.refresh([.knowledge, .knowledgeHistory])
            offerUndo(for: saved)
        } catch let error as PlannerError {
            switch error.code {
            case "KNOWLEDGE_LIMIT": errorText = "You can keep up to \(KnowledgeView.limit) facts. Forget one you no longer need to add another."
            case "INVALID_FACT", "VALIDATION": errorText = "Check the fact name (up to 80 characters) and details (up to 500)."
            default:
                if error.isStale {
                    errorText = "This fact changed on another device. Cancel and open it again to see the latest before editing."
                    await store.refresh([.knowledge, .knowledgeHistory])
                } else {
                    errorText = error.userMessage
                }
            }
        } catch {
            errorText = PlannerError.decoding.userMessage
        }
    }

    private func offerUndo(for fact: KnowledgeFact) {
        let message = "Saved “\(humanKey(fact.key))”."
        guard let change = store.knowledgeHistory.first(where: { $0.key == fact.key && $0.resultRevision == fact.revision }) else {
            app.show(message); return
        }
        let store = store, app = app
        app.show(message, action: Toast.Action(label: "Undo") {
            Task {
                do {
                    try await store.client.undoKnowledgeChange(change.id, expectedRevision: fact.revision)
                    app.show("Change undone.")
                } catch {
                    app.show(error)
                }
                await store.refresh([.knowledge, .knowledgeHistory])
            }
        })
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
