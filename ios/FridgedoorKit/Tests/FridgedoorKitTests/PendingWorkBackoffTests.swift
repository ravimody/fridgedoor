import Testing
@testable import FridgedoorKit

/// Fast polling while the server finishes work slows down and then stops.
@Suite struct PendingWorkBackoffTests {
    @Test func pollsQuicklyThenSlowsDownAndStops() {
        var backoff = PendingWorkBackoff()
        var delays: [Duration] = []
        while let delay = backoff.nextDelay() { delays.append(delay) }

        #expect(delays.prefix(PendingWorkBackoff.quickPolls).allSatisfy { $0 == .seconds(3) })
        #expect(Array(delays.dropFirst(PendingWorkBackoff.quickPolls).prefix(4)) == [.seconds(6), .seconds(12), .seconds(24), .seconds(30)])
        #expect(delays.allSatisfy { $0 <= PendingWorkBackoff.maxDelay })
        #expect(delays.reduce(.zero, +) >= PendingWorkBackoff.limit)
        #expect(delays.count < 40)
        #expect(backoff.nextDelay() == nil)
    }

    @Test func resetStartsOver() {
        var backoff = PendingWorkBackoff()
        while backoff.nextDelay() != nil {}
        backoff.reset()
        #expect(backoff.nextDelay() == .seconds(3))
    }
}
