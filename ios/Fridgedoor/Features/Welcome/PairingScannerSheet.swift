import AVFoundation
import FridgedoorKit
import SwiftUI
import UIKit
import VisionKit

/// Scans the QR code from the web app's Settings → iPhone page. Hands back a
/// parsed `PairingLink`; confirming its server happens in `PairingConfirmSheet`.
struct PairingScannerSheet: View {
    let onFound: (PairingLink) -> Void

    private enum Camera { case checking, ready, denied, unsupported }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var camera = Camera.checking
    @State private var hint: String?
    @State private var found = false

    var body: some View {
        NavigationStack {
            Group {
                switch camera {
                case .checking:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .ready:
                    ZStack(alignment: .bottom) {
                        QRScanner { handle($0) }.ignoresSafeArea(edges: .bottom)
                        Text(hint ?? "Point the camera at the code in Settings → iPhone on the web.")
                            .font(.subheadline)
                            .foregroundStyle(Color.ink)
                            .multilineTextAlignment(.center)
                            .padding(14)
                            .frame(maxWidth: .infinity)
                            .glassEffect(.regular, in: .rect(cornerRadius: 18))
                            .padding(20)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                case .denied, .unsupported:
                    unavailable
                }
            }
            .plannerBackground()
            .navigationTitle("Scan pairing code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .task { camera = await Self.cameraState() }
    }

    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: camera == .denied ? "video.slash" : "camera.metering.unknown")
                .font(.largeTitle)
                .foregroundStyle(Color.muted)
                .accessibilityHidden(true)
            Text(camera == .denied ? "Camera access is off" : "Scanning isn't available here")
                .font(.serif(.title2))
                .foregroundStyle(Color.ink)
            Text(camera == .denied
                 ? "Turn on camera access for Fridgedoor in Settings to scan here. Or open the iPhone Camera app and point it at the code: it opens Fridgedoor for you."
                 : "Open the iPhone Camera app and point it at the code: it opens Fridgedoor for you. Or go back and enter your server's address.")
                .font(.body)
                .foregroundStyle(Color.muted)
            if camera == .denied, let settings = URL(string: UIApplication.openSettingsURLString) {
                Button("Open Settings") { openURL(settings) }
                    .buttonStyle(PlannerButtonStyle(kind: .primary))
                    .padding(.top, 6)
            }
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func handle(_ payload: String) {
        guard !found else { return }
        do {
            let link = try PairingLink.parse(payload)
            found = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onFound(link)
        } catch {
            hint = switch error {
            case .notPairingLink: "That isn't a Fridgedoor pairing code. Scan the code in Settings → iPhone on the web."
            case .missingCode: "That pairing code is incomplete. Make a new one and try again."
            case .invalidServer(.insecureRemote): "That code points at a server over an unencrypted internet connection, so Fridgedoor won't use it."
            case .invalidServer: "That code doesn't contain a valid server address."
            }
        }
    }

    private static func cameraState() async -> Camera {
        guard DataScannerViewController.isSupported else { return .unsupported }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { return .denied }
        case .authorized: break
        default: return .denied
        }
        return DataScannerViewController.isAvailable ? .ready : .denied
    }
}

/// VisionKit's live scanner, limited to QR codes.
private struct QRScanner: UIViewControllerRepresentable {
    let onPayload: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        // Scanning can only start once the controller is in a window.
        Task { @MainActor in try? scanner.startScanning() }
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onPayload = onPayload
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload) }

    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onPayload: (String) -> Void
        init(onPayload: @escaping (String) -> Void) { self.onPayload = onPayload }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems { report(item) }
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) { report(item) }

        private func report(_ item: RecognizedItem) {
            if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue { onPayload(payload) }
        }
    }
}
