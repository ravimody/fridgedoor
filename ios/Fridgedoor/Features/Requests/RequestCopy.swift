import Foundation
import FridgedoorKit

// Client-side words for a request: its short title, a past-tense account of what
// was applied, and failure copy that says what to do next (DESIGN.md → Words).

extension AssistantRun {
    /// A short title for lists: the first item ("Art show + 2 more"), else a fact,
    /// else the first line of the request with links shown as their host.
    var shortTitle: String {
        if let items = result?.items, let first = items.first {
            return items.count == 1 ? first.title : "\(first.title) + \(items.count - 1) more"
        }
        if let change = result?.knowledge.first { return humanKey(change.key) }
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let titled = Self.replacingLinksWithHosts(line).trimmingCharacters(in: .whitespacesAndNewlines)
        // Shared items (Share sheet, Shortcuts) arrive as a capture with no typed text.
        guard !titled.isEmpty else { return captureId != nil ? "Attachment" : "Request" }
        guard titled.count > 60 else { return titled }
        // Cut at a word boundary.
        let cut = titled.prefix(60)
        let words = cut.split(separator: " ").dropLast()
        return (words.isEmpty ? String(cut) : words.joined(separator: " ")) + "…"
    }

    /// The request as typed, when it says more than `shortTitle`.
    var promptSubtitle: String? {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt != shortTitle else { return nil }
        return prompt
    }

    private static func replacingLinksWithHosts(_ text: String) -> String {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return text }
        var result = text
        for match in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let range = Range(match.range, in: text), let host = match.url?.host() else { continue }
            result.replaceSubrange(range, with: host.hasPrefix("www.") ? String(host.dropFirst(4)) : host)
        }
        return result
    }

    // MARK: Past tense (C-05)

    /// What has actually happened, in the past tense ("Added 3 items to Groceries and
    /// 1 to To do."), followed by what still waits. Nil until something is applied, so
    /// the assistant's own reply (an answer, or "once you confirm…") still shows.
    func appliedSummary(plans: [PlanSummary]) -> String? {
        guard state == "succeeded", let result else { return nil }
        var groceries: [String] = [], todos: [String] = [], onCalendar: [String] = [], saved: [String] = []
        var savedFacts: [String] = [], forgotFacts: [String] = []
        var undone = 0, dismissed = 0
        for (index, item) in result.items.enumerated() {
            guard let review = review(for: "item:\(index)") else { continue }
            if review.undoneAt != nil { undone += 1; continue }
            if review.state == "dismissed" { dismissed += 1; continue }
            if item.kind != "event" {
                if review.state == "saved" { if item.kind == "grocery" { groceries.append(item.title) } else { todos.append(item.title) } }
                continue
            }
            let plan = plans.first { $0.id == review.planId }
            if plan?.isClosed == true { dismissed += 1; continue }
            let title = plan?.facts.title ?? item.title
            let action = plan?.calendarAction.map { (state: $0.state, kind: $0.kind) } ?? review.calendarAction.map { (state: $0.state, kind: Optional($0.kind)) }
            if let action, action.state == "succeeded", action.kind != "cancel" {
                onCalendar.append(title)
            } else if action == nil, plan?.savedInPlanner == true || review.state == "kept" {
                saved.append(title)
            }
            // Calendar work still running or failing shows on the plan's own status line.
        }
        for (index, change) in result.knowledge.enumerated() {
            guard let review = review(for: "knowledge:\(index)") else { continue }
            if review.state == "dismissed" { dismissed += 1 } else if change.operation == "delete" { forgotFacts.append(humanKey(change.key)) } else { savedFacts.append(humanKey(change.key)) }
        }

        var sentences: [String] = []
        switch (groceries.count, todos.count) {
        case (0, 0): break
        case (1, 0): sentences.append("Added “\(groceries[0])” to Groceries.")
        case (0, 1): sentences.append("Added “\(todos[0])” to To do.")
        case (let g, 0): sentences.append("Added \(g) items to Groceries.")
        case (0, let t): sentences.append("Added \(t) items to To do.")
        case (let g, let t): sentences.append("Added \(g) \(g == 1 ? "item" : "items") to Groceries and \(t) to To do.")
        }
        if !onCalendar.isEmpty { sentences.append(onCalendar.count == 1 ? "Added “\(onCalendar[0])” to the household calendar." : "Added \(onCalendar.count) plans to the household calendar.") }
        if !saved.isEmpty { sentences.append(saved.count == 1 ? "Saved “\(saved[0])”." : "Saved \(saved.count) plans.") }
        if !savedFacts.isEmpty { sentences.append(savedFacts.count == 1 ? "Saved “\(savedFacts[0])” to Household facts." : "Saved \(savedFacts.count) Household facts.") }
        if !forgotFacts.isEmpty { sentences.append(forgotFacts.count == 1 ? "Forgot “\(forgotFacts[0])”." : "Forgot \(forgotFacts.count) facts.") }
        if undone > 0 { sentences.append(undone == 1 ? "Undid 1 item." : "Undid \(undone) items.") }
        if dismissed > 0 { sentences.append(dismissed == 1 ? "Dismissed 1 suggestion." : "Dismissed \(dismissed) suggestions.") }
        guard !sentences.isEmpty else { return nil }
        if let waiting = reviewCount(plans: plans).label { sentences.append("\(waiting.prefix(1).uppercased())\(waiting.dropFirst()).") }
        return sentences.joined(separator: " ")
    }

    // MARK: Failure (C-06)

    /// What went wrong, as a next step. Never shows internal codes.
    var failureMessage: String {
        let hasLink = AssistantLinks.firstLink(in: text) != nil
        switch errorCode {
        case "AGENT_RATE_LIMITED": return "The planner is busy right now. Try again in a minute."
        case "AGENT_TIMEOUT": return hasLink ? "The planner couldn't read that link in time. Try again, or paste the text instead." : "That took the planner too long. Try again, or ask for less at once."
        case "AGENT_INVALID_TIME": return "The planner got the times mixed up. Try again, or say the time another way."
        case "AGENT_CANCELED": return "That request was stopped before it finished. Try again."
        case "ASSISTANT_UNAVAILABLE": return "The planner isn't available right now. Try again later."
        case "ASSISTANT_DISABLED": return "Ask the planner was turned off before this finished. Turn it back on, then send it again."
        case "CAPTURE_UNAVAILABLE": return "The photo or PDF for this request has expired. Attach it again in a new request."
        default: return hasLink ? "The planner couldn't read that link. Try again, or paste the text instead." : "The planner couldn't finish that. Try again, or rephrase it."
        }
    }

    /// Whether "Try again" can work; otherwise the request has to be sent anew.
    var canRetryFailure: Bool { !["ASSISTANT_DISABLED", "CAPTURE_UNAVAILABLE"].contains(errorCode ?? "") }
}

// MARK: Reply layout

/// Splits an assistant reply into prose and lists. Agenda answers arrive as one
/// sentence joined with "; " ("Today has 3 items: Gym (6:30 AM); Pickup (all day); …");
/// those become rows. Anything else stays prose.
enum ReplyLayout {
    struct Row: Hashable {
        let title: String
        let detail: String?
    }

    enum Block: Hashable {
        case prose(String)
        case list(lead: String?, rows: [Row], tail: String?)
    }

    static func blocks(_ text: String) -> [Block] {
        text.components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { list(in: $0) ?? .prose($0) }
    }

    private static func list(in paragraph: String) -> Block? {
        guard !paragraph.contains("\n") else { return nil }
        var lead: String?
        var body = Substring(paragraph)
        // A lead-in ends with ": " before the first "; " ("6:30" has no space after the colon).
        if let colon = paragraph.range(of: ": "), let semicolon = paragraph.range(of: "; "), colon.lowerBound < semicolon.lowerBound {
            lead = String(paragraph[..<colon.lowerBound]) + ":"
            body = paragraph[colon.upperBound...]
        }
        var parts = body.components(separatedBy: "; ").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count >= 3, parts.allSatisfy({ !$0.isEmpty && $0.count <= 160 }) else { return nil }
        // The last entry may run into closing sentences ("… (7 PM). Anything else?").
        var tail: String?
        if let last = parts.last, let stop = last.range(of: ". ") {
            tail = String(last[stop.upperBound...]).trimmingCharacters(in: .whitespaces)
            parts[parts.count - 1] = String(last[..<stop.lowerBound])
        }
        if parts[parts.count - 1].hasSuffix(".") { parts[parts.count - 1].removeLast() }
        // Rows are short entries, not clauses of a sentence.
        guard parts.dropLast().allSatisfy({ !$0.contains(". ") }) else { return nil }
        return .list(lead: lead, rows: parts.map(row), tail: tail?.isEmpty == false ? tail : nil)
    }

    /// "School drop-off (Alex) (Sat 7:45 AM)" → title "School drop-off (Alex)", detail "Sat 7:45 AM".
    private static func row(_ entry: String) -> Row {
        guard entry.hasSuffix(")"), let open = entry.range(of: " (", options: .backwards) else { return Row(title: entry, detail: nil) }
        let title = String(entry[..<open.lowerBound]).trimmingCharacters(in: .whitespaces)
        let detail = String(entry[open.upperBound..<entry.index(before: entry.endIndex)])
        return title.isEmpty || detail.isEmpty ? Row(title: entry, detail: nil) : Row(title: title, detail: detail)
    }
}
