import { query } from '../database/db.js';

/**
 * Remote control of the open app's player, for the watch app (android/watch in the repo).
 *
 * The watch cannot reach the phone's browser directly, so the server passes messages between
 * them. The app (an open Wallacast page, a "device") reports what its player is doing with
 * POST /api/remote/state and waits for commands with a long poll, GET /api/remote/commands. The
 * watch, signed in with an API token that has the `remote` permission, reads that state with
 * GET /api/remote/state and sends commands with POST /api/remote/command.
 *
 * Everything lives in memory: one Railway instance serves every request (as the rate limiter
 * assumes), and a lost command after a deploy is harmless. A command goes to the device whose
 * player reported last and waits at most COMMAND_TTL_MS for it: a "play" that only arrives
 * minutes later, because Chrome had put the page to sleep, would be a surprise.
 *
 * The app only polls while the user has a live token with the `remote` permission
 * (remoteEnabled), so other users cost nothing.
 */

export const REMOTE_ACTIONS = ['play', 'pause', 'toggle', 'next', 'previous', 'forward', 'back', 'shuffle', 'speed', 'archive'] as const;
export type RemoteAction = typeof REMOTE_ACTIONS[number];

export interface RemoteCommand {
  id: number;
  action: RemoteAction;
  /** shuffle: true/false (absent: flip), speed: the new rate */
  value?: boolean | number;
  created_at: number;
}

/** What a device's player reports. Every field is optional, the app sends what it knows. */
export interface PlayerState {
  item_id: number | null;
  title: string | null;
  subtitle: string | null;
  type: string | null;
  playing: boolean;
  position: number;
  duration: number;
  speed: number;
  speeds: number[];
  shuffle: boolean;
  is_archived: boolean;
  has_next: boolean;
  has_previous: boolean;
  /** The id of the last command this device carried out */
  last_command: number | null;
}

interface Device {
  state: PlayerState | null;
  stateAt: number;
  polledAt: number;
}

interface Waiter {
  device: string;
  resolve: (commands: RemoteCommand[]) => void;
}

interface UserRemote {
  devices: Map<string, Device>;
  pending: Array<RemoteCommand & { device: string }>;
  waiters: Waiter[];
}

/** A command not picked up within this time is dropped. */
export const COMMAND_TTL_MS = 30_000;
/** A long poll is answered empty after this time, so proxies never cut it. */
export const LONG_POLL_MS = 25_000;
/** A device that has not polled for this long counts as gone (the page closed or slept). */
const DEVICE_ONLINE_MS = LONG_POLL_MS + 15_000;
/** Devices unseen for this long are forgotten. */
const DEVICE_FORGET_MS = 24 * 60 * 60 * 1000;

const users = new Map<number, UserRemote>();
let nextCommandId = 1;

function forUser(userId: number): UserRemote {
  let u = users.get(userId);
  if (!u) {
    u = { devices: new Map(), pending: [], waiters: [] };
    users.set(userId, u);
  }
  return u;
}

function device(u: UserRemote, id: string): Device {
  let d = u.devices.get(id);
  if (!d) {
    d = { state: null, stateAt: 0, polledAt: 0 };
    u.devices.set(id, d);
  }
  return d;
}

function prune(u: UserRemote): void {
  const now = Date.now();
  u.pending = u.pending.filter((c) => now - c.created_at < COMMAND_TTL_MS);
  for (const [id, d] of u.devices) {
    if (now - Math.max(d.polledAt, d.stateAt) > DEVICE_FORGET_MS) u.devices.delete(id);
  }
}

/** A device id from the app: a short random string it keeps per browser. */
export function parseDeviceId(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(raw) ? raw : null;
}

const enabledCache = new Map<number, { value: boolean; at: number }>();
const ENABLED_CACHE_MS = 60_000;

/** True when the user has a live API token with the remote permission. Cached for a minute. */
export async function remoteEnabled(userId: number): Promise<boolean> {
  const cached = enabledCache.get(userId);
  if (cached && Date.now() - cached.at < ENABLED_CACHE_MS) return cached.value;
  const r = await query(
    `SELECT 1 FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND 'remote' = ANY(permissions) LIMIT 1`,
    [userId]
  );
  const value = r.rows.length > 0;
  enabledCache.set(userId, { value, at: Date.now() });
  return value;
}

/** Forget the cached answer, after a token was created, changed or revoked. */
export function forgetRemoteEnabled(userId: number): void {
  enabledCache.delete(userId);
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function text(raw: unknown, max: number): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, max) : null;
}

/** Keep only known fields of a state report, with sane types and lengths. */
export function cleanState(raw: unknown): PlayerState {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const itemId = num(s.item_id, NaN);
  const speeds = Array.isArray(s.speeds) ? s.speeds.filter((v): v is number => typeof v === 'number' && v > 0 && v <= 4).slice(0, 20) : [];
  return {
    item_id: Number.isInteger(itemId) && itemId > 0 ? itemId : null,
    title: text(s.title, 300),
    subtitle: text(s.subtitle, 200),
    type: text(s.type, 30),
    playing: s.playing === true,
    position: Math.max(0, num(s.position, 0)),
    duration: Math.max(0, num(s.duration, 0)),
    speed: num(s.speed, 1),
    speeds,
    shuffle: s.shuffle === true,
    is_archived: s.is_archived === true,
    has_next: s.has_next === true,
    has_previous: s.has_previous === true,
    last_command: Number.isInteger(s.last_command) ? (s.last_command as number) : null,
  };
}

export function reportState(userId: number, deviceId: string, state: PlayerState): void {
  const d = device(forUser(userId), deviceId);
  d.state = state;
  d.stateAt = Date.now();
}

/** The device a command goes to: of the devices that polled recently, the one whose player
 *  reported last. Null when no app is open and listening. */
function targetDevice(u: UserRemote): string | null {
  const now = Date.now();
  let best: { id: string; at: number } | null = null;
  for (const [id, d] of u.devices) {
    if (now - d.polledAt > DEVICE_ONLINE_MS || !d.state) continue;
    if (!best || d.stateAt > best.at) best = { id, at: d.stateAt };
  }
  return best?.id ?? null;
}

/** What the watch shows: the target device's player, whether it is reachable, and how old
 *  the report is. */
export function currentState(userId: number): { online: boolean; age_seconds: number | null; state: PlayerState | null } {
  const u = forUser(userId);
  prune(u);
  const target = targetDevice(u);
  if (target) {
    const d = u.devices.get(target)!;
    return { online: true, age_seconds: Math.round((Date.now() - d.stateAt) / 1000), state: d.state };
  }
  // No app listening: the newest report anywhere, so the watch can still show the title
  let newest: Device | null = null;
  for (const d of u.devices.values()) if (d.state && (!newest || d.stateAt > newest.stateAt)) newest = d;
  return {
    online: false,
    age_seconds: newest ? Math.round((Date.now() - newest.stateAt) / 1000) : null,
    state: newest?.state ?? null,
  };
}

export function parseCommand(raw: unknown): { action: RemoteAction; value?: boolean | number } | { error: string } {
  const b = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const action = b.action;
  if (typeof action !== 'string' || !(REMOTE_ACTIONS as readonly string[]).includes(action)) {
    return { error: `action must be one of ${REMOTE_ACTIONS.join(', ')}` };
  }
  if (action === 'speed') {
    if (typeof b.value !== 'number' || !(b.value > 0 && b.value <= 4)) return { error: 'speed needs a value from 0 to 4' };
    return { action, value: b.value };
  }
  if (action === 'shuffle' && b.value !== undefined) {
    if (typeof b.value !== 'boolean') return { error: 'shuffle takes true, false, or no value to flip it' };
    return { action, value: b.value };
  }
  return { action: action as RemoteAction };
}

/** Queue a command for the open app. Returns it, or null when no app is listening. */
export function sendCommand(userId: number, command: { action: RemoteAction; value?: boolean | number }): RemoteCommand | null {
  const u = forUser(userId);
  prune(u);
  const target = targetDevice(u);
  if (!target) return null;
  const cmd: RemoteCommand = { id: nextCommandId++, ...command, created_at: Date.now() };
  const waiterIndex = u.waiters.findIndex((w) => w.device === target);
  if (waiterIndex >= 0) {
    const [waiter] = u.waiters.splice(waiterIndex, 1);
    waiter.resolve([cmd]);
  } else {
    u.pending.push({ ...cmd, device: target });
  }
  return cmd;
}

/** The app's long poll: commands waiting for this device at once, else the first one that
 *  comes within LONG_POLL_MS, else none. `onClose` lets the route drop the wait when the
 *  request ends early. */
export function waitForCommands(userId: number, deviceId: string, onClose: (cancel: () => void) => void): Promise<RemoteCommand[]> {
  const u = forUser(userId);
  prune(u);
  device(u, deviceId).polledAt = Date.now();
  const mine = u.pending.filter((c) => c.device === deviceId);
  if (mine.length > 0) {
    u.pending = u.pending.filter((c) => c.device !== deviceId);
    return Promise.resolve(mine.map(({ device: _device, ...c }) => c));
  }
  return new Promise((resolve) => {
    // One waiting poll per device: a newer one replaces an older one
    for (const w of u.waiters.filter((w) => w.device === deviceId)) w.resolve([]);
    u.waiters = u.waiters.filter((w) => w.device !== deviceId);
    let done = false;
    const finish = (commands: RemoteCommand[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      u.waiters = u.waiters.filter((w) => w !== waiter);
      device(u, deviceId).polledAt = Date.now();
      resolve(commands);
    };
    const waiter: Waiter = { device: deviceId, resolve: finish };
    const timer = setTimeout(() => finish([]), LONG_POLL_MS);
    u.waiters.push(waiter);
    onClose(() => finish([]));
  });
}
