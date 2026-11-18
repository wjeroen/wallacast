package io.github.wjeroen.wallacast.watch;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
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
 * sends play, pause, next, previous, 15 seconds back and forward, shuffle, speed and archive.
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
    private RoundButton play, previous, next, back, forward, shuffle, speed, archive;

    private JSONObject state;
    private boolean online;
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
        applySetup(intent);
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        polling = true;
        main.removeCallbacks(pollTask);
        poll();
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
                flash("Open Wallacast on your phone");
            } else if (code == -1) {
                flash("No connection");
            } else {
                flash(errorOf(text, "Not sent (" + code + ")"));
            }
            render();
        });
    }

    // ---- interface -----------------------------------------------------------------------

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private TextView label(float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        return t;
    }

    private RoundButton button(int width, int height, View.OnClickListener click) {
        RoundButton b = new RoundButton(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(width), dp(height));
        lp.setMargins(dp(3), dp(3), dp(3), dp(3));
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
        int side = getResources().getDisplayMetrics().widthPixels / 9;
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(side, dp(22), side, dp(36));

        title = label(15, 0xFFF1F5F9, true);
        title.setMaxLines(2);
        title.setEllipsize(TextUtils.TruncateAt.END);
        subtitle = label(11, 0xFF94A3B8, false);
        subtitle.setSingleLine(true);
        subtitle.setEllipsize(TextUtils.TruncateAt.END);
        status = label(11, 0xFF94A3B8, false);
        status.setPadding(0, dp(2), 0, dp(4));
        col.addView(title);
        col.addView(subtitle);
        col.addView(status);

        LinearLayout transport = row();
        previous = button(42, 42, v -> send("previous", null));
        previous.setGlyph(RoundButton.PREVIOUS);
        play = button(58, 58, v -> send(state != null && state.optBoolean("playing") ? "pause" : "play", null));
        play.setColors(0xFF3B82F6, 0xFFFFFFFF);
        next = button(42, 42, v -> send("next", null));
        next.setGlyph(RoundButton.NEXT);
        transport.addView(previous);
        transport.addView(play);
        transport.addView(next);
        col.addView(transport);

        LinearLayout skips = row();
        back = button(52, 32, v -> send("back", null));
        back.setText("-15");
        forward = button(52, 32, v -> send("forward", null));
        forward.setText("+15");
        skips.addView(back);
        skips.addView(forward);
        col.addView(skips);

        LinearLayout modes = row();
        shuffle = button(72, 32, v -> send("shuffle", !(state != null && state.optBoolean("shuffle"))));
        speed = button(52, 32, v -> send("speed", nextSpeed()));
        modes.addView(shuffle);
        modes.addView(speed);
        col.addView(modes);

        LinearLayout last = row();
        archive = button(100, 32, v -> onArchive());
        last.addView(archive);
        col.addView(last);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0F172A);
        scroll.setFillViewport(true);
        scroll.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        // The rotating bezel or crown scrolls the focused view
        scroll.setFocusable(true);
        scroll.setFocusableInTouchMode(true);
        scroll.requestFocus();
        return scroll;
    }

    private void onArchive() {
        long now = System.currentTimeMillis();
        if (now < archiveArmedUntil) {
            archiveArmedUntil = 0;
            send("archive", null);
        } else {
            archiveArmedUntil = now + ARCHIVE_CONFIRM_MS;
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
        play.setGlyph(playing ? RoundButton.PAUSE : RoundButton.PLAY);

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

        if (isSetUp()) {
            String line;
            if (System.currentTimeMillis() < messageUntil && message != null) line = message;
            else if (!online) line = "Open Wallacast on your phone";
            else if (hasItem) line = clock(state.optInt("position")) + " / " + clock(state.optInt("duration"));
            else line = "";
            status.setText(line);
        }

        boolean usable = isSetUp() && online && hasItem;
        play.setEnabled(usable);
        back.setEnabled(usable);
        forward.setEnabled(usable);
        speed.setEnabled(usable);
        shuffle.setEnabled(isSetUp() && online);
        previous.setEnabled(usable && state.optBoolean("has_previous"));
        next.setEnabled(usable && state.optBoolean("has_next"));
        archive.setEnabled(usable && !state.optBoolean("is_archived"));

        boolean shuffleOn = state != null && state.optBoolean("shuffle");
        shuffle.setText("Shuffle");
        shuffle.setColors(shuffleOn ? 0xFF3B82F6 : 0xFF1E293B, 0xFFF1F5F9);
        speed.setText(speedText(state != null ? state.optDouble("speed", 1) : 1));
        boolean armed = System.currentTimeMillis() < archiveArmedUntil;
        archive.setText(armed ? "Tap again" : "Archive");
        archive.setColors(armed ? 0xFFB91C1C : 0xFF1E293B, 0xFFF1F5F9);
    }
}
