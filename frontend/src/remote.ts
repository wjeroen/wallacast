import { remoteAPI, type RemoteCommand } from './api';

/**
 * Remote control of this app's player by the watch app, through the server (backend
 * services/remote-control.ts). While the user has an API token with the "Control playback"
 * permission, this page waits for commands with a long poll and reports what its player does.
 * Without such a token the server answers at once with enabled false, and the page asks again
 * only every 5 minutes, or at once after pokeRemote() (Settings calls it when a token changes).
 *
 * AudioPlayer registers the handlers: run() carries out a command, state() describes the
 * player (null when no item is open). While no player is open, App's idle handlers answer
 * instead: they describe the last item (loaded false) and a play loads it into the mini
 * player and plays it, as Spotify continues its last song. remoteStateChanged() sends a fresh report, a moment
 * later so a burst of changes becomes one report.
 *
 * Each report says whether the page is hidden: Android gives a page in the background no turn
 * to play sound, so the server then sends a play to Player Link, which brings Wallacast to
 * the front if needed. A play that comes while hidden is tried, and tried again when the page
 * comes to the front within PLAY_WHEN_SHOWN_MS. Coming to the front also ends a waiting pause,
 * so a waiting command arrives at once. When the server answers `report` (a deploy emptied
 * its memory), the page reports its player before it waits for commands.
 */

export interface RemoteHandlers {
  run: (command: RemoteCommand) => Promise<void> | void;
  state: () => Record<string, unknown> | null;
}

const DISABLED_RECHECK_MS = 5 * 60 * 1000;
const REPORT_DELAY_MS = 400;
const PLAY_WHEN_SHOWN_MS = 30_000;

let handlers: RemoteHandlers | null = null;
let idle: RemoteHandlers | null = null;
const active = () => handlers ?? idle;
let enabled = false;
let loop = 0; // the running loop's number, 0 while stopped
let lastCommand: number | null = null;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let wake: (() => void) | null = null;
let device: string | null = null;
let playWhenShownUntil = 0;

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function deviceId(): string {
  if (device) return device;
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    device = localStorage.getItem('wallacast-remote-device') || fresh;
    localStorage.setItem('wallacast-remote-device', device);
  } catch {
    device = fresh;
  }
  return device;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

async function sendReportNow(): Promise<void> {
  const state = active()?.state() ?? { item_id: null, playing: false };
  await remoteAPI.reportState(deviceId(), { ...state, hidden: pageHidden(), last_command: lastCommand });
}

function sendReport(): void {
  if (!enabled) return;
  sendReportNow().catch(() => { /* the next report retries */ });
}

/** Report the player's state soon. Does nothing while remote control is off. */
export function remoteStateChanged(): void {
  if (!enabled) return;
  if (reportTimer) clearTimeout(reportTimer);
  reportTimer = setTimeout(() => { reportTimer = null; sendReport(); }, REPORT_DELAY_MS);
}

export function setRemoteHandlers(next: RemoteHandlers | null): void {
  handlers = next;
  remoteStateChanged();
}

/** What answers while no player is open (App: the last item). */
export function setRemoteIdle(next: RemoteHandlers | null): void {
  idle = next;
  remoteStateChanged();
}

/** Ask the server again at once whether remote control is on (after a token change). */
export function pokeRemote(): void {
  wake?.();
}

/** Start waiting for commands. Returns the stop function. */
export function startRemote(): () => void {
  const mine = ++loop;
  const running = () => loop === mine;
  const onVisibility = () => {
    remoteStateChanged();
    if (pageHidden()) return;
    wake?.();
    if (Date.now() < playWhenShownUntil) {
      playWhenShownUntil = 0;
      void active()?.run({ id: 0, action: 'play' });
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  void (async () => {
    let failures = 0;
    while (running()) {
      try {
        const askedAt = Date.now();
        const res = await remoteAPI.commands(deviceId());
        if (!running()) break;
        if (res.data.enabled && res.data.report) {
          enabled = true;
          await sendReportNow();
          failures = 0;
          continue;
        }
        // An empty answer should take about 25 seconds. A quick one means something cut the
        // wait short, so pause instead of asking again in a tight loop.
        if (res.data.enabled && res.data.commands.length === 0 && Date.now() - askedAt < 2000) {
          await pause(10_000);
        }
        failures = 0;
        const wasEnabled = enabled;
        enabled = res.data.enabled;
        if (!enabled) {
          await pause(DISABLED_RECHECK_MS);
          continue;
        }
        if (!wasEnabled) sendReport();
        for (const command of res.data.commands) {
          const startsPlay = command.action === 'play' || (command.action === 'toggle' && active()?.state()?.playing !== true);
          playWhenShownUntil = startsPlay && pageHidden() ? Date.now() + PLAY_WHEN_SHOWN_MS : 0;
          try {
            await active()?.run(command);
          } catch (error) {
            console.error('[Remote] command failed:', command, error);
          }
          lastCommand = command.id;
        }
        if (res.data.commands.length > 0) remoteStateChanged();
      } catch {
        // Offline, a deploy, or a 401 the API client could not renew: wait, longer each time
        failures++;
        await pause(Math.min(60_000, 5_000 * failures));
      }
    }
  })();
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    if (!running()) return;
    loop = 0;
    enabled = false;
    wake?.();
  };
}
