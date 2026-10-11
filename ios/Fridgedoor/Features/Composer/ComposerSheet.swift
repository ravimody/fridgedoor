import PhotosUI
import FridgedoorKit
import SwiftUI
import UniformTypeIdentifiers

/// "Ask the planner": a short thread of requests and their results, with the field at the
/// bottom (text, a photo/PDF, a pasted link or voice). Mirrors the web `Composer.tsx`;
/// the draft survives dismissal, and the sheet stays open after Send (C-01).
struct ComposerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(PlannerStore.self) private var store
    @Environment(ComposerModel.self) private var composer
    @FocusState private var focused: Bool
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var processing = false
    @State private var enabling = false
    @State private var detent: PresentationDetent = .medium
    /// Voice started inside the sheet is discarded if the sheet is closed mid-recording.
    @State private var voiceStartedHere = false

    private static let threadEnd = "thread-end"

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        content
                        Color.clear.frame(height: 1).id(Self.threadEnd)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 4)
                    .padding(.bottom, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: composer.thread) { scrollToEnd(proxy) }
                .onChange(of: lastRunState) { scrollToEnd(proxy) }
            }
            .plannerBackground()
            .navigationTitle("Ask the planner")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { composer.isPresented = false }
                }
                if store.assistantReady && !composer.thread.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New request", systemImage: "square.and.pencil") {
                            composer.startNewThread()
                            focused = true
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { if store.assistantReady { inputBar } }
        }
        // Errors and Undo from the thread's cards: the app's toasts are hidden behind a
        // full-height sheet (at medium height they still show above it).
        .overlay(alignment: .top) { if detent == .large { ToastOverlay() } }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.paper)
        .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images, preferredItemEncoding: .current)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in attach { try AttachmentProcessor.photo(from: image) } }
                .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .image]) { result in
            switch result {
            case .success(let url): attach { try AttachmentProcessor.file(at: url) }
            case .failure: composer.notice = AttachmentError.unreadable.errorDescription
            }
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            processing = true
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else {
                    processing = false
                    composer.notice = AttachmentError.unreadable.errorDescription
                    return
                }
                attach { try AttachmentProcessor.photo(from: data) }
            }
        }
        .onChange(of: composer.voice.phase) { _, phase in if phase == .idle { voiceStartedHere = false } }
        .onChange(of: composer.thread.isEmpty) { _, empty in if !empty { detent = .large } }
        // Anything that navigates (plan details, Settings, Household facts) closes the
        // sheet so the pushed screen is visible.
        .onChange(of: routeDepth) { old, new in if new > old { composer.isPresented = false } }
        .onChange(of: router.tab) { composer.isPresented = false }
        .onAppear {
            composer.bind(app: app, store: store)
            detent = composer.thread.isEmpty ? .medium : .large
            if store.assistantReady, composer.thread.isEmpty, !composer.voice.isActive { focused = true }
        }
        .onDisappear {
            // Closing (not covering it with the camera) discards voice started here at any
            // stage, and any clip kept for Retry voice; late callbacks can't submit.
            guard !composer.isPresented else { return }
            let voice = composer.voice
            if (voiceStartedHere && voice.isActive) || (!voice.isActive && voice.retryClip != nil) { voice.cancel() }
        }
        .sensoryFeedback(.error, trigger: composer.notice) { _, notice in notice != nil }
    }

    private var routeDepth: Int { router.homePath.count + router.todoPath.count + router.groceryPath.count + router.morePath.count }

    /// Scrolls when the newest request settles, not on every change to its cards.
    private var lastRunState: String? { composer.thread.last.flatMap { store.assistantRun($0)?.state } }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        withAnimation(.snappy) { proxy.scrollTo(Self.threadEnd, anchor: .bottom) }
    }

    @ViewBuilder private var content: some View {
        if !store.hasLoaded && store.assistantSettings == nil {
            ProgressView("Loading…").frame(maxWidth: .infinity).padding(.top, 40)
        } else if store.assistantSettings?.enabled != true {
            EmptyState(systemImage: "sparkles", title: "Ask the planner is unavailable", message: "Your plans and lists still work.")
        } else if store.assistantSettings?.consent != true {
            consentCard
        } else if composer.thread.isEmpty {
            intro
        } else {
            ForEach(composer.thread, id: \.self) { id in
                if let run = store.assistantRun(id) {
                    ComposerThreadEntry(run: run) { text in
                        composer.draft = text
                        focused = true
                    }
                }
            }
        }
    }

    // MARK: Consent

    private var consentCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Turn on Ask the planner").font(.serif(.title2)).foregroundStyle(Color.ink)
            Text("Your messages, uploads, relevant plans and lists, and approved remembered facts are sent to your household's AI provider. Public lookups send minimal search terms. Requests and results expire after seven days; remembered facts stay until removed. The provider may keep API data for a while under its own policy. Voice is transcribed on this iPhone when it can; otherwise the recording is sent through the planner to the provider for transcription, and the planner doesn't keep it. This does not enable email scanning.")
                .font(.subheadline)
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                enabling = true
                Task {
                    do { try await store.setAssistantEnabled(true); composer.notice = nil; focused = true }
                    catch { composer.notice = (error as? PlannerError)?.assistantMessage ?? error.localizedDescription }
                    enabling = false
                }
            } label: {
                HStack { if enabling { ProgressView().tint(Color.onAccent) }; Text(enabling ? "Turning on…" : "Turn on for my account") }
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plannerPrimary)
            .disabled(enabling)
            if let notice = composer.notice { ErrorBanner(message: notice) }
        }
        .plannerCard()
    }

    // MARK: Empty thread

    private var intro: some View {
        VStack(alignment: .leading, spacing: 14) {
            if composer.trimmedDraft.isEmpty && composer.attachment == nil && !composer.voice.isActive {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Try").font(.caption.weight(.semibold)).foregroundStyle(Color.muted)
                    FlowChips(items: ["Add oat milk and bananas to groceries", "Dinner with the Parkers Friday 7pm", "Remind me to renew the library cards", "What’s on today?"]) { example in
                        composer.draft = example
                        focused = true
                    }
                }
            }
            Label("Direct list commands are added right away with Undo; everything else waits for your review.", systemImage: "checkmark.shield")
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Input

    private var inputBar: some View {
        @Bindable var composer = composer
        return VStack(alignment: .leading, spacing: 8) {
            if let notice = composer.notice { ErrorBanner(message: notice) }
            if composer.voice.isActive { VoicePanel().transition(.move(edge: .bottom).combined(with: .opacity)) }
            VoiceNotice()
            if let link = composer.detectedLink { LinkChip(url: link) { composer.removeLink(link) } }
            if processing {
                HStack(spacing: 10) { ProgressView(); Text("Preparing attachment…").foregroundStyle(Color.muted) }
                    .font(.subheadline)
            } else if let attachment = composer.attachment {
                AttachmentPreview(attachment: attachment) { withAnimation(.snappy) { composer.attachment = nil } }
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
            }
            if composer.draftLength > ComposerModel.maxLength - 500 {
                Text("\(composer.draftLength.formatted()) / \(ComposerModel.maxLength.formatted()) characters")
                    .font(.caption)
                    .foregroundStyle(composer.draftLength > ComposerModel.maxLength ? Color.danger : Color.muted)
            }
            HStack(alignment: .bottom, spacing: 6) {
                attachMenu
                HStack(alignment: .bottom, spacing: 0) {
                    TextField(composer.thread.isEmpty ? "Ask, add, or share…" : "Ask a follow-up…", text: $composer.draft, axis: .vertical)
                        .lineLimit(1...6)
                        .font(.body)
                        .foregroundStyle(Color.ink)
                        .focused($focused)
                        .disabled(composer.isSending || composer.voice.isActive)
                        .padding(.leading, 14)
                        .padding(.vertical, 11)
                        .accessibilityLabel("Request")
                    trailingControl
                }
                .background(Color.card, in: .rect(cornerRadius: 22, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(focused ? Color.plannerAccent.opacity(0.6) : Color.line, lineWidth: 1) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(Color.paper)
        .overlay(alignment: .top) { Divider().overlay(Color.line) }
        .animation(.snappy, value: composer.voice.isActive)
    }

    /// Send sits in the field, like Messages (C-07); with nothing to send it's the mic.
    @ViewBuilder private var trailingControl: some View {
        let hasContent = !composer.trimmedDraft.isEmpty || composer.attachment != nil
        if composer.isSending || (hasContent && !composer.voice.isActive) {
            Button {
                detent = .large
                Task { await composer.send() }
            } label: {
                ZStack {
                    if composer.isSending { ProgressView().tint(Color.onAccent) }
                    else { Image(systemName: "arrow.up").font(.body.weight(.bold)) }
                }
                .foregroundStyle(Color.onAccent)
                .frame(width: 34, height: 34)
                .background(Color.plannerAccent, in: .circle)
                .opacity(composer.canSend || composer.isSending ? 1 : 0.45)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!composer.canSend || processing)
            .accessibilityLabel(composer.isSending ? "Sending" : "Send")
        } else {
            VoiceMicButton(size: 34)
                .frame(width: 44, height: 44)
                .simultaneousGesture(TapGesture().onEnded { if !composer.voice.isActive { voiceStartedHere = true; focused = false } })
        }
    }

    private var attachMenu: some View {
        Menu {
            Button("Choose a photo", systemImage: "photo.on.rectangle") { showPhotos = true }
            if CameraPicker.isAvailable {
                Button("Take a photo", systemImage: "camera") { showCamera = true }
            }
            Button("Attach a PDF or image file", systemImage: "doc") { showFiles = true }
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.plannerAccent)
                .frame(width: 44, height: 44)
                .background(Color.soft, in: .circle)
                .contentShape(.circle)
        }
        .disabled(composer.isSending || processing)
        .accessibilityLabel("Add a photo or file")
    }

    /// Decodes/re-encodes off the main thread; large photos take a moment.
    private func attach(_ make: @escaping @Sendable () throws -> ComposerAttachment) {
        processing = true
        Task {
            let result = await Task.detached(priority: .userInitiated) { Result { try make() } }.value
            processing = false
            switch result {
            case .success(let attachment):
                withAnimation(.snappy) { composer.attachment = attachment }
                composer.notice = nil
            case .failure(let error):
                composer.notice = (error as? AttachmentError)?.errorDescription ?? AttachmentError.unreadable.errorDescription
            }
        }
    }
}

/// Thumbnail, name and size of the pending photo/PDF, with a remove button.
struct AttachmentPreview: View {
    let attachment: ComposerAttachment
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let preview = attachment.preview {
                    Image(uiImage: preview).resizable().scaledToFill()
                } else {
                    Image(systemName: attachment.kind == .pdf ? "doc.richtext" : "photo").font(.title2).foregroundStyle(Color.muted)
                }
            }
            .frame(width: 56, height: 56)
            .background(Color.soft)
            .clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.kind == .pdf ? attachment.filename : "Photo")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1)
                Text(attachment.detail).font(.caption).foregroundStyle(Color.muted)
                Text("The planner will read this and suggest items for your review.").font(.caption).foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.hierarchical)
            }
            .foregroundStyle(Color.muted)
            .frame(width: 44, height: 44)
            .accessibilityLabel("Remove attachment")
        }
        .plannerCard(padding: 10)
        .accessibilityElement(children: .contain)
    }
}

/// A detected link in the message, with a remove button.
struct LinkChip: View {
    let url: URL
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "link").foregroundStyle(Color.plannerAccent)
            VStack(alignment: .leading, spacing: 1) {
                Text(url.host() ?? url.absoluteString).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1)
                Text("The planner will read this page.").font(.caption).foregroundStyle(Color.muted)
            }
            Spacer(minLength: 0)
            Button(action: remove) { Image(systemName: "xmark.circle.fill").symbolRenderingMode(.hierarchical) }
                .foregroundStyle(Color.muted)
                .frame(width: 44, height: 44)
                .accessibilityLabel("Remove link")
        }
        .padding(.leading, 12)
        .background(Color.soft, in: .rect(cornerRadius: 14))
    }
}

/// Wrapping row of tappable suggestion chips.
struct FlowChips: View {
    let items: [String]
    let action: (String) -> Void

    var body: some View {
        ChipFlowLayout(spacing: 8) {
            ForEach(items, id: \.self) { item in
                Button { action(item) } label: {
                    Text(item)
                        .font(.subheadline)
                        .foregroundStyle(Color.plannerAccent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(minHeight: 36)
                        .background(Color.soft, in: .capsule)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Minimal wrapping layout for chips.
struct ChipFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.init(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: .init(width: min(size.width, bounds.width), height: size.height))
                x += min(size.width, bounds.width) + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        var current: [Int] = []
        var x: CGFloat = 0
        var height: CGFloat = 0
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.init(width: width, height: nil))
            let itemWidth = min(size.width, width)
            if !current.isEmpty && x + spacing + itemWidth > width {
                rows.append((current, x, height))
                current = []; x = 0; height = 0
            }
            x += (current.isEmpty ? 0 : spacing) + itemWidth
            height = max(height, size.height)
            current.append(index)
        }
        if !current.isEmpty { rows.append((current, x, height)) }
        return rows
    }
}
