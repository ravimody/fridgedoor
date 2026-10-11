import FridgedoorKit
import SafariServices
import SwiftUI

/// In-app Safari for browser-only steps (Google consent, Shortcut download). It keeps
/// its own cookies, so the household sign-in page may appear once.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.barCollapsingEnabled = true
        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.dismissButtonStyle = .done
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

struct BrowserLink: Identifiable, Hashable {
    let url: URL
    var id: String { url.absoluteString }
}

/// Settings row label: a tinted glyph (no colored tile), a title and a trailing value
/// that summarizes the page's state. `LabeledContent` stacks the value under the
/// title at accessibility sizes instead of squeezing both onto one line.
struct SettingsRowLabel: View {
    let title: String
    let systemImage: String
    var value: String?
    var valueTone: Color = .muted

    var body: some View {
        LabeledContent {
            if let value { Text(value).foregroundStyle(valueTone).lineLimit(2) }
        } label: {
            Label {
                Text(title).foregroundStyle(Color.ink)
            } icon: {
                SettingsGlyph(systemImage: systemImage)
            }
        }
    }
}

/// A Settings icon: the symbol itself in the accent color, in a fixed-width slot so
/// row titles line up.
struct SettingsGlyph: View {
    let systemImage: String
    var tint: Color = .plannerAccent
    @ScaledMetric(relativeTo: .body) private var width: CGFloat = 28

    var body: some View {
        Image(systemName: systemImage)
            .font(.body.weight(.medium))
            .foregroundStyle(tint)
            .frame(width: width)
            .accessibilityHidden(true)
    }
}

/// Inline status message inside a settings list (the web's `role="status"` notices).
struct SettingsNotice: View {
    enum Tone { case info, success, warning }
    let text: String
    var tone: Tone = .info

    var body: some View {
        Label {
            Text(text).font(.subheadline).foregroundStyle(Color.ink)
        } icon: {
            Image(systemName: tone == .warning ? "exclamationmark.triangle.fill" : tone == .success ? "checkmark.circle.fill" : "info.circle.fill")
                .foregroundStyle(tone == .warning ? Color.warning : Color.plannerAccent)
        }
        .listRowBackground(Color.soft)
        .accessibilityElement(children: .combine)
    }
}

/// Placeholder row shown while a settings part loads or after it fails.
struct SettingsLoadingRow: View {
    var failed = false
    var retry: (() -> Void)?

    var body: some View {
        if failed {
            HStack {
                Label("Couldn't load this setting.", systemImage: "exclamationmark.triangle").foregroundStyle(Color.muted)
                Spacer()
                if let retry {
                    Button("Retry", action: retry)
                        .font(.subheadline.weight(.semibold))
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
            }
        } else {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading…").foregroundStyle(Color.muted)
            }
        }
    }
}

/// Up to three short bullets that say what a setting does, with the full text one
/// tap away under "Read more" (DESIGN.md: long policy text by progressive disclosure).
struct SettingsSummary: View {
    struct Point: Hashable {
        let systemImage: String
        let text: String
        init(_ systemImage: String, _ text: String) { self.systemImage = systemImage; self.text = text }
    }

    let points: [Point]
    var readMoreTitle = "Read more"
    var details: [String] = []
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(points, id: \.self) { point in
                Label {
                    Text(point.text).foregroundStyle(Color.ink).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    SettingsGlyph(systemImage: point.systemImage)
                }
                .font(.subheadline)
            }
            if !details.isEmpty {
                DisclosureGroup(readMoreTitle, isExpanded: $expanded) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(details, id: \.self) { paragraph in
                            Text(paragraph).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .padding(.top, 6)
                }
                .font(.subheadline.weight(.semibold))
                .tint(Color.plannerAccent)
                .frame(minHeight: 44)
            }
        }
        .padding(.vertical, 4)
    }
}

extension View {
    /// Room under a list's last row for the floating composer accessory (its height
    /// plus 16pt), so footers and Sign out aren't hidden behind it.
    func settingsBottomClearance() -> some View {
        contentMargins(.bottom, 72, for: .scrollContent)
    }
}

/// "Oct 10, 3:39 PM" in the member's timezone, or nil.
func settingsTimestamp(_ iso: String?, in zone: TimeZone) -> String? {
    PlannerDates.instant(iso).map { TimeLabels.dateTime($0, in: zone) }
}

/// The member's timezone as people say it ("Eastern Time").
func settingsTimeZoneName(_ zone: TimeZone, fallback: String? = nil) -> String {
    zone.localizedName(for: .generic, locale: .current) ?? fallback ?? zone.identifier
}

/// Gmail's system label ids as Gmail shows them; names people typed stay as they are.
func gmailLabelName(_ id: String) -> String {
    switch id.uppercased() {
    case "CATEGORY_PROMOTIONS": "Promotions"
    case "CATEGORY_SOCIAL": "Social"
    case "CATEGORY_UPDATES": "Updates"
    case "CATEGORY_FORUMS": "Forums"
    case "CATEGORY_PERSONAL": "Primary"
    case "INBOX": "Inbox"
    case "SPAM": "Spam"
    case "TRASH": "Trash"
    case "IMPORTANT": "Important"
    case "STARRED": "Starred"
    case "SENT": "Sent"
    case "DRAFT": "Drafts"
    case "UNREAD": "Unread"
    case "CHAT": "Chat"
    default: id
    }
}
