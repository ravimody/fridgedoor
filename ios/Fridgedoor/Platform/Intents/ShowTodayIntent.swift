import AppIntents
import Foundation
import FridgedoorKit
import SwiftUI

/// Today or tomorrow, for "What's on tomorrow in Fridgedoor".
enum PlannerDay: String, AppEnum {
    case today, tomorrow
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Day"
    static let caseDisplayRepresentations: [PlannerDay: DisplayRepresentation] = [.today: "today", .tomorrow: "tomorrow"]
}

/// "What's on today in Fridgedoor": a spoken summary plus a snippet card (today or tomorrow).
struct ShowTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "What's On"
    static let description = IntentDescription("Shows what's left today (or what's on tomorrow) on the household agenda, with open to-dos and groceries.", categoryName: "Today")
    /// Reads or changes household data, so Siri asks for Face ID / passcode on a locked phone.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Day", default: .today) var day: PlannerDay

    static var parameterSummary: some ParameterSummary { Summary("What's on \(\.$day)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        guard let client = await PlatformSession.client() else {
            return .result(dialog: IntentSupport.signedOutDialog, view: TodaySnippetView(snapshot: nil, now: .now, day: day))
        }
        let snapshot: WidgetSnapshot
        if let store = PlatformSession.store, store.hasLoaded, let refreshed = store.lastRefreshedAt, Date.now.timeIntervalSince(refreshed) < 120 {
            snapshot = PlatformData(store: store).snapshot()
        } else {
            do { snapshot = try await PlatformData.fetch(client).snapshot() }
            catch { throw IntentFailure(error) }
        }
        let now = Date.now
        return .result(dialog: IntentDialog(stringLiteral: Self.spoken(snapshot, now: now, day: day)), view: TodaySnippetView(snapshot: snapshot, now: now, day: day))
    }

    /// What's left today, or everything on tomorrow (the snapshot covers both days).
    static func items(_ snapshot: WidgetSnapshot, now: Date, day: PlannerDay) -> [WidgetSnapshot.Entry] {
        guard day == .tomorrow else { return snapshot.remaining(at: now) }
        guard let tomorrow = snapshot.calendar.date(byAdding: .day, value: 1, to: snapshot.calendar.startOfDay(for: now)) else { return [] }
        // Open to-dos from earlier days belong to today, not tomorrow.
        return snapshot.entries.filter { snapshot.entry($0, isOn: tomorrow) && ($0.start ?? .distantPast) >= tomorrow }
    }

    static func spoken(_ snapshot: WidgetSnapshot, now: Date, day: PlannerDay = .today) -> String {
        let remaining = items(snapshot, now: now, day: day)
        let zone = snapshot.timeZone
        func phrase(_ entry: WidgetSnapshot.Entry) -> String {
            guard !entry.allDay, let start = entry.start else { return displayTitle(entry) }
            return "\(displayTitle(entry)) at \(start.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone)))"
        }
        guard !remaining.isEmpty else {
            if day == .tomorrow { return "Nothing on the agenda for tomorrow yet." }
            if let next = snapshot.nextLater(than: now) { return "Nothing else today. Tomorrow starts with \(phrase(next))." }
            return "Nothing else on today's agenda."
        }
        if day == .tomorrow {
            let named = remaining.prefix(3).map(phrase)
            let list = named.count > 1 ? named.dropLast().joined(separator: ", ") + " and " + named.last! : named[0]
            let more = remaining.count > 3 ? ", plus \(remaining.count - 3) more" : ""
            return remaining.count == 1 ? "One thing tomorrow: \(list)." : "\(remaining.count) things tomorrow: \(list)\(more)."
        }
        let named = remaining.prefix(3).map(phrase)
        let list = named.count > 1 ? named.dropLast().joined(separator: ", ") + " and " + named.last! : named[0]
        let more = remaining.count > 3 ? ", plus \(remaining.count - 3) more" : ""
        return remaining.count == 1 ? "One thing left today: \(list)." : "\(remaining.count) things left today: \(list)\(more)."
    }

    /// Siri may read the result aloud or show it to others, so private entries never use their title.
    static func displayTitle(_ entry: WidgetSnapshot.Entry) -> String {
        guard entry.isPrivate == true else { return entry.title }
        return entry.kind == "reminder" ? "Private reminder" : "Private plan"
    }
}

/// Snippet card shown by Siri / Shortcuts, in the Linen & Teal style.
struct TodaySnippetView: View {
    let snapshot: WidgetSnapshot?
    let now: Date
    var day: PlannerDay = .today

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let snapshot {
                let zone = snapshot.timeZone
                let shown = day == .tomorrow ? snapshot.calendar.date(byAdding: .day, value: 1, to: now) ?? now : now
                Text(shown.formatted(Date.FormatStyle(timeZone: zone).weekday(.wide).month(.wide).day()).uppercased())
                    .font(.caption2.weight(.bold)).tracking(1.4).foregroundStyle(Color.plannerAccent)
                let remaining = ShowTodayIntent.items(snapshot, now: now, day: day)
                if remaining.isEmpty {
                    Text(day == .tomorrow ? "Nothing planned yet" : "Nothing else today").font(.serif(.title3)).foregroundStyle(Color.ink)
                } else {
                    ForEach(remaining.prefix(6)) { entry in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(label(entry, zone: zone))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(Color.muted)
                                .frame(minWidth: 64, alignment: .leading)
                            Text(ShowTodayIntent.displayTitle(entry)).font(.subheadline).foregroundStyle(Color.ink).lineLimit(2)
                        }
                    }
                    if remaining.count > 6 { Text("+\(remaining.count - 6) more").font(.caption).foregroundStyle(Color.muted) }
                }
                HStack(spacing: 14) {
                    Label("\(snapshot.openTodoCount) to-dos", systemImage: "checklist")
                    Label("\(snapshot.openGroceryCount) groceries", systemImage: "basket")
                    if snapshot.attentionCount > 0 { Label("\(snapshot.attentionCount) to decide", systemImage: "sparkles").foregroundStyle(Color.attentionInk) }
                }
                .font(.caption)
                .foregroundStyle(Color.muted)
                .padding(.top, 4)
            } else {
                Label("Open Fridgedoor and sign in first.", systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.subheadline).foregroundStyle(Color.ink)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(_ entry: WidgetSnapshot.Entry, zone: TimeZone) -> String {
        if entry.kind == "task" { return (entry.start ?? now) < PlannerDates.calendar(zone).startOfDay(for: now) ? "Earlier" : "Any time" }
        if entry.allDay { return "All day" }
        return entry.start?.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone)) ?? ""
    }
}
