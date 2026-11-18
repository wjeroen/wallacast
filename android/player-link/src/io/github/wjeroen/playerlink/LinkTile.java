package io.github.wjeroen.playerlink;

import android.content.SharedPreferences;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * The Player Link tile in the quick settings (the pull-down menu): one tap turns linking on or
 * off, the same switch as the app's first one. Turning it on starts nothing: players tie again
 * once two ticked ones play at the same moment.
 */
public class LinkTile extends TileService {
    private SharedPreferences prefs() {
        return getSharedPreferences(LinkService.PREFS, MODE_PRIVATE);
    }

    @Override
    public void onStartListening() {
        show();
    }

    @Override
    public void onClick() {
        boolean on = !prefs().getBoolean(LinkService.PREF_ENABLED, false);
        prefs().edit().putBoolean(LinkService.PREF_ENABLED, on).apply();
        LinkService s = LinkService.instance;
        if (s != null) s.refreshSessions();
        show();
    }

    private void show() {
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setState(prefs().getBoolean(LinkService.PREF_ENABLED, false) ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.updateTile();
    }
}
