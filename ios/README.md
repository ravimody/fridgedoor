# Fridgedoor for iPhone

Native SwiftUI client for Fridgedoor (iOS 26+, iPhone). It has no server of its own:
each household points it at the Fridgedoor server they run, and it talks to that
server through `/native/v1`. No household data lives only on the phone.

## Requirements

- macOS with Xcode 26 or later (iOS 26 SDK, Swift 6).
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`.
- For the local preview server: Node 22–25 and pnpm (see the repository root).
- To run on a phone: an Apple ID in Xcode. A free personal team works, with limits
  (see "Install on a phone").

## Layout

- `project.yml`: XcodeGen spec, the source of truth. The `.xcodeproj` is generated and
  gitignored: run `xcodegen generate` after pulling or after adding or removing files.
- `Config/Base.xcconfig`: signing team and bundle-id prefix (see "Signing").
- `FridgedoorKit/`: Swift package shared by the app, widget and Share extension: wire
  models, `PlannerClient`, `AuthSession` (Keychain, PKCE, pairing, single-flight
  refresh), `ServerAddress` / `PairingLink` / `ServerProbe` (server addresses and
  pairing links), `PlannerDates`, palette.
- `Fridgedoor/App`: `AppModel` (server, sign-in phase, pairing, toasts), `Router`
  (tabs, routes, `fridgedoor://` deep links), `PlannerStore` (app-wide cache, polling)
  and shared actions.
- `Fridgedoor/Features/*`: Welcome (first run, QR pairing, server address), Home, To
  do/Groceries, Plans + reminders, Composer + requests, Settings, Knowledge, Feedback.
  `Fridgedoor/Platform`: local notifications, background refresh, App Intents/Siri,
  Spotlight, widget snapshot, Share credential.
- `Widgets/`: Today, Groceries, To do, Decisions and Quick actions widgets (Home and
  Lock Screen), and the Ask Planner / Add Grocery / Add To-Do controls.
- `ShareExtension/`: share text, links, photos and PDFs into the planner.
- `Watch/`: the Apple Watch app (`App/`: brief, today, decisions) and its Today
  complication (`Widgets/`). It has no credential; see "Apple Watch" below.
- `DESIGN.md`: vocabulary and UI rules every screen follows. Update it when a rule changes.
- `scripts/make-icon.swift`: draws the app icons (`swift scripts/make-icon.swift`): Big
  sun (the default `AppIcon`), Rising sun and Full page, each in light, dark and tinted,
  plus their Settings → App icon previews, the watch icon and `site/icon.png`.

## Build and test

```sh
cd ios
xcodegen generate
xcodebuild -project Fridgedoor.xcodeproj -scheme Fridgedoor \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/dd \
  CODE_SIGNING_ALLOWED=NO build
(cd FridgedoorKit && swift test)
```

Or open `Fridgedoor.xcodeproj` in Xcode and run the Fridgedoor scheme on a simulator.
Simulator builds need no signing team.

## Signing

`Config/Base.xcconfig` sets an empty `DEVELOPMENT_TEAM` and
`FRIDGEDOOR_BUNDLE_PREFIX = dev.fridgedoor`. To build for a device, use your own:

```sh
cp Config/Local.xcconfig.example Config/Local.xcconfig   # gitignored
# edit DEVELOPMENT_TEAM and FRIDGEDOOR_BUNDLE_PREFIX, then:
xcodegen generate
```

Everything that must be unique per Apple team derives from the prefix: the bundle ids
(`<prefix>`, `<prefix>.widgets`, `<prefix>.share`, `<prefix>.watchkitapp`,
`<prefix>.watchkitapp.widgets`), the App Group
(`group.<prefix>`), the Keychain groups, the background-task id and the
`PlannerAppGroup` / `PlannerKeychainGroup` Info.plist keys that code reads at runtime.
Never hard-code any of them.

## Run against the local preview server

The preview server serves an obviously fake household on loopback, with the real HTTP
handlers. From the repository root:

```sh
pnpm install
pnpm --filter @fridgedoor/contracts build
pnpm --filter @fridgedoor/server dev:native        # http://127.0.0.1:8899
```

Then either tap **Enter server address** in the app and use `http://127.0.0.1:8899`
(the preview server treats every browser as the preview member, so the sign-in sheet
only asks for confirmation), or let a DEBUG build sign in headlessly:

```sh
xcrun simctl install <device> build/dd/Build/Products/Debug-iphonesimulator/Fridgedoor.app
SIMCTL_CHILD_PLANNER_PREVIEW_SERVER=http://127.0.0.1:8899 \
SIMCTL_CHILD_PLANNER_DEBUG_ROUTE=plans/<id> \
  xcrun simctl launch --terminate-running-process <device> dev.fridgedoor
```

Use `127.0.0.1`, not `localhost`: the server checks the exact origin.
`PLANNER_DEBUG_ROUTE` takes any deep link path (`home`, `todos`, `groceries`, `more`,
`settings`, `knowledge`, `history`, `suggestions`, `plans/<id>`, `requests/<id>`) or a
pairing link (`'pair?server=…&code=…'`, shown signed in or out). Both variables are
DEBUG-only; the preview hook accepts only loopback hosts. `PREVIEW_MEMBER=sam` on the
server signs in as the second member.

Boot at most one or two simulators at a time: each runs hundreds of processes, and
several together can exhaust the macOS per-user process limit.

## Connecting to a server

There is no default server. A signed-out app offers:

- **Scan pairing code**: the web app's Settings → iPhone page shows a QR code for
  `fridgedoor://pair?server=<origin>&code=<one-time code>` (10 minutes, single use).
  The iPhone Camera app or a tapped link opens the same link. The app always asks
  "Connect to <host>?" before exchanging the code (`grantType: pairing_code`), because
  a code from someone else could point it at a server they control.
- **Enter server address**: normalized by `ServerAddress` (https unless typed
  otherwise; plain http only for LAN, `.local`, Tailscale and similar hosts, with a
  warning), checked with `/healthz` and `/dashboard/api/v1/auth/status`, then the
  browser sign-in at `/dashboard/native/authorize` (PKCE, `ASWebAuthenticationSession`).
- **Set one up**: the setup guide in the repository README.

Settings → Switch server signs out (revoking the session and the Share credential,
clearing notifications, widget snapshots and Spotlight) and forgets the server.
Session tokens are stored per server in the Keychain.

## Install on a phone

1. Set your team and prefix in `Config/Local.xcconfig` (see "Signing"), then
   `xcodegen generate`.
2. Connect the phone (or pair it over Wi-Fi), then press Run in Xcode, or build with
   `-allowProvisioningUpdates`.
3. On first launch, scan the pairing code from Fridgedoor on the web, or enter your
   server's address and sign in.

With a free personal team, installs expire after seven days, there is no APNs and no
TestFlight. If provisioning rejects App Groups, remove
`com.apple.security.application-groups` from the targets in `project.yml`: the
widget then reads its snapshot through the shared Keychain group. If Keychain sharing
is also refused, the widget shows a sign-in placeholder and Share asks you to open the
app; everything else works.

## Behavior notes

- Reminders and the daily brief alert are local notifications scheduled from server
  state after each refresh and in background refresh. They can be turned off per
  iPhone (Settings → Notifications) to avoid double alerts with a Web Push
  subscription on the same phone. Activity notifications still use Web Push.
- Operator details (server, AI provider and limits, sync counts, Gmail label ids) are
  in Settings → Help & diagnostics, not on the everyday pages.
- Google consent is browser-only: Settings opens the web app's Settings → Email page in Safari.
- The Share extension uses its own capture-only credential (`/capture/v1`), created
  at sign-in and revoked at sign-out; it can't read plans.
- Voice uses on-device speech when available and falls back to server transcription.
- Widget buttons run their intents in the app's process (`LiveActivityIntent`, see
  `Platform/Intents/WidgetIntents.swift`), launched in the background if needed, with
  the app's own session; the widget extension only reads the App Group snapshot.
- Siri and Shortcuts answer to "Fridgedoor", "Planner" and "Fridge door"
  (`INAlternativeAppNames`): "Ask Planner", "Add groceries in Fridgedoor", "Add a
  to-do in Planner", "What's on the fridge door", "What's on tomorrow in Planner",
  "What needs me in Fridgedoor", "What's on the Planner grocery list". They require
  an unlocked phone. Private plans are never added to Spotlight, and private titles are
  hidden on the Lock Screen, in widgets while locked, and in reminder alerts.
- Small widgets also appear in CarPlay and on Apple HomeView, through the paired iPhone,
  with their buttons turned off. They read the App Group snapshot, which is available
  after first unlock, so they work while the phone is locked. Quick actions is
  disfavored there (`disfavoredLocations([.carPlay], …)`); HomeView has no location of
  its own and no simulator yet.
- Settings → App icon switches between the icon sets with `setAlternateIconName`
  (`ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES` in `project.yml`).

## Apple Watch

- The watch app (watchOS 26+) is a companion: `WKRunsIndependentlyOfCompanionApp` is
  false and it ships inside the iPhone app. It never talks to the server and holds no
  credential.
- The iPhone sends it a `WatchPayload` (FridgedoorKit) with WatchConnectivity's
  application context after each sync (`Platform/WatchBridge.swift`, called from
  `PlatformSync`): the widget snapshot, today's brief, and the decisions Home shows
  that are still open (the brief's decisions and deadlines, plus open questions).
  While the server rebuilds the brief it keeps the last ready one. Only changes are
  resent, or every 15 minutes.
- The watch sends a `WatchCommand` (Save, Add to calendar, answer or dismiss a
  question, refresh) with `sendMessage`. The system wakes the iPhone app in the
  background, which runs it with its own session and replies. The watch hides the
  row at once and puts it back with the error if the iPhone couldn't do it.
- The watch saves the payload to its App Group (Keychain fallback) for the Today
  complication (rectangular, circular, corner, inline). Private titles use
  `privacySensitive` and read "Busy" in the one-line faces.
- Simulator: pair an iPhone and a watch simulator (`xcrun simctl pair`), install the
  iPhone app, then the watch app from `Debug-watchsimulator`. Launch the iPhone app
  after the watch app is installed, or it won't see it.

