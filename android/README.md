# Wallacast Android apps

Two small optional apps. Wallacast itself stays a web app: both apps work next to it. Player Link also works without Wallacast.

| App | Where it runs | What it does |
|---|---|---|
| **Wallacast** (`watch/`) | A Wear OS watch | Shows what Wallacast plays on your phone, with play/pause, previous and next item, 15-second skips, shuffle, speed, and archive or unarchive |
| **Player Link** (`player-link/`) | Your Android phone | Pauses and plays the players you tick together (for example Wallacast and Spotify), whichever one got the press. Also passes the Wallacast watch app's play, pause and skips on while Chrome lets Wallacast sleep |

Both are plain Java with no libraries, built without Gradle by `build.sh`, so they build on the phone itself in Termux.

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
3. In Termux, with the token still copied:

```bash
adb pair WATCH_IP:PAIR_PORT PAIR_CODE
adb connect WATCH_IP:PORT          # the port on the Wireless debugging screen itself
adb install -r android/build/wallacast-watch.apk
adb shell am start -n io.github.wjeroen.wallacast.watch/.MainActivity \
  --es server https://YOUR-BACKEND.up.railway.app --es token "$(termux-clipboard-get)"
```

The server is the backend address (the app's `VITE_API_URL`, with or without `/api`), not the frontend address. The watch shows "Set up" when it saved them. Turn off ADB debugging afterwards to save battery.

**How it behaves**

- The watch asks for the player's state every 2 seconds while its screen is on.
- Wallacast must be open on the phone (in the background is fine). While audio plays, Chrome keeps the page running. After about 5 minutes of pause in the background, Chrome freezes the page, and only Chrome's own player still answers. Then:
  - With Player Link's watch bridge set up (below), play, pause and the skips still work: Player Link presses them on Chrome's player, which wakes the page. The watch shows "Asleep on the phone" and greys out the other buttons until the page runs again.
  - Without it, the watch says "Wallacast sleeps or is closed". Press play in the watch's own media controls, which reach Chrome's player directly.
  - A command nobody takes is dropped after 30 seconds.
- Archive works like the player's archive button: the item goes on playing. It asks for a second tap within 3 seconds. Once archived, the button says Unarchive (one tap). The audio stays 7 days.
- The phone's own media controls on the watch keep working as before: play, pause and the two skip buttons (15 seconds back and forward).

## Player Link

Android lets several apps play at once, but a headphone press, the lock screen, a watch or a phone shortcut reaches only one of them. Player Link pauses and plays the players you tick together, whichever one got the press. It works for any apps, for example Wallacast and Spotify. A Chrome player is known by its site, so a web app such as Wallacast is its own player in the list.

1. Install: `termux-open android/build/player-link.apk` and allow Termux to install apps when Android asks.
2. Open **Player Link** and tap **Open notification access**. Notification access is the Android permission that lets an app see and control other apps' players. Android blocks it for apps from outside the Play Store: when it says "Restricted setting", open the app's App info, tap the three dots at the top right, tap **Allow restricted settings**, and go back to notification access.
3. Start the players you want to link, so they show under **Players**, and tick them. A ticked player stays in the list when it is not open.
4. Turn on **Pause and play the ticked players together** (off by default).
5. Play two of them at the same time once. The screen then says "Linked". From then on, pausing or playing one does the same to the others that played with it.

**How it behaves**

- Players join the link when they play at the same moment, or when one starts while a linked one plays. So a player never starts just because another one does, unless they played together. The link ends when fewer than two of them are left, when a copied command does not take effect within 4 seconds, when all stayed paused for 6 hours, or when you turn the switch off.
- A pause of a Chrome player is copied after 2.5 seconds, since a web app pauses for a moment while it loads its next item. Other pauses after 1 second.
- A Chrome player's site comes from Chrome's media notification. When it cannot be read, the player shows as "Chrome (site unknown)", and ticking it links every Chrome player.
- After you pause Wallacast with its own pause button, Wallacast ignores a play that comes from outside the app (headphones, lock screen, Player Link) until you press play in the app once (`userPausedRef` in `AudioPlayer.tsx`). So a play on another linked player then does not restart Wallacast, Player Link sees that, and ends the link.

### The Wallacast watch bridge

Optional, for the watch app. Under **Wallacast watch bridge**, fill in the server (the same backend address as for the watch) and an API token with **Control playback**, then Save. Player Link then waits for the watch app's commands while Wallacast has a player in Chrome, and presses play, pause and the 15-second skips on that player when the Wallacast page sleeps. The screen shows "Watch bridge: on" when it works. It finds Wallacast's player by the site in Chrome's media notification. When it says "waiting for Wallacast's player" while Wallacast plays, turn on **Every Chrome player is Wallacast**. Set Player Link's battery use to **Unrestricted** (App info, Battery), or Android's battery saving may hold its requests back while the phone lies still.

Any token with **Control playback** works. One already on the phone (such as the share menu shortcut's) is fine. A token of its own can be revoked without breaking anything else.
