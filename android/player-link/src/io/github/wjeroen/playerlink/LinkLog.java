package io.github.wjeroen.playerlink;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Player Link's event log, to find out afterwards what happened on the phone while nobody
 * watched: what Player Link did, Wallacast's player in Chrome changing state, and the screen
 * going off, on or unlocked. Every event goes to
 *  - a file in the app's own storage (LOG_FILE, and LOG_FILE.1 for the part before it, about
 *    1 MB together), which the Save log button copies to the phone's Downloads folder;
 *  - the Wallacast server, in batches every SEND_MS (POST /api/remote/link-log with the watch
 *    bridge's token), which prints them as [PlayerLink] lines in its log. Without a server or
 *    token nothing is sent, and events wait for the next try, at most MAX_PENDING.
 * One background thread does both, so the service's main thread never waits on a file or the
 * network.
 */
final class LinkLog {
    private static final String LOG_FILE = "player-link-log.txt";
    private static final long MAX_FILE_BYTES = 512 * 1024;
    private static final long SEND_MS = 15_000;
    private static final long RETRY_MS = 60_000;
    private static final int MAX_PENDING = 500;
    private static final int MAX_BATCH = 100;

    private static final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private static final Object lock = new Object();
    private static final ArrayDeque<JSONObject> pending = new ArrayDeque<>();
    private static boolean sendPlanned;

    interface Saved {
        void done(String result);
    }

    private LinkLog() {
    }

    /** Adds an event, stamped now. Safe from any thread. */
    static void add(Context context, String text) {
        long now = System.currentTimeMillis();
        Context app = context.getApplicationContext();
        String line = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.ROOT).format(new Date(now)) + " " + text;
        worker.execute(() -> append(app, line));
        synchronized (lock) {
            try {
                pending.addLast(new JSONObject().put("at", now).put("text", text));
            } catch (Exception ignored) {
                return;
            }
            while (pending.size() > MAX_PENDING) pending.removeFirst();
            if (!sendPlanned) {
                sendPlanned = true;
                worker.schedule(() -> send(app), SEND_MS, TimeUnit.MILLISECONDS);
            }
        }
    }

    private static void append(Context app, String line) {
        try {
            File file = new File(app.getFilesDir(), LOG_FILE);
            if (file.length() > MAX_FILE_BYTES) {
                File older = new File(app.getFilesDir(), LOG_FILE + ".1");
                if (older.exists() && !older.delete()) return;
                if (!file.renameTo(older)) return;
            }
            try (OutputStream out = new FileOutputStream(file, true)) {
                out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            // the server copy may still arrive
        }
    }

    /** Sends the waiting events to the server, a batch at a time, on the worker thread. */
    private static void send(Context app) {
        SharedPreferences prefs = app.getSharedPreferences(LinkService.PREFS, Context.MODE_PRIVATE);
        String server = prefs.getString(LinkService.PREF_SERVER, "");
        String token = prefs.getString(LinkService.PREF_TOKEN, "");
        List<JSONObject> batch = new ArrayList<>();
        synchronized (lock) {
            if (server.isEmpty() || token.isEmpty() || pending.isEmpty()) {
                // No server: the events stay for a later try, which the next event plans
                sendPlanned = false;
                return;
            }
            for (JSONObject e : pending) {
                if (batch.size() >= MAX_BATCH) break;
                batch.add(e);
            }
        }
        boolean sent = false;
        try {
            JSONArray events = new JSONArray();
            for (JSONObject e : batch) events.put(e);
            byte[] body = new JSONObject().put("events", events).toString().getBytes(StandardCharsets.UTF_8);
            HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/remote/link-log").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream out = c.getOutputStream()) {
                out.write(body);
            }
            int code = c.getResponseCode();
            c.disconnect();
            sent = code >= 200 && code < 300;
        } catch (Exception ignored) {
            // no connection: the events stay
        }
        synchronized (lock) {
            if (sent) for (int i = 0; i < batch.size() && !pending.isEmpty(); i++) pending.removeFirst();
            if (pending.isEmpty()) {
                sendPlanned = false;
            } else {
                worker.schedule(() -> send(app), sent ? 1000 : RETRY_MS, TimeUnit.MILLISECONDS);
            }
        }
    }

    /** Copies the log to Downloads as player-link-log-<date>-<time>.txt and answers on the
     *  worker thread with the file's name, or why it failed. */
    static void saveToDownloads(Context context, Saved saved) {
        Context app = context.getApplicationContext();
        worker.execute(() -> {
            if (Build.VERSION.SDK_INT < 29) {
                saved.done("Saving needs Android 10 or later");
                return;
            }
            String name = "player-link-log-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date()) + ".txt";
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                ContentResolver resolver = app.getContentResolver();
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new java.io.IOException("Downloads refused the file");
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) throw new java.io.IOException("Downloads refused the file");
                    for (String part : new String[] { LOG_FILE + ".1", LOG_FILE }) {
                        File file = new File(app.getFilesDir(), part);
                        if (!file.exists()) continue;
                        try (InputStream in = new FileInputStream(file)) {
                            byte[] buf = new byte[16384];
                            for (int n = in.read(buf); n > 0; n = in.read(buf)) out.write(buf, 0, n);
                        }
                    }
                }
                saved.done("Saved to Downloads as " + name);
            } catch (Exception e) {
                saved.done("Could not save the log: " + e.getMessage());
            }
        });
    }
}
