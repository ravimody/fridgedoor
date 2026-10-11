import FridgedoorKit
import SwiftUI

/// Teach suggestions: rate real recent suggestions as a card stack (swipe right for
/// Useful, left for Not useful, or use the buttons). Ratings are private.
struct RelevanceTrialView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @State private var model: RelevanceTrialModel?

    var body: some View {
        Group {
            if let model {
                TrialContent(model: model)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .plannerBackground()
        .navigationTitle("Teach suggestions")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard model == nil else { return }
            let next = RelevanceTrialModel(client: store.client)
            model = next
            await next.load()
        }
    }
}

private struct TrialContent: View {
    @Bindable var model: RelevanceTrialModel
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @State private var confirmClear = false
    @State private var confirmForget = false
    @State private var rated = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if !model.loaded {
                    if model.loadFailed {
                        ErrorBanner(message: "Couldn't load your examples.") { Task { await model.load() } }
                    } else {
                        HStack { Spacer(); ProgressView("Loading your examples…"); Spacer() }.padding(.vertical, 40)
                    }
                } else if model.items.isEmpty {
                    EmptyState(systemImage: "rectangle.stack", title: "No examples yet", message: "Sample five recent suggestions to start rating.")
                    nextBatchButton
                } else {
                    progress
                    if let current = model.current {
                        TrialCardStack(current: current, behind: Array(model.upcoming.prefix(2)), busy: model.busy, isChanging: model.changingId != nil, zone: store.timeZone) { vote, reason in
                            await rate(current, vote, reason)
                        } cancelChange: {
                            withAnimation(.snappy) { model.changingId = nil }
                        }
                    } else {
                        doneCard
                    }
                    if !model.hasUnanswered { nextBatchButton }
                    if !model.answered.isEmpty { answersSection }
                    summarySection
                }
                if let learning = model.learning { learningSection(learning) }
                if model.loaded && !model.items.isEmpty { deleteSection }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 32)
        }
        .settingsBottomClearance()
        .refreshable { await model.load() }
        .sensoryFeedback(.selection, trigger: rated)
        .confirmationDialog("Delete your ratings?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Delete examples and ratings", role: .destructive) { run { await model.clear() } success: { "Examples, ratings and learned preferences deleted." } }
        } message: {
            Text("This removes these examples, your ratings and learned preferences, and turns off nightly learning.")
        }
        .confirmationDialog("Forget learned preferences?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { run { await model.forgetLearning() } success: { "Learned preferences forgotten. Earlier ratings won't teach them again unless you change those ratings." } }
        }
    }

    // MARK: Pieces

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("These are real recent suggestions, shown as they appeared. Would each be useful on your Home? A reason is optional.")
                .foregroundStyle(Color.ink)
            Label("Only you. Examples and ratings are kept for 30 days. Rating something doesn't dismiss or delete its plan.", systemImage: "lock")
                .font(.footnote).foregroundStyle(Color.muted)
        }
        .padding(.top, 8)
    }

    private var progress: some View {
        let total = model.items.count, done = model.answered.count
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(done) of \(total) answered").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
            }
            ProgressView(value: Double(done), total: Double(max(total, 1))).tint(Color.plannerAccent)
        }
        .accessibilityElement(children: .combine)
    }

    private var doneCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "checkmark.seal.fill").font(.largeTitle).foregroundStyle(Color.plannerAccent)
            Text("Thanks, your ratings are saved.").font(.serif(.title2))
            Text("Turn on nightly learning below to personalize your daily brief. You can change any answer.").font(.subheadline)
        }
        .plannerCard(.soft, padding: 20)
        .transition(.scale.combined(with: .opacity))
    }

    private var nextBatchButton: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                run { await model.next() } success: { nil }
            } label: {
                Label("Get five more", systemImage: "rectangle.stack.badge.plus").frame(maxWidth: .infinity)
            }
            .buttonStyle(.plannerPrimary)
            .disabled(model.busy || model.hasUnanswered)
            Text("Finish this batch to get five more. Your earlier ratings stay saved.").font(.footnote).foregroundStyle(Color.muted)
        }
    }

    private var answersSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeading("Your answers")
            VStack(spacing: 0) {
                ForEach(model.answered) { item in
                    HStack(spacing: 12) {
                        Image(systemName: icon(item.value)).foregroundStyle(tint(item.value)).frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.facts.title).foregroundStyle(Color.ink).lineLimit(2)
                            Text(item.value?.label ?? "").font(.caption).foregroundStyle(Color.muted)
                        }
                        Spacer()
                        Button("Change") { withAnimation(.snappy) { model.changingId = item.id } }
                            .buttonStyle(.plannerQuiet)
                            .disabled(model.busy || model.changingId == item.id)
                            .accessibilityLabel("Change answer for \(item.facts.title)")
                    }
                    .padding(.vertical, 10)
                    if item.id != model.answered.last?.id { Divider().overlay(Color.line) }
                }
            }
            .plannerCard(padding: 14)
        }
    }

    @ViewBuilder
    private var summarySection: some View {
        if !model.answered.isEmpty || model.summary != nil {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Preview my preferences")
                if let summary = model.summary?.result {
                    VStack(alignment: .leading, spacing: 10) {
                        Eyebrow("Draft")
                        Text(summary.overview).foregroundStyle(Color.ink)
                        ForEach(Array(summary.preferences.enumerated()), id: \.offset) { _, rule in
                            PreferenceRow(rule: rule, draft: true)
                        }
                        Text("Draft only — this preview doesn't apply new preferences. Nightly learning applies only well-supported personal exceptions. Change any rating and summarize again to revise it.")
                            .font(.footnote).foregroundStyle(Color.muted)
                    }
                    .plannerCard(.soft)
                }
                Text("Summarizing sends your saved suggestion summaries, authorized source excerpts, ratings and optional reasons to the AI provider. The result is a draft of your preferences, not an active filter.")
                    .font(.footnote).foregroundStyle(Color.muted)
                Button {
                    run { await model.summarize() } success: { nil }
                } label: {
                    Label(model.summary == nil ? "Summarize my feedback" : "Summarize again", systemImage: "text.badge.star").frame(maxWidth: .infinity)
                }
                .buttonStyle(.plannerSecondary)
                .disabled(model.busy || model.answered.isEmpty)
            }
        }
    }

    private func learningSection(_ learning: TrialLearning) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Learn what matters to me")
            VStack(alignment: .leading, spacing: 12) {
                Toggle(isOn: Binding(get: { learning.enabled }, set: { value in
                    run { await model.setLearning(enabled: value) } success: {
                        value ? "Nightly learning is on. New ratings will be considered overnight." : "Nightly learning is paused; your daily brief uses the shared guidance."
                    }
                })) {
                    Text("Nightly learning").font(.headline)
                }
                .disabled(model.busy)
                .tint(Color.plannerAccent)
                Text("With nightly learning and Daily brief on, the AI provider summarizes your rated examples, authorized source excerpts and optional reasons into private preferences. These guide optional suggestions in your brief. Your commitments, important deadlines and reminders stay visible.")
                    .font(.subheadline).foregroundStyle(Color.muted)
                if learning.enabled, store.dailySettings?.enabled == false {
                    Label("Daily brief is off, so nothing is learned yet. Turn it on in Settings → Daily brief.", systemImage: "exclamationmark.circle")
                        .font(.footnote).foregroundStyle(Color.warning)
                }
                Text("Examples expire after 30 days; learned preferences stay until you forget them. A single unexplained vote stays tentative.")
                    .font(.footnote).foregroundStyle(Color.muted)
                Divider().overlay(Color.line)
                if learning.preferences.isEmpty {
                    Text("No established personal exceptions yet. Shared guidance already keeps routine clutter out of your daily brief.")
                        .font(.subheadline).foregroundStyle(Color.ink)
                } else {
                    Text("My learned preferences").font(.subheadline.weight(.semibold))
                    ForEach(Array(learning.preferences.enumerated()), id: \.offset) { _, rule in PreferenceRow(rule: rule, draft: false) }
                    Button("Forget learned preferences", role: .destructive) { confirmForget = true }
                        .buttonStyle(PlannerButtonStyle(kind: .destructive, size: .small))
                        .disabled(model.busy)
                }
            }
            .plannerCard()
        }
    }

    private var deleteSection: some View {
        Button("Delete my ratings", role: .destructive) { confirmClear = true }
            .font(.subheadline)
            .foregroundStyle(Color.danger)
            .disabled(model.busy)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(.rect)
            .padding(.top, 8)
    }

    // MARK: Helpers

    private func icon(_ vote: TrialVote?) -> String {
        switch vote { case .useful: "hand.thumbsup.fill"; case .notUseful: "hand.thumbsdown.fill"; default: "forward.fill" }
    }

    private func tint(_ vote: TrialVote?) -> Color {
        switch vote { case .useful: .plannerAccent; default: .muted }
    }

    private func rate(_ item: TrialItem, _ vote: TrialVote, _ reason: String) async -> Bool {
        let wasChanging = model.changingId != nil
        if let error = await model.rate(item, vote, reason: reason) {
            app.show(error, isError: true)
            return false
        }
        rated += 1
        if wasChanging { app.show("Answer updated.") }
        return true
    }

    private func run(_ action: @escaping () async -> String?, success: @escaping () -> String?) {
        Task {
            if let error = await action() { app.show(error, isError: true) } else if let message = success() { app.show(message) }
        }
    }
}

private struct PreferenceRow: View {
    let rule: TrialPreference
    let draft: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: rule.direction == "prefer" ? "plus.circle.fill" : rule.direction == "avoid" ? "minus.circle.fill" : "questionmark.circle")
                .foregroundStyle(rule.direction == "prefer" ? Color.plannerAccent : Color.muted)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(Text("\(label): ").fontWeight(.semibold))\(rule.pattern)")
                if draft {
                    Text("Based on \(rule.evidenceIds.count) rated example\(rule.evidenceIds.count == 1 ? "" : "s")").font(.caption).foregroundStyle(Color.muted)
                }
            }
        }
        .font(.subheadline)
        .foregroundStyle(Color.ink)
        .accessibilityElement(children: .combine)
    }

    private var label: String {
        switch rule.direction {
        case "prefer": draft ? "Useful" : "Usually include"
        case "avoid": "Usually omit"
        default: "Still uncertain"
        }
    }
}

// MARK: Card stack

private struct TrialCardStack: View {
    let current: TrialItem
    let behind: [TrialItem]
    let busy: Bool
    let isChanging: Bool
    let zone: TimeZone
    let rate: (TrialVote, String) async -> Bool
    let cancelChange: () -> Void

    @State private var offset: CGSize = .zero
    @State private var reason = ""
    @State private var showReason = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let threshold: CGFloat = 110

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                ForEach(Array(behind.enumerated().reversed()), id: \.element.id) { index, item in
                    TrialCard(item: item, zone: zone, reason: .constant(""), showReason: .constant(false), interactive: false)
                        .scaleEffect(1 - CGFloat(index + 1) * 0.04, anchor: .top)
                        .offset(y: CGFloat(index + 1) * 12)
                        .opacity(0.7)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                TrialCard(item: current, zone: zone, reason: $reason, showReason: $showReason, interactive: true)
                    .overlay(alignment: .top) { swipeHint }
                    .offset(offset)
                    .rotationEffect(.degrees(reduceMotion ? 0 : Double(offset.width / 22)))
                    .gesture(drag)
                    .accessibilityAction(named: "Useful") { submit(.useful) }
                    .accessibilityAction(named: "Not useful") { submit(.notUseful) }
                    .accessibilityAction(named: "Skip") { submit(.skip) }
            }
            .padding(.bottom, CGFloat(behind.count) * 12)
            .id(current.id)
            .transition(.asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.96)), removal: .opacity))

            // Side by side when they fit; stacked at the largest text sizes.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { voteButtons }
                VStack(spacing: 10) { voteButtons }
            }
            .disabled(busy)
            HStack {
                Text("Swipe right for Useful, left for Not useful.").font(.caption).foregroundStyle(Color.muted)
                Spacer()
                if isChanging {
                    Button("Cancel change", action: cancelChange)
                        .font(.caption.weight(.semibold))
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                }
            }
        }
        .onAppear { reason = current.reason; showReason = !current.reason.isEmpty }
        .onChange(of: current.id) { _, _ in reason = current.reason; showReason = !current.reason.isEmpty; offset = .zero }
    }

    @ViewBuilder
    private var swipeHint: some View {
        let progress = min(abs(offset.width) / threshold, 1)
        if offset.width != 0 {
            Text(offset.width > 0 ? "USEFUL" : "NOT USEFUL")
                .font(.headline.weight(.heavy)).tracking(1.5)
                .foregroundStyle(offset.width > 0 ? Color.plannerAccent : Color.ink)
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Color.card, in: .capsule)
                .overlay(Capsule().strokeBorder(offset.width > 0 ? Color.plannerAccent : Color.ink, lineWidth: 2))
                .opacity(progress)
                .padding(.top, 14)
                .accessibilityHidden(true)
        }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 20)
            .onChanged { value in
                guard !busy, abs(value.translation.width) > abs(value.translation.height) else { return }
                offset = CGSize(width: value.translation.width, height: value.translation.height * 0.2)
            }
            .onEnded { value in
                guard !busy else { return }
                if value.translation.width > threshold || value.predictedEndTranslation.width > threshold * 2 { submit(.useful) }
                else if value.translation.width < -threshold || value.predictedEndTranslation.width < -threshold * 2 { submit(.notUseful) }
                else { withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) { offset = .zero } }
            }
    }

    @ViewBuilder private var voteButtons: some View {
        voteButton("Not useful", systemImage: "hand.thumbsdown", vote: .notUseful, kind: .secondary)
        voteButton("Skip", systemImage: "forward", vote: .skip, kind: .quiet)
        voteButton("Useful", systemImage: "hand.thumbsup", vote: .useful, kind: .secondary)
    }

    /// The planner's own button styles: glass is for navigation, not content.
    private func voteButton(_ title: String, systemImage: String, vote: TrialVote, kind: PlannerButtonStyle.Kind) -> some View {
        Button { submit(vote) } label: {
            Label(title, systemImage: systemImage)
                .lineLimit(1)
                .fixedSize()
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(PlannerButtonStyle(kind: kind))
        .accessibilityLabel(title)
    }

    private func submit(_ vote: TrialVote) {
        guard !busy else { return }
        let direction: CGFloat = vote == .useful ? 1 : vote == .notUseful ? -1 : 0
        withAnimation(.easeIn(duration: 0.22)) {
            offset = direction == 0 ? CGSize(width: 0, height: -40) : CGSize(width: direction * 520, height: 40)
        }
        Task {
            let ok = await rate(vote, reason)
            if !ok { withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) { offset = .zero } }
        }
    }
}

private struct TrialCard: View {
    let item: TrialItem
    let zone: TimeZone
    @Binding var reason: String
    @Binding var showReason: Bool
    let interactive: Bool
    @State private var showExcerpt = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Eyebrow("Suggested \(PlannerDates.instant(item.observedAt).map { TimeLabels.relativeDay($0, in: zone) } ?? "recently")")
                Spacer()
                if item.value != nil { Badge("Was \(item.value!.label.lowercased())", style: .neutral) }
            }
            Text(item.facts.title).font(.serif(.title2)).foregroundStyle(Color.ink).fixedSize(horizontal: false, vertical: true)
            if let time = item.facts.time {
                DetailRow(systemImage: "calendar", text: TimeLabels.plan(time, in: zone))
            }
            if let location = item.facts.location, !location.isEmpty {
                DetailRow(systemImage: "mappin.and.ellipse", text: location)
            }
            DetailRow(systemImage: "envelope", text: item.source?.sender ?? (item.source?.available == true ? "Your email" : "Original email unavailable"))
            if let notes = item.facts.notes, !notes.isEmpty {
                Text(notes).font(.subheadline).foregroundStyle(Color.ink)
            }
            if !item.facts.preparationTasks.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(item.facts.preparationTasks.enumerated()), id: \.offset) { _, task in
                        Label(task, systemImage: "circle").font(.subheadline).foregroundStyle(Color.ink)
                    }
                }
            }
            if interactive {
                if let excerpt = item.source?.excerpt, !excerpt.isEmpty {
                    DisclosureGroup("Source excerpt", isExpanded: $showExcerpt) {
                        Text(excerpt).font(.footnote).foregroundStyle(Color.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                    }
                    .font(.subheadline)
                }
                DisclosureGroup("Add a reason (optional)", isExpanded: $showReason) {
                    VStack(alignment: .leading, spacing: 4) {
                        TextField("What should we learn?", text: $reason, axis: .vertical)
                            .lineLimit(2...5)
                            .padding(10)
                            .background(Color.paper, in: .rect(cornerRadius: 10))
                            .onChange(of: reason) { _, next in if next.utf16.count > 500 { reason = next.clipped(utf16: 500) } }
                        Text("Choose an answer below to save it with your reason.").font(.caption).foregroundStyle(Color.muted)
                    }
                    .padding(.top, 6)
                }
                .font(.subheadline)
            }
        }
        .plannerCard(padding: 20)
        .shadow(color: .black.opacity(interactive ? 0.08 : 0), radius: 12, y: 6)
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
