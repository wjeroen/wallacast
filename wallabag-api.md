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
| `perPage` | int | Items per page (max 30) |
| `tags` | string | Filter by tag slug |
| `since` | int | Unix timestamp; return entries modified after this time |
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
| `tags` | string | Replace all tags (comma-separated) |
| `archive` | 0/1 | Update archived status |
| `starred` | 0/1 | Update starred status |

**Response:** Updated entry object.

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

Add tags to an entry.

**Body:**
```json
{ "tags": "tag1,tag2,tag3" }
```

### DELETE /api/entries/{id}/tags/{tag_id}.json

Remove a specific tag from an entry.

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

1. Call `GET /api/entries.json?since={last_sync_timestamp}&perPage=30`
2. Paginate through all results
3. For each entry:
   - Skip if tagged `nosync`
   - Check if `wallabag_id` exists locally
   - If exists: update title, content, is_starred, is_archived, tags (preserve Wallacast-only fields)
   - If new: create content_item with appropriate type based on tag
4. Update `wallabag_last_sync` setting

### Sync Flow: Push (Wallacast → Wallabag)

1. Query local items where `updated_at > wallabag_updated_at` OR `wallabag_id IS NULL`
2. For each item:
   - If no `wallabag_id`: POST new entry
   - If has `wallabag_id`: PATCH existing entry
3. Verify/add type tag after create/update
4. Store returned `wallabag_id` and `updated_at` as `wallabag_updated_at`

### Deletion Handling

- Delete in Wallacast: Also delete from Wallabag via API
- Delete in Wallabag: On next pull, if a known `wallabag_id` is missing from results, mark local item as deleted (or actually delete, based on user preference)

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
- Use `perPage=30` (maximum) to reduce call count
- Implement exponential backoff starting at 1s for errors

## Testing Credentials

Before syncing, validate credentials work:

```
GET {wallabag_url}/api/entries.json?perPage=1
Authorization: Bearer {access_token}
```

A 200 response confirms valid setup. Store the current timestamp as `wallabag_last_sync` for initial sync baseline.
