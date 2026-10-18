#if DEBUG
import Foundation
import FridgedoorKit

/// DEBUG-only: when launched with `PLANNER_PREVIEW_SERVER=http://127.0.0.1:<port>`
/// (e.g. `SIMCTL_CHILD_PLANNER_PREVIEW_SERVER=… xcrun simctl launch …`), complete the
/// PKCE handoff headlessly against the synthetic preview server
/// (`pnpm --filter @fridgedoor/server dev:native`). Only `127.0.0.1` is accepted: a real
/// server requires a browser sign-in first and would reject this anyway, and the preview
/// server checks the exact origin, so `localhost` would fail the authorize step.
enum DebugPreviewSignIn {
    static var server: URL? {
        guard let value = ProcessInfo.processInfo.environment["PLANNER_PREVIEW_SERVER"], let url = URL(string: value),
              url.host() == "127.0.0.1" else { return nil }
        return url
    }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? { nil }
    }

    static func signIn(server: URL) async throws -> (AuthSession, Member) {
        let verifier = PKCE.verifier(), state = PKCE.state()
        let form = [
            "code_challenge": PKCE.challenge(for: verifier), "code_challenge_method": "S256",
            "state": state, "redirect_uri": "fridgedoor://auth/callback",
        ].map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0.value)" }.joined(separator: "&")
        var request = URLRequest(url: server.appending(path: "dashboard/native/authorize"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(server.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.httpBody = Data(form.utf8)
        let (_, response) = try await URLSession.shared.data(for: request, delegate: NoRedirect())
        guard let location = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location"),
              let code = URLComponents(string: location)?.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw PlannerError(code: "PREVIEW_SIGN_IN_FAILED")
        }
        SharedContainer.serverURL = server
        let auth = AuthSession.shared(for: server)
        let member = try await auth.exchange(code: code, verifier: verifier, deviceLabel: "Simulator preview")
        return (auth, member)
    }
}
#endif
