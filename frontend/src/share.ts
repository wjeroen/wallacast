// Links shared to Wallacast from another app through the Android share menu (see
// takeSharedContent in App.tsx). Android can hand the same share over again, for example when
// the app is opened again from the recent apps or the back button leads to it. The last link
// saved from a share is kept for 10 minutes, and the same link arriving again in that time is
// ignored, so the app just opens instead of saving a copy.

const LAST_SHARE_KEY = 'wallacast-last-share';
const SHARE_REPEAT_MS = 10 * 60 * 1000;

export function rememberShare(link: string) {
  try { localStorage.setItem(LAST_SHARE_KEY, JSON.stringify({ link, at: Date.now() })); } catch { /* private mode */ }
}

export function isRepeatedShare(link: string): boolean {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_SHARE_KEY) || 'null');
    return !!last && last.link === link && Date.now() - last.at < SHARE_REPEAT_MS;
  } catch {
    return false;
  }
}
