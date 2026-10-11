import EventKit
import EventKitUI
import FridgedoorKit
import SwiftUI

/// Prefilled event for "Add to Apple Calendar". This is a personal copy on the
/// iPhone, separate from the household Google Calendar write.
struct AppleCalendarDraft: Identifiable {
    let id = UUID()
    let title: String
    let location: String?
    let notes: String?
    let start: Date
    let end: Date
    let isAllDay: Bool
    let timeZone: TimeZone

    /// Nil when the plan has no usable date yet.
    init?(facts: PlanFacts, memberZone: TimeZone) {
        let zone = facts.time?.timezoneIdentifier.flatMap(TimeZone.init(identifier:)) ?? memberZone
        switch facts.time {
        case let .timed(start, end, _)?:
            guard let s = PlannerDates.instant(start) else { return nil }
            self.start = s; self.end = PlannerDates.instant(end) ?? s.addingTimeInterval(3600); isAllDay = false
        case let .allDay(startDate, endDateExclusive)?:
            // EventKit all-day events are floating: they read their dates in the phone's
            // current zone, so use midnight of the same calendar dates there.
            let local = PlannerDates.calendar(.current)
            guard let s = PlannerDates.day(startDate, in: .current) else { return nil }
            // EventKit all-day ends are inclusive.
            let exclusive = PlannerDates.day(endDateExclusive, in: .current) ?? s
            self.start = s; self.end = max(s, local.date(byAdding: .second, value: -1, to: exclusive) ?? s); isAllDay = true
        case let .deadline(at, _)?:
            guard let due = PlannerDates.instant(at) else { return nil }
            self.start = due.addingTimeInterval(-1800); self.end = due; isAllDay = false
        case let .unresolved(dateHint, startHint, _)?:
            if let s = PlannerDates.instant(startHint) {
                self.start = s; self.end = s.addingTimeInterval(3600); isAllDay = false
            } else if let day = PlannerDates.day(dateHint, in: .current) { // all-day: floating, see above
                self.start = day; self.end = day; isAllDay = true
            } else { return nil }
        case nil:
            return nil
        }
        title = facts.time?.isDeadline == true ? "Due: \(facts.title)" : facts.title
        location = facts.location
        notes = facts.notes
        timeZone = zone
    }
}

/// `EKEventEditViewController` runs out of process on iOS 17+, so adding an
/// event this way needs no calendar permission prompt.
struct AppleCalendarEditor: UIViewControllerRepresentable {
    let draft: AppleCalendarDraft
    let onFinish: (EKEventEditViewAction) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = draft.title
        event.location = draft.location
        event.notes = draft.notes
        event.isAllDay = draft.isAllDay
        event.timeZone = draft.isAllDay ? nil : draft.timeZone
        event.startDate = draft.start
        event.endDate = draft.end
        let controller = EKEventEditViewController()
        controller.eventStore = store
        controller.event = event
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {}

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let onFinish: (EKEventEditViewAction) -> Void
        init(onFinish: @escaping (EKEventEditViewAction) -> Void) { self.onFinish = onFinish }
        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            onFinish(action)
        }
    }
}
