import FridgedoorKit
import SwiftUI

/// Home: a greeting, a seven-day picker in the member's timezone, then the
/// selected day. Today adds the morning brief, Decisions, routine review cards and
/// "On the horizon" (the schedule leads in the evening); other days never repeat
/// today's brief. See `docs/features/home-design.md` and the web `features/Home/Home.tsx`.
struct HomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @State private var home: HomeState?

    var body: some View {
        Group {
            if let home {
                HomeContent().environment(home)
            } else {
                Color.paper.ignoresSafeArea()
            }
        }
        .onAppear { if home == nil { home = HomeState(app: app, store: store) } }
    }
}

private struct HomeContent: View {
    @Environment(AppModel.self) private var app
    @Environment(PlannerStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(HomeState.self) private var home
    @Environment(\.scenePhase) private var scenePhase

    @State private var selectedDay: Date?
    @State private var now = Date.now
    @State private var forward = true
    @State private var showsCompactTitle = false

    var body: some View {
        @Bindable var home = home
        let snapshot = HomeSnapshot(store: store, selectedDay: selectedDay, now: now)
        let todaySnapshot = snapshot.isToday ? snapshot : HomeSnapshot(store: store, selectedDay: nil, now: now)
        let todayScheduleCount = todaySnapshot.schedule.count

        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HomeHeader(member: store.member, now: now, decisionCount: todaySnapshot.decisionCount,
                           scheduleCount: todayScheduleCount, nextUp: todaySnapshot.nextUp(after: now, zone: store.timeZone),
                           isLoaded: store.hasLoaded)
                    .padding(.top, 4)

                DayPicker(days: snapshot.days, today: snapshot.today, selection: daySelection(snapshot),
                          dayLoad: snapshot.dayLoad, zone: store.timeZone)
                    .padding(.top, 22)
                    .padding(.bottom, 8)

                if let error = store.refreshError {
                    OfflineBanner(error: error, lastRefreshedAt: store.lastRefreshedAt) { Task { await store.refresh() } }
                        .padding(.top, 12)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                if !store.hasLoaded {
                    HomeSkeleton().padding(.top, 20)
                } else {
                    ZStack(alignment: .top) {
                        DayContent(snapshot: snapshot, now: now) { withAnimation(.snappy) { forward = false; selectedDay = nil } }
                            .id(PlannerDates.dayString(snapshot.day, in: store.timeZone))
                            .transition(.asymmetric(
                                insertion: .offset(x: forward ? 36 : -36).combined(with: .opacity),
                                removal: .opacity.animation(.easeOut(duration: 0.12))
                            ))
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
            .animation(.smooth, value: store.refreshError)
        }
        .scrollDismissesKeyboard(.interactively)
        .onScrollGeometryChange(for: Bool.self, of: { $0.contentOffset.y + $0.contentInsets.top > 70 }) { _, past in
            withAnimation(.easeInOut(duration: 0.2)) { showsCompactTitle = past }
        }
        .plannerBackground()
        .refreshable { await store.refresh() }
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(snapshot.isToday ? "Today" : TimeLabels.relativeDay(snapshot.day, in: store.timeZone))
                    .font(.headline)
                    .foregroundStyle(Color.ink)
                    .opacity(showsCompactTitle ? 1 : 0)
                    .accessibilityHidden(!showsCompactTitle)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { router.open(.settings) } label: { PersonAvatar(personId: store.member.id, size: 30).accessibilityHidden(true) }
                    .accessibilityLabel("Settings")
            }
        }
        .sheet(item: $home.calendarDraft) { draft in
            CalendarEventEditor(draft: draft, zone: store.timeZone) { action in
                home.calendarDraft = nil
                if action == .saved { app.show("Added to your calendar.") }
            }
            .ignoresSafeArea()
        }
        .sheet(item: $home.datePickerTask) { task in
            SnoozeDateSheet(task: task, zone: store.timeZone) { date in home.snooze(task, to: date) }
        }
        .onChange(of: todaySnapshot.answeredByDecision, initial: true) { _, folded in store.foldedClarifications.formUnion(folded) }
        .sensoryFeedback(.success, trigger: home.completedCount)
        .sensoryFeedback(.impact(weight: .medium), trigger: home.dismissedCount)
        .task {
            // Keep "today", the greeting and the now-marker current.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                now = .now
            }
        }
        .task(id: store.dailyOverview?.errorCode == "DAILY_OVERVIEW_UPDATING") {
            // The server is regenerating the review; check back until it lands.
            while !Task.isCancelled, store.dailyOverview?.errorCode == "DAILY_OVERVIEW_UPDATING" {
                try? await Task.sleep(for: .seconds(4))
                await store.refresh([.dailyOverview, .clarifications])
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { now = .now } }
        .task(id: home.morningUndo) {
            guard let receipt = home.morningUndo else { return }
            try? await Task.sleep(for: .seconds(max(0, receipt.expiresAt.timeIntervalSinceNow)))
            if home.morningUndo == receipt { home.morningUndo = nil }
        }
    }

    private func daySelection(_ snapshot: HomeSnapshot) -> Binding<Date> {
        Binding(
            get: { snapshot.day },
            set: { day in
                forward = day > snapshot.day
                selectedDay = day == snapshot.today ? nil : day
            }
        )
    }
}

/// The selected day's modules. Re-created (and transitioned) when the day changes.
private struct DayContent: View {
    let snapshot: HomeSnapshot
    let now: Date
    var backToToday: () -> Void
    @Environment(PlannerStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(HomeState.self) private var home

    /// After 4 PM the rest of the day matters more than the morning's brief.
    private var isEvening: Bool { snapshot.isToday && store.calendar.component(.hour, from: now) >= 16 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if snapshot.isToday {
                if isEvening {
                    schedule
                    DecisionsSection(snapshot: snapshot)
                    brief
                } else {
                    brief
                    DecisionsSection(snapshot: snapshot)
                    schedule
                }
            } else {
                if !snapshot.attention.isEmpty || !snapshot.clarifications.isEmpty {
                    backToTodayLink.padding(.top, 14)
                }
                schedule
            }

            if !snapshot.reminders.isEmpty {
                HomeModuleHeading(title: "Reminders", note: "Just for you")
                VStack(spacing: 10) {
                    ForEach(snapshot.reminders) { reminder in
                        ReminderCard(reminder: reminder, title: title(for: reminder), now: now).transition(.reviewCard)
                    }
                }
                .animation(.smooth, value: snapshot.reminders.map(\.id))
            }

            if snapshot.isToday, !snapshot.upcoming.isEmpty {
                HomeModuleHeading(title: "On the horizon", note: "Worth a look")
                VStack(spacing: 12) {
                    ForEach(snapshot.upcoming) { item in
                        ReviewCard(item: item).transition(.reviewCard)
                    }
                }
                .animation(.smooth, value: snapshot.upcoming.map(\.id))
            }

            if snapshot.isToday, home.morningUndo != nil {
                MorningUndoBar().padding(.top, 16).transition(.opacity)
            }
        }
        .animation(.smooth, value: home.morningUndo)
    }

    @ViewBuilder private var schedule: some View {
        HomeModuleHeading(title: snapshot.isToday ? (isEvening ? "Tonight" : "Today") : snapshot.day.formatted(Date.FormatStyle(timeZone: store.timeZone).weekday(.wide)),
                          note: snapshot.isToday ? nil : snapshot.day.formatted(Date.FormatStyle(timeZone: store.timeZone).month(.abbreviated).day()))
        if snapshot.schedule.isEmpty {
            EmptyState(systemImage: snapshot.isToday ? "sun.max" : "calendar",
                       title: snapshot.isToday ? "Nothing scheduled today" : "Nothing scheduled",
                       message: snapshot.isToday ? "Calendar events, saved plans and dated to-dos show up here." : nil)
        } else {
            AgendaTimeline(entries: snapshot.schedule, day: snapshot.day, isToday: snapshot.isToday, now: now, zone: store.timeZone, foldsPast: isEvening)
                .animation(.smooth, value: snapshot.schedule.map(\.id))
        }
        if snapshot.isToday, !snapshot.routine.isEmpty {
            VStack(spacing: 12) {
                ForEach(snapshot.routine) { item in
                    ReviewCard(item: item).transition(.reviewCard)
                }
            }
            .padding(.top, 14)
            .animation(.smooth, value: snapshot.routine.map(\.id))
        }
    }

    /// The morning brief: its status line, any notice, and the summary.
    @ViewBuilder private var brief: some View {
        if let overview = store.dailyOverview {
            ReviewStatusLine(overview: overview).padding(.top, 12)
            if overview.state == "unavailable" {
                ReviewNotice(overview: overview).padding(.top, 12)
            } else if overview.state == "fallback" {
                AIOffNotice().padding(.top, 12)
            }
        }
        if let summary = HomeSnapshot.summary(store.dailyOverview) {
            MorningSummary(text: summary).padding(.top, 12)
        }
    }

    private var backToTodayLink: some View {
        let count = snapshot.attention.count + snapshot.clarifications.count
        return Button(action: backToToday) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                Text("\(count) \(count == 1 ? "item needs" : "items need") your attention today")
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "arrow.uturn.backward")
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.attentionInk)
            .padding(14)
            .background(Color.attention, in: .rect(cornerRadius: 14, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(CardPressStyle())
        .accessibilityHint("Shows today")
    }

    private func title(for reminder: Reminder) -> String {
        reminder.title ?? store.plan(reminder.parentId)?.facts.title ?? store.listItem(reminder.parentId)?.title ?? "Household reminder"
    }
}

// MARK: - Pieces

private struct MorningSummary: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 1.5).fill(Color.attentionInk.opacity(0.5)).frame(width: 3)
            Text(text)
                .font(.callout)
                .lineSpacing(3)
                .foregroundStyle(Color.ink.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Brief: \(text)")
    }
}

/// The AI review couldn't be shown (updating, daily limit, changed plans, failure).
private struct ReviewNotice: View {
    let overview: DailyView
    @Environment(HomeState.self) private var home
    @Environment(PlannerStore.self) private var store

    private var updating: Bool { overview.errorCode == "DAILY_OVERVIEW_UPDATING" || home.refreshingReview }
    private var canRefresh: Bool { store.dailySettings?.enabled == true && !updating && overview.errorCode != "DAILY_AI_LIMIT" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                if updating { ProgressView().controlSize(.small) } else { Image(systemName: "info.circle") }
                Text(overview.result?.summary ?? "Your brief isn’t available right now. Your schedule is still below.")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if canRefresh {
                Button("Refresh brief", systemImage: "arrow.clockwise") { home.refreshReview() }
                    .buttonStyle(PlannerButtonStyle(kind: .secondary, size: .small))
            }
        }
        .foregroundStyle(Color.ink)
        .plannerCard(.soft, padding: 14)
    }
}

/// Daily AI is off: the agenda, to-dos and reminders still work; the review is a plain list.
private struct AIOffNotice: View {
    @Environment(Router.self) private var router

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkles").foregroundStyle(Color.muted)
            VStack(alignment: .leading, spacing: 4) {
                Text("The morning brief is off").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                Text("Your schedule, to-dos and reminders still appear here.").font(.footnote).foregroundStyle(Color.muted)
            }
            Spacer(minLength: 0)
            Button("Settings") { router.open(.settings) }
                .buttonStyle(PlannerButtonStyle(kind: .quiet, size: .small))
        }
        .plannerCard(.soft, padding: 14)
    }
}

/// Persistent Undo for the last brief dismissal (the toast only lasts a few seconds).
private struct MorningUndoBar: View {
    @Environment(HomeState.self) private var home

    var body: some View {
        HStack {
            Image(systemName: "eye.slash").foregroundStyle(Color.muted)
            Text("Dismissed from your brief").font(.subheadline).foregroundStyle(Color.ink)
            Spacer()
            Button("Undo") { home.undoDismiss() }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.plannerAccent)
                .disabled(home.isBusy("undo"))
        }
        .plannerCard(.plain, padding: 14)
    }
}

/// Shown when every request in the last refresh failed.
private struct OfflineBanner: View {
    let error: PlannerError
    let lastRefreshedAt: Date?
    var retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: error.code == "OFFLINE" ? "wifi.slash" : "exclamationmark.triangle")
                .foregroundStyle(Color.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text(error.userMessage).font(.subheadline).foregroundStyle(Color.ink)
                if let lastRefreshedAt {
                    Text("Showing what was loaded \(lastRefreshedAt.formatted(.relative(presentation: .named))).")
                        .font(.caption).foregroundStyle(Color.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Retry", action: retry).font(.subheadline.weight(.semibold)).foregroundStyle(Color.plannerAccent)
        }
        .plannerCard(.soft, padding: 12)
    }
}

/// Placeholder layout while the first refresh is in flight.
private struct HomeSkeleton: View {
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Brief · 7:00 AM").font(.footnote)
            Text("A few things on today, some coming up, and one question for you.").font(.callout)
            Text("Today").font(.serif(.title2)).padding(.top, 14)
            ForEach(0..<4, id: \.self) { index in
                HStack(alignment: .top, spacing: 16) {
                    Text("9:30 AM").font(.caption).frame(width: 58, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(index.isMultiple(of: 2) ? "School drop-off" : "Lunch with a friend").font(.subheadline.weight(.semibold))
                        Text("7:45 – 8:15 AM · Brookside").font(.caption)
                    }
                    .plannerCard(.plain, padding: 14)
                }
            }
        }
        .redacted(reason: .placeholder)
        .opacity(pulse ? 0.45 : 0.9)
        .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
        .accessibilityElement()
        .accessibilityLabel("Loading your day")
    }
}

extension AnyTransition {
    static var reviewCard: AnyTransition {
        .asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.97, anchor: .top)),
                    removal: .opacity.combined(with: .move(edge: .leading)))
    }
}
