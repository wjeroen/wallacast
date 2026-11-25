package io.github.wjeroen.playerlink;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The settings screen: the main switch (off by default), notification access, the players to
 * link (every player Android knows now, plus the linked ones that are not open), what the
 * service does, and the Wallacast watch bridge: server address, token, and the permission to
 * open Wallacast.
 */
public class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private TextView access, status;
    private Switch enabled;
    private Button grant, allowOpen;
    private TextView openState;
    private LinearLayout playerList;
    private final Map<String, CheckBox> boxes = new HashMap<>();
    private String shownKeys = "";

    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            render();
            main.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(LinkService.PREFS, MODE_PRIVATE);
        int pad = dp(20);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);

        TextView title = text(22);
        title.setText(R.string.app_name);
        col.addView(title);

        enabled = new Switch(this);
        enabled.setText("Pause and play the ticked players together");
        enabled.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        enabled.setPadding(0, dp(16), 0, dp(8));
        enabled.setChecked(prefs.getBoolean(LinkService.PREF_ENABLED, false));
        tintSwitch(enabled);
        enabled.setOnCheckedChangeListener((b, on) -> {
            if (on == prefs.getBoolean(LinkService.PREF_ENABLED, false)) return;
            prefs.edit().putBoolean(LinkService.PREF_ENABLED, on).apply();
            LinkService s = LinkService.instance;
            if (s != null) s.onSwitch(on);
        });
        col.addView(enabled);

        access = text(14);
        col.addView(access);
        grant = new Button(this);
        grant.setText("Open notification access");
        grant.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        col.addView(grant);

        TextView playersTitle = text(16);
        playersTitle.setText("Players");
        playersTitle.setPadding(0, dp(16), 0, dp(4));
        col.addView(playersTitle);
        playerList = new LinearLayout(this);
        playerList.setOrientation(LinearLayout.VERTICAL);
        col.addView(playerList);

        status = text(14);
        status.setPadding(0, dp(12), 0, dp(12));
        col.addView(status);

        TextView bridge = text(16);
        bridge.setText("Wallacast watch bridge");
        bridge.setPadding(0, dp(16), 0, dp(4));
        col.addView(bridge);
        EditText server = new EditText(this);
        server.setHint("Server, for example https://your-backend.up.railway.app");
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setText(prefs.getString(LinkService.PREF_SERVER, ""));
        col.addView(server);
        EditText token = new EditText(this);
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        col.addView(token);
        Button save = new Button(this);
        save.setText("Save");
        save.setOnClickListener(v -> {
            String address = server.getText().toString().trim().replaceAll("/+$", "").replaceAll("/api$", "");
            SharedPreferences.Editor edit = prefs.edit().putString(LinkService.PREF_SERVER, address);
            String typed = token.getText().toString().trim();
            if (typed.startsWith("wcr_")) edit.putString(LinkService.PREF_TOKEN, typed);
            if (address.isEmpty()) edit.remove(LinkService.PREF_TOKEN);
            edit.apply();
            token.setText("");
            tokenHint(token);
        });
        tokenHint(token);
        col.addView(save);
        Switch anyChrome = new Switch(this);
        anyChrome.setText("Every Chrome player is Wallacast");
        anyChrome.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        anyChrome.setChecked(prefs.getBoolean(LinkService.PREF_ANY_CHROME_IS_WALLACAST, false));
        tintSwitch(anyChrome);
        anyChrome.setOnCheckedChangeListener((b, on) -> {
            prefs.edit().putBoolean(LinkService.PREF_ANY_CHROME_IS_WALLACAST, on).apply();
            LinkService s = LinkService.instance;
            if (s != null) s.refreshSessions();
        });
        col.addView(anyChrome);
        openState = text(14);
        openState.setPadding(0, dp(12), 0, dp(4));
        col.addView(openState);
        allowOpen = new Button(this);
        allowOpen.setText("Allow display over other apps");
        allowOpen.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))));
        col.addView(allowOpen);

        // The event log (LinkLog): it also goes to the Wallacast server while the bridge is set up
        TextView logTitle = text(16);
        logTitle.setText("Log");
        logTitle.setPadding(0, dp(16), 0, dp(4));
        col.addView(logTitle);
        TextView logState = text(14);
        logState.setText("What Player Link did and what Wallacast's player in Chrome did, with the screen's state. With the watch bridge set up it also reaches the Wallacast server's log.");
        col.addView(logState);
        Button saveLog = new Button(this);
        saveLog.setText("Save log to Downloads");
        saveLog.setOnClickListener(v -> LinkLog.saveToDownloads(this, result -> main.post(() -> logState.setText(result))));
        col.addView(saveLog);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        // Android 15 and later draw the app under the status and navigation bars, so the column
        // leaves their height free
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            col.setPadding(pad, pad + insets.getSystemWindowInsetTop(), pad, pad + insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(scroll);
    }

    private void tokenHint(EditText token) {
        token.setHint(prefs.getString(LinkService.PREF_TOKEN, "").isEmpty() ? "API token (wcr_...)" : "API token saved");
    }

    @Override
    protected void onResume() {
        super.onResume();
        main.post(refresh);
    }

    @Override
    protected void onPause() {
        super.onPause();
        main.removeCallbacks(refresh);
    }

    private boolean hasAccess() {
        String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        ComponentName me = new ComponentName(this, LinkService.class);
        return enabled != null && (enabled.contains(me.flattenToString()) || enabled.contains(me.flattenToShortString()));
    }

    private void render() {
        // the quick settings tile can change the switch too
        boolean switchOn = prefs.getBoolean(LinkService.PREF_ENABLED, false);
        if (enabled.isChecked() != switchOn) enabled.setChecked(switchOn);
        boolean ok = hasAccess();
        access.setText(ok ? "Notification access: on" : "Notification access: off. Turn it on for Player Link.");
        grant.setVisibility(ok ? Button.GONE : Button.VISIBLE);
        boolean overlay = Settings.canDrawOverlays(this);
        openState.setText(overlay
            ? "Play on the watch opens Wallacast when Chrome has no Wallacast player: on"
            : "Play on the watch opens Wallacast when Chrome has no Wallacast player: needs \"Display over other apps\"");
        allowOpen.setVisibility(overlay ? Button.GONE : Button.VISIBLE);
        LinkService s = LinkService.instance;
        if (s == null) {
            status.setText(ok ? "Starting…" : "");
            return;
        }
        List<String[]> list = s.describePlayers();
        Set<String> linked = s.linkedKeys();
        StringBuilder keys = new StringBuilder();
        for (String[] p : list) keys.append(p[0]).append('\n');
        // Rebuild the boxes only when the players change, so a tap is never lost
        if (!keys.toString().equals(shownKeys)) {
            shownKeys = keys.toString();
            playerList.removeAllViews();
            boxes.clear();
            for (String[] p : list) {
                CheckBox box = new CheckBox(this);
                box.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
                final String key = p[0];
                box.setOnCheckedChangeListener((b, on) -> {
                    LinkService service = LinkService.instance;
                    if (service != null && on != service.linkedKeys().contains(key)) service.setLinked(key, on);
                });
                playerList.addView(box);
                boxes.put(key, box);
            }
            if (list.isEmpty()) {
                TextView none = text(14);
                none.setText("No player right now. Start playing something.");
                playerList.addView(none);
            }
        }
        for (String[] p : list) {
            CheckBox box = boxes.get(p[0]);
            if (box == null) continue;
            box.setText(p[1] + " (" + p[2] + ")");
            if (box.isChecked() != linked.contains(p[0])) box.setChecked(linked.contains(p[0]));
        }
        status.setText(s.describeStatus());
    }

    private TextView text(float sp) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        return t;
    }

    /** The device's dark theme drew an off switch dark on dark: amber when on, light grey when off. */
    private static void tintSwitch(Switch s) {
        int[][] states = { { android.R.attr.state_checked }, {} };
        s.setThumbTintList(new ColorStateList(states, new int[] { 0xFFF59E0B, 0xFFD1D5DB }));
        s.setTrackTintList(new ColorStateList(states, new int[] { 0x80F59E0B, 0x809CA3AF }));
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
