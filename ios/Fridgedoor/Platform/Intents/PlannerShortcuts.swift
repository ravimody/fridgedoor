import AppIntents

/// Siri / Spotlight / Shortcuts phrases. App Shortcut phrases can't embed free
/// text (only entities/enums), so Siri asks for the item or request as a follow-up.
struct PlannerShortcuts: AppShortcutsProvider {
    // Every phrase names the app through `.applicationName`, so each works with
    // "Fridgedoor" and with its INAlternativeAppNames ("Planner", "Fridge door"):
    // "Ask Fridgedoor", "Ask Planner", "What's on the fridge door".
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AddGroceryIntent(), phrases: [
            "Add to groceries in \(.applicationName)",
            "Add groceries in \(.applicationName)",
            "Add to the \(.applicationName) grocery list",
            "Add to my \(.applicationName) shopping list",
        ], shortTitle: "Add Grocery", systemImageName: "basket")
        AppShortcut(intent: AddTodoIntent(), phrases: [
            "Add a to-do in \(.applicationName)",
            "Add to my \(.applicationName) to-dos",
            "Add a task in \(.applicationName)",
        ], shortTitle: "Add To-Do", systemImageName: "checklist")
        AppShortcut(intent: AskPlannerIntent(), phrases: [
            "Ask \(.applicationName)",
            "Ask \(.applicationName) something",
            "Tell \(.applicationName) something",
        ], shortTitle: "Ask Planner", systemImageName: "sparkles")
        AppShortcut(intent: ShowTodayIntent(), phrases: [
            "What's on \(\.$day) in \(.applicationName)",
            "What's happening \(\.$day) in \(.applicationName)",
            "What's my day look like in \(.applicationName)",
            "What's next in \(.applicationName)",
            "What's on the \(.applicationName)",
        ], shortTitle: "What's On", systemImageName: "calendar")
        AppShortcut(intent: ShowDecisionsIntent(), phrases: [
            "What needs me in \(.applicationName)",
            "What's waiting in \(.applicationName)",
            "Any decisions in \(.applicationName)",
        ], shortTitle: "What Needs Me", systemImageName: "sparkles.rectangle.stack")
        AppShortcut(intent: ShowGroceriesIntent(), phrases: [
            "What's on the \(.applicationName) grocery list",
            "What do we need from the store in \(.applicationName)",
            "Read my \(.applicationName) groceries",
        ], shortTitle: "Grocery List", systemImageName: "basket")
        AppShortcut(intent: OpenComposerIntent(), phrases: [
            "Open the \(.applicationName) composer",
            "Start a request in \(.applicationName)",
        ], shortTitle: "Open Composer", systemImageName: "square.and.pencil")
    }
}
