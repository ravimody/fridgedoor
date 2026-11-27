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
                    .init("lock", "Email and what you send the planner are kept encrypted, then deleted after 7 days."),
                    .init("sparkles", "AI services get only what they need, never your sign-in or the power to change calendars."),
                ], readMoreTitle: "Read the full policy", details: Self.policy)
            }
            .plannerRows()
            Section {
                Text("To remove your private data, use Settings → Email → Delete my private data.")
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

    /// The full disclosure, as the web's Settings → Email shows it.
    static let policy = [
        "What's shared. Household suggestions share only permitted logistics and facts; the source email and private evidence stay with you. Clear everyday logistics become shared suggestions automatically. Uncertain or personal items stay private until you share them. Medical sources stay private unless you opt into generic appointment logistics, without diagnosis or provider details. Work email, and email from excluded senders or labels, doesn't become a suggestion at all. Work and personal calendars stay visible only to you.",
        "What's kept, and for how long. Stored email and private extraction data are encrypted and deleted after 7 days. What you send the planner (photos, PDFs, text and links) and its replies are also deleted after 7 days. Shared plans and calendar events stay until the household deletes them. The server operator can access decrypted processing data.",
        "AI providers. Email suggestions control background AI for your account separately from email sync and the planner. Hosted AI can retain submitted content under its provider policy; this isn't a zero-retention service. Most providers keep API data for a limited time for abuse monitoring under their own policy. AI never receives sign-in tokens or authority to write calendars.",
    ]
}
