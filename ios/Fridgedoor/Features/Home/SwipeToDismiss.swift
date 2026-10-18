import SwiftUI
import UIKit

/// Swipe left to dismiss a review card inside a `ScrollView` (where `.swipeActions`
/// isn't available). A UIKit pan that only begins on a clearly horizontal, leftward
/// drag leaves vertical scrolling alone, as the web `ReviewItem` does. VoiceOver and
/// keyboard users get the same action through `accessibilityAction` and the menu.
struct SwipeToDismiss: ViewModifier {
    var enabled: Bool
    var cornerRadius: CGFloat = 20
    var onDismiss: () -> Void

    @State private var offset: CGFloat = 0
    @State private var width: CGFloat = 320
    @State private var armed = false
    private let threshold: CGFloat = 90

    func body(content: Content) -> some View {
        if enabled {
            content
                .offset(x: offset)
                .background(alignment: .trailing) { revealed }
                .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
                .gesture(HorizontalPan(onChange: changed, onEnd: ended))
                .sensoryFeedback(.impact(weight: .light), trigger: armed) { _, now in now }
                .accessibilityAction(named: "Dismiss", onDismiss)
        } else {
            content
        }
    }

    private var revealed: some View {
        HStack(spacing: 6) {
            Image(systemName: "eye.slash")
            Text("Dismiss")
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(armed ? Color.onAccent : Color.muted)
        .padding(.horizontal, 20)
        .frame(maxHeight: .infinity)
        .frame(width: max(0, -offset), alignment: .trailing)
        .background(armed ? Color.plannerAccent : Color.line.opacity(0.6), in: .rect(cornerRadius: cornerRadius, style: .continuous))
        .opacity(offset < -8 ? 1 : 0)
        .animation(.snappy(duration: 0.2), value: armed)
        .accessibilityHidden(true)
    }

    private func changed(_ translation: CGFloat) {
        // Rubber-band past the threshold so the card never fully leaves under the finger.
        let raw = min(0, translation)
        offset = raw < -threshold * 1.6 ? -threshold * 1.6 + (raw + threshold * 1.6) * 0.3 : raw
        armed = offset <= -threshold
    }

    private func ended(_ translation: CGFloat, _ velocity: CGFloat) {
        if offset <= -threshold || (velocity < -900 && offset < -30) {
            withAnimation(.smooth(duration: 0.25)) { offset = -width - 40 }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(180))
                onDismiss()
                // If the dismissal fails the card comes back; make sure it isn't stranded off-screen.
                try? await Task.sleep(for: .seconds(1))
                withAnimation(.snappy) { offset = 0 }
                armed = false
            }
        } else {
            withAnimation(.snappy) { offset = 0 }
            armed = false
        }
    }
}

extension View {
    func swipeToDismiss(enabled: Bool = true, cornerRadius: CGFloat = 20, _ onDismiss: @escaping () -> Void) -> some View {
        modifier(SwipeToDismiss(enabled: enabled, cornerRadius: cornerRadius, onDismiss: onDismiss))
    }
}

/// A pan recognizer that only starts for a mostly-horizontal leftward drag.
struct HorizontalPan: UIGestureRecognizerRepresentable {
    var onChange: (CGFloat) -> Void
    var onEnd: (CGFloat, CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let translation = recognizer.translation(in: recognizer.view).x
        switch recognizer.state {
        case .changed: onChange(translation)
        case .ended: onEnd(translation, recognizer.velocity(in: recognizer.view).x)
        case .cancelled, .failed: onEnd(0, 0)
        default: break
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            return velocity.x < 0 && abs(velocity.x) > abs(velocity.y) * 1.5
        }
    }
}
