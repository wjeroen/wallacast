package io.github.wjeroen.playerlink;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pauses and plays the players you link, together.
 *
 * Android lets several apps play at once, but a headphone press, the lock screen, a watch or a
 * phone shortcut reaches only one of them. This service watches the linked players and copies a
 * pause or a play from one to the others, whichever got the press. It reacts to what the players
 * do, not to buttons, so it works for every way of pausing.
 *
 * Notification access is the Android permission that lets an app see and control other apps'
 * players (MediaSessionManager.getActiveSessions). A player is known by its app, and a Chrome
 * player also by the site its media notification names, so a web app such as Wallacast can be
 * linked on its own.
 *
 * The linked players join once two of them play at the same moment, and a player that starts
 * while one of them plays joins too. From then on a pause or play of one is copied to the others
 * that joined. So a player never starts just because another one does, unless they played
 * together. The link ends only when all stayed paused for UNLINK_AFTER_MS or the switch is off:
 * a player that closes stays linked and follows again when it is back, and a copied command
 * that does not take effect is sent once more (Chrome drops the first one after some pauses).
 *
 * The Wallacast watch bridge, for the Wallacast watch app: Chrome freezes a Wallacast page that
 * stayed paused for minutes with the screen off, and then the watch app's commands cannot reach
 * it. With a server address and an API token that has "Control playback", this service waits
 * for those commands itself (GET /api/remote/fallback, only while Wallacast has a player in
 * Chrome) and presses play, pause or a 15-second skip on Chrome's player, which works on a
 * frozen page and wakes it. Chrome drops that player soon after a pause in the background, so
 * with "Display over other apps" allowed it also waits while there is none: a play from the
 * watch then opens Wallacast (its home screen app), and the server hands the page that play.
 * Android gives an app in the background no turn to play sound (audio focus), so the server
 * sends every play for a hidden Wallacast here: when Chrome's player still does not play
 * PLAY_CHECK_MS after the press, this service brings Wallacast to the front and presses
 * play again.
 */
public class LinkService extends NotificationListenerService {
    static final String PREFS = "link";
    static final String PREF_ENABLED = "enabled";
    static final String PREF_LINKED = "linked_players";
    static final String PREF_LABEL = "label:";
    static final String PREF_SERVER = "server";
    static final String PREF_TOKEN = "token";
    static final String PREF_ANY_CHROME_IS_WALLACAST = "all_chrome";
    /** Wallacast's site as its Chrome player last named it, to open it again */
    static final String PREF_SITE = "wallacast_site";

    /** A change must last this long before it is copied: a web player pauses for a moment
     *  while it loads its next item, an app while it skips. */
    private static final long SETTLE_CHROME_PAUSE_MS = 1500;
    private static final long SETTLE_MS = 500;
    /** A copied command that has not taken effect by then is sent once more: Chrome sometimes
     *  drops the first command after a pause, as it drops the first headphone press. */
    private static final long COMMAND_TIMEOUT_MS = 2000;
    private static final long UNLINK_AFTER_MS = 6L * 60 * 60 * 1000;
    /** A play from the watch that Android refused shows as not playing by then */
    private static final long PLAY_CHECK_MS = 2000;
    /** Time for Wallacast to come to the front before play is pressed again */
    private static final long PLAY_AFTER_OPEN_MS = 1500;
    private static final Pattern SITE = Pattern.compile("\\b((?:[a-z0-9-]+\\.)+[a-z]{2,})\\b");

    static volatile LinkService instance;

    /** One player Android knows right now. */
    static class Player {
        final MediaController controller;
        final String key;
        final String label;
        boolean settled;
        Boolean expect;

        Player(MediaController controller, String key, String label) {
            this.controller = controller;
            this.key = key;
            this.label = label;
            this.settled = playing(controller);
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    /** What a Chrome media notification says about its player: the site, and whether it names Wallacast */
    private final Map<MediaSession.Token, String> chromeSites = new HashMap<>();
    private final Set<MediaSession.Token> wallacastTokens = new HashSet<>();
    private MediaSessionManager sessions;
    private ComponentName self;
    private SharedPreferences prefs;

    /** Every player now, by key (the first one when two share a key) */
    private final Map<String, Player> players = new LinkedHashMap<>();
    /** The keys of the players that joined the link */
    private final Set<String> joined = new HashSet<>();
    private long allPausedSince;
    private long expectUntil;
    private String lastEvent = "";
    /** The last events with their time, newest first, for the screen and the dump */
    private final java.util.LinkedList<String> history = new java.util.LinkedList<>();
    private boolean retried;

    private final Runnable evaluateTask = this::evaluate;
    private final MediaSessionManager.OnActiveSessionsChangedListener sessionsChanged = this::onSessions;

    private final MediaController.Callback callback = new MediaController.Callback() {
        @Override
        public void onPlaybackStateChanged(PlaybackState state) {
            updateSeen();
            schedule();
        }

        @Override
        public void onSessionDestroyed() {
            refreshSessions();
        }
    };

    // The Wallacast watch bridge, on its own thread
    private volatile boolean bridgeRunning;
    private volatile HttpURLConnection bridgeConnection;
    /** Wallacast's player as last seen: playing, paused, or null when there is none */
    private volatile Boolean seenPlaying;
    private volatile String bridgeStatus = "";
    private volatile String bridgeError = "";

    @Override
    public void onListenerConnected() {
        instance = this;
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        sessions = (MediaSessionManager) getSystemService(MEDIA_SESSION_SERVICE);
        self = new ComponentName(this, LinkService.class);
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active != null) for (StatusBarNotification sbn : active) learn(sbn);
        } catch (Exception ignored) {
            // the list is not available yet, the next notification fills it
        }
        sessions.addOnActiveSessionsChangedListener(sessionsChanged, self, main);
        refreshSessions();
        startBridge();
    }

    @Override
    public void onListenerDisconnected() {
        if (sessions != null) sessions.removeOnActiveSessionsChangedListener(sessionsChanged);
        for (Player p : players.values()) p.controller.unregisterCallback(callback);
        players.clear();
        main.removeCallbacks(evaluateTask);
        stopBridge();
        instance = null;
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (learn(sbn)) refreshSessions();
    }

    // ---- which players ----------------------------------------------------------------------

    static boolean isChrome(String pkg) {
        return pkg != null && (pkg.startsWith("com.android.chrome") || pkg.startsWith("com.chrome.") || pkg.startsWith("org.chromium."));
    }

    /** Read a Chrome media notification: which site it names, and whether that is Wallacast.
     *  True when it taught something new. */
    @SuppressWarnings("deprecation")
    private boolean learn(StatusBarNotification sbn) {
        if (!isChrome(sbn.getPackageName())) return false;
        Bundle extras = sbn.getNotification().extras;
        if (extras == null) return false;
        Object raw = extras.getParcelable(Notification.EXTRA_MEDIA_SESSION);
        if (!(raw instanceof MediaSession.Token)) return false;
        MediaSession.Token token = (MediaSession.Token) raw;
        String site = null;
        StringBuilder all = new StringBuilder();
        // The site usually sits in the small text, so that field is read first
        for (String key : new String[] {
            Notification.EXTRA_SUB_TEXT, Notification.EXTRA_TEXT, Notification.EXTRA_INFO_TEXT,
            Notification.EXTRA_SUMMARY_TEXT, Notification.EXTRA_TITLE, Notification.EXTRA_BIG_TEXT,
        }) {
            CharSequence value = extras.getCharSequence(key);
            if (value == null) continue;
            String text = value.toString().toLowerCase(Locale.ROOT);
            all.append(text).append(' ');
            if (site == null) {
                Matcher m = SITE.matcher(text);
                if (m.find()) site = m.group(1).replaceFirst("^www\\.", "");
            }
        }
        boolean changed = false;
        if (site != null && !site.equals(chromeSites.get(token))) {
            chromeSites.put(token, site);
            changed = true;
        }
        if (all.toString().contains("wallacast") && wallacastTokens.add(token)) changed = true;
        return changed;
    }

    private String keyOf(MediaController c) {
        String pkg = c.getPackageName();
        if (isChrome(pkg)) {
            String site = chromeSites.get(c.getSessionToken());
            return site != null ? "chrome:" + site : "chrome";
        }
        return pkg;
    }

    private String labelOf(MediaController c, String key) {
        if (key.startsWith("chrome:")) return "Chrome: " + key.substring(7);
        if (key.equals("chrome")) return "Chrome (site unknown)";
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(c.getPackageName(), 0)).toString();
        } catch (Exception e) {
            return c.getPackageName();
        }
    }

    void refreshSessions() {
        if (sessions == null) return;
        try {
            onSessions(sessions.getActiveSessions(self));
        } catch (SecurityException e) {
            lastEvent = "No notification access";
        }
    }

    private void onSessions(List<MediaController> list) {
        Map<String, Player> now = new LinkedHashMap<>();
        if (list != null) {
            for (MediaController c : list) {
                String key = keyOf(c);
                if (now.containsKey(key)) continue;
                Player old = players.get(key);
                if (old != null && old.controller.getSessionToken().equals(c.getSessionToken())) {
                    now.put(key, old);
                } else {
                    Player p = new Player(c, key, labelOf(c, key));
                    c.registerCallback(callback, main);
                    now.put(key, p);
                    if (prefs != null) prefs.edit().putString(PREF_LABEL + key, p.label).apply();
                }
            }
        }
        for (Player old : players.values()) {
            if (now.get(old.key) != old) old.controller.unregisterCallback(callback);
        }
        players.clear();
        players.putAll(now);
        // A player that goes away (Chrome may drop its player while paused) stays in the link:
        // when it comes back, it follows again.
        updateSeen();
        schedule();
    }

    static boolean playing(MediaController c) {
        if (c == null) return false;
        PlaybackState st = c.getPlaybackState();
        if (st == null) return false;
        switch (st.getState()) {
            case PlaybackState.STATE_PLAYING:
            case PlaybackState.STATE_BUFFERING:
            case PlaybackState.STATE_CONNECTING:
            case PlaybackState.STATE_FAST_FORWARDING:
            case PlaybackState.STATE_REWINDING:
            case PlaybackState.STATE_SKIPPING_TO_NEXT:
            case PlaybackState.STATE_SKIPPING_TO_PREVIOUS:
            case PlaybackState.STATE_SKIPPING_TO_QUEUE_ITEM:
                return true;
            default:
                return false;
        }
    }

    Set<String> linkedKeys() {
        return prefs == null ? new HashSet<>() : new HashSet<>(prefs.getStringSet(PREF_LINKED, new HashSet<>()));
    }

    void setLinked(String key, boolean on) {
        Set<String> keys = linkedKeys();
        if (on) keys.add(key);
        else keys.remove(key);
        prefs.edit().putStringSet(PREF_LINKED, keys).apply();
        if (!on) {
            joined.remove(key);
            if (joined.size() < 2) unlink("a player was unticked");
        }
        schedule();
    }

    // ---- the switch -----------------------------------------------------------------------------

    /** The switch (in the app or the quick settings tile) was turned on or off. Turned on while a
     *  ticked player plays, the other ticked players start at once and are tied to it. */
    void onSwitch(boolean on) {
        if (!on) {
            unlink("switched off");
            note("Switched off");
            return;
        }
        long now = SystemClock.elapsedRealtime();
        Set<String> linked = linkedKeys();
        List<Player> group = new ArrayList<>();
        boolean anyPlaying = false;
        for (Player p : players.values()) {
            if (!linked.contains(p.key)) continue;
            group.add(p);
            if (playing(p.controller)) anyPlaying = true;
        }
        if (!anyPlaying || group.size() < 2) {
            note("Switched on");
            schedule();
            return;
        }
        StringBuilder names = new StringBuilder();
        for (Player p : group) {
            joined.add(p.key);
            if (playing(p.controller)) {
                p.settled = true;
                continue;
            }
            p.controller.getTransportControls().play();
            p.expect = true;
            p.settled = true;
            if (names.length() > 0) names.append(", ");
            names.append(p.label);
        }
        expectUntil = now + COMMAND_TIMEOUT_MS;
        retried = false;
        allPausedSince = 0;
        note("Switched on" + (names.length() > 0 ? ", played " + names : ""));
        evaluatePending = true;
        main.removeCallbacks(evaluateTask);
        main.postDelayed(evaluateTask, 300);
    }

    // ---- copying pause and play ---------------------------------------------------------------

    /** Which players play, as of the last schedule(): a player reports often (position, track,
     *  buffering), and only a change of playing or paused may move the check, or the check
     *  could be put off again and again and never run. */
    private String lastSignature = "";
    private boolean evaluatePending;

    private void schedule() {
        StringBuilder sig = new StringBuilder();
        for (Player p : players.values()) sig.append(p.key).append(playing(p.controller) ? ":1," : ":0,");
        String now = sig.toString();
        if (now.equals(lastSignature) && evaluatePending) return;
        lastSignature = now;
        evaluatePending = true;
        main.removeCallbacks(evaluateTask);
        boolean chromePaused = false;
        for (Player p : players.values()) {
            if (isChrome(p.controller.getPackageName()) && p.settled && !playing(p.controller)) chromePaused = true;
        }
        main.postDelayed(evaluateTask, chromePaused ? SETTLE_CHROME_PAUSE_MS : SETTLE_MS);
    }

    private void note(String event) {
        lastEvent = event;
        history.addFirst(new java.text.SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new java.util.Date()) + " " + event);
        while (history.size() > 8) history.removeLast();
    }

    private void unlink(String why) {
        if (!joined.isEmpty() && joined.size() >= 2) note("Unlinked: " + why);
        joined.clear();
        allPausedSince = 0;
        for (Player p : players.values()) p.expect = null;
    }

    private void evaluate() {
        evaluatePending = false;
        long now = SystemClock.elapsedRealtime();
        Set<String> linked = linkedKeys();
        List<Player> group = new ArrayList<>();
        for (Player p : players.values()) if (linked.contains(p.key)) group.add(p);

        if (prefs == null || !prefs.getBoolean(PREF_ENABLED, false)) {
            for (Player p : players.values()) p.settled = playing(p.controller);
            unlink("switched off");
            return;
        }
        if (group.size() < 2) {
            // a ticked player is not open right now: nothing to copy, the link stays
            for (Player p : players.values()) p.settled = playing(p.controller);
            return;
        }

        // Commands this service sent: wait for them, send a dropped one once more, then give up
        // on that one command (the link stays)
        boolean waiting = false;
        List<Player> failed = new ArrayList<>();
        for (Player p : group) {
            if (p.expect == null) continue;
            if (p.expect == playing(p.controller)) p.expect = null;
            else if (now < expectUntil) waiting = true;
            else failed.add(p);
        }
        if (waiting) {
            evaluatePending = true;
            main.postDelayed(evaluateTask, 300);
            return;
        }
        if (!failed.isEmpty()) {
            if (!retried) {
                retried = true;
                for (Player p : failed) {
                    if (p.expect) p.controller.getTransportControls().play();
                    else p.controller.getTransportControls().pause();
                }
                note("Sent again to " + failed.get(0).label);
                expectUntil = now + COMMAND_TIMEOUT_MS;
                evaluatePending = true;
                main.postDelayed(evaluateTask, 300);
                return;
            }
            for (Player p : failed) {
                note(p.label + " did not follow");
                p.expect = null;
                p.settled = playing(p.controller);
            }
        }

        List<Player> changed = new ArrayList<>();
        List<Player> nowPlaying = new ArrayList<>();
        for (Player p : group) {
            boolean on = playing(p.controller);
            if (on != p.settled) changed.add(p);
            if (on) nowPlaying.add(p);
            p.settled = on;
        }

        // Players that play at the same moment join (and start the link)
        if (nowPlaying.size() >= 2 || (joined.size() >= 2 && !nowPlaying.isEmpty() && anyJoinedPlaying(nowPlaying))) {
            boolean wasLinked = joined.size() >= 2;
            for (Player p : nowPlaying) joined.add(p.key);
            if (!wasLinked && joined.size() >= 2) note("Linked");
        }
        if (joined.size() < 2) return;

        // Copy a change of joined players to the other joined players, when the changes agree
        Boolean wanted = null;
        for (Player p : changed) {
            if (!joined.contains(p.key)) continue;
            boolean on = playing(p.controller);
            if (wanted == null) wanted = on;
            else if (wanted != on) return;
        }
        if (wanted == null) {
            if (nowPlaying.isEmpty() && allPausedSince == 0) allPausedSince = now;
            return;
        }
        if (wanted && allPausedSince > 0 && now - allPausedSince > UNLINK_AFTER_MS) {
            unlink("all paused for hours");
            return;
        }
        StringBuilder names = new StringBuilder();
        for (Player p : group) {
            if (!joined.contains(p.key) || changed.contains(p) || playing(p.controller) == wanted) continue;
            if (wanted) p.controller.getTransportControls().play();
            else p.controller.getTransportControls().pause();
            p.expect = wanted;
            p.settled = wanted;
            if (names.length() > 0) names.append(", ");
            names.append(p.label);
        }
        if (names.length() == 0) return;
        expectUntil = now + COMMAND_TIMEOUT_MS;
        retried = false;
        allPausedSince = wanted ? 0 : now;
        String first = null;
        for (Player p : changed) if (joined.contains(p.key)) { first = p.label; break; }
        note((wanted ? "Played " : "Paused ") + names + (first != null ? " (after " + first + ")" : ""));
        evaluatePending = true;
        main.postDelayed(evaluateTask, 300);
    }

    private boolean anyJoinedPlaying(List<Player> nowPlaying) {
        for (Player p : nowPlaying) if (joined.contains(p.key)) return true;
        return false;
    }

    // ---- the Wallacast watch bridge -------------------------------------------------------------

    /** Wallacast's player in Chrome, found by its notification or, when the user says so, any Chrome player. */
    private Player wallacast() {
        boolean anyChrome = prefs != null && prefs.getBoolean(PREF_ANY_CHROME_IS_WALLACAST, false);
        for (Player p : players.values()) {
            if (!isChrome(p.controller.getPackageName())) continue;
            if (anyChrome || wallacastTokens.contains(p.controller.getSessionToken()) || p.key.contains("wallacast")) return p;
        }
        return null;
    }

    /** Called on the main thread whenever Wallacast's player may have changed. A changed state
     *  ends the waiting request, so the server learns it at once from the next one. */
    private void updateSeen() {
        Player w = wallacast();
        if (w != null && w.key.startsWith("chrome:") && prefs != null && !w.key.substring(7).equals(prefs.getString(PREF_SITE, ""))) {
            prefs.edit().putString(PREF_SITE, w.key.substring(7)).apply();
        }
        Boolean now = w == null ? null : playing(w.controller);
        Boolean before = seenPlaying;
        if (now == null ? before == null : now.equals(before)) return;
        seenPlaying = now;
        HttpURLConnection c = bridgeConnection;
        if (c != null) new Thread(c::disconnect).start();
    }

    private void startBridge() {
        if (bridgeRunning) return;
        bridgeRunning = true;
        Thread t = new Thread(this::bridgeLoop, "wallacast-bridge");
        t.setDaemon(true);
        t.start();
    }

    private void stopBridge() {
        bridgeRunning = false;
        HttpURLConnection c = bridgeConnection;
        if (c != null) new Thread(c::disconnect).start();
    }

    private static void rest(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        return buf.toString("UTF-8");
    }

    private void bridgeLoop() {
        int failures = 0;
        while (bridgeRunning) {
            String server = prefs.getString(PREF_SERVER, "");
            String token = prefs.getString(PREF_TOKEN, "");
            Boolean seen = seenPlaying;
            if (server.isEmpty() || token.isEmpty()) {
                bridgeStatus = "";
                rest(5000);
                continue;
            }
            boolean canOpen = seen == null && openIntent() != null;
            if (seen == null && !canOpen) {
                bridgeStatus = "Watch bridge: waiting for Wallacast's player";
                rest(5000);
                continue;
            }
            long started = SystemClock.elapsedRealtime();
            try {
                // "closed": no Wallacast player in Chrome, but a play opens Wallacast
                String seenParam = seen == null ? "closed" : seen.toString();
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/remote/fallback?playing=" + seenParam).openConnection();
                bridgeConnection = c;
                c.setConnectTimeout(10000);
                c.setReadTimeout(40000);
                c.setRequestProperty("Authorization", "Bearer " + token);
                int code = c.getResponseCode();
                if (code == 401 || code == 403) {
                    bridgeStatus = "Watch bridge: the token was refused (" + code + "). It needs \"Control playback\".";
                    rest(5 * 60 * 1000);
                    continue;
                }
                if (code != 200) throw new IOException("HTTP " + code);
                JSONArray commands = new JSONObject(read(c.getInputStream())).optJSONArray("commands");
                failures = 0;
                bridgeStatus = canOpen ? "Watch bridge: on, a play opens Wallacast" : "Watch bridge: on";
                if (commands != null) {
                    for (int i = 0; i < commands.length(); i++) {
                        String action = commands.getJSONObject(i).optString("action", "");
                        main.post(() -> runCommand(action));
                    }
                }
                // An empty answer takes about 25 seconds. A quick one means something cut it short.
                if ((commands == null || commands.length() == 0) && SystemClock.elapsedRealtime() - started < 2000) rest(10000);
            } catch (Exception e) {
                if (!bridgeRunning) break;
                Boolean now = seenPlaying;
                if (now == null ? seen != null : !now.equals(seen)) continue; // cut on purpose, the player changed
                failures++;
                bridgeError = e.getClass().getSimpleName() + ": " + e.getMessage();
                bridgeStatus = "Watch bridge: no connection";
                rest(Math.min(60000, 5000L * failures));
            } finally {
                bridgeConnection = null;
            }
        }
    }

    /** How to open Wallacast: its home screen app, else its site in the browser. Null without
     *  "Display over other apps", or before Wallacast's player was ever seen. */
    private Intent openIntent() {
        if (prefs == null || !Settings.canDrawOverlays(this)) return null;
        String site = prefs.getString(PREF_SITE, "");
        if (site.isEmpty()) return null;
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse("https://" + site + "/"));
        view.addCategory(Intent.CATEGORY_BROWSABLE);
        PackageManager pm = getPackageManager();
        try {
            for (ResolveInfo r : pm.queryIntentActivities(view, 0)) {
                String pkg = r.activityInfo.packageName;
                // A home screen app brings back the open page as it was, a browser opens a new tab
                if (pkg.contains(".webapk")) {
                    Intent launch = pm.getLaunchIntentForPackage(pkg);
                    if (launch != null) return launch;
                }
            }
        } catch (Exception ignored) {
            // fall back to the browser
        }
        return view;
    }

    private boolean openWallacast() {
        Intent open = openIntent();
        if (open == null) {
            note("Watch: play, but Wallacast cannot be opened");
            return false;
        }
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(open);
            note("Watch: opened Wallacast");
            return true;
        } catch (Exception e) {
            note("Watch: opening Wallacast failed (" + e.getClass().getSimpleName() + ")");
            return false;
        }
    }

    /** A play from the watch: press Chrome's play button, and if Android refused Wallacast its
     *  turn to play sound, bring it to the front and press play again. */
    private void playFromWatch(Player w) {
        w.controller.getTransportControls().play();
        note("Watch: play");
        main.postDelayed(() -> {
            Player now = wallacast();
            if (now != null && playing(now.controller)) return;
            if (!openWallacast()) return;
            main.postDelayed(() -> {
                Player shown = wallacast();
                if (shown != null && !playing(shown.controller)) shown.controller.getTransportControls().play();
            }, PLAY_AFTER_OPEN_MS);
        }, PLAY_CHECK_MS);
    }

    /** A command from the watch, on Chrome's player. Chrome passes it to the page, waking it.
     *  Without that player, a play opens Wallacast instead. */
    private void runCommand(String action) {
        Player w = wallacast();
        if (w == null) {
            if (action.equals("play") || action.equals("toggle")) openWallacast();
            return;
        }
        MediaController.TransportControls t = w.controller.getTransportControls();
        if (action.equals("play") || action.equals("toggle") && !playing(w.controller)) {
            playFromWatch(w);
            return;
        }
        switch (action) {
            case "pause":
            case "toggle": t.pause(); break;
            case "forward": t.fastForward(); break;
            case "back": t.rewind(); break;
            default: return;
        }
        note("Watch: " + action);
    }

    // ---- diagnostics: adb shell dumpsys activity service io.github.wjeroen.playerlink/.LinkService ----

    @Override
    protected void dump(FileDescriptor fd, PrintWriter pw, String[] args) {
        try {
            pw.println("enabled=" + (prefs != null && prefs.getBoolean(PREF_ENABLED, false)));
            pw.println("ticked=" + linkedKeys());
            pw.println("joined=" + new ArrayList<>(joined) + " allPausedSince=" + allPausedSince);
            for (Player p : new ArrayList<>(players.values())) {
                pw.println("player key=" + p.key + " pkg=" + p.controller.getPackageName() + " playing=" + playing(p.controller)
                    + " settled=" + p.settled + " expect=" + p.expect);
            }
            pw.println("chromeSites=" + new ArrayList<>(chromeSites.values()) + " wallacastTokens=" + wallacastTokens.size());
            String server = prefs != null ? prefs.getString(PREF_SERVER, "") : "";
            String token = prefs != null ? prefs.getString(PREF_TOKEN, "") : "";
            pw.println("bridge=" + bridgeStatus + " seenPlaying=" + seenPlaying + " server=" + server
                + " token=" + (token.isEmpty() ? "none" : "set") + " lastError=" + bridgeError);
            pw.println("site=" + (prefs != null ? prefs.getString(PREF_SITE, "") : "") + " overlay=" + Settings.canDrawOverlays(this)
                + " open=" + openIntent());
            pw.println("last=" + lastEvent);
            for (String h : new ArrayList<>(history)) pw.println("  " + h);
        } catch (Exception e) {
            pw.println("dump failed: " + e);
        }
    }

    // ---- for the settings screen ----------------------------------------------------------------

    /** Every player to show: the ones now, then linked ones that are not open. {key, label, state} */
    List<String[]> describePlayers() {
        List<String[]> out = new ArrayList<>();
        for (Player p : players.values()) {
            MediaMetadata md = p.controller.getMetadata();
            String title = md != null ? md.getString(MediaMetadata.METADATA_KEY_TITLE) : null;
            out.add(new String[] { p.key, p.label, (playing(p.controller) ? "playing" : "paused") + (title != null ? ", " + title : "") });
        }
        for (String key : linkedKeys()) {
            if (players.containsKey(key)) continue;
            out.add(new String[] { key, prefs.getString(PREF_LABEL + key, key), "not open" });
        }
        return out;
    }

    String describeStatus() {
        StringBuilder b = new StringBuilder();
        if (joined.size() >= 2) {
            b.append("Linked: ");
            boolean first = true;
            for (String key : joined) {
                Player p = players.get(key);
                b.append(first ? "" : ", ").append(p != null ? p.label : key);
                first = false;
            }
        } else {
            b.append("Not linked yet: two ticked players must play at the same moment");
        }
        if (!bridgeStatus.isEmpty()) b.append('\n').append(bridgeStatus);
        for (String h : history) b.append('\n').append(h);
        return b.toString();
    }
}
