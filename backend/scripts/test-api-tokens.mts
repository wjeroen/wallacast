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
const all = ['read_library', 'feed', 'add_any', 'tag', 'star'];
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
assert.deepEqual(effectiveLimits({ items_hour: 7, minutes_2d: 99999 }), { ...DEFAULT_LIMITS, items_hour: 7 }, 'an out-of-range stored value falls back');
assert.deepEqual(validateLimits({ items_hour: 0 }, DEFAULT_LIMITS), { limits: { ...DEFAULT_LIMITS, items_hour: 0 } }, '0 is allowed: no adds at all');
assert.deepEqual(validateLimits({ items_hour: MAX_LIMITS.items_hour }, DEFAULT_LIMITS), { limits: { ...DEFAULT_LIMITS, items_hour: 500 } });
for (const bad of [{ items_hour: 501 }, { items_hour: -1 }, { items_hour: 1.5 }, { items_hour: '5' }, { foo: 1 }, [], null]) {
  assert.ok('error' in validateLimits(bad, DEFAULT_LIMITS), `limits ${JSON.stringify(bad)} refused`);
}
assert.deepEqual(MAX_LIMITS, { items_hour: 500, items_2d: 5000, minutes_hour: 2000, minutes_2d: 10000 });

assert.deepEqual(parseGeneration(undefined), { follow: true, audio: false, summary: false, summary_audio: false, transcribe: false });
assert.equal(parseGeneration({ follow: false }).follow, false);
assert.deepEqual(
  validateGeneration({ follow: false, summary: true }, parseGeneration({})),
  { generation: { follow: false, audio: false, summary: true, summary_audio: false, transcribe: false } }
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

console.log('\nALL API TOKEN CHECKS PASSED');
