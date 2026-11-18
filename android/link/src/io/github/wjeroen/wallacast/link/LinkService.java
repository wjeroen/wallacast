package io.github.wjeroen.wallacast.link;

import android.app.Notification;
import android.content.ComponentName;
import android.content.SharedPreferences;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Pauses and plays Spotify together with Wallacast.
 *
 * Android lets both play at once, but a headphone press, the lock screen, a watch or a phone
 * shortcut reaches only one of them. This service watches both players and copies a pause or
 * a play from one to the other, whichever got the press. It reacts to what the players do,
 * not to buttons, so it works for every way of pausing.
 *
 * Notification access is the Android permission that lets an app see and control other apps'
 * players (MediaSessionManager.getActiveSessions). Wallacast plays in Chrome, so its player is
 * one of Chrome's. Chrome's media notification names the site, which is how the Wallacast
 * player is told apart from other Chrome tabs (or every Chrome player counts, when the
 * user turns that on).
 *
 * The two are linked once both play at the same moment. From then on a pause or play of one
 * is copied to the other. The link ends when one of the players goes away, when a copied
 * command does not take effect, when both stayed paused for UNLINK_AFTER_MS, or when the
 * switch is off. So Spotify never starts just because Wallacast does.
 */
public class LinkService extends NotificationListenerService {
    static final String SPOTIFY = "com.spotify.music";
    static final String PREFS = "link";
    static final String PREF_ENABLED = "enabled";
    static final String PREF_ALL_CHROME = "all_chrome";

    /** A change must last this long before it is copied: Wallacast pauses for a moment
     *  while it loads the next item, Spotify while it skips. */
    private static final long SETTLE_WALLACAST_MS = 2500;
    private static final long SETTLE_SPOTIFY_MS = 1000;
    /** A copied command that has not taken effect by then ends the link. */
    private static final long COMMAND_TIMEOUT_MS = 4000;
    private static final long UNLINK_AFTER_MS = 6L * 60 * 60 * 1000;

    static volatile LinkService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<MediaSession.Token> wallacastTokens = new HashSet<>();
    private MediaSessionManager sessions;
    private ComponentName self;
    private SharedPreferences prefs;

    private MediaController wallacast, spotify;
    private boolean settledWallacast, settledSpotify;
    private boolean linked;
    private long bothPausedSince;
    /** A command this service sent and waits for: which side, which state, until when. */
    private Boolean expectWallacast, expectSpotify;
    private long expectUntil;
    private String lastEvent = "";

    private final Runnable evaluateTask = this::evaluate;

    private final MediaSessionManager.OnActiveSessionsChangedListener sessionsChanged = this::onSessions;

    private final MediaController.Callback callback = new MediaController.Callback() {
        @Override
        public void onPlaybackStateChanged(PlaybackState state) {
            schedule();
        }

        @Override
        public void onMetadataChanged(MediaMetadata metadata) {
            refreshSessions();
        }

        @Override
        public void onSessionDestroyed() {
            refreshSessions();
        }
    };

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
    }

    @Override
    public void onListenerDisconnected() {
        if (sessions != null) sessions.removeOnActiveSessionsChangedListener(sessionsChanged);
        attach(null, null);
        main.removeCallbacks(evaluateTask);
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

    /** Remember the player of a Chrome media notification that names Wallacast. True when it is new. */
    @SuppressWarnings("deprecation")
    private boolean learn(StatusBarNotification sbn) {
        if (!isChrome(sbn.getPackageName())) return false;
        Bundle extras = sbn.getNotification().extras;
        if (extras == null) return false;
        Object token = extras.getParcelable(Notification.EXTRA_MEDIA_SESSION);
        if (!(token instanceof MediaSession.Token)) return false;
        StringBuilder text = new StringBuilder();
        for (String key : new String[] {
            Notification.EXTRA_TITLE, Notification.EXTRA_TEXT, Notification.EXTRA_SUB_TEXT,
            Notification.EXTRA_INFO_TEXT, Notification.EXTRA_SUMMARY_TEXT, Notification.EXTRA_BIG_TEXT,
        }) {
            CharSequence value = extras.getCharSequence(key);
            if (value != null) text.append(value).append(' ');
        }
        if (!text.toString().toLowerCase(Locale.ROOT).contains("wallacast")) return false;
        return wallacastTokens.add((MediaSession.Token) token);
    }

    private boolean isWallacast(MediaController c) {
        if (!isChrome(c.getPackageName())) return false;
        if (prefs.getBoolean(PREF_ALL_CHROME, false)) return true;
        if (wallacastTokens.contains(c.getSessionToken())) return true;
        MediaMetadata md = c.getMetadata();
        if (md == null) return false;
        for (String key : new String[] { MediaMetadata.METADATA_KEY_ARTIST, MediaMetadata.METADATA_KEY_ALBUM, MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE }) {
            String value = md.getString(key);
            if (value != null && value.toLowerCase(Locale.ROOT).contains("wallacast")) return true;
        }
        return false;
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
        MediaController w = null, s = null;
        if (list != null) {
            for (MediaController c : list) {
                if (s == null && SPOTIFY.equals(c.getPackageName())) s = c;
                else if (w == null && isWallacast(c)) w = c;
            }
        }
        attach(w, s);
    }

    private static boolean same(MediaController a, MediaController b) {
        if (a == null || b == null) return a == b;
        return a.getSessionToken().equals(b.getSessionToken());
    }

    private void attach(MediaController w, MediaController s) {
        boolean newW = !same(w, wallacast), newS = !same(s, spotify);
        if (newW) {
            if (wallacast != null) wallacast.unregisterCallback(callback);
            wallacast = w;
            if (w != null) w.registerCallback(callback, main);
            settledWallacast = playing(w);
            expectWallacast = null;
        }
        if (newS) {
            if (spotify != null) spotify.unregisterCallback(callback);
            spotify = s;
            if (s != null) s.registerCallback(callback, main);
            settledSpotify = playing(s);
            expectSpotify = null;
        }
        if (wallacast == null || spotify == null) unlink("a player went away");
        if (newW || newS) schedule();
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

    // ---- copying pause and play ---------------------------------------------------------------

    private void schedule() {
        main.removeCallbacks(evaluateTask);
        boolean wallacastPaused = settledWallacast && !playing(wallacast);
        main.postDelayed(evaluateTask, wallacastPaused ? SETTLE_WALLACAST_MS : SETTLE_SPOTIFY_MS);
    }

    private void unlink(String why) {
        if (linked) lastEvent = "Unlinked: " + why;
        linked = false;
        bothPausedSince = 0;
        expectWallacast = null;
        expectSpotify = null;
    }

    private void evaluate() {
        boolean w = playing(wallacast), s = playing(spotify);
        long now = SystemClock.elapsedRealtime();

        if (prefs == null || !prefs.getBoolean(PREF_ENABLED, false) || wallacast == null || spotify == null) {
            settledWallacast = w;
            settledSpotify = s;
            unlink("switched off");
            return;
        }

        // A command this service sent: wait for it, and give up on the link when it did not work
        if (expectWallacast != null || expectSpotify != null) {
            boolean reached = (expectWallacast == null || expectWallacast == w) && (expectSpotify == null || expectSpotify == s);
            if (reached) {
                expectWallacast = null;
                expectSpotify = null;
            } else if (now < expectUntil) {
                main.postDelayed(evaluateTask, 500);
                return;
            } else {
                settledWallacast = w;
                settledSpotify = s;
                unlink(expectWallacast != null ? "Wallacast did not follow" : "Spotify did not follow");
                return;
            }
        }

        boolean changedW = w != settledWallacast, changedS = s != settledSpotify;
        settledWallacast = w;
        settledSpotify = s;

        if (w && s) {
            if (!linked) lastEvent = "Linked";
            linked = true;
            bothPausedSince = 0;
            return;
        }
        if (!linked) return;
        if (!w && !s) {
            if (bothPausedSince == 0) bothPausedSince = now;
            return;
        }
        // Exactly one plays now. The one that changed decides: copy its state to the other.
        if (changedW == changedS) return;
        boolean wanted = changedW ? w : s;
        if (wanted && bothPausedSince > 0 && now - bothPausedSince > UNLINK_AFTER_MS) {
            unlink("both paused for hours");
            return;
        }
        MediaController other = changedW ? spotify : wallacast;
        if (wanted) other.getTransportControls().play();
        else other.getTransportControls().pause();
        if (changedW) {
            expectSpotify = wanted;
            settledSpotify = wanted;
        } else {
            expectWallacast = wanted;
            settledWallacast = wanted;
        }
        expectUntil = now + COMMAND_TIMEOUT_MS;
        bothPausedSince = wanted ? 0 : now;
        lastEvent = (wanted ? "Played " : "Paused ") + (changedW ? "Spotify" : "Wallacast");
        main.postDelayed(evaluateTask, 600);
    }

    // ---- for the settings screen ----------------------------------------------------------------

    String describe() {
        StringBuilder b = new StringBuilder();
        b.append("Wallacast: ").append(describe(wallacast)).append('\n');
        b.append("Spotify: ").append(describe(spotify)).append('\n');
        b.append(linked ? "Linked" : "Not linked (both must play at once)");
        if (!lastEvent.isEmpty()) b.append('\n').append("Last: ").append(lastEvent);
        return b.toString();
    }

    private static String describe(MediaController c) {
        if (c == null) return "not found";
        MediaMetadata md = c.getMetadata();
        String title = md != null ? md.getString(MediaMetadata.METADATA_KEY_TITLE) : null;
        return (playing(c) ? "playing" : "paused") + (title != null ? ", " + title : "");
    }
}
