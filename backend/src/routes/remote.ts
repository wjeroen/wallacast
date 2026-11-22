import express from 'express';
import {
  cleanState,
  currentState,
  hasState,
  parseCommand,
  parseDeviceId,
  remoteEnabled,
  reportState,
  sendCommand,
  waitAsFallback,
  waitForCommands,
} from '../services/remote-control.js';

/**
 * Remote control of the open app's player (services/remote-control.ts explains the flow).
 *   GET  /api/remote/commands?device=  the app's long poll for commands (app sessions only)
 *   POST /api/remote/state             the app reports its player { device, state } (app sessions only)
 *   GET  /api/remote/state             what the player is doing (the watch, a token with `remote`)
 *   POST /api/remote/command           { action, value?, item_id? } for the player (the watch)
 *   GET  /api/remote/fallback?playing=  Player Link's long poll, while the page may sleep
 *   POST /api/remote/link-log           Player Link's event log, printed as [PlayerLink] lines
 * Tokens reach only the last four (TOKEN_ROUTES in services/api-tokens.ts).
 */
const router = express.Router();

router.get('/commands', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const deviceId = parseDeviceId(req.query.device);
    if (!deviceId) return res.status(400).json({ error: 'device must be 6 to 64 letters, digits, - or _' });
    if (!(await remoteEnabled(userId))) return res.json({ enabled: false, commands: [] });
    // The server does not know this page's player (a deploy emptied its memory): report it first
    if (!hasState(userId, deviceId)) return res.json({ enabled: true, commands: [], report: true });
    // res, not req: a request's own 'close' fires as soon as its (empty) body was read
    const commands = await waitForCommands(userId, deviceId, (cancel) => res.on('close', cancel));
    if (!res.headersSent && !res.writableEnded) res.json({ enabled: true, commands });
  } catch (error) {
    console.error('[Remote] command poll failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Remote command poll failed' });
  }
});

router.post('/state', (req, res) => {
  const deviceId = parseDeviceId(req.body?.device);
  if (!deviceId) return res.status(400).json({ error: 'device must be 6 to 64 letters, digits, - or _' });
  reportState(req.user!.userId, deviceId, cleanState(req.body?.state));
  res.json({ ok: true });
});

router.get('/state', (req, res) => {
  res.json(currentState(req.user!.userId));
});

router.post('/command', (req, res) => {
  const parsed = parseCommand(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  if ((parsed.action === 'archive' || parsed.action === 'unarchive') && req.apiToken && !req.apiToken.permissions.includes('archive')) {
    return res.status(403).json({ error: 'This token needs the archive permission to archive' });
  }
  if ((parsed.action === 'star' || parsed.action === 'unstar') && req.apiToken && !req.apiToken.permissions.includes('star')) {
    return res.status(403).json({ error: 'This token needs the star permission to star' });
  }
  const sent = sendCommand(req.user!.userId, parsed);
  if (sent === 'asleep') {
    return res.status(409).json({ code: 'asleep', error: 'Wallacast is asleep on the phone. Press play first.' });
  }
  if (!sent) {
    return res.status(409).json({ code: 'closed', error: 'No open Wallacast app is listening. Open Wallacast on your phone.' });
  }
  console.log(`[Remote] user=${req.user!.userId} ${req.apiToken ? `token=${req.apiToken.id} ` : ''}command ${sent.id} ${sent.action}${sent.value !== undefined ? `=${sent.value}` : ''}${sent.item_id !== undefined ? ` item=${sent.item_id}` : ''}`);
  res.status(202).json({ id: sent.id, action: sent.action });
});

// Player Link's event log (android/player-link LinkLog.java): what it did, Wallacast's player
// in Chrome changing state, and the screen going off, on or unlocked, sent in batches, so the
// [PlayerLink] lines show what happened on the phone while nobody watched. At most 100 events
// per request, each cut to 300 characters, `at` the phone's clock in ms.
router.post('/link-log', (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [];
  for (const e of events) {
    const at = typeof e?.at === 'number' && Number.isFinite(e.at) ? new Date(e.at).toISOString() : '?';
    const text = typeof e?.text === 'string' ? e.text.replace(/\s+/g, ' ').slice(0, 300) : '';
    if (text) console.log(`[PlayerLink] user=${req.user!.userId} at=${at} ${text}`);
  }
  res.status(204).end();
});

// Player Link's long poll (android/player-link). `playing` is what it sees of Wallacast's player in
// Chrome: true, false, closed (there is none, but a play opens Wallacast), or none (nothing is
// sent to it).
router.get('/fallback', async (req, res) => {
  try {
    const raw = req.query.playing;
    const seen = raw === 'true' ? 'playing' : raw === 'false' ? 'paused' : raw === 'closed' ? 'closed' : null;
    const commands = await waitAsFallback(req.user!.userId, seen, (cancel) => res.on('close', cancel));
    if (!res.headersSent && !res.writableEnded) res.json({ commands });
  } catch (error) {
    console.error('[Remote] fallback poll failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Remote fallback poll failed' });
  }
});

export default router;
