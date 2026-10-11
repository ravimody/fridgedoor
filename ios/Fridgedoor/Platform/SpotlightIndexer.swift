import CoreSpotlight
import Foundation
import FridgedoorKit
import UIKit
import UniformTypeIdentifiers

/// Indexes shared plans and open list items for Spotlight search (on-device
/// only). Private plans are never indexed. Cleared on sign-out.
@MainActor
enum SpotlightIndexer {
    /// `.complete`: the index is unreadable while the phone is locked.
    private static let index = CSSearchableIndex(name: "Fridgedoor", protectionClass: .complete)
    private static var lastFingerprint: Int?
    private static var unlockObserver: NSObjectProtocol?
    private static let domains = ["plans", "todo", "grocery"]

    static func update(plans: [PlanSummary], todos: [ListItem], groceries: [ListItem], timeZone: TimeZone) {
        let visiblePlans = plans.filter { !$0.isPrivate && $0.status != "dismissed" && $0.status != "archived" }
        let openItems = (todos + groceries).filter { !$0.isCompleted }
        var hasher = Hasher()
        for plan in visiblePlans { hasher.combine(plan.id); hasher.combine(plan.revision) }
        for item in openItems { hasher.combine(item.id); hasher.combine(item.revision) }
        let fingerprint = hasher.finalize()
        // A `.complete` index can't be written while locked (e.g. background refresh);
        // leave the fingerprint unset so the next unlocked sync indexes.
        guard fingerprint != lastFingerprint, UIApplication.shared.isProtectedDataAvailable else { return }
        lastFingerprint = fingerprint

        var items: [CSSearchableItem] = visiblePlans.map { plan in
            let attributes = CSSearchableItemAttributeSet(contentType: .text)
            attributes.title = plan.facts.title
            attributes.contentDescription = [plan.isOpenSuggestion ? "Suggestion" : "Plan", plan.facts.location].compactMap { $0 }.joined(separator: " · ")
            attributes.keywords = [plan.facts.category] + plan.facts.participants
            if let start = plan.facts.time?.anchor(in: timeZone) { attributes.startDate = start }
            return CSSearchableItem(uniqueIdentifier: "plan:\(plan.id)", domainIdentifier: "plans", attributeSet: attributes)
        }
        items += openItems.map { item in
            let attributes = CSSearchableItemAttributeSet(contentType: .text)
            attributes.title = item.title
            attributes.contentDescription = item.kind == .grocery ? ["Groceries", item.quantity].compactMap { $0 }.joined(separator: " · ") : "To do"
            return CSSearchableItem(uniqueIdentifier: "\(item.kind.rawValue):\(item.id)", domainIdentifier: item.kind.rawValue, attributeSet: attributes)
        }
        let index = index
        index.deleteSearchableItems(withDomainIdentifiers: domains) { _ in
            index.indexSearchableItems(items) { error in
                guard let error else { return }
                #if DEBUG
                print("[Platform] Spotlight index failed: \(error)")
                #endif
                Task { @MainActor in if lastFingerprint == fingerprint { lastFingerprint = nil } }
            }
        }
    }

    static func clear() {
        lastFingerprint = nil
        index.deleteAllSearchableItems { _ in }
        // Sign-out noticed in background refresh can run while locked, when the
        // `.complete` index may refuse the delete: repeat it once the phone unlocks.
        guard !UIApplication.shared.isProtectedDataAvailable, unlockObserver == nil else { return }
        unlockObserver = NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                if let unlockObserver { NotificationCenter.default.removeObserver(unlockObserver) }
                unlockObserver = nil
                lastFingerprint = nil
                index.deleteAllSearchableItems { _ in }
            }
        }
    }

    /// The deep link for a tapped Spotlight result.
    static func link(for identifier: String) -> URL? {
        let parts = identifier.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        switch parts[0] {
        case "plan": return URL(string: "fridgedoor://plans/\(parts[1])")
        case "todo": return URL(string: "fridgedoor://todos")
        case "grocery": return URL(string: "fridgedoor://groceries")
        default: return nil
        }
    }
}
