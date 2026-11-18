package io.github.wjeroen.wallacast.link;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.TypedValue;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

/**
 * The settings screen: the Spotify switch (off by default), notification access, and what the
 * service sees right now, so a missing player is easy to spot.
 */
public class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private TextView access, players;
    private Button grant;

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

        Switch spotify = new Switch(this);
        spotify.setText("Pause and play Spotify together with Wallacast");
        spotify.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        spotify.setPadding(0, dp(16), 0, dp(8));
        spotify.setChecked(prefs.getBoolean(LinkService.PREF_ENABLED, false));
        spotify.setOnCheckedChangeListener((b, on) -> prefs.edit().putBoolean(LinkService.PREF_ENABLED, on).apply());
        col.addView(spotify);

        access = text(14);
        col.addView(access);
        grant = new Button(this);
        grant.setText("Open notification access");
        grant.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        col.addView(grant);

        players = text(14);
        players.setPadding(0, dp(16), 0, dp(16));
        col.addView(players);

        Switch allChrome = new Switch(this);
        allChrome.setText("Every Chrome player is Wallacast");
        allChrome.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        allChrome.setChecked(prefs.getBoolean(LinkService.PREF_ALL_CHROME, false));
        allChrome.setOnCheckedChangeListener((b, on) -> {
            prefs.edit().putBoolean(LinkService.PREF_ALL_CHROME, on).apply();
            LinkService s = LinkService.instance;
            if (s != null) s.refreshSessions();
        });
        col.addView(allChrome);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        setContentView(scroll);
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
        boolean ok = hasAccess();
        access.setText(ok ? "Notification access: on" : "Notification access: off. Turn it on for Wallacast Link.");
        grant.setVisibility(ok ? Button.GONE : Button.VISIBLE);
        LinkService s = LinkService.instance;
        players.setText(s != null ? s.describe() : (ok ? "Starting…" : ""));
    }

    private TextView text(float sp) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        return t;
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
