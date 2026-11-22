package io.github.wjeroen.wallacast.watch;

import android.app.Activity;
import android.app.ActivityOptions;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

/**
 * The Wallacast remote for a watch. It shows what the Wallacast app on the phone plays and
 * sends play, pause, next, previous, 15 seconds back and forward, shuffle, speed, archive and
 * star, with the Lucide icons the app uses (res/drawable, made by android/tools/lucide2vector.py).
 * An Update button shows when the GitHub release android-latest holds a newer version
 * (android/release.sh puts it there), and installs it after one confirmation on the watch.
 *
 * While Chrome lets the page sleep (paused for minutes with the screen off), the server passes
 * play, pause and the skips to Player Link on the phone instead (mode "link"), and the other
 * buttons wait until the page runs again. Once Chrome dropped its player, play alone works:
 * Player Link opens Wallacast, which then plays (mode "open").
 *
 * The watch never talks to the phone directly. It asks the Wallacast server, which passes
 * commands on to the open app (backend/src/services/remote-control.ts), with an API token that
 * has the "Control playback" permission (and "Archive and unarchive" for the archive button).
 *
 * Set up once over adb, see android/README.md:
 *   am start -n io.github.wjeroen.wallacast.watch/.MainActivity --es server https://... --es token wcr_...
 */
public class MainActivity extends Activity {
    private static final long POLL_MS = 2000;
    /** How often the clock moves on while audio plays */
    private static final long TICK_MS = 250;
    /** How long a tapped archive or star waits, dimmed, for the phone to confirm it */
    private static final long WANT_MS = 8000;
    /** How long play, pause, next, previous, shuffle and speed wait, dimmed, for the phone (a play
     *  through Player Link can take a few seconds) */
    private static final long PRESS_CONFIRM_MS = 10_000;
    /** A 15-second skip shows at once, and counts as carried out once a report lands within
     *  SKIP_MATCH_S of it, or is undone after SKIP_WAIT_MS */
    private static final long SKIP_WAIT_MS = 8000;
    private static final double SKIP_MATCH_S = 3;
    /** An update is given up, so the button works again, when its download gets no data for
     *  DOWNLOAD_STALL_MS (a slow download that moves goes on), when the watch does not ask to
     *  confirm within ANSWER_MS of the download, or when nobody answers that question in CONFIRM_MS */
    private static final long DOWNLOAD_STALL_MS = 20_000;
    private static final long ANSWER_MS = 30_000;
    private static final long CONFIRM_MS = 120_000;

    /**
     * The screen layouts, chosen with --ei layout N in the start command:
     *   1: title, author and clock on their own lines, the buttons in three rows
     *   2: the author shares the clock's line, the buttons in three rows
     *   3: title, author and clock on their own lines, the 15-second skips beside previous and
     *      next, and shuffle, speed, archive and star in one row
     */
    private static final int DEFAULT_LAYOUT = 3;
    /** The gap in dp between the last row of buttons and the Update button */
    private static final int UPDATE_GAP = 10;
    /** The progress ring around play: its width, and the room in dp it adds around the blue circle */
    private static final float RING_WIDTH = 2f;
    private static final int RING_SPACE = 4;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;

    private int layout;
    private TickerText title;
    private TextView author, status;
    private RoundButton play, previous, next, back, forward, shuffle, speed, archive, star, update;

    private static final String RELEASE = "https://github.com/wjeroen/wallacast/releases/download/android-latest/";
    private static final String INSTALL_STATUS = "io.github.wjeroen.wallacast.watch.INSTALL_STATUS";
    private long newerVersion;
    private long lastUpdateCheck;
    private boolean installing;
    /** The update's steps, shown on the status line while it runs */
    private static final int DOWNLOADING = 1, WAITING = 2, CONFIRMING = 3;
    private int installStep;
    private long installStepSince;
    /** Each try has its own thread and number: a try given up on may still hang in its
     *  thread, but its results no longer count, and it blocks neither the remote nor a new try */
    private volatile int installAttempt;
    private volatile int installSession = -1;
    private volatile HttpURLConnection installConnection;
    private volatile long downloadedBytes, totalBytes, lastProgressAt;

    private JSONObject state;
    private boolean online;
    /** "app": the page listens, "link": the page sleeps and Player Link stands in, "open":
     *  Player Link opens Wallacast on a play, "none" */
    private String mode = "none";
    private boolean polling;
    private String message;
    private long messageUntil;

    /** The clock: the page reports its position only every 5 seconds while it plays, so the
     *  watch moves it on itself from the last report (basePosition at baseAt) */
    private double basePosition;
    private long baseAt;
    private String reportKey = "";
    private long baseItem = -1;
    /** A 15-second skip shown before the phone confirms it: the position, NaN when none */
    private double skipTarget = Double.NaN;
    private long skipAt;

    /** A tapped archive or star waits, dimmed, until the phone's report shows the new state */
    private long wantItem = -1;
    private Boolean wantArchived, wantStarred;
    private long wantArchivedUntil, wantStarredUntil;

    private final Runnable pollTask = this::poll;
    private final Runnable tickTask = new Runnable() {
        @Override
        public void run() {
            // A wait for the phone that ran out shows at once, not at the next poll
            if (wantArchived != null || wantStarred != null || !waits.isEmpty()) render();
            else renderStatus();
            if (polling) main.postDelayed(this, TICK_MS);
        }
    };
    private final Runnable installWatch = new Runnable() {
        @Override
        public void run() {
            if (!installing) return;
            long now = SystemClock.elapsedRealtime();
            String problem = null;
            if (installStep == DOWNLOADING && now - lastProgressAt > DOWNLOAD_STALL_MS) {
                problem = "The download stopped. Check the connection and tap Update again.";
            } else if (installStep == WAITING && now - installStepSince > ANSWER_MS) {
                problem = "The watch did not ask to install. Tap Update again.";
            } else if (installStep == CONFIRMING && now - installStepSince > CONFIRM_MS) {
                problem = "No answer to the update question. Tap Update again.";
            }
            if (problem != null) {
                cancelInstall();
                finishInstall(problem);
                return;
            }
            main.postDelayed(this, 1000);
        }
    };

    interface Done {
        void done(int code, String body);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("wallacast", MODE_PRIVATE);
        applySetup(getIntent());
        setContentView(buildUi());
        render();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (INSTALL_STATUS.equals(intent.getAction())) {
            onInstallStatus(intent);
            return;
        }
        applySetup(intent);
        if (prefs.getInt("layout", DEFAULT_LAYOUT) != layout) {
            setContentView(buildUi());
            if (polling) title.setRunning(true);
        }
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        polling = true;
        main.removeCallbacks(pollTask);
        main.removeCallbacks(tickTask);
        poll();
        main.postDelayed(tickTask, TICK_MS);
        title.setRunning(true);
        // every time the app comes to the front (at most once a minute): reopening it from the
        // watch face reuses the same screen, so a check only at start would miss new versions
        if (System.currentTimeMillis() - lastUpdateCheck > 60 * 1000) checkForUpdate();
    }

    @Override
    protected void onPause() {
        super.onPause();
        polling = false;
        main.removeCallbacks(pollTask);
        main.removeCallbacks(tickTask);
        title.setRunning(false);
    }

    // ---- updates from the GitHub release ----------------------------------------------------

    private long installedVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
        } catch (Exception e) {
            return Long.MAX_VALUE;
        }
    }

    /** Reads versions.json from the release. Never sends the Wallacast token there. */
    private void checkForUpdate() {
        lastUpdateCheck = System.currentTimeMillis();
        net.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(RELEASE + "versions.json").openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                if (c.getResponseCode() != 200) return;
                long latest = new JSONObject(read(c.getInputStream())).optLong("watch", 0);
                c.disconnect();
                main.post(() -> {
                    newerVersion = latest > installedVersion() ? latest : 0;
                    render();
                });
            } catch (Exception ignored) {
                // no connection: the next start checks again
            }
        });
    }

    /** Downloads the new APK into an install session and asks the watch to install it. The
     *  download runs on a thread of its own, so a stuck one never holds up the remote's
     *  requests or a new try (installWatch gives it up). The screen stays on meanwhile:
     *  Android shows the confirmation only over an app in front. */
    private void installUpdate() {
        if (installing) return;
        installing = true;
        final int attempt = ++installAttempt;
        downloadedBytes = 0;
        totalBytes = -1;
        lastProgressAt = SystemClock.elapsedRealtime();
        setInstallStep(DOWNLOADING);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        main.removeCallbacks(installWatch);
        main.postDelayed(installWatch, 1000);
        render();
        new Thread(() -> {
            String problem = null;
            PackageInstaller installer = getPackageManager().getPackageInstaller();
            int id = -1;
            try {
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                id = installer.createSession(params);
                installSession = id;
                PackageInstaller.Session session = installer.openSession(id);
                HttpURLConnection c = (HttpURLConnection) new URL(RELEASE + "wallacast-watch.apk").openConnection();
                installConnection = c;
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                if (c.getResponseCode() != 200) throw new java.io.IOException("download failed (" + c.getResponseCode() + ")");
                totalBytes = c.getContentLengthLong();
                try (InputStream in = c.getInputStream(); OutputStream out = session.openWrite("update.apk", 0, -1)) {
                    byte[] buf = new byte[16384];
                    for (int n = in.read(buf); n > 0; n = in.read(buf)) {
                        if (attempt != installAttempt) throw new java.io.IOException("given up");
                        out.write(buf, 0, n);
                        downloadedBytes += n;
                        lastProgressAt = SystemClock.elapsedRealtime();
                    }
                    session.fsync(out);
                }
                c.disconnect();
                if (attempt != installAttempt) throw new java.io.IOException("given up");
                main.post(() -> {
                    if (attempt == installAttempt) setInstallStep(WAITING);
                });
                Intent back = new Intent(this, MainActivity.class).setAction(INSTALL_STATUS);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent answer;
                if (Build.VERSION.SDK_INT >= 34) {
                    // Android 15 starts an activity from this app's PendingIntent only when the app says so
                    ActivityOptions options = ActivityOptions.makeBasic();
                    options.setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                    answer = PendingIntent.getActivity(this, 0, back, flags, options.toBundle());
                } else {
                    answer = PendingIntent.getActivity(this, 0, back, flags);
                }
                session.commit(answer.getIntentSender());
                session.close();
            } catch (Exception e) {
                problem = e.getMessage() == null ? "Update failed" : e.getMessage();
                if (id >= 0) {
                    try {
                        installer.abandonSession(id);
                    } catch (Exception ignored) {
                        // already gone
                    }
                }
            }
            final String shown = problem;
            main.post(() -> {
                if (shown != null && attempt == installAttempt) finishInstall(shown);
            });
        }, "wallacast-update").start();
    }

    private void setInstallStep(int step) {
        installStep = step;
        installStepSince = SystemClock.elapsedRealtime();
        renderStatus();
    }

    /** What the status line says during an update */
    private String installText() {
        switch (installStep) {
            case DOWNLOADING:
                long got = downloadedBytes / 1024, all = totalBytes / 1024;
                if (downloadedBytes == 0) return "Downloading the update…";
                return totalBytes > 0 ? "Downloading " + got + " of " + all + " KB" : "Downloading " + got + " KB";
            case WAITING:
                return "Waiting for the watch to ask";
            case CONFIRMING:
                return "Confirm the update";
            default:
                return "";
        }
    }

    /** Gives up the running try: its thread may hang on, but its results no longer count. */
    private void cancelInstall() {
        installAttempt++;
        final HttpURLConnection c = installConnection;
        installConnection = null;
        if (c != null) new Thread(c::disconnect).start();
        abandonInstallSession();
    }

    @SuppressWarnings("deprecation")
    private void onInstallStatus(Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) {
                finishInstall("The watch did not ask to confirm the update");
                return;
            }
            setInstallStep(CONFIRMING);
            try {
                startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                abandonInstallSession();
                finishInstall("Could not ask to confirm: " + e.getMessage());
            }
            return;
        }
        installSession = -1;
        if (status == PackageInstaller.STATUS_SUCCESS) {
            finishInstall(null);
            return;
        }
        String why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        finishInstall("Update not installed" + (why != null ? ": " + why : ""));
    }

    private void abandonInstallSession() {
        int id = installSession;
        installSession = -1;
        if (id < 0) return;
        try {
            getPackageManager().getPackageInstaller().abandonSession(id);
        } catch (Exception ignored) {
            // already gone
        }
    }

    private void finishInstall(String problem) {
        installing = false;
        installStep = 0;
        installConnection = null;
        main.removeCallbacks(installWatch);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (problem != null) {
            // Long enough to read after looking away while the update ran
            flash(problem);
            messageUntil = System.currentTimeMillis() + 10_000;
        }
        render();
    }

    // ---- setup ---------------------------------------------------------------------------

    /** The server address, token and layout arrive as extras of the start command (adb shell am start). */
    private void applySetup(Intent intent) {
        if (intent == null) return;
        String server = intent.getStringExtra("server");
        String token = intent.getStringExtra("token");
        int wantedLayout = intent.getIntExtra("layout", 0);
        SharedPreferences.Editor edit = prefs.edit();
        boolean changed = false;
        if (server != null && server.trim().matches("https?://.+")) {
            // The backend address, with or without the /api the app's own setting ends in
            edit.putString("server", server.trim().replaceAll("/+$", "").replaceAll("/api$", ""));
            changed = true;
        }
        if (token != null && token.trim().startsWith("wcr_")) {
            edit.putString("token", token.trim());
            changed = true;
        }
        if (wantedLayout >= 1 && wantedLayout <= 3) edit.putInt("layout", wantedLayout);
        edit.commit();
        if (changed) flash("Set up");
    }

    private String server() {
        return prefs.getString("server", "");
    }

    private String token() {
        return prefs.getString("token", "");
    }

    private boolean isSetUp() {
        return !server().isEmpty() && !token().isEmpty();
    }

    // ---- network -------------------------------------------------------------------------

    private void request(String method, String path, JSONObject body, Done done) {
        final String base = server();
        final String auth = token();
        net.execute(() -> {
            int code;
            String text;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(10000);
                c.setRequestMethod(method);
                c.setRequestProperty("Authorization", "Bearer " + auth);
                c.setRequestProperty("Accept", "application/json");
                if (body != null) {
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    try (OutputStream out = c.getOutputStream()) {
                        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    }
                }
                code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                text = in == null ? "" : read(in);
                c.disconnect();
            } catch (Exception e) {
                code = -1;
                text = e.getMessage() == null ? "No connection" : e.getMessage();
            }
            final int finalCode = code;
            final String finalText = text;
            main.post(() -> done.done(finalCode, finalText));
        });
    }

    private static String read(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        return buf.toString("UTF-8");
    }

    private static String errorOf(String body, String fallback) {
        try {
            String e = new JSONObject(body).optString("error", "");
            return e.isEmpty() ? fallback : e;
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private void poll() {
        main.removeCallbacks(pollTask);
        if (!polling) return;
        if (!isSetUp()) {
            render();
            return;
        }
        request("GET", "/api/remote/state", null, (code, body) -> {
            if (code == 200) {
                try {
                    JSONObject json = new JSONObject(body);
                    online = json.optBoolean("online", false);
                    mode = json.optString("mode", online ? "app" : "none");
                    state = json.optJSONObject("state");
                    followReport(json.isNull("age_seconds") ? 0 : json.optDouble("age_seconds", 0));
                } catch (Exception e) {
                    flash("Unexpected answer");
                }
            } else if (code == 401) {
                flash("The token was refused. Set up again.");
            } else if (code == 403) {
                flash(errorOf(body, "This token may not control playback"));
            } else if (code == -1) {
                flash("No connection");
            }
            render();
            if (polling) main.postDelayed(pollTask, POLL_MS);
        });
    }

    private void send(String action, Object value) {
        send(action, value, -1);
    }

    /** itemId: archive and star name the item shown, so the phone changes that one even when
     *  its player moved on in the meantime */
    private void send(String action, Object value, long itemId) {
        if (!isSetUp()) return;
        JSONObject body = new JSONObject();
        try {
            body.put("action", action);
            if (value != null) body.put("value", value);
            if (itemId > 0) body.put("item_id", itemId);
        } catch (Exception ignored) {
            return;
        }
        request("POST", "/api/remote/command", body, (code, text) -> {
            if (code == 202) {
                main.removeCallbacks(pollTask);
                main.postDelayed(pollTask, 700);
            } else {
                // Nothing changes on the phone, so every waiting button and a shown skip go back
                wantArchived = null;
                wantStarred = null;
                waits.clear();
                skipTarget = Double.NaN;
                if (code == 409) flash(errorOf(text, "Open Wallacast on your phone"));
                else if (code == -1) flash("No connection");
                else flash(errorOf(text, "Not sent (" + code + ")"));
            }
            render();
        });
    }

    // ---- the clock -------------------------------------------------------------------------

    private boolean playingNow() {
        return state != null && state.optBoolean("playing") && online && "app".equals(mode);
    }

    /** A new report moves the clock to the reported position plus the time since the report.
     *  The same report seen again by a later poll changes nothing, so the clock never jumps back. */
    private void followReport(double ageSeconds) {
        if (state == null) {
            reportKey = "";
            return;
        }
        String key = state.optLong("item_id") + "/" + state.optInt("position") + "/" + state.optBoolean("playing") + "/" + state.optDouble("speed", 1) + "/" + mode;
        if (key.equals(reportKey)) return;
        reportKey = key;
        long item = state.optLong("item_id");
        basePosition = state.optInt("position") + (playingNow() ? Math.max(0, ageSeconds) * state.optDouble("speed", 1) : 0);
        baseAt = SystemClock.elapsedRealtime();
        // A report that includes the skips (it lands where the watch showed them) or another item
        // ends the shown skip. An older report, from before the phone carried the skip out, does not.
        if (!Double.isNaN(skipTarget) && (item != baseItem || Math.abs(basePosition - skippedNow()) <= SKIP_MATCH_S)) {
            skipTarget = Double.NaN;
        }
        baseItem = item;
    }

    /** Where a 15-second skip put the clock, moved on while playing */
    private double skippedNow() {
        double moved = playingNow() ? (SystemClock.elapsedRealtime() - skipAt) / 1000.0 * state.optDouble("speed", 1) : 0;
        return skipTarget + moved;
    }

    private double exactPosition() {
        if (state == null) return 0;
        double position = basePosition;
        if (playingNow()) position += (SystemClock.elapsedRealtime() - baseAt) / 1000.0 * state.optDouble("speed", 1);
        if (!Double.isNaN(skipTarget)) {
            // A skip the phone did not carry out within SKIP_WAIT_MS falls back to its report
            if (SystemClock.elapsedRealtime() - skipAt > SKIP_WAIT_MS) skipTarget = Double.NaN;
            else position = skippedNow();
        }
        int duration = state.optInt("duration");
        position = Math.max(0, position);
        return duration > 0 ? Math.min(duration, position) : position;
    }

    private int shownPosition() {
        return (int) Math.floor(exactPosition());
    }

    /** A 15-second skip shows on the clock at once, so a second press adds to it instead of
     *  repeating a press that seemed lost. The next reports confirm it or, after SKIP_WAIT_MS,
     *  undo it. */
    private void onSkip(boolean forwards) {
        if (state == null) return;
        double target = exactPosition() + (forwards ? 15 : -15);
        int duration = state.optInt("duration");
        skipTarget = Math.max(0, duration > 0 ? Math.min(duration, target) : target);
        skipAt = SystemClock.elapsedRealtime();
        send(forwards ? "forward" : "back", null);
        renderStatus();
    }

    // ---- waiting for the phone -------------------------------------------------------------

    /** A button pressed and not yet confirmed by the phone's report: dimmed meanwhile, so a
     *  second press does not overshoot. Ends when `confirmed` holds, or after PRESS_CONFIRM_MS with
     *  `failure` on the status line. */
    private static final class Wait {
        final long until;
        final BooleanSupplier confirmed;
        final String failure;

        Wait(long until, BooleanSupplier confirmed, String failure) {
            this.until = until;
            this.confirmed = confirmed;
            this.failure = failure;
        }
    }

    private final Map<String, Wait> waits = new HashMap<>();

    private void waitFor(String button, BooleanSupplier confirmed, String failure) {
        waits.put(button, new Wait(System.currentTimeMillis() + PRESS_CONFIRM_MS, confirmed, failure));
    }

    private boolean waiting(String button) {
        Wait w = waits.get(button);
        if (w == null) return false;
        if (state != null && w.confirmed.getAsBoolean()) {
            waits.remove(button);
            return false;
        }
        if (System.currentTimeMillis() > w.until) {
            waits.remove(button);
            if (w.failure != null) flash(w.failure);
            return false;
        }
        return true;
    }

    private void onPlayPause() {
        if (waiting("play")) return;
        boolean target = !(state != null && state.optBoolean("playing"));
        waitFor("play", () -> state.optBoolean("playing") == target, target ? "The phone did not start playing" : "The phone did not pause");
        send(target ? "play" : "pause", null);
        render();
    }

    private void onTrack(String action) {
        if (waiting("track")) return;
        long from = currentItem();
        waitFor("track", () -> currentItem() != from, "The phone did not move to another item");
        send(action, null);
        render();
    }

    private void onShuffle() {
        if (waiting("shuffle")) return;
        boolean target = !(state != null && state.optBoolean("shuffle"));
        waitFor("shuffle", () -> state.optBoolean("shuffle") == target, "The phone did not confirm shuffle");
        send("shuffle", target);
        render();
    }

    private void onSpeed() {
        if (waiting("speed")) return;
        double target = nextSpeed();
        waitFor("speed", () -> Math.abs(state.optDouble("speed", 1) - target) < 0.01, "The phone did not confirm the speed");
        send("speed", target);
        render();
    }

    // ---- interface -----------------------------------------------------------------------

    /** Everything is sized for a round screen of 225 dp (a Galaxy Watch) and scaled to this one,
     *  so all buttons fit on one screen without scrolling. */
    private float unit = 1f;

    private int s(float dpValue) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dpValue * unit, getResources().getDisplayMetrics()));
    }

    private TextView label(float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_PX, s(sp));
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setIncludeFontPadding(false);
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        return t;
    }

    private LinearLayout.LayoutParams centered(float width) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(s(width), ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        return lp;
    }

    private RoundButton button(int width, int height, int margin, View.OnClickListener click) {
        RoundButton b = new RoundButton(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(s(width), s(height));
        lp.setMargins(s(margin), s(2), s(margin), s(2));
        b.setLayoutParams(lp);
        b.setOnClickListener(click);
        return b;
    }

    private LinearLayout row() {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER);
        return r;
    }

    private RoundButton skip(int size, int margin, boolean forwards) {
        RoundButton b = button(size, size, margin, v -> onSkip(forwards));
        b.setPlain(true);
        b.setIcon(forwards ? R.drawable.ic_rotate_cw : R.drawable.ic_rotate_ccw, 0.9f, "15");
        return b;
    }

    private View buildUi() {
        android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
        unit = Math.max(0.75f, Math.min(1.4f, (Math.min(dm.widthPixels, dm.heightPixels) / dm.density) / 225f));
        layout = prefs.getInt("layout", DEFAULT_LAYOUT);

        // The controls fill exactly one screen, centered. The Update button peeks in below them
        // at the bottom edge, and a scroll shows it whole.
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);
        col.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dm.heightPixels));

        // The text lines sit where the round screen is still narrow
        title = new TickerText(this);
        title.setTextSizePx(s(13));
        title.setColor(0xFFF1F5F9);
        title.setBold(true);
        title.setLayoutParams(centered(layout == 3 ? 156 : 150));
        author = label(9.5f, 0xFF94A3B8, false);
        author.setLayoutParams(centered(layout == 3 ? 168 : 160));
        status = label(10, 0xFF94A3B8, false);
        LinearLayout.LayoutParams statusLp = centered(layout == 2 ? 170 : 172);
        statusLp.topMargin = s(1);
        statusLp.bottomMargin = s(3);
        status.setLayoutParams(statusLp);
        col.addView(title);
        if (layout != 2) col.addView(author);
        col.addView(status);

        View.OnClickListener onPlay = v -> onPlayPause();
        LinearLayout upper, last;
        if (layout == 3) {
            // 15 back, previous, play, next, 15 forward in one row through the middle, where the
            // round screen is widest
            upper = row();
            back = skip(36, 1, false);
            previous = button(32, 32, 3, v -> onTrack("previous"));
            play = button(50 + 2 * RING_SPACE, 50 + 2 * RING_SPACE, 3, onPlay);
            next = button(32, 32, 3, v -> onTrack("next"));
            forward = skip(36, 1, true);
            upper.addView(back);
            upper.addView(previous);
            upper.addView(play);
            upper.addView(next);
            upper.addView(forward);
            col.addView(upper);

            last = row();
            shuffle = button(32, 32, 4, v -> onShuffle());
            speed = button(40, 32, 4, v -> onSpeed());
            archive = button(32, 32, 4, v -> onArchive());
            star = button(32, 32, 4, v -> onStar());
            last.addView(shuffle);
            last.addView(speed);
            last.addView(archive);
            last.addView(star);
            col.addView(last);
        } else {
            LinearLayout transport = row();
            previous = button(36, 36, 5, v -> onTrack("previous"));
            play = button(52 + 2 * RING_SPACE, 52 + 2 * RING_SPACE, 5, onPlay);
            next = button(36, 36, 5, v -> onTrack("next"));
            transport.addView(previous);
            transport.addView(play);
            transport.addView(next);
            col.addView(transport);

            // 15 seconds back and forward (the app's circular arrows with the 15 inside) around
            // shuffle and speed
            upper = row();
            back = skip(40, 2, false);
            shuffle = button(32, 32, 3, v -> onShuffle());
            speed = button(40, 32, 3, v -> onSpeed());
            forward = skip(40, 2, true);
            upper.addView(back);
            upper.addView(shuffle);
            upper.addView(speed);
            upper.addView(forward);
            col.addView(upper);

            last = row();
            archive = button(32, 32, 4, v -> onArchive());
            star = button(32, 32, 4, v -> onStar());
            last.addView(archive);
            last.addView(star);
            col.addView(last);
        }
        previous.setIcon(R.drawable.ic_skip_back, 0.5f, null);
        next.setIcon(R.drawable.ic_skip_forward, 0.5f, null);
        play.setColors(0xFF3B82F6, 0xFFFFFFFF);
        // The progress ring around the blue circle makes play's row a little taller
        play.setRing(s(RING_WIDTH), s(RING_SPACE - RING_WIDTH));

        LinearLayout below = row();
        below.setPadding(0, 0, 0, s(40));
        update = button(84, 32, 4, v -> installUpdate());
        update.setText("Update");
        update.setColors(0xFF3B82F6, 0xFFFFFFFF);
        below.addView(update);

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.addView(col);
        page.addView(below);
        // Pull the Update row up over the empty bottom of the screen, UPDATE_GAP below the last
        // row in every layout, so part of its blue always shows
        col.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> below.post(() -> {
            if (layout == 3) {
                // The title takes the whole width the round screen has at its height
                float radius = col.getWidth() / 2f;
                float dy = Math.abs(title.getTop() + title.getHeight() / 2f - col.getHeight() / 2f) + title.getHeight() / 2f;
                int width = (int) (2 * Math.sqrt(Math.max(0, radius * radius - dy * dy))) - s(6);
                ViewGroup.LayoutParams tlp = title.getLayoutParams();
                if (width > 0 && tlp.width != width) {
                    tlp.width = width;
                    title.setLayoutParams(tlp);
                }
            }
            View lastButton = last.getChildAt(0);
            int top = last.getTop() + lastButton.getBottom() + s(UPDATE_GAP) - s(2) - col.getHeight();
            LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) below.getLayoutParams();
            if (lp.topMargin != top) {
                lp.topMargin = top;
                below.setLayoutParams(lp);
            }
        }));

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0F172A);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(page, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        // The rotating bezel or crown scrolls the focused view
        scroll.setFocusable(true);
        scroll.setFocusableInTouchMode(true);
        scroll.requestFocus();
        return scroll;
    }

    private long currentItem() {
        return state == null || state.isNull("item_id") ? -1 : state.optLong("item_id");
    }

    /** One tap archives or unarchives: the item goes on playing, and its audio stays 7 days.
     *  The button is dimmed until the phone confirms, so its color is always the real state. */
    private void onArchive() {
        if (state == null || archiveWaiting()) return;
        boolean now = state.optBoolean("is_archived");
        wantItem = currentItem();
        wantArchived = !now;
        wantArchivedUntil = System.currentTimeMillis() + WANT_MS;
        send(now ? "unarchive" : "archive", null, wantItem);
        render();
    }

    private void onStar() {
        if (state == null || starWaiting()) return;
        boolean now = state.optBoolean("is_starred");
        wantItem = currentItem();
        wantStarred = !now;
        wantStarredUntil = System.currentTimeMillis() + WANT_MS;
        send(now ? "unstar" : "star", null, wantItem);
        render();
    }

    /** True while a tapped archive waits for the phone. Ends when the report shows the new
     *  state, when another item plays, or after WANT_MS with a message. */
    private boolean archiveWaiting() {
        if (wantArchived == null) return false;
        boolean reported = state != null && state.optBoolean("is_archived");
        if (wantArchived == reported || wantItem != currentItem()) {
            wantArchived = null;
        } else if (System.currentTimeMillis() > wantArchivedUntil) {
            wantArchived = null;
            flash("The phone did not confirm the archive. Tap again.");
        }
        return wantArchived != null;
    }

    private boolean starWaiting() {
        if (wantStarred == null) return false;
        boolean reported = state != null && state.optBoolean("is_starred");
        if (wantStarred == reported || wantItem != currentItem()) {
            wantStarred = null;
        } else if (System.currentTimeMillis() > wantStarredUntil) {
            wantStarred = null;
            flash("The phone did not confirm the star. Tap again.");
        }
        return wantStarred != null;
    }

    /** The speed after the current one in the app's speed cycle, wrapping around. */
    private double nextSpeed() {
        double current = state != null ? state.optDouble("speed", 1) : 1;
        JSONArray speeds = state != null ? state.optJSONArray("speeds") : null;
        if (speeds == null || speeds.length() == 0) return current >= 2 ? 1 : current + 0.25;
        for (int i = 0; i < speeds.length(); i++) {
            if (speeds.optDouble(i) > current + 0.001) return speeds.optDouble(i);
        }
        return speeds.optDouble(0, 1);
    }

    private void flash(String text) {
        message = text;
        messageUntil = System.currentTimeMillis() + 4000;
    }

    private static String clock(int seconds) {
        int h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60;
        return h > 0 ? String.format(Locale.US, "%d:%02d:%02d", h, m, s) : String.format(Locale.US, "%d:%02d", m, s);
    }

    private static String speedText(double speed) {
        String t = String.format(Locale.US, "%.2f", speed).replaceAll("0+$", "").replaceAll("\\.$", "");
        return t + "×";
    }

    private String stateText(String key) {
        return state == null || state.isNull(key) ? "" : state.optString(key, "").trim();
    }

    /** The author line: "Author · Show" when both fit on the line, else the author alone (the
     *  show or feed only when there is no author). A page from before 2026-11-22 sends only
     *  `subtitle`. */
    private String byline() {
        String who = stateText("author"), from = stateText("source");
        if (who.isEmpty() && from.isEmpty()) return stateText("subtitle");
        if (who.isEmpty()) return from;
        if (from.isEmpty() || from.equalsIgnoreCase(who)) return who;
        String both = who + " · " + from;
        return author.getPaint().measureText(both) <= author.getLayoutParams().width ? both : who;
    }

    /** Only the author (or else the show), for layout 2, where it shares the line with the clock. */
    private String authorOnly() {
        String who = stateText("author");
        if (!who.isEmpty()) return who;
        String from = stateText("source");
        return from.isEmpty() ? stateText("subtitle") : from;
    }

    /** The status line: the clock, or a message, which in layout 2 also replaces the author. */
    private void renderStatus() {
        if (status == null) return;
        int length = state == null ? 0 : state.optInt("duration");
        boolean listened = state != null && !state.isNull("item_id") && state.optBoolean("loaded", true) && length > 0;
        play.setProgress(listened ? shownPosition() / (float) length : 0);
        boolean hasItem = state != null && !state.isNull("item_id");
        boolean loaded = state == null || state.optBoolean("loaded", true);
        String line;
        if (!isSetUp()) line = "See android/README.md";
        else if (installing && installStep != 0) line = installText();
        else if (System.currentTimeMillis() < messageUntil && message != null) line = message;
        else if (!online) line = "Wallacast sleeps or is closed. Play it with the watch's media controls.";
        else if ("link".equals(mode)) line = "Asleep on the phone: play, pause and skips only";
        else if ("open".equals(mode)) line = "Closed on the phone: play opens it";
        else if (hasItem && loaded) {
            String time = clock(shownPosition()) + " / " + clock(state.optInt("duration"));
            line = layout == 2 ? withAuthor(time) : time;
        } else line = layout == 2 && hasItem ? authorOnly() : "";
        if (!line.contentEquals(status.getText())) status.setText(line);
    }

    /** "Author · 1:34 / 30:33", the author shortened so the clock always fits. */
    private String withAuthor(String time) {
        String who = authorOnly();
        if (who.isEmpty()) return time;
        String joint = " · " + time;
        float room = status.getLayoutParams().width - status.getPaint().measureText(joint);
        if (room < s(20)) return time;
        return TextUtils.ellipsize(who, status.getPaint(), room, TextUtils.TruncateAt.END) + joint;
    }

    private void render() {
        if (title == null) return;
        boolean playing = state != null && state.optBoolean("playing");
        boolean hasItem = state != null && !state.isNull("item_id");
        // false: no player is open on the phone, this is the last item and play loads it
        boolean loaded = state == null || state.optBoolean("loaded", true);
        play.setIcon(playing ? R.drawable.ic_pause : R.drawable.ic_play, 0.46f, null);

        if (!isSetUp()) title.setText("Not set up");
        else if (hasItem) title.setText(state.optString("title", ""));
        else title.setText("Nothing playing");
        author.setText(isSetUp() && hasItem ? byline() : "");
        renderStatus();

        boolean appMode = online && "app".equals(mode);
        boolean linkMode = online && "link".equals(mode);
        boolean openMode = online && "open".equals(mode);
        // Play, pause and the skips also work through Player Link, the rest needs the page
        boolean transport = isSetUp() && (appMode && hasItem && loaded || linkMode);
        boolean full = isSetUp() && appMode && hasItem && loaded;
        // Dimmed while a press waits for the phone (waiting()), so a second press does not overshoot
        play.setEnabled((transport || isSetUp() && (openMode || appMode && hasItem)) && !waiting("play"));
        back.setEnabled(transport);
        forward.setEnabled(transport);
        speed.setEnabled(full && !waiting("speed"));
        shuffle.setEnabled(isSetUp() && appMode && !waiting("shuffle"));
        boolean trackWait = waiting("track");
        previous.setEnabled(full && state.optBoolean("has_previous") && !trackWait);
        next.setEnabled(full && state.optBoolean("has_next") && !trackWait);
        // Dimmed, like the Update button while it works, until the phone confirms
        archive.setEnabled(full && !archiveWaiting());
        star.setEnabled(full && !starWaiting());

        boolean shuffleOn = state != null && state.optBoolean("shuffle");
        shuffle.setIcon(R.drawable.ic_shuffle, 0.55f, null);
        shuffle.setColors(shuffleOn ? 0xFF3B82F6 : 0xFF1E293B, 0xFFF1F5F9);
        speed.setText(speedText(state != null ? state.optDouble("speed", 1) : 1));
        // The app's colors: a starred item's star is yellow, an archived item's icon blue
        boolean starred = state != null && state.optBoolean("is_starred");
        star.setIcon(starred ? R.drawable.ic_star_filled : R.drawable.ic_star, 0.5f, null);
        star.setColors(0xFF1E293B, starred ? 0xFFFBBF24 : 0xFFF1F5F9);
        boolean archived = state != null && state.optBoolean("is_archived");
        archive.setIcon(archived ? R.drawable.ic_archive_restore : R.drawable.ic_archive, 0.5f, null);
        archive.setColors(0xFF1E293B, archived ? 0xFF60A5FA : 0xFFF1F5F9);
        // the whole row below the screen, so without an update there is nothing to scroll to
        ((View) update.getParent()).setVisibility(newerVersion > 0 || installing ? View.VISIBLE : View.GONE);
        update.setEnabled(!installing);
    }
}
