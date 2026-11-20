// Checks for API tokens without a database: the route list and permissions
// (services/api-tokens.ts), the validators, and how generation minutes are estimated
// (services/token-limits.ts). The routes themselves were run end to end against the real
// backend on an in-memory database during development, see ARCHITECTURE.md.
// Run from backend/:  npx tsx scripts/test-api-tokens.mts
import assert from 'node:assert/strict';

const {
  tokenRouteDecision, validatePermissions, parsePermissions, DEFAULT_PERMISSIONS,
  generateApiToken, isApiToken, hashApiToken,
} = await import('../src/services/api-tokens.ts');
const {
  effectiveLimits, validateLimits, DEFAULT_LIMITS, MAX_LIMITS, parseGeneration, validateGeneration,
  textMinutes, summaryMinutes, commentChars, episodeMinutes, CHARS_PER_MINUTE, UNKNOWN_EPISODE_MINUTES,
} = await import('../src/services/token-limits.ts');
const { parseHttpUrl, parsePositiveInt } = await import('../src/services/token-actions.ts');

const allowed = (perms: readonly string[], m: string, p: string) => tokenRouteDecision(perms as any, m, p).allowed;

// ---- 1. a token with the default permissions reads the library and nothing else ----------
const readOnly = DEFAULT_PERMISSIONS;
assert.deepEqual(readOnly, ['read_library']);
for (const [m, p] of [
  ['GET', '/api/content/index'],
  ['GET', '/api/content/index?x=1'],
  ['GET', '/api/content/index/'],
  ['GET', '/api/content/markdown?url=https%3A%2F%2Fa.b%2Fc'],
  ['GET', '/api/content/123/markdown'],
  ['HEAD', '/api/content/index'],
  ['GET', '/api/content/tags/all'],
  ['GET', '/api/content/summaries?ids=1,2'],
  ['GET', '/api/auth/token'],
]) assert.ok(allowed(readOnly, m, p), `${m} ${p} must be allowed for a read-only token`);
for (const [m, p] of [
  ['GET', '/api/content'],
  ['GET', '/api/content/123'],
  ['GET', '/api/content/123/export'],
  ['GET', '/api/content/abc/markdown'],
  ['GET', '/api/content/123/markdown/x'],
  ['GET', '/api/users/settings'],
  ['GET', '/api/users/settings/openai_api_key'],
  ['GET', '/api/auth/tokens'],
  ['GET', '/api/auth/me'],
  ['GET', '/api/wallabag/status'],
  ['GET', '/api/queue'],
  ['POST', '/api/content/index'],
  ['POST', '/api/content/status'],
  ['POST', '/api/content'],
  ['POST', '/api/content/bulk'],
  ['GET', '/api/content/preview'],
  ['GET', '/api/podcasts/feed-items'],
  ['POST', '/api/podcasts/refresh-feeds'],
  ['DELETE', '/api/content/123'],
  ['PATCH', '/api/content/123'],
  ['PATCH', '/api/auth/tokens/1'],
  ['GET', ''],
]) assert.ok(!allowed(readOnly, m, p), `${m} ${p} must be denied for a read-only token`);
console.log('✅ the default permissions read the library and nothing else');

// ---- 2. every permission opens exactly its own routes ------------------------------------
const all = ['read_library', 'feed', 'add_any', 'tag', 'star', 'archive', 'subscribe', 'remote'];
assert.ok(allowed(['feed'], 'GET', '/api/podcasts'));
assert.ok(allowed(['feed'], 'GET', '/api/podcasts/feed-items?limit=50'));
assert.ok(allowed(['feed'], 'GET', '/api/podcasts/refresh-status'));
assert.ok(allowed(['feed'], 'POST', '/api/podcasts/refresh-feeds'));
assert.ok(!allowed(['feed'], 'GET', '/api/podcasts/12/preview-episodes'), 'other podcast routes stay closed');
assert.ok(!allowed(['feed'], 'POST', '/api/podcasts/subscribe'));
assert.ok(!allowed(['feed'], 'DELETE', '/api/podcasts/12'));
assert.ok(!allowed(['feed'], 'GET', '/api/content/index'), 'feed alone does not read the library');
assert.ok(!allowed(['feed', 'add_any', 'tag', 'star'], 'GET', '/api/content/summaries?ids=1'), 'summaries need read_library');
for (const add of ['add_any', 'add_feed']) {
  assert.ok(allowed([add], 'POST', '/api/content'));
  assert.ok(allowed([add], 'GET', '/api/content/preview?url=x'));
  assert.ok(!allowed([add], 'POST', '/api/content/12/refetch'));
  assert.ok(!allowed([add], 'POST', '/api/content/12/generate-audio'));
}
assert.ok(allowed(['tag'], 'POST', '/api/content/bulk') && allowed(['star'], 'POST', '/api/content/bulk'));
assert.ok(allowed(['tag'], 'GET', '/api/content/tags/all'), 'tagging needs the tag list');
assert.ok(allowed(['archive'], 'POST', '/api/content/bulk'), 'archive uses the bulk route');
assert.ok(!allowed(['archive'], 'PATCH', '/api/content/5'), 'archive never opens the item PATCH');
assert.ok(allowed(['subscribe'], 'POST', '/api/podcasts/subscribe'));
assert.ok(allowed(['subscribe'], 'DELETE', '/api/podcasts/12'));
assert.ok(allowed(['subscribe'], 'GET', '/api/podcasts'), 'unsubscribing needs the feed list');
assert.ok(!allowed(['subscribe'], 'DELETE', '/api/podcasts/abc'));
assert.ok(!allowed(['subscribe'], 'GET', '/api/podcasts/feed-items'), 'subscribe alone does not read the feed');
assert.ok(!allowed(['subscribe'], 'GET', '/api/podcasts/search?q=x'));
assert.ok(allowed(['remote'], 'GET', '/api/remote/state'));
assert.ok(allowed(['remote'], 'POST', '/api/remote/command'));
assert.ok(allowed(['remote'], 'GET', '/api/remote/fallback?playing=false'), 'Player Link polls with a remote token');
// Refetch and the generate permissions each open their own route only
assert.ok(allowed(['refetch'], 'POST', '/api/content/12/refetch'));
assert.ok(!allowed(['add_any'], 'POST', '/api/content/12/refetch'), 'adding is not refetching');
assert.ok(allowed(['generate_audio'], 'POST', '/api/content/12/generate-audio'));
assert.ok(!allowed(['generate_summary'], 'POST', '/api/content/12/generate-audio'));
assert.ok(allowed(['generate_summary'], 'POST', '/api/content/12/generate-summary'));
assert.ok(allowed(['generate_summary_audio'], 'POST', '/api/content/12/generate-summary-audio'));
assert.ok(!allowed(['generate_summary'], 'POST', '/api/content/12/generate-summary-audio'));
assert.ok(allowed(['generate_transcript'], 'POST', '/api/transcription/content/12'));
assert.ok(!allowed(['generate_transcript'], 'POST', '/api/content/12/cancel-generation'), 'cancelling stays app-only');
assert.ok(!allowed(['remote'], 'GET', '/api/content/index'), 'remote alone does not read the library');
for (const [m, p] of [
  ['POST', '/api/content/tags/rename'],
  ['POST', '/api/content/tags/remove'],
  ['PATCH', '/api/content/5'],
  ['DELETE', '/api/content/5'],
  ['GET', '/api/users/settings'],
  ['POST', '/api/auth/tokens'],
  ['DELETE', '/api/auth/tokens/1'],
  ['POST', '/api/auth/tokens/1/changes/undo'],
  ['GET', '/api/content/markdown-zip?ids=1'],
  ['GET', '/api/remote/commands?device=abcdef'],
  ['POST', '/api/remote/state'],
  ['DELETE', '/api/content/5'],
  ['DELETE', '/api/queue/5'],
]) assert.ok(!allowed(all, m, p), `${m} ${p} must stay closed for every token`);
assert.match(
  (tokenRouteDecision(['read_library'], 'POST', '/api/content') as any).error,
  /add_any or add_feed/,
  'a missing permission is named'
);
assert.match((tokenRouteDecision(all as any, 'GET', '/api/users/settings') as any).error, /cannot use this route/);
console.log('✅ every permission opens exactly its own routes, rename, delete, settings and token management never');

// ---- 3. validators ---------------------------------------------------------------------------
assert.deepEqual(validatePermissions(['star', 'read_library', 'star']), { permissions: ['read_library', 'star'] }, 'canonical order, no duplicates');
assert.ok('error' in validatePermissions(['add_any', 'add_feed']), 'add_any and add_feed exclude each other');
assert.ok('error' in validatePermissions(['admin']));
assert.ok('error' in validatePermissions('read_library'));
assert.deepEqual(parsePermissions(['read_library', 'bogus', 'feed']), ['read_library', 'feed']);
assert.deepEqual(parsePermissions(null), []);

assert.deepEqual(effectiveLimits({}), DEFAULT_LIMITS);
assert.deepEqual(effectiveLimits({ items_hour: 7, minutes_2d: 99999 }), { ...DEFAULT_LIMITS, items_hour: 7, generations_hour: 21 }, 'an out-of-range stored value falls back');
// Generation limits: 20 and 100 for a new token, three per item for limits saved before they existed
assert.equal(DEFAULT_LIMITS.generations_hour, 20);
assert.equal(DEFAULT_LIMITS.generations_2d, 100);
assert.deepEqual(
  [effectiveLimits({ items_hour: 40, items_2d: 100 }).generations_hour, effectiveLimits({ items_hour: 40, items_2d: 100 }).generations_2d],
  [120, 300],
  'the AI Radio token (40 and 100 items) keeps room for its 68 generations an hour'
);
assert.equal(effectiveLimits({ items_hour: 400, generations_hour: 30 }).generations_hour, 30, 'a saved generation limit is kept');
assert.equal(effectiveLimits({ items_hour: 400 }).generations_hour, 500, 'capped at the maximum');
assert.deepEqual(validateLimits({ items_hour: 0 }, DEFAULT_LIMITS), { limits: { ...DEFAULT_LIMITS, items_hour: 0 } }, '0 is allowed: no adds at all');
assert.deepEqual(validateLimits({ items_hour: MAX_LIMITS.items_hour }, DEFAULT_LIMITS), { limits: { ...DEFAULT_LIMITS, items_hour: 500 } });
for (const bad of [{ items_hour: 501 }, { items_hour: -1 }, { items_hour: 1.5 }, { items_hour: '5' }, { foo: 1 }, [], null]) {
  assert.ok('error' in validateLimits(bad, DEFAULT_LIMITS), `limits ${JSON.stringify(bad)} refused`);
}
assert.deepEqual(MAX_LIMITS, { items_hour: 500, items_2d: 5000, minutes_hour: 2000, minutes_2d: 10000, generations_hour: 500, generations_2d: 5000, subscriptions_hour: 100 });
assert.equal(DEFAULT_LIMITS.subscriptions_hour, 10);
assert.equal(effectiveLimits({ items_hour: 7 }).subscriptions_hour, 10, 'a token saved before the subscription limit gets the default');
assert.ok('error' in validateLimits({ subscriptions_hour: 101 }, DEFAULT_LIMITS));
assert.deepEqual(validateLimits({ subscriptions_hour: 0 }, DEFAULT_LIMITS), { limits: { ...DEFAULT_LIMITS, subscriptions_hour: 0 } });

assert.deepEqual(parseGeneration(undefined), { follow: true, audio: false, transcribe: false, transcribe_video: false, summary: false, summary_on_transcript: false, summary_audio: false });
// A token saved before videos had their own switch keeps one transcript switch for both
assert.equal(parseGeneration({ follow: false, transcribe: true }).transcribe_video, true);
assert.equal(parseGeneration({ follow: false, transcribe: true, transcribe_video: false }).transcribe_video, false);
assert.equal(parseGeneration({ follow: false }).follow, false);
assert.deepEqual(
  validateGeneration({ follow: false, summary: true }, parseGeneration({})),
  { generation: { follow: false, audio: false, transcribe: false, transcribe_video: false, summary: true, summary_on_transcript: false, summary_audio: false } }
);
assert.ok('error' in validateGeneration({ audio: 'yes' }, parseGeneration({})));
assert.ok('error' in validateGeneration({ video: true }, parseGeneration({})));
console.log('✅ permission, limit and generation validators');

// ---- 4. minutes and small parsers -----------------------------------------------------------
assert.equal(textMinutes(0), 1, 'a generation counts at least a minute');
assert.equal(textMinutes(CHARS_PER_MINUTE), 1);
assert.equal(textMinutes(CHARS_PER_MINUTE + 1), 2);
assert.equal(textMinutes(27634), 31, 'the 27,634-character article from the production log is about 31 minutes');
assert.equal(summaryMinutes(27634), 4, 'its summary counts a tenth, rounded up');
assert.equal(summaryMinutes(99000), 11, "Zvi's AI #189 (110 minutes of narration) counts 11 for its summary");
assert.equal(summaryMinutes(0), 1, 'a summary counts at least a minute');
assert.equal(commentChars(JSON.stringify([{ content: '<p>abc</p>', replies: [{ content: 'de' }] }, { content: 'f' }])), 6);
assert.equal(commentChars('not json'), 0);
assert.equal(commentChars(null), 0);
assert.equal(episodeMinutes(3600), 60);
assert.equal(episodeMinutes(61), 2);
assert.equal(episodeMinutes(null), UNKNOWN_EPISODE_MINUTES);
assert.equal(parseHttpUrl('https://a.b/c?d=1'), 'https://a.b/c?d=1');
assert.equal(parseHttpUrl('javascript:alert(1)'), null);
assert.equal(parseHttpUrl('file:///etc/passwd'), null);
assert.equal(parseHttpUrl('not a url'), null);
assert.equal(parsePositiveInt('12'), 12);
assert.equal(parsePositiveInt(12), 12);
assert.equal(parsePositiveInt('1.5'), null);
assert.equal(parsePositiveInt(0), null);
assert.equal(parsePositiveInt('12abc'), null);
console.log('✅ minutes estimates and parsers');

// ---- 5. token format --------------------------------------------------------------------------
const tok = generateApiToken();
assert.match(tok, /^wcr_[0-9a-f]{40}$/, 'token format');
assert.ok(isApiToken(tok) && !isApiToken('eyJhbGciOiJIUzI1NiJ9.x.y'), 'token vs JWT detection');
assert.match(hashApiToken(tok), /^[0-9a-f]{64}$/, 'sha256 hex');
assert.notEqual(generateApiToken(), tok, 'random');
console.log('✅ token format');

// ---- 6. remote control (in memory, services/remote-control.ts) ---------------------------------
const remote = await import('../src/services/remote-control.ts');
assert.deepEqual(remote.parseCommand({ action: 'speed', value: 1.5 }), { action: 'speed', value: 1.5 });
assert.ok('error' in remote.parseCommand({ action: 'speed' }), 'speed needs a value');
assert.ok('error' in remote.parseCommand({ action: 'speed', value: 9 }));
assert.deepEqual(remote.parseCommand({ action: 'shuffle' }), { action: 'shuffle' }, 'shuffle without a value flips');
assert.ok('error' in remote.parseCommand({ action: 'shuffle', value: 'yes' }));
assert.ok('error' in remote.parseCommand({ action: 'delete' }), 'unknown actions are refused');
assert.equal(remote.parseDeviceId('abc'), null);
assert.equal(remote.parseDeviceId('a1b2c3d4'), 'a1b2c3d4');
assert.equal(remote.parseDeviceId('../etc'), null);
const cleaned = remote.cleanState({ item_id: 5, title: 'x'.repeat(400), playing: true, speed: 1.5, speeds: [1, 'x', 9, 2], evil: 'y' });
assert.equal(cleaned.item_id, 5);
assert.equal(cleaned.title!.length, 300, 'titles are cut');
assert.deepEqual(cleaned.speeds, [1, 2], 'only real speeds are kept');
assert.ok(!('evil' in cleaned), 'unknown fields are dropped');

const USER = 999_001;
assert.equal(remote.sendCommand(USER, { action: 'play' }), null, 'no app listening: nothing is sent');
assert.equal(remote.currentState(USER).online, false);
// An app polls and reports, then a command reaches its waiting poll
let cancelPoll: (() => void) | undefined;
const waiting = remote.waitForCommands(USER, 'phone-1', (cancel) => { cancelPoll = cancel; });
remote.reportState(USER, 'phone-1', remote.cleanState({ item_id: 7, playing: false }));
assert.equal(remote.currentState(USER).online, true);
assert.equal(remote.currentState(USER).state!.item_id, 7);
const sent = remote.sendCommand(USER, { action: 'play' });
assert.ok(sent && sent.action === 'play');
const got = await waiting;
assert.deepEqual(got.map((c) => c.action), ['play'], 'the waiting poll gets the command at once');
// A command sent between two polls waits for the next poll
const queued = remote.sendCommand(USER, { action: 'next' });
assert.ok(queued);
const next = await remote.waitForCommands(USER, 'phone-1', () => {});
assert.deepEqual(next.map((c) => c.action), ['next']);
// The device that reported last gets the command
const w1 = remote.waitForCommands(USER, 'phone-1', (cancel) => { cancelPoll = cancel; });
const w2 = remote.waitForCommands(USER, 'laptop-1', () => {});
remote.reportState(USER, 'laptop-1', remote.cleanState({ item_id: 8, playing: true }));
remote.sendCommand(USER, { action: 'pause' });
assert.deepEqual((await w2).map((c) => c.action), ['pause'], 'the newest player is the target');
cancelPoll!();
assert.deepEqual(await w1, [], 'a cancelled poll ends empty');
assert.deepEqual(remote.parseCommand({ action: 'unarchive' }), { action: 'unarchive' });
assert.deepEqual(remote.parseCommand({ action: 'star' }), { action: 'star' });

// The page sleeps: only Player Link listens, and takes play, pause and the skips
const SLEEPY = 999_002;
remote.reportState(SLEEPY, 'phone-9', remote.cleanState({ item_id: 3, title: 'Old', playing: false }));
let cancelLink: (() => void) | undefined;
const linkPoll = remote.waitAsFallback(SLEEPY, 'paused', (cancel) => { cancelLink = cancel; });
const sleepy = remote.currentState(SLEEPY);
assert.equal(sleepy.mode, 'link', 'Link stands in for the sleeping page');
assert.equal(sleepy.online, true);
assert.equal(sleepy.state!.title, 'Old', 'the last known title stays');
assert.equal(remote.sendCommand(SLEEPY, { action: 'next' }), 'asleep', 'Link cannot go to the next item');
assert.equal(remote.sendCommand(SLEEPY, { action: 'archive' }), 'asleep');
const play = remote.sendCommand(SLEEPY, { action: 'play' });
assert.ok(play && play !== 'asleep');
assert.deepEqual((await linkPoll).map((c) => c.action), ['play'], 'Link gets the play');
// Once the page polls again, commands go to the page, not to Link
const linkPoll2 = remote.waitAsFallback(SLEEPY, 'playing', (cancel) => { cancelLink = cancel; });
const pagePoll = remote.waitForCommands(SLEEPY, 'phone-9', () => {});
remote.reportState(SLEEPY, 'phone-9', remote.cleanState({ item_id: 3, playing: true }));
assert.equal(remote.currentState(SLEEPY).mode, 'app');
remote.sendCommand(SLEEPY, { action: 'next' });
assert.deepEqual((await pagePoll).map((c) => c.action), ['next']);
cancelLink!();
assert.deepEqual(await linkPoll2, []);

// Chrome dropped the player: Link opens Wallacast on a play, and the play waits for the page
const CLOSED = 999_003;
remote.reportState(CLOSED, 'phone-7', remote.cleanState({ item_id: 5, title: 'Paused long ago', playing: false }));
const openPoll = remote.waitAsFallback(CLOSED, 'closed', () => {});
const closed = remote.currentState(CLOSED);
assert.equal(closed.mode, 'open', 'Link can open Wallacast');
assert.equal(closed.state!.title, 'Paused long ago');
assert.equal(closed.state!.playing, false);
assert.equal(remote.sendCommand(CLOSED, { action: 'pause' }), 'asleep', 'nothing to pause');
assert.equal(remote.sendCommand(CLOSED, { action: 'forward' }), 'asleep', 'nothing to skip');
assert.ok(remote.sendCommand(CLOSED, { action: 'toggle' }), 'a toggle opens it too');
assert.deepEqual((await openPoll).map((c) => c.action), ['play'], 'Link gets a play, which opens Wallacast');
assert.deepEqual((await remote.waitForCommands(CLOSED, 'phone-7', () => {})).map((c) => c.action), ['play'], 'the opened page finds the play');

// A page in the background gets no turn to play sound: a play goes to Player Link instead
const HIDDEN = 999_004;
assert.equal(remote.hasState(HIDDEN, 'phone-5'), false, 'a fresh server asks the page to report');
remote.reportState(HIDDEN, 'phone-5', remote.cleanState({ item_id: 8, playing: false, hidden: true }));
assert.equal(remote.hasState(HIDDEN, 'phone-5'), true);
const hiddenPage = remote.waitForCommands(HIDDEN, 'phone-5', () => {});
const hiddenLink = remote.waitAsFallback(HIDDEN, 'paused', () => {});
assert.equal(remote.currentState(HIDDEN).mode, 'app');
remote.sendCommand(HIDDEN, { action: 'toggle' });
assert.deepEqual((await hiddenLink).map((c) => c.action), ['play'], 'Player Link presses play for a hidden page');
remote.sendCommand(HIDDEN, { action: 'next' });
assert.deepEqual((await hiddenPage).map((c) => c.action), ['next'], 'other commands still go to the page');
const hiddenPage2 = remote.waitForCommands(HIDDEN, 'phone-5', () => {});
const hiddenLink2 = remote.waitAsFallback(HIDDEN, 'closed', () => {});
remote.sendCommand(HIDDEN, { action: 'play' });
assert.deepEqual((await hiddenLink2).map((c) => c.action), ['play'], 'without Chrome\'s player, Player Link brings Wallacast to the front');
assert.deepEqual((await hiddenPage2).map((c) => c.action), ['play'], 'and the page plays once it is in front');
remote.reportState(HIDDEN, 'phone-5', remote.cleanState({ item_id: 8, playing: false, hidden: false }));
const shownPage = remote.waitForCommands(HIDDEN, 'phone-5', () => {});
remote.sendCommand(HIDDEN, { action: 'play' });
assert.deepEqual((await shownPage).map((c) => c.action), ['play'], 'a page in front plays itself');
console.log('✅ remote control commands and state, and Player Link for a sleeping, closed or hidden page');

console.log('\nALL API TOKEN CHECKS PASSED');
