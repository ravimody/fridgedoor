import AppIntents
import Foundation
import FridgedoorKit

/// Sends a request to the planner's assistant — the same as typing it in the
/// composer. Results that change lists or the calendar still wait for review.
struct AskPlannerIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Planner"
    static let description = IntentDescription("Sends a request to the planner, like “Soccer practice moved to Thursday at 5”. Anything it suggests waits for your decision in the app.", categoryName: "Assistant")
    /// Reads or changes household data, so Siri asks for Face ID / passcode on a locked phone.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Request", inputOptions: String.IntentInputOptions(multiline: true), requestValueDialog: "What should I ask your planner?")
    var text: String

    static var parameterSummary: some ParameterSummary { Summary("Ask Fridgedoor \(\.$text)") }

    private struct Submit: Encodable, Sendable { let clientId: String; let text: String }
    private struct Submitted: Decodable, Sendable { let id: String }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let request = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !request.isEmpty else { throw $text.needsValueError("What should I ask your planner?") }
        guard let client = await PlatformSession.client() else { return .result(dialog: IntentSupport.signedOutDialog) }
        do {
            let settings = try await client.assistantSettings()
            guard settings.enabled, settings.consent else {
                return .result(dialog: "The assistant isn't turned on yet. Open Fridgedoor, tap the composer and turn it on — then ask again.")
            }
            let run = try await client.send(.post, "assistant/runs", body: Submit(clientId: UUID().uuidString, text: request.prefix(utf16Count: 8000)), as: Submitted.self)
            PlatformSession.store?.pollSoon()
            // Wait briefly for a quick answer; longer work finishes in the app.
            for _ in 0..<8 {
                try await Task.sleep(for: .seconds(2))
                guard let current = try? await client.assistantRuns().first(where: { $0.id == run.id }) else { continue }
                if current.state == "failed" { return .result(dialog: "Your planner couldn't finish that. Open Fridgedoor to try again.") }
                if current.state == "succeeded" { return .result(dialog: IntentDialog(stringLiteral: Self.summary(of: current))) }
            }
            return .result(dialog: "Sent. Your planner is working on it — the answer will be on Home in Fridgedoor.")
        } catch let error as PlannerError {
            throw IntentFailure(error)
        }
    }

    static func summary(of run: AssistantRun) -> String {
        let reply = run.result?.reply.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let suggestions = run.result?.items.count ?? 0
        let review = suggestions == 0 ? "" : suggestions == 1 ? " 1 suggestion is waiting for you in Fridgedoor." : " \(suggestions) suggestions are waiting for you in Fridgedoor."
        let base = reply.isEmpty ? "Done." : String(reply.prefix(600))
        return base + review
    }
}
