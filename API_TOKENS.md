# Wallacast API tokens

An API token lets a tool outside the app work with your Wallacast account: the Obsidian commands, or a cloud Claude Code routine that reads your feed and helps you decide what to add. Create one in Settings → API tokens, then tick what it may do. A token can never read your settings or API keys, change or delete library items, rename or delete tags, or manage tokens.

Every request sends the token as a Bearer header:

```bash
curl -H "Authorization: Bearer wcr_..." https://<your-backend>/api/auth/token
```

The backend address is the one the app talks to (for the hosted instance, the Railway backend service, not the frontend address).

## Start here: what can this token do?

`GET /api/auth/token` works for every token. It answers with the token's name, permissions, limits, how much of them is used and left, and what is generated for the items it adds:

```json
{
  "name": "Routine",
  "permissions": ["read_library", "feed", "add_any", "tag", "star"],
  "limits": { "items_hour": 20, "items_2d": 100, "minutes_hour": 120, "minutes_2d": 600 },
  "usage": { "items_hour": 3, "items_2d": 10, "minutes_hour": 12, "minutes_2d": 80 },
  "remaining": { "items_hour": 17, "items_2d": 90, "minutes_hour": 108, "minutes_2d": 520, "changes_hour": 500 },
  "generation": { "follows_app_settings": true, "audio": false, "summary": true, "summary_audio": false, "transcribe": true },
  "refresh_interval_minutes": 15,
  "chars_per_minute": 900
}
```

## Permissions and their routes

| Permission | Routes |
|---|---|
| `read_library` | `GET /api/content/index`, `GET /api/content/markdown?url=`, `GET /api/content/:id/markdown`, `GET /api/content/tags/all` |
| `feed` | `GET /api/podcasts`, `GET /api/podcasts/feed-items`, `POST /api/podcasts/refresh-feeds`, `GET /api/podcasts/refresh-status` |
| `add_any` | `POST /api/content` with `url` or `feed_item_id`, `GET /api/content/preview` with `url` or `feed_item_id` |
| `add_feed` | the same two routes, but only with `feed_item_id`: items from your own feeds, never a free address |
| `tag` | `POST /api/content/bulk` with `add_tags` (tags that already exist), and `tags` when adding. `GET /api/content/tags/all` |
| `star` | `POST /api/content/bulk` with `star` or `unstar` |

`add_any` and `add_feed` exclude each other. Any other route answers `403`.

### Reading the library

- `GET /api/content/index`: one small row per item, newest first (`id, type, title, url, alt_url, audio_url, author, published_at, created_at, tags, is_starred, is_archived, summary_status, comment_count, description` cut to 300 characters, `has_transcript`, and a few more).
- `GET /api/content/:id/markdown` and `GET /api/content/markdown?url=<address>`: the item exactly as the app's Copy content button gives it, in `markdown`. 404 when no item has that address.
- `GET /api/content/tags/all`: `{ "tags": [{ "tag": "ai-safety", "count": 12 }, ...] }`.

### The feed

- `GET /api/podcasts`: your subscriptions.
- `GET /api/podcasts/feed-items?limit=50&offset=0`: cached feed items, newest first, at most 50 per request. Page on with `offset`. Each item has `feed_item_id`, `item_type` (`article` or `podcast_episode`), `title`, `teaser` (up to 1,200 characters of plain text, the best summary of what the item is), `description` (up to 2,000 characters), `url` or `audio_url`, `duration` (seconds), `author`, `published_at`, `podcast_show_name`.
- `POST /api/podcasts/refresh-feeds`: starts fetching every feed and answers `202` at once. Watch it with `GET /api/podcasts/refresh-status` until `running` is false. One refresh per 15 minutes per token, a second one answers `429` with `retry_after_seconds`.

### Reading an article without saving it

`GET /api/content/preview?feed_item_id=123` (or `?url=` with `add_any`): Wallacast fetches the page exactly as an add would, through its bot-check and archive fallbacks, and answers `{ title, author, published_at, url, comment_count, markdown }`. Nothing is stored. It counts as one item against the item limits. Episodes have no page, their text is the feed's `teaser` and `description`.

### Adding

`POST /api/content` with a JSON body of exactly one of:

```json
{ "feed_item_id": 123, "tags": ["ai-safety"] }
{ "url": "https://example.com/post", "tags": ["ai-safety"] }
```

`tags` is optional, needs `tag`, and every tag must already exist in the library. Any other field is refused. A feed item is added exactly as the Feed tab's plus button adds it. The answer is `201`:

```json
{
  "id": 2801, "type": "article", "title": "...", "url": "...", "audio_url": null, "author": "...",
  "published_at": "...", "tags": ["ai-safety"], "comment_count": 4,
  "generation": { "started": ["summary"], "skipped": [{ "what": "audio", "reason": "This token reached its limit of 120 generation minutes per hour" }] }
}
```

`generation` says what started for the item and what was skipped and why. Read the item afterwards with `GET /api/content/2801/markdown`. An address that is already in the library answers `409` with its `id`. A page that cannot be fetched answers `502` with the reason.

### Tags and stars

`POST /api/content/bulk` with `{ "action": "add_tags", "ids": [1, 2], "tags": ["ai-safety"] }`, `{ "action": "star", "ids": [...] }` or `{ "action": "unstar", "ids": [...] }` (at most 500 ids). Answers `{ "affected": 2, "changes": 3 }`. Only real changes count: a tag an item already has, or a star it already has, is skipped. Every change is logged, and Settings can undo one change or all of them.

## Limits

Each token has four limits, set under the token in Settings. They are rolling windows: the last hour and the last 48 hours.

| Limit | Default | Highest | Counts |
|---|---|---|---|
| Items per hour | 20 | 500 | every add and every preview that passes its checks, also one whose page then cannot be fetched |
| Items per 2 days | 100 | 5,000 | the same |
| Generation minutes per hour | 120 | 2,000 | audio, summary, summary audio and transcripts started for items the token adds |
| Generation minutes per 2 days | 600 | 10,000 | the same |

Minutes are estimated before a generation starts: an article's text (plus its comments) at 900 characters a minute, at least one minute, an episode by its duration (60 minutes when the feed gives none), summary audio as 3 minutes. Audio and the summary of one article each count its full length.

- Over an item limit, the request answers `429` with `{ error, limit, max, used }`.
- Over a minute limit, the item is still added, the generation that does not fit is skipped, and `generation.skipped` says so.
- Fixed limits: one feed refresh per 15 minutes, 500 tag and star changes per hour.

Each limit hit shows a notice in the app. The Reset button in Settings counts usage from that moment. Usage is kept in the database, so a deploy does not reset it, and deleting an item does not give back what it used.

## What is generated for added items

Under each token, Settings has "Same as my auto-generation settings" (on for a new token). Off, the token gets its own four switches: audio for articles, summary, summary audio, transcript for podcasts. Either way every generation must fit the minute limits.

## Errors

| Status | Meaning |
|---|---|
| `401` | Unknown or revoked token |
| `403` | The token lacks the permission, or tokens cannot use the route at all |
| `400` | A field is missing or wrong, an unknown tag |
| `409` | Already in the library (`id` in the answer) |
| `429` | A limit, see above |
| `502` | The article page could not be fetched |

## Keeping a token safe

The token is as strong as its permissions. Tick only what a tool needs, and revoke it in Settings the moment it may have leaked: the next request carrying it is refused. For a cloud Claude Code routine, store the token as a network secret on the routine's cloud environment, so Claude can call Wallacast without ever seeing the token.
