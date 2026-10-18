import FridgedoorKit
import SwiftUI

/// Suggestions that one tap can settle, and the planner's questions, answered by
/// dictation or Scribble. Anything that needs more (a missing time, edits) says to
/// use the iPhone rather than offering a half-working control.
struct DecisionsView: View {
    @Environment(WatchModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let payload = model.payload
        List {
            ForEach(payload?.questions ?? []) { question in
                QuestionRow(question: question)
            }
            ForEach(payload?.decisions ?? []) { row in
                SuggestionRow(row: row)
            }
        }
        .navigationTitle("Decisions")
        .onChange(of: (payload?.decisionCount ?? 0) == 0) { _, empty in
            if empty { dismiss() }
        }
    }
}

private struct SuggestionRow: View {
    let row: WidgetSnapshot.DecisionRow
    @Environment(WatchModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.headline)
                    .lineLimit(4)
                Text(row.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            switch row.action {
            case .calendar?:
                Button { model.decide(row, .calendar) } label: {
                    Label("Add to calendar", systemImage: "calendar.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .foregroundStyle(Color.onAccent)
                Button("Save") { model.decide(row, .keep) }
            case .keep?:
                Button("Save") { model.decide(row, .keep) }
                    .buttonStyle(.borderedProminent)
                    .foregroundStyle(Color.onAccent)
            case nil:
                Text("Decide on your iPhone")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct QuestionRow: View {
    let question: WatchPayload.Question
    @Environment(WatchModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(question.text).font(.body)
            } icon: {
                Image(systemName: "questionmark.bubble").foregroundStyle(Color.attentionInk)
            }
            TextFieldLink(prompt: Text("Your answer")) {
                Text("Answer")
                    .frame(maxWidth: .infinity)
            } onSubmit: { text in
                model.answer(question, text)
            }
            .buttonStyle(.borderedProminent)
            .foregroundStyle(Color.onAccent)
        }
        .padding(.vertical, 4)
        .swipeActions {
            Button { model.dismiss(question) } label: {
                Label("Dismiss", systemImage: "eye.slash")
            }
        }
    }
}
