import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// "Linen & Teal" (see `docs/features/home-design.md`): linen/ink neutrals, a slate-blue
/// accent, and teal reserved for things that need attention. Values mirror the
/// web tokens in `web/src/app/styles.css`.
public extension Color {
    static let paper = Color(light: 0xF0EBE1, dark: 0x22262D)
    static let card = Color(light: 0xE8E3DA, dark: 0x2A2F37)
    static let ink = Color(light: 0x303846, dark: 0xEAE5DC)
    static let muted = Color(light: 0x585F6C, dark: 0xB2B8C2)
    static let line = Color(light: 0xCECAC2, dark: 0x414650)
    static let soft = Color(light: 0xE2E4E7, dark: 0x2E3540)
    static let plannerAccent = Color(light: 0x455A7A, dark: 0xACBFD9)
    static let onAccent = Color(light: 0xF8F3E8, dark: 0x212F45)
    static let attention = Color(light: 0xC5E5DF, dark: 0x304B4B)
    static let attentionInk = Color(light: 0x294F4C, dark: 0xC5E9E2)
    static let warning = Color(light: 0x9A5B13, dark: 0xF0C27A)
    static let danger = Color(light: 0xA23B32, dark: 0xF2A39B)

    init(light: UInt32, dark: UInt32) {
        #if canImport(UIKit)
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        })
        #else
        self.init(red: Double((light >> 16) & 0xFF) / 255, green: Double((light >> 8) & 0xFF) / 255, blue: Double(light & 0xFF) / 255)
        #endif
    }
}

public extension Font {
    /// Editorial serif headings (New York), as the web uses Georgia.
    static func serif(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font { .system(style, design: .serif, weight: weight) }
}
