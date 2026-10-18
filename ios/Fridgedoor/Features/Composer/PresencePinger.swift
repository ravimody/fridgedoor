import Foundation
import FridgedoorKit

/// Mirrors the web: while the app is in the foreground it pings
/// `assistant/presence` every 15 s so the server suppresses activity pushes
/// (the person is already looking). Leaving the foreground clears it.
@MainActor
final class PresencePinger {
    private let clientId = UUID().uuidString.lowercased()
    private var task: Task<Void, Never>?
    private var visible = false

    func setVisible(_ visible: Bool, client: PlannerClient) {
        guard visible != self.visible else { return }
        self.visible = visible
        task?.cancel()
        let clientId = clientId
        task = Task {
            guard visible else {
                try? await client.assistantPresence(clientId: clientId, visible: false)
                return
            }
            while !Task.isCancelled {
                try? await client.assistantPresence(clientId: clientId, visible: true)
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }
}
