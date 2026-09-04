# Wallabag API Integration Reference

This document covers the Wallabag API as used by Wallacast for bidirectional sync.

## Authentication

Wallabag uses OAuth 2.0 with password grant. Users provide their own Wallabag instance credentials.

### Required User Settings

| Setting Key | Description | Secret |
|-------------|-------------|--------|
| `wallabag_url` | Base URL of Wallabag instance (e.g., `https://app.wallabag.it`) | No |
| `wallabag_client_id` | OAuth client ID | No |
| `wallabag_client_secret` | OAuth client secret | Yes |
| `wallabag_username` | Wallabag username | No |
| `wallabag_password` | Wallabag password | Yes |
| `wallabag_access_token` | Current access token (managed by sync) | Yes |
| `wallabag_refresh_token` | Refresh token (managed by sync) | Yes |
| `wallabag_token_expires_at` | Token expiry timestamp (managed by sync) | No |
| `wallabag_last_sync` | ISO timestamp of last successful sync | No |

### Token Acquisition

```
POST {wallabag_url}/oauth/v2/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
&client_id={client_id}
&client_secret={client_secret}
&username={username}
&password={password}
```

**Response:**
```json
{
  "access_token": "ZGJmNTA2MDdm...",
  "expires_in": 3600,
  "refresh_token": "OTNlZGE5OTJj...",
  "scope": null,
  "token_type": "bearer"
}
```

### Token Refresh

When `access_token` expires, use the refresh token:

```
POST {wallabag_url}/oauth/v2/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id={client_id}
&client_secret={client_secret}
&refresh_token={refresh_token}
```

### Using the Token

All API calls require the Authorization header:

```
Authorization: Bearer {access_token}
```

## Entries API

Base path: `{wallabag_url}/api`

### GET /api/entries.json

Retrieve entries with optional filters.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `archive` | 0/1 | Filter by archived status |
| `starred` | 0/1 | Filter by starred status |
| `sort` | string | Sort field: `created`, `updated`, `archived` |
| `order` | string | Sort order: `asc`, `desc` |
| `page` | int | Page number (starts at 1) |
| `perPage` | int | Items per page (default 30; the 2.6.13 controller enforces NO cap, Wallacast uses 100 for the metadata pass) |
| `tags` | string | Comma-separated labels; an entry must carry ALL of them (matched by label, case-sensitive) |
| `since` | int | Unix timestamp; entries whose `updated_at` is strictly after it. **Tag-only changes never bump `updated_at`** (see "Tags and `updated_at`" below) |
| `public` | 0/1 | Filter by public status |
| `detail` | string | `full` for complete content, `metadata` for summary |

**Response:**
```json
{
  "_embedded": {
    "items": [
      {
        "id": 123,
        "url": "https://example.com/article",
        "title": "Article Title",
        "content": "<p>HTML content...</p>",
        "is_archived": 0,
        "is_starred": 1,
        "tags": [
          { "id": 1, "label": "article", "slug": "article" }
        ],
        "preview_picture": "https://example.com/image.jpg",
        "domain_name": "example.com",
        "reading_time": 5,
        "created_at": "2024-01-15T10:30:00+0000",
        "updated_at": "2024-01-15T10:30:00+0000",
        "published_at": "2024-01-14T08:00:00+0000",
        "published_by": ["Author Name"],
        "user_name": "wallabag_user",
        "user_email": "user@example.com",
        "user_id": 1
      }
    ]
  },
  "_links": {
    "self": { "href": "/api/entries?page=1&perPage=30" },
    "first": { "href": "/api/entries?page=1&perPage=30" },
    "last": { "href": "/api/entries?page=3&perPage=30" },
    "next": { "href": "/api/entries?page=2&perPage=30" }
  },
  "page": 1,
  "limit": 30,
  "pages": 3,
  "total": 75
}
```

### GET /api/entries/{id}.json

Retrieve a single entry by ID.

**Response:** Single entry object (same structure as items above).

### POST /api/entries.json

Create a new entry.

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | The URL (can be synthetic for texts/podcasts) |
| `title` | string | No | Override extracted title |
| `content` | string | No | Override extracted content (HTML) |
| `tags` | string | No | Comma-separated tags |
| `archive` | 0/1 | No | Set archived status |
| `starred` | 0/1 | No | Set starred status |
| `published_at` | datetime | No | Original publish date |

**Response:** Created entry object.

### PATCH /api/entries/{id}.json

Update an existing entry.

**Body Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `title` | string | New title |
| `content` | string | New HTML content |
| `tags` | string | Replace all tags (comma-separated). Verified in 2.6.13: `removeAllTags()` then assign, but ONLY when the value is non-empty, so an empty string does not clear tags. Wallacast always sends the type tag, so its list is never empty |
| `archive` | 0/1 | Update archived status |
| `starred` | 0/1 | Update starred status |

**Response:** Updated entry object.

### Tag label normalization (server side)

Wallabag's `TagsAssigner` splits on commas, trims, and **lowercases** every label (`mb_convert_case(..., MB_CASE_LOWER)`), drops empties, and reuses an existing tag with the same label. Wallacast normalizes identically before storing (`backend/src/services/tags.ts`), so a pushed tag comes back byte-identical and never causes churn.

### Tags and `updated_at` (important for sync)

Adding or removing a tag on an entry does **not** change the entry's `updated_at`. `updatedAt` is set by a Doctrine `PreUpdate` lifecycle callback (`EntityTimestampsTrait`), which only fires when a persistent field of the entry changed; a ManyToMany collection change (the `entry_tag` join table) produces an empty changeset, and none of the tag controllers call `setUpdatedAt()`. Star/archive ARE fields, so those do bump it. Consequence: a `since` pull never sees Wallabag-side tag edits, and neither does a pull that compares `updated_at`. Wallacast therefore runs a separate **tag reconciliation pass** after every pull (below).

### DELETE /api/entries/{id}.json

Delete an entry permanently.

**Response:** The deleted entry object.

## Tags API

### GET /api/tags.json

List all tags for the user.

**Response:**
```json
[
  { "id": 1, "label": "article", "slug": "article" },
  { "id": 2, "label": "podcast", "slug": "podcast" },
  { "id": 3, "label": "text", "slug": "text" }
]
```

### POST /api/entries/{id}/tags.json

Add tags to an entry (never removes existing ones).

**Body:**
```json
{ "tags": "tag1,tag2,tag3" }
```

### DELETE /api/entries/{id}/tags/{tag_id}.json

Remove a specific tag from an entry (numeric tag id).

### DELETE /api/tags/label.json?tags=a,b and DELETE /api/tag/label.json?tag=a

Remove one or more tags (by label) from every entry of the user. Orphaned tags are cleaned up. Not used by Wallacast yet (a future library-wide "rename/delete tag" action would use it).

## Content Type Mapping

Wallacast uses Wallabag tags to identify content types.

| Wallacast Type | Wallabag Tag | URL Pattern | Content |
|----------------|--------------|-------------|---------|
| `article` | `article` | Original URL | Extracted article HTML |
| `text` | `text` | `wallacast://text/{uuid}` | User-entered text |
| `podcast_episode` | `podcast` | Original audio URL | Whisper transcript |

### Type Tag Enforcement

On every sync, Wallacast verifies each item has exactly one type tag (`article`, `text`, or `podcast`). If missing or incorrect, Wallacast adds/fixes the tag based on the local `type` field.

## Sync Strategy

### Conflict Resolution

**Wallacast always wins.** If both systems have changes to the same item since last sync, Wallacast's version overwrites Wallabag.

### Ignored Items

Items in Wallabag with the tag `#nosync` or `nosync` are never pulled into Wallacast.

### Wallacast-Only Fields

These fields are stored locally and never synced to Wallabag:

- `audio_data` (binary TTS audio)
- `audio_url` (local audio endpoint)
- `playback_position`
- `playback_speed`
- `last_played_at`
- `generation_status`, `generation_progress`, `generation_error`, `current_operation`
- `tts_chunks`, `transcript_words`

### Sync Flow: Pull (Wallabag → Wallacast)

1. Call `GET /api/entries.json?since={last_sync_timestamp}&perPage=30&detail=full`
2. Paginate through all results (a failed page keeps the cursor where it was)
3. For each entry:
   - Tagged `nosync`: skip; a local item mapped to it is KEPT and marked (its tags gain `nosync`, so it is never pushed). Nothing is deleted
   - Check if `wallabag_id` exists locally
   - If exists, Wallabag is newer, and the body came from Wallabag (`content_source = 'wallabag'`): update title, content, is_starred, is_archived, preview picture (Wallacast-only fields preserved, body snapshotted to version history first)
   - If exists, Wallabag is newer, but the body is Wallacast's own (fetched, edited, imported): metadata only (star, archive, tags). Wallabag's copy is a purified re-parse of what we pushed and must never replace ours
   - If both sides changed: local content wins, star/archive come from Wallabag, dirty flag stays on so the push re-asserts local
   - **Tags in every branch**: three-way merge of `wallabag_synced_tags` (last synced set), local, and Wallabag's set (type tags stripped): additions on either side survive, a tag is dropped only when one side removed it
   - If new: create content_item with the type from the tag (or URL pattern)
4. Update `wallabag_last_sync` setting (only when every page was fetched)
5. **Tag reconciliation** (`reconcileTagsFromWallabag`): `GET /api/entries.json?detail=metadata&perPage=100`, all pages, no content (only the `content` field is omitted, tags are included). For every local item with a `wallabag_id`: `nosync` in Wallabag marks the local item; otherwise the same three-way merge is applied (without touching `updated_at`, so no fake conflict next time) and `wallabag_synced_tags` is set to Wallabag's set. Entries without one of our type tags are skipped, and a response where no entry carries a type tag aborts the pass (a response without tags must never read as "remove all tags"). This is the only path that sees tag edits made in Wallabag's UI (see "Tags and `updated_at`").

### Sync Flow: Push (Wallacast → Wallabag)

1. Query local items where `wallabag_needs_push = TRUE` OR `wallabag_id IS NULL` (an explicit dirty flag set by every syncable local write, including tag edits; the old `updated_at > wallabag_updated_at` comparison was unreliable across clocks)
2. Skip items tagged `nosync` (never pushed) and podcasts without a transcript
3. For each item:
   - If no `wallabag_id`: POST new entry
   - If has `wallabag_id`: PATCH existing entry; when the PATCH fails and `GET /api/entries/{id}` also fails, the entry is assumed deleted and re-created (a transient outage can therefore produce a duplicate, see TODO.md)
4. Tags sent as one comma string: type tag first, then the user's tags (Wallabag's PATCH replaces the whole set)
5. Store returned `wallabag_id` and `updated_at` as `wallabag_updated_at`, clear the dirty flag

### Deletion Handling

- Delete in Wallacast: Also delete from Wallabag via API
- Delete in Wallabag: **not propagated** (the local item stays; see the TODO.md discussion of archive-instead-of-delete). The reconciliation pass deliberately ignores entries missing from Wallabag.

## Synthetic URLs

For content without real URLs:

**Texts:**
```
wallacast://text/{uuid}
```

**Podcasts:**
```
wallacast://podcast/{uuid}
```

These URLs are unique identifiers that Wallabag stores but cannot fetch content from. The content field contains the actual text or transcript.

## Error Handling

| HTTP Code | Meaning | Action |
|-----------|---------|--------|
| 401 | Token expired | Refresh token and retry |
| 403 | Invalid credentials | Prompt user to re-enter credentials |
| 404 | Entry not found | Clear local `wallabag_id`, item was deleted |
| 429 | Rate limited | Exponential backoff, retry later |
| 5xx | Server error | Retry with backoff |

## Rate Limiting

Wallabag doesn't document specific rate limits. Recommendations:

- Add 100ms delay between API calls during bulk sync
- Use a large `perPage` to reduce call count (no server cap in 2.6.13; the full-content pull uses 30, the metadata reconciliation pass uses 100)
- Implement exponential backoff starting at 1s for errors

## Testing Credentials

Before syncing, validate credentials work:

```
GET {wallabag_url}/api/entries.json?perPage=1
Authorization: Bearer {access_token}
```

A 200 response confirms valid setup. Store the current timestamp as `wallabag_last_sync` for initial sync baseline.

---

## Wallacast Implementation Guide

This section documents how Wallacast implements Wallabag sync.

### Core Design Rules

1. **Wallacast always wins conflicts.** If both systems modified an item since last sync, Wallacast's version overwrites Wallabag.

2. **`#nosync` items are ignored.** Wallabag entries tagged `nosync` or `#nosync` are never pulled into Wallacast. If a local item is already mapped to such an entry it is kept and marked with a `nosync` tag (never pushed, skipped by later pulls); removing the tag on either side resumes syncing. `nosync` cannot be added from Wallacast's tag picker.

3. **Type tags are mandatory.** Every synced item must have exactly one type tag: `article`, `text`, or `podcast`. Wallacast adds/fixes this tag on every push. Locally the type tag is NOT stored in `content_items.tags` (that array holds only the user's tags, derived-and-stripped at the sync boundary), and `article`/`text`/`podcast`/`nosync` are reserved names the tag picker refuses.

3b. **User tags sync both ways.** Local tag edits set the dirty flag and push the full list; Wallabag-side tag edits reach Wallacast through the reconciliation pass. Per item the sets are merged three-way against the last synced set, so nothing added on either side is lost.

3c. **A sync never destroys local data.** No local item is deleted by a pull (nosync marks instead), no body that Wallacast produced itself is overwritten by Wallabag's copy, and Wallabag-side deletions are ignored.

4. **Local-only fields never sync to Wallabag:**
   - `audio_data` (binary TTS audio)
   - `audio_url` (local endpoint for serving audio)
   - `playback_position`, `playback_speed`, `last_played_at`
   - `generation_status`, `generation_progress`, `generation_error`, `current_operation`
   - `tts_chunks`, `transcript_words`
   - `podcast_id`, `episode_number` (RSS metadata)

5. **App works without Wallabag.** All sync functionality is optional. If credentials aren't configured or sync is disabled, the app functions normally.

6. **Content is editable.** Users can edit article content, text content, or podcast transcripts in Wallacast. These edits sync to Wallabag on push.

### Content Type Details

#### Articles (`type = 'article'`)

**What they are:** Web articles saved by URL. Wallacast fetches the HTML, cleans it without any LLM (`article-fetcher.ts`), and generates TTS audio.

**Wallabag representation:**
- `url`: The original article URL (e.g., `https://example.com/article`)
- `content`: The extracted/cleaned HTML content
- `tags`: Must include `article` tag

**Sync behaviour:**
- **Pull from Wallabag:** Create local article with the URL. Wallacast may re-fetch and re-extract content, or use Wallabag's content directly.
- **Push to Wallabag:** Send the current `html_content` or `content` field. Edited content in Wallacast syncs to Wallabag.
- **Content ownership:** Wallacast can overwrite/edit content. On push, Wallacast's version always wins.

#### Texts (`type = 'text'`)

**What they are:** User-pasted plain text (not from a URL). Users type or paste text directly into Wallacast, and TTS is generated.

**Wallabag representation:**
- `url`: Synthetic URL in format `wallacast://text/{uuid}` (Wallabag requires a URL but won't fetch it)
- `content`: The user's text content (may be wrapped in basic HTML like `<p>` tags)
- `tags`: Must include `text` tag

**Sync behaviour:**
- **Pull from Wallabag:** If URL matches `wallacast://text/*` pattern OR has `text` tag, create as text type.
- **Push to Wallabag:** Generate synthetic URL if none exists. Push current content.
- **Content ownership:** User can edit text in Wallacast. Edited version pushes to Wallabag.

#### Podcasts (`type = 'podcast_episode'`)

**What they are:** Podcast episodes from RSS feeds. Wallacast transcribes audio using Whisper.

**Wallabag representation:**
- `url`: The actual podcast audio URL (e.g., `https://podcast.com/episode.mp3`)
- `content`: The Whisper transcription of the episode
- `tags`: Must include `podcast` tag

**Sync behaviour:**
- **Pull from Wallabag:** If URL ends in audio extension (`.mp3`, `.m4a`, etc.) OR has `podcast` tag, create as podcast_episode type. The `content` from Wallabag becomes the `transcript` field locally.
- **Push to Wallabag:** Push the `transcript` field as `content`. Audio URL is the real URL.
- **Content ownership:** Wallacast owns the transcript. Re-transcription or edits push to Wallabag.

### Implementation Status

**Status: COMPLETE** ✅

All core Wallabag sync features are implemented and functional:

- **Pull Sync (Wallabag → Wallacast)**: Articles, texts, and podcasts automatically sync from Wallabag
- **Push Sync (Wallacast → Wallabag)**: Local changes (creates, edits, stars, archives) sync to Wallabag
- **Delete propagation**: Wallacast → Wallabag only (Wallabag-side deletions are left alone, by design)
- **Tag sync**: user tags stored as a normalized `TEXT[]`, editable in the app, pushed as the full list, pulled with a dirty-wins rule, and reconciled library-wide after every pull because Wallabag's `updated_at` ignores tag changes
- **Full Refresh**: Button to fetch all items from Wallabag (ignores timestamps)
- **Cleanup Tool**: Emergency button to delete recently synced items and reset sync state
- **OAuth Token Management**: Automatic token refresh with fallback
- **Type Detection**: Automatic detection of article/text/podcast based on tags and URL patterns
- **Conflict Resolution**: Pull sync properly detects conflicts and preserves Wallacast changes per "Wallacast always wins" rule

### Implementation Files

#### Created
- `backend/src/services/wallabag-service.ts` - OAuth, API wrapper, CRUD operations
- `backend/src/services/wallabag-sync.ts` - Pull sync, push sync, full sync, delete sync
- `backend/src/routes/wallabag.ts` - API endpoints (test, status, pull, push, sync, cleanup, full refresh)

#### Modified
- `backend/src/routes/users.ts` - Added wallabag_token_expires_at and wallabag_last_sync keys
- `backend/src/routes/content.ts` - Two-way delete integration, content regeneration fixes
- `backend/src/index.ts` - Registered wallabag router at /api/wallabag
- `frontend/src/api.ts` - Added wallabagAPI object
- `frontend/src/components/SettingsPage.tsx` - Wallabag settings UI
- `frontend/src/App.tsx` - Sync button in header with pending changes indicator
