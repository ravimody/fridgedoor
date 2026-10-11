import AuthenticationServices
import Foundation
import Observation
import FridgedoorKit
import SwiftUI
import UIKit

struct Toast: Identifiable, Equatable {
    struct Action: Equatable {
        let label: String
        let id = UUID()
        let perform: @MainActor () -> Void
        static func == (lhs: Action, rhs: Action) -> Bool { lhs.id == rhs.id }
    }
    let id = UUID()
    let message: String
    var action: Action?
    var isError = false
    var duration: Duration = .seconds(4)

    /// Work that has started but not finished ("Adding … to the household calendar…")
    /// shows a progress mark, never a ✓.
    var isPending: Bool { !isError && message.hasSuffix("…") }

    /// How long an Undo stays reachable. VoiceOver users need far longer to get to it.
    @MainActor static var undoWindow: Duration { UIAccessibility.isVoiceOverRunning ? .seconds(30) : .seconds(8) }
}

enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var colorScheme: ColorScheme? { self == .light ? .light : self == .dark ? .dark : nil }
}

@MainActor @Observable
final class AppModel {
    enum Phase: Equatable { case launching, signedOut, signedIn }

    private(set) var phase: Phase = .launching
    private(set) var client: PlannerClient?
    private(set) var store: PlannerStore?
    let router = Router()
    let composer = ComposerModel()
    var toast: Toast?
    var signInError: String?
    var isSigningIn = false
    /// The household's server. Nil until someone pairs or enters an address; there is no default.
    private(set) var serverURL: URL? = SharedContainer.serverURL

    /// A pairing link waiting for the person to confirm its server (`PairingConfirmSheet`).
    var pendingPairing: PairingLink?
    /// Why a pairing link couldn't be used, shown as an alert.
    var pairingProblem: String?
    var pairingError: String?
    private(set) var isPairing = false

    var appearance: Appearance {
        get { access(keyPath: \.appearance); return Appearance(rawValue: UserDefaults.standard.string(forKey: "planner-appearance") ?? "") ?? .system }
        set { withMutation(keyPath: \.appearance) { UserDefaults.standard.set(newValue.rawValue, forKey: "planner-appearance") } }
    }

    private var toastTask: Task<Void, Never>?
    private var pendingURL: URL?

    func launch() async {
        #if DEBUG
        // e.g. SIMCTL_CHILD_PLANNER_DEBUG_ROUTE='pair?server=…&code=…' — the pairing confirmation, signed in or out.
        if let route = ProcessInfo.processInfo.environment["PLANNER_DEBUG_ROUTE"], let url = URL(string: "fridgedoor://\(route)"), PairingLink.isPairingLink(url) {
            handle(url)
        }
        if let preview = DebugPreviewSignIn.server {
            serverURL = preview
            if let existing = await AuthSession.shared(for: preview).member, SharedContainer.serverURL == preview {
                await start(auth: AuthSession.shared(for: preview), member: existing)
            } else if let (auth, member) = try? await DebugPreviewSignIn.signIn(server: preview) {
                await start(auth: auth, member: member)
            } else {
                phase = .signedOut; signInError = "Preview server at \(preview.absoluteString) didn't respond."
            }
            return
        }
        #endif
        guard let serverURL else { phase = .signedOut; return }
        let auth = AuthSession.shared(for: serverURL)
        guard let member = await auth.member else { phase = .signedOut; return }
        await start(auth: auth, member: member)
    }

    private func start(auth: AuthSession, member: Member) async {
        await auth.setSignOutHandler { [weak self] expired in
            // Only the current session may end the signed-in state: after switching
            // servers, the old session's late sign-out must not touch the new one.
            Task { @MainActor in if self?.client?.auth === auth { self?.didSignOut(expired: expired) } }
        }
        let client = PlannerClient(auth: auth)
        let store = PlannerStore(client: client, member: member)
        store.announce = { [weak self] message in self?.show(message) }
        store.didRefresh = { store in PlatformIntegration.storeDidRefresh(store) }
        self.client = client
        self.store = store
        phase = .signedIn
        PlatformIntegration.didSignIn(self)
        if let pendingURL { self.pendingURL = nil; handle(pendingURL) }
        #if DEBUG
        // e.g. SIMCTL_CHILD_PLANNER_DEBUG_ROUTE=plans/<id> — opens a screen without a URL prompt.
        if let route = ProcessInfo.processInfo.environment["PLANNER_DEBUG_ROUTE"], let url = URL(string: "fridgedoor://\(route)"), !PairingLink.isPairingLink(url) { handle(url) }
        #endif
        await store.refresh()
    }

    // MARK: Sign in / out

    func signIn(using session: WebAuthenticationSession) async {
        guard !isSigningIn, let serverURL else { return }
        isSigningIn = true; signInError = nil
        defer { isSigningIn = false }
        let verifier = PKCE.verifier(), state = PKCE.state()
        var components = URLComponents(url: serverURL.appending(path: "dashboard/native/authorize"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: PKCE.challenge(for: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "redirect_uri", value: "fridgedoor://auth/callback"),
        ]
        do {
            // Shared browser session: reuses the person's existing sign-in to their server in Safari.
            let callback = try await session.authenticate(using: components.url!, callback: .customScheme("fridgedoor"), preferredBrowserSession: .shared, additionalHeaderFields: [:])
            let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            guard query.first(where: { $0.name == "state" })?.value == state, let code = query.first(where: { $0.name == "code" })?.value else {
                signInError = "Sign-in didn't complete. Try again."
                return
            }
            let auth = AuthSession.shared(for: serverURL)
            let member = try await auth.exchange(code: code, verifier: verifier, deviceLabel: UIDevice.current.name)
            await start(auth: auth, member: member)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return
        } catch let error as PlannerError {
            signInError = error.userMessage
        } catch {
            signInError = "Couldn't reach \(ServerAddress.Normalized.displayName(for: serverURL)). Check your connection and try again."
        }
    }

    func signOut() async {
        store?.stopPolling()
        await PlatformIntegration.willSignOut(self)
        await client?.auth.signOut()
        didSignOut(expired: false)
    }

    /// Signs out and forgets the server, back to the welcome screen's choices.
    func switchServer() async {
        await signOut()
        forgetServer()
    }

    // MARK: Server

    /// A server the person entered and `ServerProbe` verified. Remembered so a
    /// relaunch offers "Sign in" to it; nothing is signed in yet.
    func useServer(_ url: URL) {
        serverURL = url
        SharedContainer.serverURL = url
        signInError = nil
    }

    func forgetServer() {
        guard phase != .signedIn else { return }
        serverURL = nil
        SharedContainer.serverURL = nil
        signInError = nil
    }

    // MARK: Pairing

    /// Asks the person to confirm `link`'s server before anything is sent to it:
    /// a QR code from someone else could point this iPhone at a server they control.
    func offerPairing(_ link: PairingLink) {
        // Composer is the one sheet that can be up app-wide; the confirmation can't show over it.
        composer.isPresented = false
        pairingError = nil
        pendingPairing = link
    }

    /// Exchanges the one-time code, then (only once that worked) signs out of any
    /// other server and starts the new session.
    func confirmPairing(_ link: PairingLink) async {
        guard !isPairing else { return }
        if phase == .signedIn, client?.baseURL == link.server.url { pendingPairing = nil; return }
        isPairing = true; pairingError = nil
        defer { isPairing = false }
        let auth = AuthSession.shared(for: link.server.url)
        do {
            // A specific reason (not a server, certificate…) beats a generic grant failure.
            _ = try await ServerProbe.check(link.server.url)
            let member = try await auth.pair(code: link.code, deviceLabel: UIDevice.current.name)
            if phase == .signedIn, client?.auth !== auth { await signOut() }
            useServer(link.server.url)
            pendingPairing = nil
            await start(auth: auth, member: member)
        } catch {
            pairingError = (error as? PlannerError)?.userMessage ?? "Couldn't connect to \(link.server.displayName). Try again."
        }
    }

    private func receivePairingLink(_ url: URL) {
        do {
            offerPairing(try PairingLink.parse(url))
        } catch {
            pairingProblem = switch error {
            case .missingCode, .notPairingLink: "This pairing link is incomplete. Make a new code in Fridgedoor on the web (Settings → iPhone) and scan it again."
            case .invalidServer(.insecureRemote): "This pairing code points at a server over an unencrypted connection on the internet, so Fridgedoor won't use it. Set the server up with https and make a new code."
            case .invalidServer: "This pairing code doesn't contain a valid server address. Make a new code and try again."
            }
        }
    }

    private func didSignOut(expired: Bool) {
        guard phase == .signedIn else { return }
        store?.stopPolling()
        store = nil; client = nil
        router.reset()
        composer.reset()
        phase = .signedOut
        if expired {
            signInError = PlannerError.signedOut.userMessage
            // No server session left to revoke with; drop everything derived from the account.
            Task { await PlatformIntegration.didExpire() }
        }
    }

    // MARK: Links

    func handle(_ url: URL) {
        // Pairing works signed in or out (from the Camera app, a tapped link or the scanner).
        if PairingLink.isPairingLink(url) { receivePairingLink(url); return }
        guard phase == .signedIn else { pendingURL = url; return }
        if url.host() == "compose" {
            let text = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "text" }?.value
            composer.open(prefill: text)
            return
        }
        router.handle(url)
    }

    // MARK: Feedback

    func show(_ message: String, action: Toast.Action? = nil, isError: Bool = false) {
        let toast = Toast(message: message, action: action, isError: isError, duration: action == nil ? .seconds(4) : Toast.undoWindow)
        withAnimation(.snappy) { self.toast = toast }
        // Toasts are visual-only otherwise; read them out (with the action's name) for VoiceOver.
        AccessibilityNotification.Announcement(action.map { "\(message) \($0.label) is available." } ?? message).post()
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: toast.duration)
            guard !Task.isCancelled, self?.toast?.id == toast.id else { return }
            withAnimation(.snappy) { self?.toast = nil }
        }
    }

    func show(_ error: Error) {
        let message = (error as? PlannerError)?.userMessage ?? error.localizedDescription
        show(message, isError: true)
        if let error = error as? PlannerError, error.isStale { Task { await store?.refresh() } }
    }

    func dismissToast() { withAnimation(.snappy) { toast = nil } }
}
