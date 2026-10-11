import EventKit
import EventKitUI
import FridgedoorKit
import SwiftUI

/// Something Home can copy into the phone's own calendar or share as text.
/// Adding to Apple Calendar uses the system editor, which needs no calendar
/// permission (iOS 17+) and never touches the household Google calendar.
struct CalendarDraft: Identifiable {
    let id = UUID()
    let title: String
    let time: NormalizedTime
    let location: String?
    let notes: String?

    init?(title: String, time: NormalizedTime?, location: String? = nil, notes: String? = nil) {
        guard let time else { return nil }
        switch time {
        case .timed, .allDay, .deadline: break
        case .unresolved: return nil
        }
        self.title = title; self.time = time; self.location = location; self.notes = notes
    }

    @MainActor
    func event(in store: EKEventStore, zone: TimeZone) -> EKEvent {
        let event = EKEvent(eventStore: store)
        event.title = title
        event.location = location
        event.notes = notes
        event.timeZone = zone
        switch time {
        case let .timed(start, end, _):
            event.startDate = PlannerDates.instant(start)
            event.endDate = PlannerDates.instant(end) ?? event.startDate
        case let .allDay(startDate, endDateExclusive):
            // All-day events are floating and read in the phone's current zone, so use
            // midnight of the same calendar dates there, not midnight in `zone`.
            event.isAllDay = true
            event.timeZone = nil
            event.startDate = PlannerDates.day(startDate, in: .current)
            event.endDate = PlannerDates.day(endDateExclusive, in: .current)?.addingTimeInterval(-1) ?? event.startDate
        case let .deadline(at, _):
            event.startDate = PlannerDates.instant(at)
            event.endDate = event.startDate?.addingTimeInterval(30 * 60)
        case .unresolved: break
        }
        return event
    }
}

/// Plain-text summary for the share sheet: title, time and place.
func shareText(title: String, time: NormalizedTime?, location: String?, zone: TimeZone) -> String {
    [title, time.map { TimeLabels.plan($0, in: zone) }, location?.nilIfBlank].compactMap { $0 }.joined(separator: "\n")
}

struct CalendarEventEditor: UIViewControllerRepresentable {
    let draft: CalendarDraft
    let zone: TimeZone
    var onFinish: (EKEventEditViewAction) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let controller = EKEventEditViewController()
        let store = EKEventStore()
        controller.eventStore = store
        controller.event = draft.event(in: store, zone: zone)
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, @preconcurrency EKEventEditViewDelegate {
        let onFinish: (EKEventEditViewAction) -> Void
        init(onFinish: @escaping (EKEventEditViewAction) -> Void) { self.onFinish = onFinish }
        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            onFinish(action)
        }
    }
}
