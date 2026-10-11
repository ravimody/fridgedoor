import FridgedoorKit
import SwiftUI

struct ShareView: View {
    @Bindable var model: ShareModel
    @FocusState private var noteFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView("Preparing…").frame(maxWidth: .infinity, maxHeight: .infinity)
                case .signedOut:
                    message(symbol: "person.crop.circle.badge.exclamationmark", title: "Sign in to Fridgedoor first", detail: "Open Fridgedoor on this iPhone and sign in; sharing to the planner turns on automatically.")
                case let .unsupported(text):
                    message(symbol: "doc.questionmark", title: "Can't send this", detail: text)
                case .sent:
                    sent
                default:
                    form
                }
            }
            .background(Color.paper.ignoresSafeArea())
            .navigationTitle("Ask the planner")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.phase == .sent ? "Done" : "Cancel") { model.cancel() }
                        .disabled(model.phase == .sending)
                }
                if model.payload != nil, model.phase != .sent {
                    ToolbarItem(placement: .confirmationAction) {
                        Button {
                            noteFocused = false
                            Task { await model.send() }
                        } label: {
                            if model.phase == .sending { ProgressView() } else { Text("Send").fontWeight(.semibold) }
                        }
                        .buttonStyle(.glassProminent)
                        .tint(.plannerAccent)
                        .disabled(!model.canSend)
                    }
                }
            }
        }
        .tint(.plannerAccent)
        .sensoryFeedback(.success, trigger: model.phase == .sent)
        .sensoryFeedback(.error, trigger: { if case .failed = model.phase { true } else { false } }())
    }

    // MARK: Form

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "sparkles")
                        .font(.title3)
                        .foregroundStyle(Color.plannerAccent)
                        .accessibilityHidden(true)
                    Text("The planner reads this and suggests what to add.")
                        .font(.serif(.title3))
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if case let .failed(text) = model.phase {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(Color.warning)
                        Text(text).font(.subheadline).foregroundStyle(Color.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(12)
                    .background(Color.soft, in: .rect(cornerRadius: 14, style: .continuous))
                    .accessibilityElement(children: .combine)
                }

                preview

                VStack(alignment: .leading, spacing: 6) {
                    Text("Note").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                    if model.payload?.isFile == true {
                        Text("The planner reads the file itself; notes can't be added to photos or PDFs yet.")
                            .font(.footnote).foregroundStyle(Color.muted)
                    } else {
                        TextField("Optional — e.g. “Add this to Saturday”", text: $model.note, axis: .vertical)
                            .lineLimit(2...6)
                            .focused($noteFocused)
                            .padding(12)
                            .background(Color.card, in: .rect(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line))
                            .disabled(model.phase == .sending)
                    }
                }

                // Shared things always arrive as a capture, which the server never applies
                // directly (only typed list commands are), so everything here waits for review.
                Label("Everything you share waits for your review in Fridgedoor; nothing is added right away.", systemImage: "checkmark.shield")
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder private var preview: some View {
        switch model.payload {
        case let .text(text, link)?:
            VStack(alignment: .leading, spacing: 8) {
                if let link {
                    Label(link.host() ?? link.absoluteString, systemImage: "link")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.plannerAccent)
                        .lineLimit(1)
                }
                if !text.isEmpty {
                    Text(text).font(.body).foregroundStyle(Color.ink).lineLimit(8)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.card, in: .rect(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line))
        case let .file(data, filename, mimeType, image)?:
            HStack(spacing: 14) {
                if let image {
                    Image(uiImage: image)
                        .resizable().scaledToFill()
                        .frame(width: 72, height: 72)
                        .clipShape(.rect(cornerRadius: 12, style: .continuous))
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: mimeType == "application/pdf" ? "doc.richtext" : "photo")
                        .font(.largeTitle)
                        .foregroundStyle(Color.plannerAccent)
                        .frame(width: 72, height: 72)
                        .background(Color.soft, in: .rect(cornerRadius: 12, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(filename).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(2)
                    Text("\(mimeType == "application/pdf" ? "PDF" : "Photo") · \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))")
                        .font(.caption).foregroundStyle(Color.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(Color.card, in: .rect(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line))
        case nil:
            EmptyView()
        }
    }

    // MARK: States

    private var sent: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.onAccent, Color.plannerAccent)
                .symbolEffect(.bounce, value: model.phase == .sent)
                .accessibilityHidden(true)
            Text("Sent to the planner").font(.serif(.title2)).foregroundStyle(Color.ink)
            Text("Review what the planner suggests in Fridgedoor.").font(.subheadline).foregroundStyle(Color.muted)
        }
        .multilineTextAlignment(.center)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func message(symbol: String, title: String, detail: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 44)).foregroundStyle(Color.plannerAccent)
            Text(title).font(.serif(.title3)).foregroundStyle(Color.ink)
            Text(detail).font(.subheadline).foregroundStyle(Color.muted)
            Button("Close") { model.cancel() }
                .buttonStyle(.glass)
                .padding(.top, 8)
        }
        .multilineTextAlignment(.center)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
