import crypto from 'crypto';

// Unguessable per-item audio token. The audio streaming route is unauthenticated (a browser
// <audio> element cannot send a JWT header), so without this, sequential integer content ids
// let anyone enumerate and download every user's generated narration (which for pasted-text
// items is the user's private text spoken aloud). We require ?t=<token> for private article/text
// audio, where token = HMAC-SHA256("audio:<id>") keyed by the server secret. The token is
// DERIVED from the id (never stored), so it needs no migration/backfill and is stable per id.
//
// Podcast-episode audio is exempt: that route proxies already-public CDN audio.

// Same resolution as the JWT secret: a stable value in production (JWT_SECRET is set), a
// per-boot random in dev (audio URLs simply regenerate on restart, which is fine locally).
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

export function audioToken(id: number): string {
  return crypto.createHmac('sha256', SECRET).update(`audio:${id}`).digest('hex').slice(0, 24);
}

// Constant-time comparison so the token cannot be guessed byte-by-byte via timing.
export function verifyAudioToken(id: number, token: string): boolean {
  if (!token) return false;
  const expected = Buffer.from(audioToken(id));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Append the audio token to an item's audio_url for private (article/text) generated audio, so
// the frontend's existing `content.audio_url` playback keeps working with NO frontend change.
// The DB always stores a token-LESS audio_url; the token is added here at serialization time.
// Podcasts (external CDN audio_url) and items without our endpoint URL are returned unchanged.
export function withAudioToken<T extends { id: number; type?: string; audio_url?: string | null }>(item: T): T {
  if (
    (item.type === 'article' || item.type === 'text') &&
    item.audio_url &&
    item.audio_url.includes('/api/content/')
  ) {
    const sep = item.audio_url.includes('?') ? '&' : '?';
    return { ...item, audio_url: `${item.audio_url}${sep}t=${audioToken(item.id)}` };
  }
  return item;
}
