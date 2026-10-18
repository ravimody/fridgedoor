import Foundation
import Observation
import FridgedoorKit

/// State for Teach suggestions (Settings; the server's `relevance-trial` endpoints): five
/// sampled suggestions at a time, owner-only ratings, an on-demand draft summary, and
/// the opt-in nightly learning profile.
@MainActor @Observable
final class RelevanceTrialModel {
    let client: PlannerClient

    private(set) var items: [TrialItem] = []
    private(set) var learning: TrialLearning?
    private(set) var summary: TrialSummaryRecord?
    private(set) var loaded = false
    private(set) var loadFailed = false
    private(set) var busy = false
    /// The rated item being changed, if any; otherwise the first unanswered item is current.
    var changingId: String?

    init(client: PlannerClient) { self.client = client }

    var current: TrialItem? {
        items.first { $0.id == changingId } ?? items.first { $0.value == nil }
    }
    /// Unanswered items behind the current card, for the stack.
    var upcoming: [TrialItem] { items.filter { $0.value == nil && $0.id != current?.id } }
    var answered: [TrialItem] { items.filter { $0.value != nil } }
    var hasUnanswered: Bool { items.contains { $0.value == nil } }

    func load() async {
        do {
            async let list = client.relevanceTrial()
            async let saved = client.trialSummary()
            async let profile = client.trialLearning()
            items = try await list.items
            summary = try? await saved
            learning = try? await profile
            loaded = true
            loadFailed = false
        } catch {
            loadFailed = !loaded
        }
    }

    /// Returns nil on success, or the message to show.
    func rate(_ item: TrialItem, _ vote: TrialVote, reason: String) async -> String? {
        guard !busy else { return nil }
        busy = true
        defer { busy = false }
        do {
            items = try await client.rateTrialItem(item.id, vote: vote, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines), expectedRevision: item.revision).items
            changingId = nil
            summary = nil // the server discards the draft when ratings change
            learning = try? await client.trialLearning()
            return nil
        } catch {
            if (error as? PlannerError)?.isStale == true {
                await load()
                return "This answer changed on another device. It's been refreshed."
            }
            return message(error, fallback: "Couldn't save. Your answer is still here; try again.")
        }
    }

    func next() async -> String? {
        busy = true
        defer { busy = false }
        do {
            items = try await client.nextTrialBatch().items
            changingId = nil
            return hasUnanswered ? nil : "No more recent suggestions are available to sample."
        } catch {
            return message(error, fallback: "Couldn't load another batch. Try again.")
        }
    }

    func summarize() async -> String? {
        busy = true
        defer { busy = false }
        do {
            summary = try await client.summarizeTrial()
            return nil
        } catch {
            return message(error, fallback: "Couldn't summarize yet. Your ratings are saved; try again after rating a few examples.")
        }
    }

    func setLearning(enabled: Bool) async -> String? {
        guard let learning, !busy else { return nil }
        busy = true
        defer { busy = false }
        do {
            self.learning = try await client.setTrialLearning(enabled: enabled, expectedRevision: learning.revision)
            return nil
        } catch {
            self.learning = try? await client.trialLearning()
            return message(error, fallback: "Couldn't update learning. Try again.")
        }
    }

    func forgetLearning() async -> String? {
        guard let learning, !busy else { return nil }
        busy = true
        defer { busy = false }
        do {
            self.learning = try await client.forgetTrialLearning(expectedRevision: learning.revision)
            return nil
        } catch {
            self.learning = try? await client.trialLearning()
            return message(error, fallback: "Couldn't forget learned preferences. Try again.")
        }
    }

    func clear() async -> String? {
        busy = true
        defer { busy = false }
        do {
            try await client.clearTrial()
            items = []; summary = nil; changingId = nil
            learning = (try? await client.trialLearning()) ?? TrialLearning(enabled: false, revision: 0, preferences: [], generatedAt: nil)
            return nil
        } catch {
            return message(error, fallback: "Couldn't delete the trial. Try again.")
        }
    }

    private func message(_ error: Error, fallback: String) -> String {
        guard let error = error as? PlannerError else { return fallback }
        switch error.code {
        case "OFFLINE", "SERVER_DOWN", "SIGNED_OUT": return error.userMessage
        case "STALE_REVISION": return "This changed on another device. Pull to refresh and try again."
        case "SUMMARY_UNAVAILABLE": return "Summaries aren't available on the server right now."
        case "SUMMARY_BUSY": return "A summary is already being prepared. Try again in a moment."
        case "RATINGS_REQUIRED": return "Rate a few examples first, then summarize."
        case "TRIAL_LIMIT": return "You've sampled the most suggestions allowed for now."
        case "CONSENT_REQUIRED": return "Turning on nightly learning needs your consent."
        default: return fallback
        }
    }
}
