package io.github.wjeroen.wallacast.watch;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
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
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The Wallacast remote for a watch. It shows what the Wallacast app on the phone plays and
 * sends play, pause, next, previous, 15 seconds back and forward, shuffle, speed, archive and
 * star, with the Lucide icons the app uses (res/drawable, made by android/tools/lucide2vector.py).
 * An Update button shows when the GitHub release android-latest holds a newer version
 * (android/release.sh puts it there), and installs it after one confirmation on the watch.
 *
 * While Chrome lets the page sleep (paused for minutes with the screen off), the server passes
 * play, pause and the skips to Player Link on the phone instead (mode "link"), and the other
 * buttons wait until the page runs again.
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
    private static final long ARCHIVE_CONFIRM_MS = 3000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;

    private TextView title, subtitle, status;
    private RoundButton play, previous, next, back, forward, shuffle, speed, archive, star, update;

    private static final String RELEASE = "https://github.com/wjeroen/wallacast/releases/download/android-latest/";
    private static final String INSTALL_STATUS = "io.github.wjeroen.wallacast.watch.INSTALL_STATUS";
    private long newerVersion;
    private long lastUpdateCheck;
    private boolean installing;

    private JSONObject state;
    private boolean online;
    /** "app": the page listens, "link": the page sleeps and Player Link stands in, "none" */
    private String mode = "none";
    private boolean polling;
    private long archiveArmedUntil;
    private String message;
    private long messageUntil;

    private final Runnable pollTask = this::poll;

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
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        polling = true;
        main.removeCallbacks(pollTask);
        poll();
        if (System.currentTimeMillis() - lastUpdateCheck > 60 * 60 * 1000) checkForUpdate();
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

    /** Downloads the new APK into an install session and asks the watch to install it. */
    private void installUpdate() {
        if (installing) return;
        installing = true;
        flash("Downloading the update…");
        render();
        net.execute(() -> {
            String problem = null;
            try {
                PackageInstaller installer = getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                int id = installer.createSession(params);
                PackageInstaller.Session session = installer.openSession(id);
                HttpURLConnection c = (HttpURLConnection) new URL(RELEASE + "wallacast-watch.apk").openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(60000);
                if (c.getResponseCode() != 200) throw new java.io.IOException("download failed (" + c.getResponseCode() + ")");
                try (InputStream in = c.getInputStream(); OutputStream out = session.openWrite("update.apk", 0, -1)) {
                    byte[] buf = new byte[65536];
                    for (int n = in.read(buf); n > 0; n = in.read(buf)) out.write(buf, 0, n);
                    session.fsync(out);
                }
                c.disconnect();
                Intent back = new Intent(this, MainActivity.class).setAction(INSTALL_STATUS);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                session.commit(PendingIntent.getActivity(this, 0, back, flags).getIntentSender());
                session.close();
            } catch (Exception e) {
                problem = e.getMessage() == null ? "Update failed" : e.getMessage();
            }
            final String shown = problem;
            main.post(() -> {
                if (shown != null) {
                    installing = false;
                    flash(shown);
                    render();
                }
            });
        });
    }

    @SuppressWarnings("deprecation")
    private void onInstallStatus(Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return;
        }
        installing = false;
        if (status != PackageInstaller.STATUS_SUCCESS) {
            String why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            flash("Update not installed" + (why != null ? ": " + why : ""));
        }
        render();
    }

    @Override
    protected void onPause() {
        super.onPause();
        polling = false;
        main.removeCallbacks(pollTask);
    }

    // ---- setup ---------------------------------------------------------------------------

    /** The server address and token arrive as extras of the start command (adb shell am start). */
    private void applySetup(Intent intent) {
        if (intent == null) return;
        String server = intent.getStringExtra("server");
        String token = intent.getStringExtra("token");
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
        if (changed) {
            edit.apply();
            flash("Set up");
        }
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
        if (!isSetUp()) return;
        JSONObject body = new JSONObject();
        try {
            body.put("action", action);
            if (value != null) body.put("value", value);
        } catch (Exception ignored) {
            return;
        }
        request("POST", "/api/remote/command", body, (code, text) -> {
            if (code == 202) {
                main.removeCallbacks(pollTask);
                main.postDelayed(pollTask, 700);
            } else if (code == 409) {
                flash(errorOf(text, "Open Wallacast on your phone"));
            } else if (code == -1) {
                flash("No connection");
            } else {
                flash(errorOf(text, "Not sent (" + code + ")"));
            }
            render();
        });
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
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        return t;
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

    private View buildUi() {
        android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
        unit = Math.max(0.75f, Math.min(1.4f, (Math.min(dm.widthPixels, dm.heightPixels) / dm.density) / 225f));

        // The controls fill exactly one screen, centered as before. The Update button sits below
        // them, so it takes a scroll to reach and moves nothing else.
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);
        col.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dm.heightPixels));

        // Two lines of text where the round screen is still narrow: the title and a status line
        title = label(13, 0xFFF1F5F9, true);
        LinearLayout.LayoutParams textWidth = new LinearLayout.LayoutParams(s(150), ViewGroup.LayoutParams.WRAP_CONTENT);
        textWidth.gravity = Gravity.CENTER_HORIZONTAL;
        title.setLayoutParams(textWidth);
        subtitle = label(10, 0xFF94A3B8, false);
        subtitle.setVisibility(View.GONE);
        status = label(10, 0xFF94A3B8, false);
        LinearLayout.LayoutParams statusWidth = new LinearLayout.LayoutParams(s(160), ViewGroup.LayoutParams.WRAP_CONTENT);
        statusWidth.gravity = Gravity.CENTER_HORIZONTAL;
        statusWidth.bottomMargin = s(3);
        status.setLayoutParams(statusWidth);
        col.addView(title);
        col.addView(status);

        LinearLayout transport = row();
        previous = button(36, 36, 5, v -> send("previous", null));
        previous.setIcon(R.drawable.ic_skip_back, 0.5f, null);
        play = button(52, 52, 5, v -> send(state != null && state.optBoolean("playing") ? "pause" : "play", null));
        play.setColors(0xFF3B82F6, 0xFFFFFFFF);
        next = button(36, 36, 5, v -> send("next", null));
        next.setIcon(R.drawable.ic_skip_forward, 0.5f, null);
        transport.addView(previous);
        transport.addView(play);
        transport.addView(next);
        col.addView(transport);

        // 15 seconds back and forward (the app's circular arrows with the 15 inside) around
        // shuffle and speed
        LinearLayout middle = row();
        back = button(40, 40, 2, v -> send("back", null));
        back.setPlain(true);
        back.setIcon(R.drawable.ic_rotate_ccw, 0.9f, "15");
        shuffle = button(32, 32, 3, v -> send("shuffle", !(state != null && state.optBoolean("shuffle"))));
        shuffle.setIcon(R.drawable.ic_shuffle, 0.55f, null);
        speed = button(40, 32, 3, v -> send("speed", nextSpeed()));
        forward = button(40, 40, 2, v -> send("forward", null));
        forward.setPlain(true);
        forward.setIcon(R.drawable.ic_rotate_cw, 0.9f, "15");
        middle.addView(back);
        middle.addView(shuffle);
        middle.addView(speed);
        middle.addView(forward);
        col.addView(middle);

        LinearLayout last = row();
        archive = button(32, 32, 4, v -> onArchive());
        star = button(32, 32, 4, v -> send(state != null && state.optBoolean("is_starred") ? "unstar" : "star", null));
        last.addView(archive);
        last.addView(star);
        col.addView(last);

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

    private void onArchive() {
        if (state != null && state.optBoolean("is_archived")) {
            send("unarchive", null);
            return;
        }
        long now = System.currentTimeMillis();
        if (now < archiveArmedUntil) {
            archiveArmedUntil = 0;
            send("archive", null);
        } else {
            archiveArmedUntil = now + ARCHIVE_CONFIRM_MS;
            message = "Tap again to archive";
            messageUntil = archiveArmedUntil;
            main.postDelayed(this::render, ARCHIVE_CONFIRM_MS + 50);
        }
        render();
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

    private void render() {
        if (title == null) return;
        boolean playing = state != null && state.optBoolean("playing");
        boolean hasItem = state != null && !state.isNull("item_id");
        play.setIcon(playing ? R.drawable.ic_pause : R.drawable.ic_play, 0.46f, null);

        if (!isSetUp()) {
            title.setText("Not set up");
            subtitle.setText("");
            status.setText("See android/README.md");
        } else if (hasItem) {
            title.setText(state.optString("title", ""));
            subtitle.setText(state.isNull("subtitle") ? "" : state.optString("subtitle", ""));
        } else {
            title.setText("Nothing playing");
            subtitle.setText("");
        }

        boolean appMode = online && "app".equals(mode);
        boolean linkMode = online && "link".equals(mode);
        if (isSetUp()) {
            String line;
            if (System.currentTimeMillis() < messageUntil && message != null) line = message;
            else if (!online) line = "Wallacast sleeps or is closed. Play it with the watch's media controls.";
            else if (linkMode) line = "Asleep on the phone: play, pause and skips only";
            else if (hasItem) line = clock(state.optInt("position")) + " / " + clock(state.optInt("duration"));
            else line = "";
            status.setText(line);
        }

        // Play, pause and the skips also work through Player Link, the rest needs the page
        boolean transport = isSetUp() && (appMode && hasItem || linkMode);
        boolean full = isSetUp() && appMode && hasItem;
        play.setEnabled(transport);
        back.setEnabled(transport);
        forward.setEnabled(transport);
        speed.setEnabled(full);
        shuffle.setEnabled(isSetUp() && appMode);
        previous.setEnabled(full && state.optBoolean("has_previous"));
        next.setEnabled(full && state.optBoolean("has_next"));
        archive.setEnabled(full);
        star.setEnabled(full);

        boolean shuffleOn = state != null && state.optBoolean("shuffle");
        shuffle.setColors(shuffleOn ? 0xFF3B82F6 : 0xFF1E293B, 0xFFF1F5F9);
        speed.setText(speedText(state != null ? state.optDouble("speed", 1) : 1));
        boolean starred = state != null && state.optBoolean("is_starred");
        star.setIcon(starred ? R.drawable.ic_star_filled : R.drawable.ic_star, 0.5f, null);
        // Archive asks for a second tap: red while it waits for it
        boolean armed = System.currentTimeMillis() < archiveArmedUntil;
        boolean archived = state != null && state.optBoolean("is_archived");
        archive.setIcon(archived ? R.drawable.ic_archive_restore : R.drawable.ic_archive, 0.5f, null);
        archive.setColors(armed ? 0xFFB91C1C : 0xFF1E293B, 0xFFF1F5F9);
        // the whole row below the screen, so without an update there is nothing to scroll to
        ((View) update.getParent()).setVisibility(newerVersion > 0 || installing ? View.VISIBLE : View.GONE);
        update.setEnabled(!installing);
    }
}
