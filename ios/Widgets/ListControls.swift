import AppIntents
import FridgedoorKit
import SwiftUI
import WidgetKit

/// Control Center / Lock Screen / Action button: open Groceries ready to type.
struct AddGroceryControl: ControlWidget {
    static let kind = "dev.fridgedoor.add-grocery"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenListAddIntent(.grocery)) {
                Label("Add Grocery", systemImage: "basket")
            }
        }
        .displayName("Add Grocery")
        .description("Open the grocery list, ready to type.")
    }
}

/// Control Center / Lock Screen / Action button: open To do ready to type.
struct AddToDoControl: ControlWidget {
    static let kind = "dev.fridgedoor.add-todo"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenListAddIntent(.todo)) {
                Label("Add To-Do", systemImage: "checklist")
            }
        }
        .displayName("Add To-Do")
        .description("Open the to-do list, ready to type.")
    }
}
