import AppIntents
import Foundation
import FridgedoorKit

/// "What needs me in Fridgedoor": the suggestions waiting on a decision, read aloud.
struct ShowDecisionsIntent: AppIntent {
    static let title: LocalizedStringResource = "What Needs Me"
    static let description = IntentDescription("Reads the suggestions from email that are waiting on your decision.", categoryName: "Today")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let snapshot = try await ReadIntentSupport.snapshot() else { return .result(dialog: IntentSupport.signedOutDialog) }
        let rows = snapshot.decisions ?? []
        guard !rows.isEmpty else { return .result(dialog: "Nothing needs you right now.") }
        // Siri may read aloud in company: private plans are never named.
        let names = rows.prefix(3).map { $0.isPrivate ? "a private plan" : $0.title }
        let list = names.count > 1 ? names.dropLast().joined(separator: ", ") + " and " + names.last! : names[0]
        let more = rows.count > 3 ? ", plus \(rows.count - 3) more" : ""
        let lead = rows.count == 1 ? "One suggestion needs you" : "\(rows.count) suggestions need you"
        return .result(dialog: "\(lead): \(list)\(more). Open Fridgedoor to decide.")
    }
}

/// "What's on the Fridgedoor grocery list": the open groceries, in aisle order.
struct ShowGroceriesIntent: AppIntent {
    static let title: LocalizedStringResource = "Grocery List"
    static let description = IntentDescription("Reads what's on the household grocery list.", categoryName: "Lists")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let snapshot = try await ReadIntentSupport.snapshot() else { return .result(dialog: IntentSupport.signedOutDialog) }
        let rows = snapshot.groceries ?? []
        guard !rows.isEmpty else { return .result(dialog: "The grocery list is empty.") }
        let names = rows.prefix(6).map { row in row.detail.map { "\(row.title) (\($0))" } ?? row.title }
        let list = names.count > 1 ? names.dropLast().joined(separator: ", ") + " and " + names.last! : names[0]
        let more = snapshot.openGroceryCount > names.count ? ", plus \(snapshot.openGroceryCount - names.count) more" : ""
        return .result(dialog: "\(snapshot.openGroceryCount == 1 ? "One thing" : "\(snapshot.openGroceryCount) things") on the grocery list: \(list)\(more).")
    }
}

enum ReadIntentSupport {
    /// Fresh household data as a snapshot: the running app's if it refreshed in the last
    /// two minutes, otherwise fetched. Nil when signed out.
    @MainActor
    static func snapshot() async throws -> WidgetSnapshot? {
        guard let client = await PlatformSession.client() else { return nil }
        if let store = PlatformSession.store, store.hasLoaded, let refreshed = store.lastRefreshedAt, Date.now.timeIntervalSince(refreshed) < 120 {
            return PlatformData(store: store).snapshot()
        }
        do { return try await PlatformData.fetch(client).snapshot() } catch { throw IntentFailure(error) }
    }
}
