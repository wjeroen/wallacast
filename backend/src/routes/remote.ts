import express from 'express';
import {
  cleanState,
  currentState,
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
 *   POST /api/remote/command           { action, value? } for the player (the watch)
 *   GET  /api/remote/fallback?playing=  Player Link's long poll, while the page may sleep
 * Tokens reach only the last three (TOKEN_ROUTES in services/api-tokens.ts).
 */
const router = express.Router();

router.get('/commands', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const deviceId = parseDeviceId(req.query.device);
    if (!deviceId) return res.status(400).json({ error: 'device must be 6 to 64 letters, digits, - or _' });
    if (!(await remoteEnabled(userId))) return res.json({ enabled: false, commands: [] });
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
  const sent = sendCommand(req.user!.userId, parsed);
  if (sent === 'asleep') {
    return res.status(409).json({ code: 'asleep', error: 'Wallacast is asleep on the phone. Press play first.' });
  }
  if (!sent) {
    return res.status(409).json({ code: 'closed', error: 'No open Wallacast app is listening. Open Wallacast on your phone.' });
  }
  console.log(`[Remote] user=${req.user!.userId} ${req.apiToken ? `token=${req.apiToken.id} ` : ''}command ${sent.id} ${sent.action}${sent.value !== undefined ? `=${sent.value}` : ''}`);
  res.status(202).json({ id: sent.id, action: sent.action });
});

// Player Link's long poll (android/player-link). `playing` is what it sees of Wallacast's player in
// Chrome: true, false, or none when there is none (then nothing is sent to it).
router.get('/fallback', async (req, res) => {
  try {
    const raw = req.query.playing;
    const playing = raw === 'true' ? true : raw === 'false' ? false : null;
    const commands = await waitAsFallback(req.user!.userId, playing, (cancel) => res.on('close', cancel));
    if (!res.headersSent && !res.writableEnded) res.json({ commands });
  } catch (error) {
    console.error('[Remote] fallback poll failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Remote fallback poll failed' });
  }
});

export default router;
