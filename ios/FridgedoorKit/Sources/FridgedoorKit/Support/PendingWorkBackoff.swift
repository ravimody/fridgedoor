import Foundation

/// How fast to poll while the server finishes work for us (a request, a calendar sync,
/// the brief): every few seconds at first, then slower, and not at all after a while,
/// so a job stuck in "updating" doesn't keep the app polling every few seconds forever.
public struct PendingWorkBackoff: Sendable, Equatable {
    /// Polls at `initialDelay` before slowing down.
    public static let quickPolls = 10
    public static let initialDelay: Duration = .seconds(3)
    public static let maxDelay: Duration = .seconds(30)
    /// Total time spent fast polling before giving up until the work settles.
    public static let limit: Duration = .seconds(10 * 60)

    public private(set) var polls = 0
    public private(set) var elapsed: Duration = .zero

    public init() {}

    /// The wait before the next poll for pending work, or nil once fast polling has run
    /// for `limit` (polling falls back to the normal interval).
    public mutating func nextDelay() -> Duration? {
        guard elapsed < Self.limit else { return nil }
        let delay: Duration
        if polls < Self.quickPolls {
            delay = Self.initialDelay
        } else {
            let doublings = min(polls - Self.quickPolls + 1, 8)
            delay = min(Self.initialDelay * (1 << doublings), Self.maxDelay)
        }
        polls += 1
        elapsed += delay
        return delay
    }

    /// The work settled (or new work started): the next pending work polls quickly again.
    public mutating func reset() { self = PendingWorkBackoff() }
}
