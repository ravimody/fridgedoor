# The iPhone app

The native iPhone app is for people who build it themselves with Xcode, because it isn't
in the App Store yet (see [Installing it](#installing-it)). Everyone else in the
household should use the web app on their phone: open your Fridgedoor address in Safari,
tap Share, then Add to Home Screen. On Android, open it in Chrome, tap the ⋮ menu, then
Add to Home screen (or Install app).

The iPhone app shows today's plan, your lists and the decisions waiting on you. It also
adds Home Screen and Lock Screen widgets, Siri ("Ask Fridgedoor…" or "Ask Planner…"),
and reminders. From the share sheet you can send a flyer, photo, PDF or web page to the
planner.
In the app, groceries can be sorted by store aisle, and to-dos can have a due date and
an assignee. You can pick a different app icon in Settings → App icon.

## Widgets in the car and the kitchen

The small Today, Decisions, Groceries and To do widgets also show up in CarPlay and on
Apple's HomeView display, coming from your iPhone. There they're read-only: buttons
such as checking off a grocery don't work, so do those on the phone. On a shared
HomeView, each person sees their own widgets only once HomeView recognizes them.

## Apple Watch

The iPhone app comes with a watch app. It shows this morning's brief, what's left
today, and the decisions waiting on you. You can choose Save or Add to calendar with one
tap, or answer the planner's questions by dictation or Scribble. Add the Today
complication to a watch face to see what's next and how many decisions are waiting.

There's nothing to set up: install the iPhone app, sign in, and the watch app appears
(or install it from the Watch app on the iPhone). The watch gets everything from the
iPhone and stores no password, so it needs the iPhone nearby to send a decision.
Decisions that need more, such as setting a missing time, are made on the iPhone.

## Connect it to your server

The quickest way is a pairing code. In the web app on a computer, open Settings →
iPhone and choose Show a pairing code. Scan the code with the iPhone's Camera app, or
with Scan pairing code on the app's welcome screen. The code works once and expires
after 10 minutes. If the app says it was already used or has expired, make a new one on
the same page.

You can also choose Enter server address on the welcome screen, type your server's
address, and sign in with your Fridgedoor email and password in the sign-in sheet that
opens.

The app needs your server to be reachable over HTTPS from the phone: a Tailscale
`*.ts.net` address, your own domain, or your hosting platform's address. A plain
`http://` address only works on your home network.

## Installing it

Build the app yourself with Xcode on a Mac; see [ios/README.md](../ios/README.md). A
free Apple account works for testing, but the app then has to be reinstalled every 7
days. A paid Apple Developer Program membership ($99/year) gives installs that last a
year and lets you share builds through TestFlight.
