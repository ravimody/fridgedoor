import Foundation
import Testing
@testable import FridgedoorKit

/// The pairing grant says why a code failed; the welcome flow shows `userMessage`.
@Suite struct PairingErrorTests {
    private let server = URL(string: "https://fridgedoor.example.test")!

    private func pair(answering status: Int, _ body: String) async throws -> Member {
        let session = StubProtocol.session(routes: ["/native/v1/auth/token": (status, body)])
        let auth = AuthSession(baseURL: server, keychain: KeychainStore(service: "dev.fridgedoor.tests.\(UUID().uuidString)"), urlSession: session)
        return try await auth.pair(code: "code", deviceLabel: "Test iPhone")
    }

    @Test(arguments: [
        ("PAIRING_CODE_USED", "This code was already used. Make a new one in Settings → iPhone on the web."),
        ("PAIRING_CODE_EXPIRED", "This code expired. Codes last 10 minutes; make a new one."),
        ("PAIRING_CODE_INVALID", PlannerError.pairingCodeInvalid.userMessage),
    ])
    func explainsEachRejectedCode(code: String, message: String) async {
        do {
            _ = try await pair(answering: 401, #"{"error":{"code":"\#(code)","message":"pairing code","requestId":"req-1"}}"#)
            Issue.record("pairing should fail")
        } catch let error as PlannerError {
            #expect(error.code == code)
            #expect(error.status == 401)
            #expect(error.userMessage == message)
        } catch {
            Issue.record("unexpected \(error)")
        }
    }

    @Test func olderServersStillReadAsAnInvalidCode() async {
        await #expect(throws: PlannerError.pairingCodeInvalid) {
            _ = try await pair(answering: 401, #"{"error":{"code":"NATIVE_GRANT_INVALID","message":"native grant invalid"}}"#)
        }
    }

    @Test func decodesTheErrorBody() {
        let response = HTTPURLResponse(url: server, statusCode: 401, httpVersion: nil, headerFields: nil)!
        #expect(throws: PlannerError(code: "PAIRING_CODE_EXPIRED", status: 401, serverMessage: "pairing code expired")) {
            try PlannerClient.check(data: Data(#"{"error":{"code":"PAIRING_CODE_EXPIRED","message":"pairing code expired"}}"#.utf8), response: response)
        }
        #expect(throws: PlannerError(code: "HTTP_401", status: 401)) {
            try PlannerClient.check(data: Data("not json".utf8), response: response)
        }
    }
}
