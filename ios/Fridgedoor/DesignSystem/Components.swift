import FridgedoorKit
import SwiftUI

/// Small uppercase label above titles ("FRIDGEDOOR", "TODAY").
struct Eyebrow: View {
    let text: String
    var color: Color = .plannerAccent
    init(_ text: String, color: Color = .plannerAccent) { self.text = text; self.color = color }
    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.bold))
            .tracking(1.6)
            .foregroundStyle(color)
    }
}

/// Serif module heading with an optional quiet trailing note.
struct SectionHeading: View {
    let title: String
    var note: String?
    init(_ title: String, note: String? = nil) { self.title = title; self.note = note }
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.serif(.title2)).foregroundStyle(Color.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let note { Text(note).font(.caption).foregroundStyle(Color.muted) }
        }
        .padding(.top, 24)
        .padding(.bottom, 8)
    }
}

enum CardTone { case plain, soft, attention }

struct CardModifier: ViewModifier {
    var tone: CardTone = .plain
    var padding: CGFloat = 16
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(tone == .attention ? Color.attentionInk : Color.ink)
            .background(background, in: shape)
            .overlay { if tone == .plain { shape.strokeBorder(Color.line, lineWidth: 1) } }
    }
    private var background: Color { tone == .attention ? .attention : tone == .soft ? .soft : .card }
    // Attention cards use the web's asymmetric "tab" corner.
    private var shape: UnevenRoundedRectangle {
        tone == .attention
            ? UnevenRoundedRectangle(topLeadingRadius: 5, bottomLeadingRadius: 20, bottomTrailingRadius: 20, topTrailingRadius: 20, style: .continuous)
            : UnevenRoundedRectangle(cornerRadii: .init(topLeading: 16, bottomLeading: 16, bottomTrailing: 16, topTrailing: 16), style: .continuous)
    }
}

extension View {
    func plannerCard(_ tone: CardTone = .plain, padding: CGFloat = 16) -> some View { modifier(CardModifier(tone: tone, padding: padding)) }
    /// Standard screen background for scroll views and lists.
    func plannerBackground() -> some View { background(Color.paper.ignoresSafeArea()) }
    /// Every grouped `List` (DESIGN.md → Surfaces): paper behind, card-colored rows.
    /// Pair with `.plannerRows()` on each `Section`.
    func plannerList() -> some View {
        scrollContentBackground(.hidden)
            .background(Color.paper.ignoresSafeArea())
            .listStyle(.insetGrouped)
    }
    /// Card-colored rows for a `Section` (or a single row) inside `plannerList()`.
    func plannerRows() -> some View { listRowBackground(Color.card) }
}

struct Badge: View {
    enum Style { case neutral, accent, attention, warning, danger }
    let text: String
    var style: Style = .neutral
    var systemImage: String?
    init(_ text: String, style: Style = .neutral, systemImage: String? = nil) { self.text = text; self.style = style; self.systemImage = systemImage }
    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage) }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .foregroundStyle(foreground)
        .background(background, in: .capsule)
    }
    private var foreground: Color {
        switch style { case .neutral: .ink; case .accent: .onAccent; case .attention: .attentionInk; case .warning: .warning; case .danger: .danger }
    }
    private var background: Color {
        switch style { case .neutral: .soft; case .accent: .plannerAccent; case .attention: .attention; case .warning: .warning.opacity(0.14); case .danger: .danger.opacity(0.14) }
    }
}

struct PlannerButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, quiet, destructive }
    enum Size { case regular, small, large }
    var kind: Kind = .primary
    var size: Size = .regular
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(size == .small ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .padding(.horizontal, size == .small ? 14 : 20)
            .frame(minHeight: size == .large ? 54 : size == .small ? 36 : 46)
            .foregroundStyle(foreground)
            .background(background, in: .capsule)
            .overlay { if kind == .secondary { Capsule().strokeBorder(Color.plannerAccent, lineWidth: 1) } }
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
            // Small buttons look 36pt tall but take taps across 44pt.
            .padding(.vertical, size == .small ? 4 : 0)
            .contentShape(.rect)
    }
    private var foreground: Color {
        switch kind { case .primary: .onAccent; case .secondary, .quiet: .plannerAccent; case .destructive: .danger }
    }
    private var background: Color {
        switch kind { case .primary: .plannerAccent; case .secondary: .clear; case .quiet: .soft; case .destructive: .danger.opacity(0.12) }
    }
}

extension ButtonStyle where Self == PlannerButtonStyle {
    static var plannerPrimary: PlannerButtonStyle { PlannerButtonStyle(kind: .primary) }
    static var plannerSecondary: PlannerButtonStyle { PlannerButtonStyle(kind: .secondary) }
    static var plannerQuiet: PlannerButtonStyle { PlannerButtonStyle(kind: .quiet, size: .small) }
}

/// Dashed placeholder used for empty days and empty lists.
struct EmptyState: View {
    let systemImage: String
    let title: String
    var message: String?
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage).font(.title2).foregroundStyle(Color.muted)
            Text(title).font(.headline).foregroundStyle(Color.ink)
            if let message { Text(message).font(.subheadline).foregroundStyle(Color.muted).multilineTextAlignment(.center) }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.line, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
        }
    }
}

/// Inline error with optional retry, for screens whose data failed to load.
struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Color.warning)
            Text(message).font(.subheadline).foregroundStyle(Color.ink).frame(maxWidth: .infinity, alignment: .leading)
            if let retry { Button("Retry", action: retry).font(.subheadline.weight(.semibold)) }
        }
        .plannerCard(.soft, padding: 12)
    }
}

struct MemberAvatar: View {
    let name: String
    var size: CGFloat = 32
    var body: some View {
        Text(String(name.prefix(1)).uppercased())
            .font(.system(size: size * 0.45, weight: .semibold, design: .serif))
            .foregroundStyle(Color.onAccent)
            .frame(width: size, height: size)
            .background(Color.plannerAccent, in: .circle)
            .accessibilityHidden(true)
    }
}

/// A labeled value row for detail screens.
struct DetailRow: View {
    let systemImage: String
    let text: String
    var secondary: String?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage).foregroundStyle(Color.muted).frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(text).foregroundStyle(Color.ink)
                if let secondary { Text(secondary).font(.caption).foregroundStyle(Color.muted) }
            }
        }
        .font(.subheadline)
    }
}
