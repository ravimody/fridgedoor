import AppIntents
import Foundation
import FridgedoorKit

struct AddGroceryIntent: AppIntent {
    static let title: LocalizedStringResource = "Add to Groceries"
    static let description = IntentDescription("Adds an item to the household grocery list.", categoryName: "Lists")
    /// Reads or changes household data, so Siri asks for Face ID / passcode on a locked phone.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Item", requestValueDialog: "What should I add to groceries?")
    var item: String

    @Parameter(title: "Quantity", description: "For example “2” or “1 dozen”.")
    var quantity: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$item) to groceries") { \.$quantity }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let title = item.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw $item.needsValueError("What should I add to groceries?") }
        guard let client = await PlatformSession.client() else { return .result(dialog: IntentSupport.signedOutDialog) }
        let amount = quantity?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await client.createListItem(.grocery, title: title.prefix(utf16Count: 200), quantity: amount?.isEmpty == false ? amount!.prefix(utf16Count: 80) : nil)
        } catch {
            throw IntentFailure(error)
        }
        await IntentSupport.didChange([.groceries])
        return .result(dialog: "Added \(title) to groceries.")
    }
}

struct AddTodoIntent: AppIntent {
    static let title: LocalizedStringResource = "Add a To-Do"
    static let description = IntentDescription("Adds a to-do to the household list, optionally with a due date.", categoryName: "Lists")
    /// Reads or changes household data, so Siri asks for Face ID / passcode on a locked phone.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "To-do", requestValueDialog: "What do you need to do?")
    var title: String

    @Parameter(title: "Due")
    var due: Date?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$title) to to-dos") { \.$due }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw $title.needsValueError("What do you need to do?") }
        guard let client = await PlatformSession.client() else { return .result(dialog: IntentSupport.signedOutDialog) }
        let zone = await client.auth.member?.timeZone ?? .current
        // Siri resolves a date without a time ("Friday") to midnight in the DEVICE
        // timezone, so detect it and read the calendar day there; it's sent as a
        // plain `yyyy-MM-dd` day, like the web. Times keep the member's offset.
        let device = Calendar.current
        let dueTime = due.map { date -> String in
            let parts = device.dateComponents([.hour, .minute, .second], from: date)
            return parts.hour == 0 && parts.minute == 0 && parts.second == 0
                ? PlannerDates.dayString(date, in: device.timeZone) : PlannerDates.offsetString(date, timeZone: zone)
        }
        do {
            _ = try await client.createListItem(.todo, title: text.prefix(utf16Count: 200), dueTime: dueTime)
        } catch {
            throw IntentFailure(error)
        }
        await IntentSupport.didChange([.todos, .dailyOverview])
        if let due {
            let dateOnly = dueTime?.count == 10
            let label = due.formatted(Date.FormatStyle(date: .abbreviated, time: dateOnly ? .omitted : .shortened, timeZone: dateOnly ? device.timeZone : zone))
            return .result(dialog: "Added “\(text)”, due \(label).")
        }
        return .result(dialog: "Added “\(text)” to your to-dos.")
    }
}
