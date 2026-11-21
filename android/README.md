# Wallacast Android apps

Two small optional apps. Wallacast itself stays a web app: both apps work next to it. Player Link also works without Wallacast.

| App | Where it runs | What it does |
|---|---|---|
| **Wallacast** (`watch/`) | A Wear OS watch | Shows what Wallacast plays on your phone, with play/pause, previous and next item, 15-second skips, shuffle, speed, archive or unarchive, and star, in the app's own icons |
| **Player Link** (`player-link/`) | Your Android phone | Pauses and plays the players you tick together (for example Wallacast and Spotify), whichever one got the press. Also passes the Wallacast watch app's play, pause and skips on while Chrome lets Wallacast sleep |

Both are plain Java with no libraries, built without Gradle by `build.sh`, so they build on the phone itself in Termux. Player Link's icon is drawn by `tools/icons.py`. The watch app's icon is the Wallacast W as a vector shape on a dark circle (`watch/res/drawable/ic_launcher_foreground.xml`).

## Build

In Termux, once:

```bash
pkg install aapt2 d8 apksigner openjdk-21 python android-tools
mkdir -p ~/.android-build
curl -L -o ~/.android-build/platform-35.zip https://dl.google.com/android/repository/platform-35_r02.zip
unzip -p ~/.android-build/platform-35.zip '*/android.jar' > ~/.android-build/android-35.jar
```

Then, from the repository folder:

```bash
bash android/build.sh          # both apps, or: bash android/build.sh watch / player-link
```

The apps land in `android/build/`. The first build makes a signing key in `~/.android-keys/`. Keep that folder: an update installs over the old app only when it carries the same key. Without it, uninstall the app first (its setup is lost).

## The watch app

The watch never talks to the phone directly. It asks the Wallacast server what the player does and sends it commands, and the open Wallacast app on the phone carries them out (`backend/src/services/remote-control.ts`). So the phone needs no extra app, and the watch needs its own internet connection (through the phone's Bluetooth is fine).

1. In Wallacast: Settings → API tokens → create a token named "Watch". Under it, tick **Control playback** and, for the archive button, **Archive and unarchive**. Untick everything else. Copy the token.
2. On the watch (Galaxy Watch): Settings → About watch → Software information → tap **Software version** 7 times. Then Settings → Developer options: turn on **ADB debugging** and **Wireless debugging**. The watch must be on the same Wi-Fi as the phone. Tap **Pair new device**: it shows an address, a port and a code.
3. In Termux:

```bash
adb pair WATCH_IP:PAIR_PORT PAIR_CODE
adb connect WATCH_IP:PORT          # the port on the Wireless debugging screen itself
adb install -r android/build/wallacast-watch.apk
read -rs -p "Paste the token: " T; echo
adb shell am start -n io.github.wjeroen.wallacast.watch/.MainActivity \
  --es server https://YOUR-BACKEND.up.railway.app --es token "$T"
```

The server is the backend address (the app's `VITE_API_URL`, with or without `/api`), not the frontend address. The token is pasted at the prompt, since Android lets no app in the background read the clipboard. The watch shows "Set up" when it saved them. Turn off ADB debugging afterwards to save battery.

If pairing fails with "protocol fault (couldn't read status message)": the watch is not answering on Wi-Fi. Turn the watch's Bluetooth off for the setup (connected to the phone, Wear OS keeps Wi-Fi asleep), keep tapping its screen, check with `ping WATCH_IP` that it answers, and pair again with a fresh code. On the phone itself, `adb kill-server` before pairing helped.

**How it behaves**

- Every button fits on one screen, sized for a round Galaxy Watch screen and scaled to others. A title too long for its line scrolls like an iPod's: it waits at the start, scrolls to the end, and jumps back. The author or show sits on a small line below it. When a new version exists, an Update button peeks in below the buttons: scroll down to see it whole.
- Three layouts, chosen by adding `--ei layout N` to the setup command (the default is 3): 1 puts title, author and clock on their own lines with the buttons in three rows, 2 puts the author on the clock's line, 3 puts the 15-second skips beside previous and next and shuffle, speed, archive and star in one row.
- The watch asks for the player's state every 2 seconds while its screen is on. The page reports its position only every 15 seconds while it plays, so the watch moves the clock on itself in between.
- Wallacast must be open on the phone (in the background is fine). Since Android 15 an app in the background gets no turn to play sound, so with Player Link's watch bridge a play from the watch goes through Player Link: it presses Chrome's own play button, and when Wallacast still does not play after 2 seconds, it brings Wallacast to the front and presses play again. Without the bridge, a play for Wallacast in the background stops after a moment.
- When Wallacast's player is empty (it started fresh, or the player was closed), the watch shows the last item, and play loads it into the mini player and plays it, as Spotify continues its last song. The other buttons wait until it plays. While audio plays, Chrome keeps the page running. After about 5 minutes of pause in the background, Chrome freezes the page, and only Chrome's own player still answers. Then:
  - With Player Link's watch bridge set up (below), play, pause and the skips still work: Player Link presses them on Chrome's player, which wakes the page. The watch shows "Asleep on the phone" and greys out the other buttons until the page runs again.
  - Chrome drops its player (and its notification) soon after a pause in the background. With the bridge and **Display over other apps** allowed for Player Link, the watch then shows "Closed on the phone: play opens it": play opens Wallacast in front of the other apps, and it plays where it stopped.
  - Without the bridge, the watch says "Wallacast sleeps or is closed". Press play in the watch's own media controls, which reach Chrome's player while it is there.
  - A command nobody takes is dropped after 30 seconds.
- Archive works like the player's archive button: the item goes on playing, and its audio stays 7 days. One tap archives, and the button shows the unarchive icon in blue, as in the app. The star turns yellow. Both change at once, before the phone confirms, and go back when the phone does not take the command. The star button needs **Star and unstar** on the token.
- **Updates:** an Update button shows when the GitHub release `android-latest` holds a newer version (`android/release.sh` builds both apps and puts them there). Tap it, and the status line shows each step. The first time, Wear OS says the watch "isn't allowed to install unknown apps from this source": tap **Settings**, switch on **Install unknown apps**, and confirm. Then it asks "Do you want to update this app?": scroll down and tap **Update** (tested on the Wear OS 6 emulator, 2026-11-21). The screen stays on until the update ends. When nothing ends it within 2 minutes, the button works again. Only the first install needs adb.
- The phone's own media controls on the watch keep working as before: play, pause and the two skip buttons (15 seconds back and forward).

**Trying it on an emulator** (no token, no phone): create a Wear OS emulator with a 450 x 450 round screen at density 320, like a Galaxy Watch. Build the app with a test key of its own (`WALLACAST_KEYSTORE` and `WALLACAST_KEYSTORE_PASS`), never for the real watch. Then run `node android/tools/fake-remote.mjs`, which plays made-up items and answers like the server, and:

```bash
adb reverse tcp:8790 tcp:8790
adb install -r android/build/wallacast-watch.apk
adb shell am start -n io.github.wjeroen.wallacast.watch/.MainActivity --es server http://localhost:8790 --es token wcr_fake --ei layout 3
```

The watch allows plain http only to localhost (`watch/res/xml/network_security_config.xml`). To see the Update button, build with a low `VERSION_CODE=100`.

## Player Link

Android lets several apps play at once, but a headphone press, the lock screen, a watch or a phone shortcut reaches only one of them. Player Link pauses and plays the players you tick together, whichever one got the press. It works for any apps, for example Wallacast and Spotify. A Chrome player is known by its site, so a web app such as Wallacast is its own player in the list.

1. Install it with adb. Google Play Protect blocks any app that asks for notification access when it comes from a browser, a messaging app or a file manager ("App blocked to protect your device", [Google's rule](https://developers.google.com/android/play-protect/warning-dev-guidance)), and adb is not one of those. With the phone on Wi-Fi: Settings → Developer options → turn on **Wireless debugging** → **Pair device with pairing code**. In Termux (split screen helps): `adb pair IP:PAIR_PORT CODE`, then `adb connect IP:PORT` (the port on the Wireless debugging screen itself), then `adb install -r android/build/player-link.apk`.
2. Open **Player Link** and tap **Open notification access**. Notification access is the Android permission that lets an app see and control other apps' players. Android blocks it for apps from outside the Play Store: when it says "Restricted setting", open the app's App info, tap the three dots at the top right, tap **Allow restricted settings**, and go back to notification access.
3. Start the players you want to link, so they show under **Players**, and tick them. A ticked player stays in the list when it is not open.
4. Turn on **Pause and play the ticked players together** (off by default).
5. Play two of them at the same time once. The screen then says "Linked". From then on, pausing or playing one does the same to the others that played with it.

**How it behaves**

- Players join the link when they play at the same moment, or when one starts while a linked one plays. So a player never starts just because another one does, unless they played together. From then on, pausing or playing one does the same to the others, until all stayed paused for 6 hours or you turn the switch off. A player that closes stays in the link and follows again when it is back.
- A pause of a Chrome player is copied after 1.5 seconds, since a web app pauses for a moment while it loads its next item. Other changes after half a second. A copied command that does not take effect within 2 seconds is sent once more: Chrome drops the first command after some pauses, as it drops the first headphone press.
- **Quick settings tile:** add the Player Link tile to the pull-down menu (edit the tiles, drag it in). One tap turns linking off, for example to play only Wallacast for a while. Turning it on (tile or switch) while a ticked player plays starts the other ticked players at once, so they are tied again. Turned on while nothing plays, they tie once two ticked ones play at the same moment.
- The ticked players are remembered: through restarts and updates of Player Link, and while their apps are closed (they stay in the list as "not open").
- The screen lists the last 8 things Player Link did. `adb shell dumpsys activity service io.github.wjeroen.playerlink/.LinkService` prints the same and what it sees right now.
- A Chrome player's site comes from Chrome's media notification. When it cannot be read, the player shows as "Chrome (site unknown)", and ticking it links every Chrome player.

### The Wallacast watch bridge

Optional, for the watch app. Under **Wallacast watch bridge**, fill in the server (the same backend address as for the watch) and an API token with **Control playback**, then Save. Player Link then waits for the watch app's commands while Wallacast has a player in Chrome, and presses play, pause and the 15-second skips on that player when the Wallacast page sleeps. The screen shows "Watch bridge: on" when it works. It finds Wallacast's player by the site in Chrome's media notification. When it says "waiting for Wallacast's player" while Wallacast plays, turn on **Every Chrome player is Wallacast**. That adds only a Chrome player whose site the notification does not name: a tab of another site, such as an X video, is never taken for Wallacast. To let a play from the watch open Wallacast once Chrome dropped its player, tap **Allow display over other apps** (Android lets an app open another app from the background only with that permission). While Chrome's Wallacast player exists, Player Link brings back that very page, as a tap on its media notification does. Otherwise it opens Wallacast's home screen app the way its icon does, or else its site in the browser. It needs to have seen Wallacast's player once, to know its site. Set Player Link's battery use to **Unrestricted** (App info, Battery), or Android's battery saving may hold its requests back while the phone lies still.

Any token with **Control playback** works. One already on the phone (such as the share menu shortcut's) is fine. A token of its own can be revoked without breaking anything else.
