import { contentAPI } from './api';

// Diagnostics for moving on to the next item. Each step goes to the backend, which prints it
// as one [Playback] line in the Railway logs:
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
//   page-hidden, page-visible  the screen went off or on while a chain was still open
// A chain starts at ended, skip, prev or pick, and closes when something plays or the chain
// stops. `ms` is the time since the chain started, so a long gap shows a page the phone kept
// frozen. `at` is the phone's own clock, since a frozen page sends its lines only when it
// runs again.
type Value = string | number | boolean | null | undefined;

let chainStartedAt = 0;

export function logPlayback(event: string, details: Record<string, Value> = {}, closesChain = false): void {
  const now = Date.now();
  if (event === 'ended' || event === 'skip' || event === 'prev' || event === 'pick') chainStartedAt = now;
  const fields: Record<string, Value> = {
    ...details,
    page: document.visibilityState,
    ms: chainStartedAt ? now - chainStartedAt : undefined,
    at: new Date(now).toISOString(),
  };
  if (closesChain) chainStartedAt = 0;
  contentAPI.logPlayback(event, fields).catch(() => { /* diagnostics only */ });
}

// Whether a chain is open: something ended or was skipped, and nothing plays yet
export function playbackChainOpen(): boolean {
  return chainStartedAt > 0;
}

document.addEventListener('visibilitychange', () => {
  if (chainStartedAt) logPlayback(document.visibilityState === 'visible' ? 'page-visible' : 'page-hidden');
});
