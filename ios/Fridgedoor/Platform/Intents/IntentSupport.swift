import AppIntents
import Foundation
import FridgedoorKit

/// Shared helpers for the App Intents. Intents run in the app process but may be
/// invoked while the UI isn't running, so they get their client from
/// `PlatformSession` (Keychain-backed), never from UI state.
enum IntentSupport {
    static let signedOutDialog: IntentDialog = "Open Fridgedoor and sign in first."

    /// After a change from Siri/Shortcuts, refresh the open app (if any) and the widget.
    @MainActor
    static func didChange(_ parts: Set<PlannerStore.Part>) async {
        if let store = PlatformSession.store {
            await store.refresh(parts)
        } else {
            await PlatformSync.refreshAll()
        }
    }
}

/// Errors surfaced to Siri/Shortcuts with the same copy the app uses.
struct IntentFailure: Error, CustomLocalizedStringResourceConvertible {
    let message: String
    init(_ error: Error) { message = (error as? PlannerError)?.userMessage ?? "Something went wrong. Try again in Fridgedoor." }
    var localizedStringResource: LocalizedStringResource { "\(message)" }
}
