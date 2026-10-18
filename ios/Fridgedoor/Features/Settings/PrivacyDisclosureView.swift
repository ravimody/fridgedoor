import FridgedoorKit
import SwiftUI

/// The web Settings "Privacy disclosure" card (see `docs/privacy.md`): what
/// leaves this iPhone in three lines, with the full policy under "Read the full policy".
struct PrivacyDisclosureView: View {
    var body: some View {
        List {
            Section("What leaves this iPhone") {
                SettingsSummary(points: [
                    .init("person.2", "Your household sees shared plans and lists. Source emails and private details stay with you."),
                    .init("lock", "Email and chats are kept encrypted for a short time: email up to 7 days, chats up to 30."),
                    .init("sparkles", "AI services get only what they need, never your Google sign-in or the power to change calendars."),
                ], readMoreTitle: "Read the full policy", details: Self.policy)
            }
            .plannerRows()
            Section {
                Text("To remove your private data, use Google account → Delete my private data.")
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
            }
            .plannerRows()
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The full disclosure, verbatim from the web.
    static let policy = [
        "What's shared. Household suggestions share only permitted logistics and facts; the source email and private evidence stay with you. Work calendars, private or uncertain items, and excluded sources stay owner-only. Medical sources stay private unless you opt into generic appointment logistics, without diagnosis or provider details.",
        "What's kept, and for how long. Encrypted source email and private extraction data are kept for up to 7 days, private chat for up to 30 days, and uploaded photos or PDFs for up to 24 hours after successful extraction. Shared plans and calendar bindings stay until the household deletes them. The server operator can access decrypted processing data.",
        "AI providers. Email suggestions control background AI for your account separately from Google sync and the interactive assistant. Hosted AI can retain submitted content under its provider policy; this isn't a zero-retention service. Most providers keep API data for a limited time for abuse monitoring under their own policy. AI never receives sign-in tokens or authority to write calendars.",
    ]
}
