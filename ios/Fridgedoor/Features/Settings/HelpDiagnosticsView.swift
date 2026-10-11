import FridgedoorKit
import SwiftUI

/// Details for whoever runs the household server: app build, server, AI provider and
/// volume limits, sync and analysis counts, raw Gmail label ids. Kept off the everyday
/// Settings pages.
struct HelpDiagnosticsView: View {
    @Environment(PlannerStore.self) private var store
    @Environment(SettingsModel.self) private var model
    @State private var browser: BrowserLink?

    var body: some View {
        List {
            Section {
                Button {
                    browser = BrowserLink(url: store.client.webURL("settings"))
                } label: {
                    Label("Open web settings in Safari", systemImage: "safari")
                }
            } footer: {
                Text("Connecting Google, downloading the Shortcut and adding browsers happen on the web.")
            }
            .plannerRows()

            Section("App") {
                LabeledContent("Version", value: appVersion)
                LabeledContent("Server", value: store.client.baseURL.host() ?? store.client.baseURL.absoluteString)
                if let refreshed = store.lastRefreshedAt {
                    LabeledContent("Last updated", value: TimeLabels.time(refreshed, in: store.timeZone))
                }
                LabeledContent("Timezone", value: store.member.timezone)
            }
            .plannerRows()

            if let status = model.backgroundAi {
                emailSection(status)
            }

            if let connection = store.connection, connection.connected {
                Section("Google sync") {
                    LabeledContent("Last email sync", value: settingsTimestamp(connection.syncLastSuccessAt, in: store.timeZone) ?? "Not yet")
                    LabeledContent("Emails waiting for analysis", value: "\(connection.analysisPending ?? 0)")
                    if let code = connection.syncErrorCode { LabeledContent("Sync error", value: code) }
                }
                .plannerRows()
            }

            calendarsSection

            if let digest = model.digest {
                Section("Morning notification") {
                    LabeledContent("Web delivery", value: digest.available == true ? "Available" : "Not configured")
                    LabeledContent("Browsers enrolled", value: "\(digest.devices ?? 0)")
                    if let last = digest.lastDelivery {
                        LabeledContent("Last delivery", value: PlannerDates.day(last.date, in: store.timeZone).map { TimeLabels.day($0, in: store.timeZone) } ?? last.date)
                        LabeledContent("Accepted by browsers", value: "\(last.accepted ?? 0)")
                    }
                }
                .plannerRows()
            }

            if let labels = model.policy?.excludedLabels, !labels.isEmpty {
                Section {
                    ForEach(labels, id: \.self) { label in
                        LabeledContent(gmailLabelName(label), value: label)
                            .font(.subheadline)
                    }
                } header: {
                    Text("Skipped Gmail labels")
                } footer: {
                    Text("Names as Gmail shows them, and the ids the server matches.")
                }
                .plannerRows()
            }
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("Help & diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await store.refresh([.connection])
            await model.load([.backgroundAi, .calendars, .digest, .policy])
        }
        .fullScreenCover(item: $browser) { SafariView(url: $0.url).ignoresSafeArea() }
    }

    private func emailSection(_ status: BackgroundAiStatus) -> some View {
        Section {
            LabeledContent("Provider", value: status.provider ?? "Not configured")
            LabeledContent("Model", value: status.model ?? "Not configured")
            LabeledContent("Analyses in the last hour", value: "\(status.attemptsLastHour)")
            LabeledContent("Analyses in the last 24 hours", value: "\(status.attemptsLastDay)")
            LabeledContent("Failed in the last 24 hours", value: "\(status.failuresLastDay)")
            LabeledContent("Queued", value: "\(status.pending)")
            LabeledContent("Last successful analysis", value: settingsTimestamp(status.lastProcessedAt, in: store.timeZone) ?? "None yet")
            if status.volumeWarning {
                SettingsNotice(text: "Unusually high email processing: \(status.attemptsLastHour) attempts in the last hour and \(status.attemptsLastDay) in the last 24 hours. This can happen during catch-up or an email flood. " + (status.pausedForVolume ? "Analysis is temporarily paused and resumes automatically as volume falls. Queued emails are kept subject to normal source expiry." : "Analysis continues. You can turn off email suggestions if this is unexpected."), tone: .warning)
            }
        } header: {
            Text("Email suggestions")
        } footer: {
            Text("Emergency protection pauses analysis at \(status.hourlyLimit.formatted()) attempts per hour or \(status.dailyLimit.formatted()) per day. These are volume safeguards, not spending caps.")
        }
        .plannerRows()
    }

    @ViewBuilder
    private var calendarsSection: some View {
        let read = model.savedCalendars.filter { $0.selected || $0.isDestination == true }
        if !read.isEmpty {
            Section("Calendar sync") {
                ForEach(read) { calendar in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(calendar.name).foregroundStyle(Color.ink)
                        Text(calendarDetail(calendar)).font(.subheadline).foregroundStyle(Color.muted)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .plannerRows()
        }
    }

    private func calendarDetail(_ calendar: SourceCalendar) -> String {
        let sync = calendar.sync
        var parts = [settingsTimestamp(sync?.lastSuccessAt, in: store.timeZone).map { "Last synced \($0)" } ?? "Not synced yet"]
        parts.append("\(sync?.imported ?? 0) imported · \(sync?.upcoming ?? 0) in the next 7 days")
        if let error = sync?.error { parts.append("Error: \(error)") } else if sync?.stale == true { parts.append("Overdue") }
        return parts.joined(separator: "\n")
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String
        return build.map { "\(version) (\($0))" } ?? version
    }
}
