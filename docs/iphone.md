# The iPhone app

The Fridgedoor iPhone app shows today's plan, your lists and decisions, and adds
home-screen widgets, Siri ("Ask Fridgedoor…", "Ask Planner…"), the share sheet (send a
flyer, PDF or web page to the planner), and reminders.

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
