import FridgedoorKit
import SwiftUI

/// An add that the server hasn't confirmed yet, shown as a dimmed row. Its `id` is
/// also the add's idempotency key, so retrying the same add can't create a duplicate.
struct PendingListAdd: Identifiable, Equatable {
    let id = UUID().uuidString
    let title: String
    let quantity: String?
    let assigneeId: String?
    let dueTime: String?
}

/// Copy and labels shared by the To do and Groceries screens.
enum ListCopy {
    static func heading(_ kind: ListKind) -> String { kind == .todo ? "To do" : "Groceries" }
    static func addPlaceholder(_ kind: ListKind) -> String { kind == .todo ? "Add a to-do…" : "Add an item…" }
    static func searchPrompt(_ kind: ListKind) -> String { kind == .todo ? "Search to-dos" : "Search groceries" }
    static let sharedNote = "Anything added here shows up for everyone in the household."

    /// List-specific server codes that `PlannerError.userMessage` doesn't phrase.
    static func message(for error: Error) -> String? {
        switch (error as? PlannerError)?.code {
        case "TASK_NOT_OPEN": "This to-do is already done. Reopen it first."
        case "INVALID_SNOOZE_DATE": "Choose a date after today."
        case "ASSIGNEE_NOT_FOUND": "That household member isn't available anymore."
        case "VALIDATION": "Titles can be up to 200 characters and quantities up to 80."
        default: nil
        }
    }

    static func titleWithQuantity(_ item: ListItem) -> String {
        item.quantity.map { "\(item.title) · \($0)" } ?? item.title
    }

    /// Plain-text copy of the open list for the share sheet ("send the list to whoever's at the store").
    static func shareText(_ kind: ListKind, items: [ListItem], zone: TimeZone) -> String {
        var lines = [heading(kind)]
        for item in items {
            var line = "☐ \(item.title)"
            if let quantity = item.quantity { line += " — \(quantity)" }
            if kind == .todo, let due = item.dueDate(in: zone) {
                line += " (due \(TimeLabels.relativeDay(due, in: zone)))"
            }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }
}

extension PlannerStore {
    /// "Assigned to you" / "Assigned to Sam", for rows read by VoiceOver.
    func assigneeLabel(_ id: String) -> String {
        id == member.id ? "Assigned to you" : "Assigned to \(person(id)?.firstName ?? "someone else")"
    }

    /// Everyone who can take a to-do, the signed-in member first.
    var assignablePeople: [HouseholdPerson] {
        let me = household.first { $0.id == member.id } ?? HouseholdPerson(id: member.id, displayName: member.displayName)
        return [me] + household.filter { $0.id != member.id }
    }

    /// "Me (Alex)" for the signed-in member, otherwise the person's display name.
    func assigneeChoice(_ person: HouseholdPerson) -> String {
        person.id == member.id ? "Me (\(person.firstName))" : person.displayName
    }
}

/// A short status line under a to-do title: due, overdue, or back from Later.
struct DueLabel: Equatable {
    enum Tone { case muted, accent, warning }
    let text: String
    let systemImage: String
    let tone: Tone

    static func make(_ item: ListItem, zone: TimeZone, now: Date = .now) -> DueLabel? {
        if item.isSnoozed(in: zone, now: now), let day = PlannerDates.day(item.snoozedUntil, in: zone) {
            return DueLabel(text: "Back \(TimeLabels.relativeDayInSentence(day, in: zone, now: now))", systemImage: "moon.zzz", tone: .muted)
        }
        guard let due = item.dueDate(in: zone) else { return nil }
        let day = TimeLabels.relativeDay(due, in: zone, now: now)
        let when = item.isAllDayDue ? day : "\(day) · \(TimeLabels.time(due, in: zone))"
        switch item.dueState(in: zone, now: now) {
        case .overdue: return DueLabel(text: "Overdue · \(when)", systemImage: "exclamationmark.circle", tone: .warning)
        case .today: return DueLabel(text: item.isAllDayDue ? "Due today" : "Due \(when)", systemImage: "calendar", tone: .accent)
        case .upcoming, .none: return DueLabel(text: "Due \(when)", systemImage: "calendar", tone: .muted)
        }
    }

    var color: Color {
        switch tone { case .muted: .muted; case .accent: .plannerAccent; case .warning: .warning }
    }
}

/// Quick due dates for the add field, in the member timezone.
enum QuickDate: CaseIterable, Identifiable {
    case today, tomorrow, threeDays, sevenDays
    var id: Self { self }
    var days: Int { switch self { case .today: 0; case .tomorrow: 1; case .threeDays: 3; case .sevenDays: 7 } }
    var label: String { switch self { case .today: "Today"; case .tomorrow: "Tomorrow"; case .threeDays: "In 3 days"; case .sevenDays: "In 7 days" } }
    var systemImage: String { switch self { case .today: "sun.max"; case .tomorrow: "sunrise"; case .threeDays: "calendar"; case .sevenDays: "calendar.badge.clock" } }

    func date(from now: Date = .now, in zone: TimeZone) -> Date {
        let calendar = PlannerDates.calendar(zone)
        return calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: now)) ?? now
    }
}

/// Quick picks in the Later sheet. Always after today (the server rejects today).
enum LaterOption: CaseIterable, Identifiable {
    case tomorrow, weekend, nextWeek
    var id: Self { self }
    var label: String { switch self { case .tomorrow: "Tomorrow"; case .weekend: "This weekend"; case .nextWeek: "Next week" } }
    var systemImage: String { switch self { case .tomorrow: "sunrise"; case .weekend: "sofa"; case .nextWeek: "calendar.badge.clock" } }

    func date(from now: Date = .now, in zone: TimeZone) -> Date {
        let calendar = PlannerDates.calendar(zone)
        let today = calendar.startOfDay(for: now)
        let weekday = calendar.component(.weekday, from: today) // 1 = Sunday … 7 = Saturday
        let toMonday = (9 - weekday) % 7
        let days = switch self {
        case .tomorrow: 1
        case .weekend: weekday == 7 ? 1 : 7 - weekday // the coming Saturday (Sunday when it's Saturday)
        case .nextWeek: toMonday == 0 ? 7 : toMonday // the coming Monday
        }
        return calendar.date(byAdding: .day, value: days, to: today) ?? now
    }

    /// The picks that land on different days (on a Friday, "This weekend" is tomorrow).
    static func distinct(from now: Date = .now, in zone: TimeZone) -> [(option: LaterOption, date: Date)] {
        var seen: Set<Date> = []
        return allCases.map { (option: $0, date: $0.date(from: now, in: zone)) }.filter { seen.insert($0.date).inserted }
    }
}

/// When an open to-do is due, for the grouped To do list.
enum TodoBucket: CaseIterable, Identifiable {
    case overdue, today, nextWeek, upcoming, noDate
    var id: Self { self }
    var title: String {
        switch self {
        case .overdue: "Overdue"
        case .today: "Today"
        case .nextWeek: "Next 7 days"
        case .upcoming: "Upcoming"
        case .noDate: "No date"
        }
    }

    static func of(_ item: ListItem, zone: TimeZone, now: Date = .now) -> TodoBucket {
        switch item.dueState(in: zone, now: now) {
        case .overdue: return .overdue
        case .today: return .today
        case .none: return .noDate
        case .upcoming:
            let calendar = PlannerDates.calendar(zone)
            guard let due = item.dueDate(in: zone),
                  let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: due)).day
            else { return .upcoming }
            return days <= 7 ? .nextWeek : .upcoming
        }
    }
}

/// Whose to-dos to show.
enum ListFilter: Hashable {
    case everyone, mine, person(String)

    func includes(_ item: ListItem, me: String) -> Bool {
        switch self {
        case .everyone: true
        case .mine: item.assigneeId == me
        case .person(let id): item.assigneeId == id
        }
    }
}

/// How open groceries are ordered.
enum GrocerySort: String, CaseIterable, Identifiable {
    case aisles, recent
    var id: Self { self }
    var label: String { self == .aisles ? "Aisles" : "Recent" }
}

extension AppModel {
    /// Shows a list mutation failure, with list-specific copy when the server code has one.
    func showListError(_ error: Error) {
        if let message = ListCopy.message(for: error) { show(message, isError: true) } else { show(error) }
    }
}

/// The round completion control: an empty circle that fills with a bounce.
struct CheckCircle: View {
    let checked: Bool
    var body: some View {
        Image(systemName: checked ? "checkmark.circle.fill" : "circle")
            .font(.title2)
            .foregroundStyle(checked ? Color.plannerAccent : Color.muted)
            .contentTransition(.symbolEffect(.replace))
            .symbolEffect(.bounce, value: checked)
            .frame(width: 44, height: 44)
            .contentShape(.rect)
    }
}
