import FridgedoorKit
import SwiftUI

/// The one screen most people need: this morning's brief, what's waiting on a
/// decision, then what's left today.
struct TodayView: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        Group {
            if let payload = model.payload {
                TimelineView(.everyMinute) { context in
                    TodayList(payload: payload, now: context.date)
                }
            } else {
                SetupView(signedOut: model.phase == .signedOut)
            }
        }
        .navigationTitle("Today")
        .alert("Not done", isPresented: Binding(get: { model.failure != nil }, set: { if !$0 { model.failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.failure ?? "")
        }
    }
}

private struct TodayList: View {
    let payload: WatchPayload
    let now: Date

    private var snapshot: WidgetSnapshot { payload.snapshot }

    var body: some View {
        let remaining = snapshot.remaining(at: now)
        List {
            if let brief = payload.brief {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Brief · \(WatchTime.clock(brief.generatedAt, in: snapshot.timeZone))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Text(brief.summary)
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }
            }

            if payload.decisionCount > 0 {
                Section {
                    NavigationLink {
                        DecisionsView()
                    } label: {
                        Label(payload.decisionCount == 1 ? "1 decision" : "\(payload.decisionCount) decisions", systemImage: "questionmark.bubble")
                            .font(.headline)
                            .foregroundStyle(Color.attentionInk)
                    }
                    .listRowBackground(Color.attention.clipShape(.rect(cornerRadius: 12)))
                }
            }

            Section {
                if remaining.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Nothing else today")
                        if let next = snapshot.nextLater(than: now) {
                            Text("Tomorrow · \(WatchTime.label(next, in: snapshot.timeZone)) \(next.title)")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    ForEach(remaining) { entry in
                        EntryRow(entry: entry, zone: snapshot.timeZone, now: now)
                    }
                }
            } header: {
                Text("Today")
            } footer: {
                Text(snapshot.isStale(at: now)
                     ? "Updated \(WatchTime.updated(snapshot.generatedAt, in: snapshot.timeZone, now: now)). Open Fridgedoor on your iPhone to catch up."
                     : "Updated \(WatchTime.updated(snapshot.generatedAt, in: snapshot.timeZone, now: now))")
                    .foregroundStyle(snapshot.isStale(at: now) ? Color.warning : .secondary)
            }
        }
    }
}

private struct EntryRow: View {
    let entry: WidgetSnapshot.Entry
    let zone: TimeZone
    let now: Date

    private var happening: Bool {
        guard !entry.allDay, entry.kind == "event", let start = entry.start, let end = entry.end else { return false }
        return start <= now && now < end
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                if entry.kind == "reminder" { Image(systemName: "bell") }
                if entry.kind == "task" { Image(systemName: "circle") }
                Text(happening ? "Now" : WatchTime.label(entry, in: zone))
                if entry.isPrivate == true { Image(systemName: "lock.fill").accessibilityLabel("Only you") }
            }
            .font(.footnote)
            .foregroundStyle(happening ? Color.plannerAccent : .secondary)
            Text(entry.title)
                .font(.body)
                .lineLimit(3)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Before the iPhone has sent anything, or after signing out there.
private struct SetupView: View {
    let signedOut: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Image(systemName: "iphone")
                    .font(.title2)
                    .foregroundStyle(Color.plannerAccent)
                Text(signedOut ? "Signed out" : "Open Fridgedoor on your iPhone")
                    .font(.headline)
                    .multilineTextAlignment(.center)
                Text(signedOut
                     ? "Sign in to Fridgedoor on your iPhone to see your day here."
                     : "Your brief, decisions and today’s plans show up here once the iPhone app is set up.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 8)
        }
    }
}

/// Times as the iPhone shows them, in the household member's timezone.
enum WatchTime {
    static func clock(_ date: Date, in zone: TimeZone) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone))
    }

    static func label(_ entry: WidgetSnapshot.Entry, in zone: TimeZone) -> String {
        guard let start = entry.start else { return "" }
        if entry.allDay { return entry.kind == "task" ? "To-do" : "All day" }
        return clock(start, in: zone)
    }

    static func updated(_ date: Date, in zone: TimeZone, now: Date) -> String {
        let calendar = PlannerDates.calendar(zone)
        if calendar.isDate(date, inSameDayAs: now) { return clock(date, in: zone) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "yesterday \(clock(date, in: zone))" }
        return date.formatted(Date.FormatStyle(timeZone: zone).weekday(.abbreviated).hour().minute())
    }
}
