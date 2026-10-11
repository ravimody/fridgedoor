import FridgedoorKit
import SwiftUI

/// Native iPhone notification controls (permission, reminder and daily brief alerts,
/// test), shown at the top of Notifications settings. If the account also has browsers
/// enrolled for web notifications, one line says how to avoid double alerts.
struct NotificationSettingsSection: View {
    @Bindable private var prefs = PlatformPreferences.shared

    var body: some View {
        Section {
            NotificationSettingsControls()
        } header: {
            Text("This iPhone")
        } footer: {
            if (prefs.serverDigest?.devices ?? 0) > 0 {
                Text("Also using web notifications in Safari on this iPhone? Turn one of them off so alerts don't arrive twice.")
            }
        }
        .plannerRows()
    }
}
