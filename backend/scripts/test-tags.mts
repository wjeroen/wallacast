// Scratch test for the shared tag rules and the three-way merge used by the Wallabag sync.
// Run from backend/: npx tsx scripts/test-tags.mts   (tsx from ../frontend/node_modules works too)
// Not wired into any build.
import assert from 'node:assert/strict';
import {
  mergeTagSets,
  normalizeTag,
  normalizeTagList,
  findReservedTags,
  hasNosyncTag,
  wallabagTagString,
  userTagsFromWallabagLabels,
  sameTagSet,
} from '../src/services/tags.ts';

// Normalization mirrors Wallabag's TagsAssigner
assert.equal(normalizeTag('  AI  Safety, please '), 'ai safety please');
assert.deepEqual(normalizeTagList(['Econ', 'econ', ' ', 'article', 'nosync', 'AI']), ['econ', 'ai']);
assert.deepEqual(findReservedTags(['x', 'Article', 'NOSYNC']), ['article', 'nosync']);
assert.equal(hasNosyncTag(['a', 'NoSync']), true);
assert.equal(hasNosyncTag(['a']), false);
assert.equal(wallabagTagString('podcast_episode', ['b', 'a', 'b']), 'podcast,b,a');
assert.deepEqual(userTagsFromWallabagLabels(['article', 'toread', 'nosync']), ['toread']);
assert.equal(sameTagSet(['a', 'b'], ['b', 'a']), true);

// Three-way merge (base = last synced set)
// no local edits: result is exactly remote
assert.deepEqual(mergeTagSets(['a'], ['a'], ['a', 'b']), ['a', 'b']);
assert.deepEqual(mergeTagSets(['a', 'b'], ['a', 'b'], ['a']), ['a']);
// added locally, untouched remotely: kept
assert.deepEqual(mergeTagSets(['a'], ['a', 'x'], ['a']), ['a', 'x']);
// removed locally, still in remote: stays removed (NOT re-added)
assert.deepEqual(mergeTagSets(['a', 'b'], ['a'], ['a', 'b']), ['a']);
// added on both sides: both survive
assert.deepEqual(mergeTagSets(['a'], ['a', 'x'], ['a', 'y']), ['a', 'x', 'y']);
// removed remotely while added locally elsewhere: remote removal honored, local addition kept
assert.deepEqual(mergeTagSets(['a', 'b'], ['a', 'b', 'x'], ['a']), ['a', 'x']);
// NULL base (unknown) behaves as base == local: remote wins on differences
assert.deepEqual(mergeTagSets(null, ['a', 'stale'], ['a', 'new']), ['a', 'new']);
// the migration-time worry: item dirty for unrelated reasons, Wallabag gained a tag since
assert.deepEqual(mergeTagSets([], [], ['toread']), ['toread']);

console.log('ALL BACKEND TAG TESTS PASSED');
