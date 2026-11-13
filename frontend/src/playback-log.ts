import { contentAPI } from './api';

// Diagnostics for moving on to the next item, and for what the phone does to playback while
// the screen is off. Each step goes to the backend, which prints it as one [Playback] line in
// the Railway logs:
//   ended         a track played to its end (or a video ended)
//   skip, prev    the user pressed next or previous
//   pick          the user tapped an item in the Queue tab
//   next          the item picked to open, with where it came from and how long loading it took
//   stop          nothing opens, with the reason
//   asked         the generate-it-now question for a queued item without audio, and the answer
//   passed        a queued video that plays only on YouTube, left out after a track ended
//   playing       the next item started (by=autoplay) or the user pressed Play (by=user)
//   play-refused  the browser (or YouTube) refused to start the next item
//   video-waits   a video reached by autoplay waits for Play (the player is minimized)
//   library-open  the user opened an item from the library while a chain was still open
//   stalled       the audio stopped for lack of data within a minute of its end
//   page-hidden, page-visible  the screen went off or on while a chain was open or the
//                 player had an item, with the player's state (see setPlayerProbe)
//   page-resumed  Chrome let a frozen page run again, `frozen` = for how many seconds
//   video-state   YouTube's player reported a state while the screen was off, or within
//                 15 seconds of it coming back on
//   page-start    the app started, `discarded` = Chrome had thrown the page away before
// A chain starts at ended, skip, prev or pick, and closes when something plays or the chain
// stops. `ms` is the time since the chain started, so a long gap shows a page the phone kept
// frozen. `at` is the phone's own clock, since a frozen page sends its lines only when it
// runs again. A line that fails to send (no connection) waits and goes along with the next
// line that does, so the order stays readable from `at`.
type Value = string | number | boolean | null | undefined;
type Fields = Record<string, Value>;

let chainStartedAt = 0;
const unsent: { event: string; fields: Fields }[] = [];
const MAX_UNSENT = 30;

function send(event: string, fields: Fields): void {
  contentAPI.logPlayback(event, fields)
    .then(() => {
      // The connection works again: the lines that failed before follow, oldest first
      for (const line of unsent.splice(0)) {
        contentAPI.logPlayback(line.event, { ...line.fields, late: true }).catch(() => { /* diagnostics only */ });
      }
    })
    .catch(() => {
      if (unsent.length < MAX_UNSENT) unsent.push({ event, fields });
    });
}

export function logPlayback(event: string, details: Fields = {}, closesChain = false): void {
  const now = Date.now();
  if (event === 'ended' || event === 'skip' || event === 'prev' || event === 'pick') chainStartedAt = now;
  const fields: Fields = {
    ...details,
    page: document.visibilityState,
    ms: chainStartedAt ? now - chainStartedAt : undefined,
    at: new Date(now).toISOString(),
  };
  if (closesChain) chainStartedAt = 0;
  send(event, fields);
}

// Whether a chain is open: something ended or was skipped, and nothing plays yet
export function playbackChainOpen(): boolean {
  return chainStartedAt > 0;
}

// The player's state for the screen lines: which item, whether the app thinks it plays, and
// what YouTube's player says. AudioPlayer registers it. Null when the player has no item.
type PlayerProbe = () => Fields | null;
let playerProbe: PlayerProbe | null = null;
export function setPlayerProbe(probe: PlayerProbe | null): void {
  playerProbe = probe;
}

function logScreen(event: string, extra: Fields = {}): void {
  const player = playerProbe?.() ?? null;
  if (!chainStartedAt && !player) return;
  logPlayback(event, { ...player, ...extra });
}

let visibleSince = 0;
document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible';
  if (visible) visibleSince = Date.now();
  logScreen(visible ? 'page-visible' : 'page-hidden');
});

// Whether YouTube's state reports are worth a line: the screen is off, or it came back on
// less than 15 seconds ago (a pause or resume that the phone or YouTube made by itself)
export function screenRecentlyOff(): boolean {
  return document.visibilityState === 'hidden' || (visibleSince > 0 && Date.now() - visibleSince < 15000);
}

// Chrome's page lifecycle: 'freeze' stops the page's code until 'resume'. A frozen page
// cannot send, so the freeze travels along with the resume line.
let frozenAt = 0;
document.addEventListener('freeze', () => {
  frozenAt = Date.now();
});
document.addEventListener('resume', () => {
  const frozen = frozenAt ? Math.round((Date.now() - frozenAt) / 1000) : undefined;
  frozenAt = 0;
  logScreen('page-resumed', { frozen });
});

// Once per app start, after login
export function logPageStart(): void {
  const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
  logPlayback('page-start', { discarded: !!discarded });
}
