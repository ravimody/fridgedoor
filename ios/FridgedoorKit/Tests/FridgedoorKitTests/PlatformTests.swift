import Foundation
import Testing
@testable import FridgedoorKit

/// Widget snapshot and local-notification schedule (iOS platform integrations).
@Suite struct PlatformTests {
    let zone = TimeZone(identifier: "America/New_York")!
    let member = Member(id: "m1", householdId: "h1", displayName: "Alex Rivera", timezone: "America/New_York")
    // 2026-10-10 10:00 New York.
    let now = PlannerDates.instant("2026-10-10T14:00:00Z")!

    func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(json.utf8)) }

    var plans: [PlanSummary] {
        get throws {
            try decode([PlanSummary].self, """
            [{"id":"p1","revision":1,"visibility":"shared","status":"accepted","facts":{"title":"Dinner with the Okafors","category":"social","participants":[],"time":{"kind":"timed","start":"2026-10-10T19:00:00-04:00","end":"2026-10-10T21:00:00-04:00","timezone":"America/New_York"},"preparationTasks":[],"unresolvedFields":[]},"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z","sourceSummary":{"kind":"email","count":1,"available":true},"possibleDuplicate":false},
             {"id":"p2","revision":3,"visibility":"private","status":"accepted","facts":{"title":"Therapy","category":"health","participants":[],"time":{"kind":"timed","start":"2026-10-11T09:00:00-04:00","end":"2026-10-11T10:00:00-04:00","timezone":"America/New_York"},"preparationTasks":[],"unresolvedFields":[]},"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z","sourceSummary":{"kind":"email","count":1,"available":true},"possibleDuplicate":false},
             {"id":"p3","revision":1,"visibility":"shared","status":"proposed","facts":{"title":"Bake sale","category":"school","participants":[],"preparationTasks":[],"unresolvedFields":[]},"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z","sourceSummary":{"kind":"email","count":1,"available":true},"possibleDuplicate":false}]
            """)
        }
    }

    var agenda: [AgendaItem] {
        get throws {
            try decode([AgendaItem].self, """
            [{"id":"a1","title":"Gym","time":{"kind":"timed","start":"2026-10-10T06:30:00-04:00","end":"2026-10-10T07:15:00-04:00","timezone":"America/New_York"},"status":"confirmed","visibility":"owner","origin":"your private calendar"},
             {"id":"a2","planId":"p1","title":"Dinner with the Okafors","time":{"kind":"timed","start":"2026-10-10T19:00:00-04:00","end":"2026-10-10T21:00:00-04:00","timezone":"America/New_York"},"status":"confirmed","visibility":"shared","origin":"household calendar"},
             {"id":"a3","title":"Recycling pickup","time":{"kind":"all_day","startDate":"2026-10-10","endDateExclusive":"2026-10-11"},"status":"confirmed","visibility":"shared","origin":"household calendar"},
             {"id":"a4","title":"Next week","time":{"kind":"all_day","startDate":"2026-10-17","endDateExclusive":"2026-10-18"},"status":"confirmed","visibility":"shared","origin":"household calendar"}]
            """)
        }
    }

    var todos: [ListItem] {
        get throws {
            try decode([ListItem].self, """
            [{"id":"t1","kind":"todo","title":"Pay the water bill","dueTime":"2026-10-10","revision":1,"createdAt":"2026-10-01T00:00:00Z"},
             {"id":"t2","kind":"todo","title":"Return library books","dueTime":"2026-10-08","revision":1,"createdAt":"2026-10-01T00:00:00Z"},
             {"id":"t3","kind":"todo","title":"Done already","dueTime":"2026-10-10","completedAt":"2026-10-10T12:00:00Z","revision":2,"createdAt":"2026-10-01T00:00:00Z"},
             {"id":"t4","kind":"todo","title":"Someday","revision":1,"createdAt":"2026-10-01T00:00:00Z"}]
            """)
        }
    }

    var reminders: [Reminder] {
        get throws {
            try decode([Reminder].self, """
            [{"id":"r1","parentType":"plan","parentId":"p1","dueAt":"2026-10-10T17:00:00-04:00","revision":2,"state":"active","title":"Dinner with the Okafors"},
             {"id":"r2","parentType":"plan","parentId":"p2","dueAt":"2026-10-11T08:00:00-04:00","revision":1,"state":"active","title":"Therapy"},
             {"id":"r3","parentType":"list_item","parentId":"t1","dueAt":"2026-10-10T08:00:00-04:00","revision":1,"state":"active","title":"Pay the water bill"},
             {"id":"r4","parentType":"list_item","parentId":"g1","dueAt":"2026-10-12T08:00:00-04:00","revision":1,"state":"completed","title":"Milk"}]
            """)
        }
    }

    @Test func snapshotCoversTodayAndTomorrowWithCounts() throws {
        let snapshot = WidgetSnapshotBuilder.build(member: member, plans: try plans, agenda: try agenda, todos: try todos, groceries: [], reminders: try reminders, now: now)
        let ids = snapshot.entries.map(\.id)
        #expect(ids.contains("agenda:a1"))
        #expect(!ids.contains("agenda:a4"))           // next week is outside the window
        #expect(ids.contains("plan:p2"))              // accepted, kept off the calendar
        #expect(!ids.contains("plan:p1"))             // already on the agenda as a2
        #expect(ids.contains("todo:t2"))              // overdue stays on today
        #expect(!ids.contains("todo:t3") && !ids.contains("todo:t4"))
        #expect(!ids.contains("reminder:r3"))         // already due
        #expect(snapshot.attentionCount == 1)
        #expect(snapshot.openTodoCount == 3)
        #expect(snapshot.entries.first { $0.id == "agenda:a2" }?.link == "fridgedoor://plans/p1")
        #expect(snapshot.entries.first { $0.id == "plan:p2" }?.isPrivate == true)
        // Today's all-day items and to-dos lead the list.
        #expect(snapshot.entries.prefix(3).allSatisfy { $0.allDay })
    }

    @Test func remainingDropsPastEventsAndRollsOverAtMidnight() throws {
        let snapshot = WidgetSnapshotBuilder.build(member: member, plans: try plans, agenda: try agenda, todos: try todos, groceries: [], reminders: try reminders, now: now)
        let morning = snapshot.remaining(at: now).map(\.id)
        #expect(!morning.contains("agenda:a1"))       // gym ended at 7:15
        #expect(morning.contains("agenda:a2") && morning.contains("agenda:a3") && morning.contains("reminder:r1"))
        let lateEvening = PlannerDates.instant("2026-10-10T23:30:00-04:00")!
        #expect(snapshot.remaining(at: lateEvening).map(\.id).allSatisfy { ["agenda:a3", "todo:t1", "todo:t2"].contains($0) })
        #expect(snapshot.nextLater(than: lateEvening)?.id == "reminder:r2")
        let tomorrow = PlannerDates.instant("2026-10-11T00:00:01-04:00")!
        #expect(snapshot.remaining(at: tomorrow).map(\.id) == ["todo:t1", "todo:t2", "reminder:r2", "plan:p2"])
        let dates = snapshot.timelineDates(from: now)
        #expect(dates.first == now)
        #expect(dates.contains(PlannerDates.day("2026-10-11", in: zone)!))
        #expect(dates.contains(PlannerDates.instant("2026-10-10T21:00:00-04:00")!))
    }

    @Test func reminderNotificationsAreStableAndPrivate() throws {
        let scheduled = PlatformNotificationPlan.reminders(try reminders, plans: try plans, timeZone: zone, now: now)
        #expect(scheduled.map(\.identifier) == ["reminder.r1.r2", "reminder.r2.r1"])
        #expect(scheduled[0].title == "Dinner with the Okafors")
        #expect(scheduled[0].body.hasPrefix("Starts at 7:00"))
        #expect(scheduled[0].link == "fridgedoor://plans/p1")
        #expect(scheduled[1].title == "Private reminder")
        #expect(!scheduled[1].body.contains("Therapy"))
    }

    @Test func remindersForUnknownPlansStayPrivate() throws {
        // Plans failed to load: a plan reminder's visibility is unknown, so treat it as private.
        let reminders = try reminders
        let scheduled = PlatformNotificationPlan.reminders(reminders, plans: [], timeZone: zone, now: now)
        #expect(scheduled.map(\.title) == ["Private reminder", "Private reminder"])
        #expect(scheduled.allSatisfy { !$0.body.contains("Therapy") && !$0.body.contains("Okafors") })
        #expect(scheduled[0].link == "fridgedoor://plans/p1")
        let snapshot = WidgetSnapshotBuilder.build(member: member, plans: [], agenda: [], todos: try todos, groceries: [], reminders: reminders, now: now)
        #expect(snapshot.entries.first { $0.id == "reminder:r1" }?.isPrivate == true)
        #expect(snapshot.entries.first { $0.id == "reminder:r2" }?.isPrivate == true)
        // With plans loaded, a shared plan's reminder isn't private; list reminders never are.
        let loaded = WidgetSnapshotBuilder.build(member: member, plans: try plans, agenda: [], todos: try todos, groceries: [], reminders: reminders, now: now)
        #expect(loaded.entries.first { $0.id == "reminder:r1" }?.isPrivate == false)
        #expect(loaded.entries.first { $0.id == "reminder:r2" }?.isPrivate == true)
        let listReminder = reminders.first { $0.id == "r3" }!
        #expect(!PlatformNotificationPlan.isPrivate(listReminder, plan: nil))
    }

    @Test func utf16PrefixCountsLikeZodAndKeepsCharactersWhole() {
        #expect("hello".prefix(utf16Count: 10) == "hello")
        #expect("hello".prefix(utf16Count: 3) == "hel")
        // "😀" is two UTF-16 units; never split the surrogate pair.
        #expect("ab😀".prefix(utf16Count: 3) == "ab")
        #expect("ab😀".prefix(utf16Count: 4) == "ab😀")
        let emoji = String(repeating: "😀", count: 5000)   // 5000 characters, 10000 UTF-16 units
        let capped = emoji.prefix(utf16Count: 8000)
        #expect(capped.utf16.count == 8000 && capped.count == 4000)
        // A family emoji is one character of several units: drop it whole.
        #expect("a👨‍👩‍👧".prefix(utf16Count: 5) == "a")
    }

    @Test func digestsUseMemberTimezoneAndSkipPastTimes() {
        let digests = PlatformNotificationPlan.digests(hour: 7, minute: 0, timeZone: zone, now: now, days: 3)
        #expect(digests.map(\.identifier) == ["digest.2026-10-11.0700", "digest.2026-10-12.0700", "digest.2026-10-13.0700"])
        #expect(digests[0].fireDate == PlannerDates.instant("2026-10-11T07:00:00-04:00"))
        #expect(digests[0].link == "fridgedoor://home")
    }

    @Test func morningAndEveningAlertsSayWhatTheDayHoldsWithoutNamingPrivateItems() throws {
        let agenda = try decode([AgendaItem].self, #"""
        [{"id":"a1","planId":null,"title":"Therapy","time":{"kind":"timed","start":"2026-10-12T09:00:00-04:00","end":"2026-10-12T10:00:00-04:00","timezone":"America/New_York"},"location":null,"status":"confirmed","visibility":"owner","origin":"your private calendar"},
         {"id":"a2","planId":"p1","title":"Soccer practice","time":{"kind":"timed","start":"2026-10-12T17:30:00-04:00","end":"2026-10-12T18:30:00-04:00","timezone":"America/New_York"},"location":null,"status":"confirmed","visibility":"shared","origin":"household calendar"},
         {"id":"a3","planId":"p2","title":"Picture day","time":{"kind":"all_day","startDate":"2026-10-14","endDateExclusive":"2026-10-15"},"location":null,"status":"confirmed","visibility":"shared","origin":"household calendar"}]
        """#)
        let digests = PlatformNotificationPlan.digests(hour: 7, minute: 0, timeZone: zone, now: now, days: 4, agenda: agenda, decisions: 2)
        #expect(digests[0].body == "Nothing on the calendar today. 2 decisions waiting.")
        #expect(digests[1].body == "2 things today. First: Soccer practice at 5:30\u{202F}PM. 2 decisions waiting.")
        #expect(!digests.contains { $0.body.contains("Therapy") })
        #expect(digests[3].body == "1 thing today. First: Picture day. 2 decisions waiting.")

        let evenings = PlatformNotificationPlan.eveningLookAheads(timeZone: zone, now: now, days: 4, agenda: agenda)
        // Only evenings before a day with something on it.
        #expect(evenings.map(\.identifier) == ["evening.2026-10-11", "evening.2026-10-13"])
        #expect(evenings[0].title == "Tomorrow")
        #expect(evenings[0].fireDate == PlannerDates.instant("2026-10-11T20:00:00-04:00"))
    }

    @Test func digestTimeParsesOrFallsBack() throws {
        let parsed = try decode(MorningDigestStatus.self, #"{"enabled":true,"localTime":"06:45","revision":1,"timezone":"America/New_York"}"#).hourMinute
        #expect(parsed.hour == 6 && parsed.minute == 45)
        let fallback = MorningDigestStatus(enabled: true, localTime: "nope", revision: 0, timezone: "UTC").hourMinute
        #expect(fallback.hour == 7 && fallback.minute == 0)
    }

    @Test func snapshotRoundTripsAndComparesContent() throws {
        let snapshot = WidgetSnapshotBuilder.build(member: member, plans: try plans, agenda: try agenda, todos: try todos, groceries: [], reminders: try reminders, now: now)
        let again = try JSONDecoder().decode(WidgetSnapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(again == snapshot)
        let later = WidgetSnapshot(generatedAt: now.addingTimeInterval(60), memberName: snapshot.memberName, timezone: snapshot.timezone, entries: snapshot.entries, attentionCount: snapshot.attentionCount, openTodoCount: snapshot.openTodoCount, openGroceryCount: snapshot.openGroceryCount, groceries: snapshot.groceries, todos: snapshot.todos, decisions: snapshot.decisions)
        #expect(later.sameContent(as: snapshot))
        // Snapshots written before `link` existed still decode.
        let legacy = #"{"generatedAt":0,"memberName":"Alex","timezone":"UTC","entries":[{"id":"x","title":"T","allDay":false,"kind":"event"}],"attentionCount":0,"openTodoCount":0,"openGroceryCount":0}"#
        let decoded = try decode(WidgetSnapshot.self, legacy)
        #expect(decoded.entries.first?.link == nil)
    }
}
