// Scratch test for reading YouTube Data API answers and channel addresses
// (services/youtube.ts) and for the time links in YouTube comments
// (frontend/src/timestamps.ts). The answers below follow the videos and commentThreads
// resources in Google's documentation; no request is made.
// Run from backend/: npx tsx scripts/test-youtube.mts
// Not wired into any build.
import assert from 'node:assert/strict';
import { commentsFromThreads, isYouTubeFeedUrl, resolveYouTubeChannelId, videoDetailsFromApi, YouTubeChannelError, youtubeChannelFeedUrl, youtubeChannelRef } from '../src/services/youtube.ts';
import { youtubeLinkSeconds } from '../../frontend/src/timestamps.ts';

// videos.list: counts arrive as strings, the length as ISO 8601
const video = {
  snippet: { title: 'T', channelTitle: 'C', description: 'D', publishedAt: '2017-10-05T14:00:00Z' },
  contentDetails: { duration: 'PT18M40S' },
  status: { embeddable: true },
  statistics: { viewCount: '21345678', likeCount: '400000', commentCount: '4321' },
};
let d = videoDetailsFromApi(video);
assert.equal(d.duration, 1120);
assert.equal(d.view_count, 21345678);
assert.equal(d.comment_count, 4321);
assert.equal(d.embed_blocked, null);
assert.equal(d.published_at, '2017-10-05T14:00:00.000Z');

// Embedding turned off wins over an age restriction, and comments turned off leave out
// commentCount
d = videoDetailsFromApi({ ...video, status: { embeddable: false }, contentDetails: { duration: 'PT1M', contentRating: { ytRating: 'ytAgeRestricted' } }, statistics: { viewCount: '5' } });
assert.equal(d.embed_blocked, 'not_embeddable');
assert.equal(d.comment_count, 0);
d = videoDetailsFromApi({ ...video, contentDetails: { duration: 'PT1M', contentRating: { ytRating: 'ytAgeRestricted' } } });
assert.equal(d.embed_blocked, 'age_restricted');
// No statistics part at all (it should not happen with our request): no view count
assert.equal(videoDetailsFromApi({ snippet: {}, contentDetails: {} }).view_count, null);

// commentThreads.list with textFormat=html
const comment = (author: string, html: string, likes: number, date: string) => ({
  snippet: { authorDisplayName: author, textDisplay: html, likeCount: likes, publishedAt: date },
});
const threads = {
  items: [
    {
      snippet: {
        topLevelComment: comment('@a', 'At <a href="https://www.youtube.com/watch?v=aircAruvnKk&amp;t=60">1:00</a><br>yes', 812, '2026-09-20T10:00:00Z'),
        totalReplyCount: 2,
      },
      replies: { comments: [comment('@c', 'later', 0, '2026-09-25T10:00:00Z'), comment('@b', 'first', 14, '2026-09-21T10:00:00Z')] },
    },
    { snippet: { topLevelComment: comment('@empty', '   ', 3, '2026-09-20T10:00:00Z') } },
    { snippet: { topLevelComment: comment('@d', 'no likes', 0, 'not a date') } },
  ],
};
const comments = commentsFromThreads(threads);
assert.equal(comments.length, 2, 'an empty comment is left out');
assert.equal(comments[0].username, '@a');
assert.equal(comments[0].karma, 812);
assert.ok(comments[0].content.startsWith('At <a target="_blank" rel="noopener noreferrer" href='), 'links open outside the app');
assert.deepEqual(comments[0].replies!.map((r) => r.username), ['@b', '@c'], 'replies oldest first');
assert.equal(comments[0].replies![1].karma, undefined, 'no likes, no count');
assert.equal(comments[1].date, undefined, 'a bad date is left out');
assert.deepEqual(commentsFromThreads({}), []);

// A time in a comment links to the same video at that moment
const url = 'https://www.youtube.com/watch?v=aircAruvnKk';
assert.equal(youtubeLinkSeconds('https://www.youtube.com/watch?v=aircAruvnKk&t=60', url), 60);
assert.equal(youtubeLinkSeconds('https://www.youtube.com/watch?v=aircAruvnKk&t=83s', url), 83);
assert.equal(youtubeLinkSeconds('https://youtu.be/aircAruvnKk?t=1m23s', url), 83);
assert.equal(youtubeLinkSeconds('https://www.youtube.com/watch?v=aircAruvnKk&t=1h2m3s', url), 3723);
assert.equal(youtubeLinkSeconds('https://www.youtube.com/watch?v=aircAruvnKk', url), null, 'no time');
assert.equal(youtubeLinkSeconds('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=60', url), null, 'another video');
assert.equal(youtubeLinkSeconds('https://example.com/?t=60', url), null);

// Channel addresses the Feed tab accepts, with or without https:// and www.
const id = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
assert.deepEqual(youtubeChannelRef('https://www.youtube.com/@GoogleDevelopers'), { handle: '@GoogleDevelopers' });
assert.deepEqual(youtubeChannelRef('youtube.com/@GoogleDevelopers/videos'), { handle: '@GoogleDevelopers' });
assert.deepEqual(youtubeChannelRef('https://m.youtube.com/@GoogleDevelopers?si=abc'), { handle: '@GoogleDevelopers' });
assert.deepEqual(youtubeChannelRef('https://www.youtube.com/@%E3%81%82'), { handle: '@あ' }, 'a handle in another script');
assert.deepEqual(youtubeChannelRef(`https://www.youtube.com/channel/${id}`), { channelId: id });
assert.deepEqual(youtubeChannelRef('https://www.youtube.com/user/GoogleDevelopers'), { username: 'GoogleDevelopers' });
assert.deepEqual(youtubeChannelRef('https://www.youtube.com/c/GoogleDevelopers'), { handle: 'GoogleDevelopers' });
assert.equal(youtubeChannelRef('https://www.youtube.com/channel/UCtooShort'), null, 'not a channel id');
assert.equal(youtubeChannelRef('https://www.youtube.com/watch?v=aircAruvnKk'), null, 'a video');
assert.equal(youtubeChannelRef(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`), null, 'already a feed');
assert.equal(youtubeChannelRef('https://example.com/@someone'), null);
assert.equal(youtubeChannelRef('https://www.youtube.com/@'), null);
assert.equal(youtubeChannelRef('https://www.youtube.com/@%E3%81'), null, 'broken percent code');

// The feed without Shorts, the full feed, and which addresses are YouTube feeds
assert.equal(youtubeChannelFeedUrl(id), 'https://www.youtube.com/feeds/videos.xml?playlist_id=UULF_x5XG1OV2P6uZZ5FSM9Ttw');
assert.equal(youtubeChannelFeedUrl(id, true), `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
assert.equal(isYouTubeFeedUrl(youtubeChannelFeedUrl(id)), true);
assert.equal(isYouTubeFeedUrl('http://youtube.com/feeds/videos.xml?channel_id=x'), true);
assert.equal(isYouTubeFeedUrl('https://www.youtube.com/@GoogleDevelopers'), false);
assert.equal(isYouTubeFeedUrl('https://example.com/feeds/videos.xml'), false);
assert.equal(isYouTubeFeedUrl(null), false);

// An id needs no key and no call. A handle without a key asks for one.
assert.equal(await resolveYouTubeChannelId({ channelId: id }, null), id);
await assert.rejects(resolveYouTubeChannelId({ handle: '@GoogleDevelopers' }, null), YouTubeChannelError);

console.log('YOUTUBE CHECKS PASSED');
