import Foundation
import Testing
@testable import FridgedoorKit

/// Newer server codes get plain copy instead of the "something went wrong (code)" fallback.
@Suite struct ServerErrorCopyTests {
    @Test(arguments: [
        ("CAPTURE_STORAGE_FULL", 429, "Files you sent are still waiting to be read. Wait a few minutes, then try again."),
        ("CAPTURE_RATE_LIMITED", 429, "Too many shares from this iPhone in the last hour. Try again later."),
        ("PAYLOAD_TOO_LARGE", 413, "That's too long to send. Shorten it and try again."),
        ("PROPOSAL_EXPIRED", 400, "This suggestion expired. Ask the planner again if you still want it."),
        ("DESTINATION_OWNER_ONLY", 403, "The household calendar belongs to another member. Only they or the household owner can change it."),
        ("TASK_REQUIRES_ACTION", 400, "This is a to-do. Mark it done or choose Later instead."),
        ("INTERNAL", 500, "Something went wrong on the server. Try again in a moment."),
    ])
    func explainsNewCodes(code: String, status: Int, message: String) {
        let error = PlannerError(code: code, status: status)
        #expect(error.userMessage == message)
        #expect(error.assistantMessage == message)
        #expect(error.captureMessage == message)
    }

    @Test func captureTooLargeKeepsScreenSpecificCopy() {
        let error = PlannerError(code: "CAPTURE_TOO_LARGE", status: 413)
        #expect(error.assistantMessage == "Choose a photo or PDF smaller than 10 MB.")
        #expect(error.captureMessage == "That's too large to send (10 MB limit).")
    }
}

/// No raw server code or system string reaches the screen.
@Suite struct FallbackErrorCopyTests {
    @Test func unknownCodesUsePlainCopy() {
        #expect(PlannerError(code: "PLAN_TIME_INCOMPLETE", status: 400).userMessage == "That didn't work. Try again, or pull to refresh first.")
        #expect(PlannerError(code: "SOMETHING_NEW", status: 429).userMessage == "Too many requests right now. Try again in a little while.")
        #expect(!PlannerError(code: "SOMETHING_NEW", status: 400).userMessage.contains("something new"))
    }

    @Test func urlErrorsAreMapped() {
        #expect(PlannerClient.mapped(URLError(.badServerResponse)) as? PlannerError == .serverDown)
        #expect(PlannerClient.mapped(URLError(.serverCertificateUntrusted)) as? PlannerError == .certificateProblem)
        #expect(PlannerClient.mapped(URLError(.notConnectedToInternet)) as? PlannerError == .offline)
        #expect((PlannerClient.mapped(URLError(.cancelled)) as? URLError)?.code == .cancelled)
        #expect(PlannerError.userMessage(for: URLError(.badServerResponse)) == PlannerError.serverDown.userMessage)
    }

    @Test func emptyRecordingIsNotCalledTooLong() {
        let empty = PlannerError(code: "INVALID_AUDIO", status: 413, serverMessage: "invalid audio")
        let tooBig = PlannerError(code: "INVALID_AUDIO", status: 413, serverMessage: "That recording is too long.")
        #expect(empty.assistantMessage == "That recording couldn't be used. Try again or type instead.")
        #expect(tooBig.assistantMessage == "That recording is too long. Keep voice requests under two minutes.")
    }
}
