# The iPhone app

The Fridgedoor iPhone app shows today's plan, your lists and decisions, and adds
home-screen widgets, Siri ("Ask Fridgedoor…", "Ask Planner…"), the share sheet (send a
flyer, PDF or web page to the planner), and reminders.

Until the app is in the App Store, only someone who builds it with Xcode can install it
(see [Installing it](#installing-it)). Everyone else in the household uses the web app:
open your Fridgedoor address in Safari and choose Share → Add to Home Screen.

Pick a different app icon in **Settings → App icon**.

## Widgets in the car and the kitchen

The small Today, Decisions, Groceries and To do widgets also show up in CarPlay and on
Apple's HomeView display, coming from your iPhone. There they're for reading: buttons
such as checking off a grocery don't work, so do those on the phone. On a shared
HomeView, each person sees their own widgets only once HomeView recognizes them.

## Apple Watch

The iPhone app comes with a watch app. It shows this morning's brief, what's left
today, and the decisions waiting on you: Save or Add to calendar with one tap, or
answer the planner's questions by speaking or Scribble. Add the **Today** complication
to a watch face to see what's next and how many decisions wait.

There's nothing to set up: install the iPhone app, sign in, and the watch app appears
(or install it from the Watch app on the iPhone). The watch gets everything from the
iPhone and stores no password, so it needs the iPhone nearby to send a decision.
Decisions that need more, such as setting a missing time, are made on the iPhone.

## Connect it to your server

The quickest way: in the web app on a computer, open **Settings → iPhone** and
scan the code with the iPhone's camera (or from the app's welcome screen). The code
works once and expires after 10 minutes; if the app says it was already used or has
expired, make a new one on the same page.

Or type your server's address in the app and sign in with your Fridgedoor email and
password.

The app needs your server to be reachable over HTTPS from the phone: a Tailscale
`*.ts.net` address, your own domain, or your hosting platform's address. A plain
`http://` address only works on your home network.

## Installing it

Until the app is in the App Store, build it yourself with Xcode on a Mac; see
[ios/README.md](../ios/README.md). A free Apple account works for testing, but the app
then has to be reinstalled every 7 days; a paid developer account ($99/year) lasts a
year and can share builds through TestFlight.
