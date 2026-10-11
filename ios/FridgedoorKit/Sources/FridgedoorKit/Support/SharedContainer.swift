import Foundation

/// State shared between the app, the widget and the Share extension through the
/// App Group. Holds no plan content except the widget's small today snapshot.
public enum SharedContainer {
    public static var appGroup: String? { Bundle.main.object(forInfoDictionaryKey: "PlannerAppGroup") as? String }
    public static var sharedKeychainGroup: String? { Bundle.main.object(forInfoDictionaryKey: "PlannerKeychainGroup") as? String }

    public static var defaults: UserDefaults { appGroup.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

    /// The household's server (an origin from `ServerAddress`). There is no
    /// default: nil until someone pairs or enters an address.
    public static var serverURL: URL? {
        get { defaults.string(forKey: "serverURL").flatMap(URL.init(string:)) }
        set { defaults.set(newValue?.absoluteString, forKey: "serverURL") }
    }

    /// Capture-only credential (`/capture/v1`), readable by the Share extension.
    /// It cannot read plans or apply changes, unlike the app's session.
    public struct CaptureCredential: Codable, Sendable {
        public let id: String
        public let token: String
        public let serverURL: URL
        public init(id: String, token: String, serverURL: URL) { self.id = id; self.token = token; self.serverURL = serverURL }
    }

    static var sharedKeychain: KeychainStore { KeychainStore(service: "app.fridgedoor.capture", accessGroup: sharedKeychainGroup) }

    public static var captureCredential: CaptureCredential? {
        get { sharedKeychain.value(CaptureCredential.self, for: "share-capture") }
        set { sharedKeychain.setValue(newValue, for: "share-capture") }
    }

    public static var snapshotURL: URL? {
        appGroup.flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }?.appending(path: "widget-snapshot.json")
    }

    /// Fallback for builds without an App Group (a free personal team can't
    /// provision one): the shared Keychain group still reaches the widget.
    static var snapshotKeychain: KeychainStore { KeychainStore(service: "app.fridgedoor.widget", accessGroup: sharedKeychainGroup) }

    public static func writeSnapshot(_ snapshot: WidgetSnapshot?) {
        let data = snapshot.flatMap { try? JSONEncoder().encode($0) }
        guard let url = snapshotURL else {
            snapshotKeychain.set(data, for: "widget-snapshot")
            return
        }
        if let data {
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } else {
            try? FileManager.default.removeItem(at: url)
            // A copy from a build that had no App Group would otherwise outlive the account.
            snapshotKeychain.set(nil, for: "widget-snapshot")
        }
    }

    public static func readSnapshot() -> WidgetSnapshot? {
        let data = snapshotURL.map { try? Data(contentsOf: $0) } ?? snapshotKeychain.data("widget-snapshot")
        return data.flatMap { try? JSONDecoder().decode(WidgetSnapshot.self, from: $0) }
    }
}

/// What the widget shows: the next few things today plus open counts.
public struct WidgetSnapshot: Codable, Hashable, Sendable {
    public struct Entry: Codable, Hashable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let start: Date?
        public let end: Date?
        public let allDay: Bool
        public let kind: String // event | task | reminder
        /// `fridgedoor://…` deep link for this row (plan detail, To do, …).
        public let link: String?
        /// Private plans and owner-only calendar events; redacted on the Lock Screen.
        public let isPrivate: Bool?
        public init(id: String, title: String, start: Date?, end: Date?, allDay: Bool, kind: String, link: String? = nil, isPrivate: Bool? = nil) {
            self.id = id; self.title = title; self.start = start; self.end = end; self.allDay = allDay; self.kind = kind
            self.link = link; self.isPrivate = isPrivate
        }
    }

    /// A to-do or grocery row for the interactive list widgets.
    public struct ListRow: Codable, Hashable, Sendable, Identifiable {
        public let id: String
        public let title: String
        /// Quantity for groceries; "Overdue" / "Today" / "Mon" for to-dos.
        public let detail: String?
        /// Aisle for groceries; "Overdue" / "Today" / "Coming up" / "No date" for to-dos.
        public let section: String?
        public let overdue: Bool?
        /// Initial of the assignee when it isn't the signed-in member.
        public let assignee: String?
        public init(id: String, title: String, detail: String? = nil, section: String? = nil, overdue: Bool? = nil, assignee: String? = nil) {
            self.id = id; self.title = title; self.detail = detail; self.section = section; self.overdue = overdue; self.assignee = assignee
        }
    }

    /// A suggestion waiting on a decision, for the Decisions widget.
    public struct DecisionRow: Codable, Hashable, Sendable, Identifiable {
        public enum Action: String, Codable, Sendable { case calendar, keep }
        public let id: String // plan id
        public let title: String
        public let detail: String
        /// What one tap can do from the widget; nil means it needs the app (e.g. a missing time).
        public let action: Action?
        public let isPrivate: Bool
        public init(id: String, title: String, detail: String, action: Action?, isPrivate: Bool) {
            self.id = id; self.title = title; self.detail = detail; self.action = action; self.isPrivate = isPrivate
        }
    }

    /// The item last checked off from a widget, so the widget can offer Undo for a while.
    public struct Checked: Codable, Hashable, Sendable {
        public let id: String
        public let title: String
        public let kind: String // todo | grocery
        public let at: Date
        public init(id: String, title: String, kind: String, at: Date) { self.id = id; self.title = title; self.kind = kind; self.at = at }
    }

    public let generatedAt: Date
    public let memberName: String
    public let timezone: String
    public let entries: [Entry]
    public let attentionCount: Int
    public let openTodoCount: Int
    public let openGroceryCount: Int
    // Interactive widgets (absent in snapshots written by older builds).
    public let groceries: [ListRow]?
    public let todos: [ListRow]?
    public let decisions: [DecisionRow]?
    public var lastChecked: Checked?

    public init(generatedAt: Date, memberName: String, timezone: String, entries: [Entry], attentionCount: Int, openTodoCount: Int, openGroceryCount: Int,
                groceries: [ListRow]? = nil, todos: [ListRow]? = nil, decisions: [DecisionRow]? = nil, lastChecked: Checked? = nil) {
        self.generatedAt = generatedAt; self.memberName = memberName; self.timezone = timezone; self.entries = entries
        self.attentionCount = attentionCount; self.openTodoCount = openTodoCount; self.openGroceryCount = openGroceryCount
        self.groceries = groceries; self.todos = todos; self.decisions = decisions; self.lastChecked = lastChecked
    }
}
