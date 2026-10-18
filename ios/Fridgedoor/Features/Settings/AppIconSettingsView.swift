import SwiftUI
import UIKit

/// The Home Screen icon: Big sun (the default) or one of the alternate icon sets
/// (`ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`, drawn by `scripts/make-icon.swift`).
enum AppIconChoice: CaseIterable, Identifiable {
    case bigSun, risingSun, fullPage

    var id: Self { self }

    /// The alternate icon set; nil is the primary icon.
    var iconName: String? {
        switch self {
        case .bigSun: nil
        case .risingSun: "AppIcon-RisingSun"
        case .fullPage: "AppIcon-FullPage"
        }
    }

    var title: String {
        switch self {
        case .bigSun: "Big sun"
        case .risingSun: "Rising sun"
        case .fullPage: "Full page"
        }
    }

    /// An app can't load its own icon sets as images, so each has a preview image set.
    var preview: String {
        switch self {
        case .bigSun: "IconPreview-BigSun"
        case .risingSun: "IconPreview-RisingSun"
        case .fullPage: "IconPreview-FullPage"
        }
    }

    @MainActor static var current: AppIconChoice {
        allCases.first { $0.iconName == UIApplication.shared.alternateIconName } ?? .bigSun
    }
}

struct AppIconSettingsView: View {
    @State private var selected = AppIconChoice.current
    @State private var failed = false

    var body: some View {
        List {
            Section {
                ForEach(AppIconChoice.allCases) { choice in
                    Button { choose(choice) } label: {
                        HStack(spacing: 14) {
                            Image(choice.preview)
                                .resizable()
                                .frame(width: 60, height: 60)
                                .clipShape(.rect(cornerRadius: 13.5, style: .continuous))
                                .accessibilityHidden(true)
                            Text(choice.title).foregroundStyle(Color.ink)
                            Spacer(minLength: 0)
                            if choice == selected {
                                Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.plannerAccent)
                            }
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(choice == selected ? .isSelected : [])
                }
            } footer: {
                Text("Each icon has a dark and a tinted look that follow your Home Screen.")
            }
            .plannerRows()
        }
        .plannerList()
        .settingsBottomClearance()
        .navigationTitle("App icon")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Couldn’t change the icon", isPresented: $failed) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Try again in a moment.")
        }
    }

    private func choose(_ choice: AppIconChoice) {
        guard choice != selected, UIApplication.shared.supportsAlternateIcons else { return }
        let previous = selected
        selected = choice
        Task {
            do {
                try await UIApplication.shared.setAlternateIconName(choice.iconName)
            } catch {
                selected = previous
                failed = true
            }
        }
    }
}
