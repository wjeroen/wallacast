# Wallabag Bidirectional Sync Implementation Guide

> **Instructions for Claude Code:** As you complete tasks, mark them done by changing `[ ]` to `[x]`. Never remove any items from this document. Add notes under completed items if needed.

## Overview

Wallacast is a read-it-later app with TTS (text-to-speech) capabilities. Users can save articles, paste text, or subscribe to podcasts. The app generates audio for articles/texts using OpenAI TTS, and transcribes podcasts using Whisper.

This document specifies bidirectional sync with Wallabag, allowing users to:
- Save articles in Wallabag and have them appear in Wallacast (with TTS generation)
- Save content in Wallacast and have it sync to Wallabag
- Keep starred/archived status synchronised
- Edit content in Wallacast and push changes to Wallabag

**Reference:** See `wallabag-api.md` in the repo root for complete Wallabag API documentation.

---

## Content Types and How They Sync

### Articles (`type = 'article'`)

**What they are:** Web articles saved by URL. Wallacast fetches the HTML, extracts readable content using GPT, and generates TTS audio.

**Wallabag representation:**
- `url`: The original article URL (e.g., `https://example.com/article`)
- `content`: The extracted/cleaned HTML content
- `tags`: Must include `article` tag

**Sync behaviour:**
- **Pull from Wallabag:** Create local article with the URL. Wallacast may re-fetch and re-extract content, or use Wallabag's content directly. The `content` field stores the readable text.
- **Push to Wallabag:** Send the current `html_content` or `content` field. If the user edited the content in Wallacast, the edited version is what gets pushed.
- **Content ownership:** Wallacast can overwrite/edit the content. On push, Wallacast's version always wins.

### Texts (`type = 'text'`)

**What they are:** User-pasted plain text (not from a URL). Users type or paste text directly into Wallacast, and TTS is generated for it.

**Wallabag representation:**
- `url`: Synthetic URL in format `wallacast://text/{uuid}` (Wallabag requires a URL but won't fetch it)
- `content`: The user's text content (may be wrapped in basic HTML like `<p>` tags)
- `tags`: Must include `text` tag

**Sync behaviour:**
- **Pull from Wallabag:** If URL matches `wallacast://text/*` pattern OR has `text` tag, create as text type. Store content as-is.
- **Push to Wallabag:** Generate synthetic URL if none exists. Push current content.
- **Content ownership:** User can edit text in Wallacast. Edited version pushes to Wallabag.

### Podcasts (`type = 'podcast_episode'`)

**What they are:** Podcast episodes from RSS feeds. The user subscribes to a podcast, and individual episodes can be added to their library. Wallacast transcribes the audio using Whisper.

**Wallabag representation:**
- `url`: The actual podcast audio URL (e.g., `https://podcast.com/episode.mp3`)
- `content`: The Whisper transcription of the episode (plain text or basic HTML)
- `tags`: Must include `podcast` tag

**Sync behaviour:**
- **Pull from Wallabag:** If URL ends in audio extension (`.mp3`, `.m4a`, etc.) OR has `podcast` tag, create as podcast_episode type. The `content` from Wallabag becomes the `transcript` field locally.
- **Push to Wallabag:** Push the `transcript` field as `content`. The audio URL is already the real URL.
- **Content ownership:** Wallacast owns the transcript. If re-transcribed or edited, the new version pushes to Wallabag.
- **Note:** Podcast metadata (show title, episode number, etc.) comes from the RSS feed and is stored locally but not synced to Wallabag beyond what fits in the entry fields.

### Summary Table

| Type | URL in Wallabag | Content in Wallabag | Wallabag Tag | Local Content Field |
|------|-----------------|---------------------|--------------|---------------------|
| `article` | Original article URL | Extracted HTML | `article` | `content` / `html_content` |
| `text` | `wallacast://text/{uuid}` | User's text | `text` | `content` |
| `podcast_episode` | Audio file URL (.mp3, etc.) | Whisper transcript | `podcast` | `transcript` |

---

## What Already Exists in the Codebase

### Database Schema

The `content_items` table already has these Wallabag-related columns:

```sql
wallabag_id INTEGER,           -- Wallabag entry ID (NULL if never synced)
wallabag_updated_at TIMESTAMP, -- Last known Wallabag updated_at value
tags TEXT,                     -- Comma-separated tags string
```

### User Settings Infrastructure

The `user_settings` table stores per-user key-value settings. In `backend/src/routes/users.ts`, these Wallabag keys are already defined:

```typescript
'wallabag_url',           // Base URL of user's Wallabag instance
'wallabag_client_id',     // OAuth client ID
'wallabag_client_secret', // OAuth client secret (SECRET)
'wallabag_username',      // Wallabag username
'wallabag_password',      // Wallabag password (SECRET)
'wallabag_access_token',  // Current OAuth access token (SECRET)
'wallabag_refresh_token', // OAuth refresh token (SECRET)
'wallabag_sync_enabled',  // 'true' or 'false'
```

### Frontend Settings UI

`frontend/src/components/SettingsPage.tsx` has input fields for:
- `wallabag_url`
- `wallabag_client_id`
- `wallabag_client_secret`

**Missing:** Input fields for `wallabag_username` and `wallabag_password` (needed for OAuth password grant).

---

## Core Design Rules

1. **Wallacast always wins conflicts.** If both systems modified an item since last sync, Wallacast's version overwrites Wallabag.

2. **`#nosync` items are ignored.** Wallabag entries tagged `nosync` or `#nosync` are never pulled into Wallacast.

3. **Type tags are mandatory.** Every synced item must have exactly one type tag: `article`, `text`, or `podcast`. Wallacast adds/fixes this tag on every push.

4. **Local-only fields never sync to Wallabag:**
   - `audio_data` (binary TTS audio)
   - `audio_url` (local endpoint for serving audio)
   - `playback_position`, `playback_speed`, `last_played_at`
   - `generation_status`, `generation_progress`, `generation_error`, `current_operation`
   - `tts_chunks`, `transcript_words`
   - `podcast_id`, `episode_number` (RSS metadata)

5. **App works without Wallabag.** All sync functionality is optional. If credentials aren't configured or sync is disabled, the app functions normally.

6. **Content is editable.** Users can edit article content, text content, or podcast transcripts in Wallacast. These edits sync to Wallabag on push.

---

## Implementation Tasks

### Phase 1: Configuration and Settings

#### [x] 1.1 Add missing setting keys to `backend/src/routes/users.ts`

In the `VALID_SETTING_KEYS` array, add:

```typescript
'wallabag_token_expires_at',  // ISO timestamp when access token expires
'wallabag_last_sync',         // ISO timestamp of last successful sync
```

These are NOT secret keys (don't add to `SECRET_KEYS` array).

**Done:** Added both keys to VALID_SETTING_KEYS array.

#### [x] 1.2 Add username/password input fields to frontend settings

In `frontend/src/components/SettingsPage.tsx`, the Wallabag section needs:

- [x] Input field for `wallabag_username` (text input, not secret)
- [x] Input field for `wallabag_password` (password input, secret, with show/hide toggle)
- [x] Checkbox or toggle for `wallabag_sync_enabled`

Follow the existing pattern used for `wallabag_client_secret` (masked display, show/hide button).

**Done:** All fields already exist in SettingsPage.tsx (lines 338-370).

#### [x] 1.3 Add form state for new fields

In SettingsPage.tsx, update the `formData` state and `handleChange` to include:
- `wallabag_username`
- `wallabag_password`
- `wallabag_sync_enabled`

**Done:** All fields already in formData state (lines 44-46).

---

### Phase 2: Wallabag API Service

#### [x] 2.1 Create `backend/src/services/wallabag-service.ts`

This service handles all communication with the Wallabag API.

**Done:** Created complete service with OAuth, token management, API wrapper, and all CRUD methods.

**Required exports:**

```typescript
export class WallabagService {
  constructor(userId: number);
  
  // Check if Wallabag is configured and enabled for this user
  async isEnabled(): Promise<boolean>;
  
  // Get valid access token, refreshing if needed
  async getAccessToken(): Promise<string | null>;
  
  // Test that credentials work
  async testConnection(): Promise<{ success: boolean; error?: string }>;
  
  // Fetch entries from Wallabag with pagination
  async fetchEntries(since?: string): Promise<WallabagEntry[]>;
  
  // Fetch a single entry by ID
  async fetchEntry(id: number): Promise<WallabagEntry | null>;
  
  // Create a new entry
  async createEntry(data: CreateEntryData): Promise<WallabagEntry | null>;
  
  // Update an existing entry
  async updateEntry(id: number, data: UpdateEntryData): Promise<WallabagEntry | null>;
  
  // Delete an entry
  async deleteEntry(id: number): Promise<boolean>;
  
  // Add tags to an entry
  async addTags(entryId: number, tags: string): Promise<boolean>;
}
```

**Type definitions:**

```typescript
interface WallabagEntry {
  id: number;
  url: string;
  title: string;
  content: string;
  is_archived: number;  // 0 or 1
  is_starred: number;   // 0 or 1
  tags: Array<{ id: number; label: string; slug: string }>;
  preview_picture: string | null;
  domain_name: string;
  reading_time: number;
  created_at: string;   // ISO datetime
  updated_at: string;   // ISO datetime
  published_at: string | null;
  published_by: string[] | null;
}

interface CreateEntryData {
  url: string;
  title?: string;
  content?: string;
  tags?: string;        // Comma-separated
  archive?: boolean;
  starred?: boolean;
  published_at?: string;
}

interface UpdateEntryData {
  title?: string;
  content?: string;
  tags?: string;
  archive?: boolean;
  starred?: boolean;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;   // Seconds until expiry
  refresh_token: string;
  token_type: string;   // "bearer"
}
```

#### [x] 2.2 Implement OAuth token management

The service must handle:

- [x] **Initial token acquisition** using password grant:
  ```
  POST {wallabag_url}/oauth/v2/token
  Content-Type: application/x-www-form-urlencoded
  
  grant_type=password
  &client_id={client_id}
  &client_secret={client_secret}
  &username={username}
  &password={password}
  ```

- [x] **Token refresh** when access token expires:
  ```
  POST {wallabag_url}/oauth/v2/token
  Content-Type: application/x-www-form-urlencoded

  grant_type=refresh_token
  &client_id={client_id}
  &client_secret={client_secret}
  &refresh_token={refresh_token}
  ```

- [x] **Token storage:** Save `access_token`, `refresh_token`, and calculated `token_expires_at` to user_settings

- [x] **Automatic refresh:** Before any API call, check if token is expired (with 5-minute buffer). If so, refresh first.

- [x] **Fallback:** If refresh token fails (e.g., expired after 14 days), fall back to password grant

#### [x] 2.3 Implement API request wrapper

Create a private method that:

- [x] Adds `Authorization: Bearer {token}` header
- [x] Handles 401 responses by refreshing token and retrying once
- [x] Handles rate limiting (429) with exponential backoff
- [x] Logs errors appropriately
- [x] Returns null on failure (don't throw, let caller handle)

#### [x] 2.4 Implement fetchEntries with pagination

```typescript
async fetchEntries(since?: string): Promise<WallabagEntry[]> {
  const entries: WallabagEntry[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    // Build URL: /api/entries.json?perPage=30&page={page}&detail=full
    // If since provided, add: &since={unix_timestamp}
    
    const response = await this.apiRequest('GET', endpoint);
    if (!response?._embedded?.items) break;
    
    entries.push(...response._embedded.items);
    hasMore = page < response.pages;
    page++;
    
    // Rate limit: 100ms delay between pages
    if (hasMore) await sleep(100);
  }

  return entries;
}
```

#### [x] 2.5 Implement CRUD operations

- [x] `createEntry`: POST to `/api/entries.json`
- [x] `updateEntry`: PATCH to `/api/entries/{id}.json`
- [x] `deleteEntry`: DELETE to `/api/entries/{id}.json`
- [x] `addTags`: POST to `/api/entries/{id}/tags.json` with body `{ "tags": "tag1,tag2" }`

#### [x] 2.6 Implement testConnection

```typescript
async testConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await this.getAccessToken();
    if (!token) {
      return { success: false, error: 'Failed to obtain access token. Check credentials.' };
    }
    
    // Try to fetch one entry to verify API access
    const response = await this.apiRequest('GET', '/entries.json?perPage=1');
    if (response === null) {
      return { success: false, error: 'API request failed. Check URL and permissions.' };
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
```

---

### Phase 3: Sync Service

#### [ ] 3.1 Create `backend/src/services/wallabag-sync.ts`

**Required exports:**

```typescript
// Pull changes from Wallabag into Wallacast
export async function syncFromWallabag(userId: number): Promise<SyncResult>;

// Push changes from Wallacast to Wallabag
export async function syncToWallabag(userId: number): Promise<SyncResult>;

// Full bidirectional sync (pull then push)
export async function fullSync(userId: number): Promise<FullSyncResult>;

// Delete a specific entry from Wallabag (called when deleting locally)
export async function deleteFromWallabag(userId: number, wallabagId: number): Promise<boolean>;

interface SyncResult {
  count: number;       // Items processed
  errors: string[];    // Error messages for failed items
}

interface FullSyncResult {
  pulled: number;
  pushed: number;
  errors: string[];
}
```

#### [ ] 3.2 Implement content type detection

Create helper functions:

```typescript
// Determine Wallacast type from Wallabag entry
function detectTypeFromWallabag(entry: WallabagEntry): 'article' | 'text' | 'podcast_episode' {
  const tagSlugs = entry.tags.map(t => t.slug.toLowerCase());
  
  // Check explicit type tags first
  if (tagSlugs.includes('podcast')) return 'podcast_episode';
  if (tagSlugs.includes('text')) return 'text';
  if (tagSlugs.includes('article')) return 'article';
  
  // Infer from URL pattern
  if (entry.url.startsWith('wallacast://text/')) return 'text';
  if (entry.url.startsWith('wallacast://podcast/')) return 'podcast_episode';
  
  // Check for audio file extensions
  const audioExtensions = ['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac'];
  const urlLower = entry.url.toLowerCase();
  if (audioExtensions.some(ext => urlLower.includes(ext))) {
    return 'podcast_episode';
  }
  
  // Default to article
  return 'article';
}

// Get the tag string that should be used for a Wallacast type
function getTypeTag(type: string): string {
  switch (type) {
    case 'podcast_episode': return 'podcast';
    case 'text': return 'text';
    default: return 'article';
  }
}

// Check if entry should be skipped (has nosync tag)
function shouldSkip(entry: WallabagEntry): boolean {
  return entry.tags.some(t => 
    t.slug.toLowerCase() === 'nosync' || 
    t.label.toLowerCase() === '#nosync'
  );
}
```

#### [ ] 3.3 Implement syncFromWallabag (Pull)

```typescript
export async function syncFromWallabag(userId: number): Promise<SyncResult> {
  const wallabag = new WallabagService(userId);
  const errors: string[] = [];
  let count = 0;

  // Check if enabled
  if (!(await wallabag.isEnabled())) {
    return { count: 0, errors: ['Wallabag sync not enabled'] };
  }

  // Get last sync timestamp
  const lastSync = await getUserSetting(userId, 'wallabag_last_sync');

  // Fetch entries modified since last sync (or all if first sync)
  const entries = await wallabag.fetchEntries(lastSync || undefined);

  for (const entry of entries) {
    try {
      // Skip nosync entries
      if (shouldSkip(entry)) continue;

      // Determine content type
      const type = detectTypeFromWallabag(entry);

      // Check if we already have this item
      const existing = await query(
        'SELECT id, updated_at FROM content_items WHERE wallabag_id = $1 AND user_id = $2',
        [entry.id, userId]
      );

      // Build tags string from Wallabag tags
      const tagsString = entry.tags.map(t => t.label).join(',');

      // Determine which local field to store content in
      // For podcasts, Wallabag content = transcript
      // For articles/texts, Wallabag content = content/html_content

      if (existing.rows.length > 0) {
        // UPDATE existing item
        // Preserve local-only fields by not including them in UPDATE
        
        if (type === 'podcast_episode') {
          await query(
            `UPDATE content_items SET
              title = $1,
              transcript = $2,
              is_starred = $3,
              is_archived = $4,
              tags = $5,
              preview_picture = $6,
              wallabag_updated_at = $7,
              updated_at = NOW()
            WHERE id = $8`,
            [
              entry.title,
              entry.content,  // Goes into transcript for podcasts
              entry.is_starred === 1,
              entry.is_archived === 1,
              tagsString,
              entry.preview_picture,
              entry.updated_at,
              existing.rows[0].id,
            ]
          );
        } else {
          await query(
            `UPDATE content_items SET
              title = $1,
              content = $2,
              html_content = $3,
              is_starred = $4,
              is_archived = $5,
              tags = $6,
              preview_picture = $7,
              wallabag_updated_at = $8,
              updated_at = NOW()
            WHERE id = $9`,
            [
              entry.title,
              entry.content,
              entry.content,  // Store in both for articles/texts
              entry.is_starred === 1,
              entry.is_archived === 1,
              tagsString,
              entry.preview_picture,
              entry.updated_at,
              existing.rows[0].id,
            ]
          );
        }
      } else {
        // INSERT new item
        if (type === 'podcast_episode') {
          await query(
            `INSERT INTO content_items 
              (type, title, url, transcript, is_starred, is_archived, tags,
               preview_picture, wallabag_id, wallabag_updated_at, user_id,
               author, published_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              type,
              entry.title,
              entry.url,
              entry.content,  // Wallabag content = transcript for podcasts
              entry.is_starred === 1,
              entry.is_archived === 1,
              tagsString,
              entry.preview_picture,
              entry.id,
              entry.updated_at,
              userId,
              entry.published_by?.[0] || null,
              entry.published_at,
            ]
          );
        } else {
          await query(
            `INSERT INTO content_items 
              (type, title, url, content, html_content, is_starred, is_archived, tags,
               preview_picture, wallabag_id, wallabag_updated_at, user_id,
               author, published_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              type,
              entry.title,
              entry.url,
              entry.content,
              entry.content,
              entry.is_starred === 1,
              entry.is_archived === 1,
              tagsString,
              entry.preview_picture,
              entry.id,
              entry.updated_at,
              userId,
              entry.published_by?.[0] || null,
              entry.published_at,
            ]
          );
        }
        
        // TODO: Optionally trigger TTS generation for new articles/texts
        // TODO: Optionally trigger transcription for new podcasts (if audio URL accessible)
      }

      count++;
    } catch (error) {
      errors.push(`Entry ${entry.id} (${entry.title}): ${error}`);
    }
  }

  // Update last sync timestamp
  await setUserSetting(userId, 'wallabag_last_sync', new Date().toISOString());

  return { count, errors };
}
```

#### [ ] 3.4 Implement syncToWallabag (Push)

```typescript
export async function syncToWallabag(userId: number): Promise<SyncResult> {
  const wallabag = new WallabagService(userId);
  const errors: string[] = [];
  let count = 0;

  if (!(await wallabag.isEnabled())) {
    return { count: 0, errors: ['Wallabag sync not enabled'] };
  }

  // Find items needing push:
  // 1. wallabag_id IS NULL (never synced)
  // 2. updated_at > wallabag_updated_at (local changes since last sync)
  const itemsResult = await query(
    `SELECT * FROM content_items 
     WHERE user_id = $1 
     AND (
       wallabag_id IS NULL 
       OR updated_at > COALESCE(wallabag_updated_at, '1970-01-01'::timestamp)
     )`,
    [userId]
  );

  for (const item of itemsResult.rows) {
    try {
      // Determine the type tag to use
      const typeTag = getTypeTag(item.type);

      // Build final tags string, with type tag present
      const existingTags = item.tags 
        ? item.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : [];
      
      // Remove any existing type tags to avoid duplicates
      const typeTags = ['article', 'text', 'podcast'];
      const otherTags = existingTags.filter(
        (t: string) => !typeTags.includes(t.toLowerCase())
      );
      
      // Type tag first, then other tags
      const finalTags = [typeTag, ...otherTags].join(',');

      // Determine URL
      let url = item.url;
      if (!url) {
        // Generate synthetic URL for items without one
        const uuid = crypto.randomUUID();
        if (item.type === 'text') {
          url = `wallacast://text/${uuid}`;
        } else if (item.type === 'podcast_episode') {
          url = `wallacast://podcast/${uuid}`;
        } else {
          url = `wallacast://content/${uuid}`;
        }
      }

      // Determine content to send
      // Podcasts: send transcript
      // Articles/texts: send html_content or content
      let contentToSync: string;
      if (item.type === 'podcast_episode') {
        contentToSync = item.transcript || item.content || '';
      } else {
        contentToSync = item.html_content || item.content || '';
      }

      if (item.wallabag_id) {
        // UPDATE existing Wallabag entry
        const result = await wallabag.updateEntry(item.wallabag_id, {
          title: item.title,
          content: contentToSync,
          tags: finalTags,
          archive: item.is_archived,
          starred: item.is_starred,
        });

        if (result) {
          // Update local wallabag_updated_at to match
          await query(
            'UPDATE content_items SET wallabag_updated_at = $1 WHERE id = $2',
            [result.updated_at, item.id]
          );
          count++;
        } else {
          // Entry might have been deleted from Wallabag
          // Check if it exists
          const exists = await wallabag.fetchEntry(item.wallabag_id);
          if (!exists) {
            // Re-create it
            const newEntry = await wallabag.createEntry({
              url,
              title: item.title,
              content: contentToSync,
              tags: finalTags,
              archive: item.is_archived,
              starred: item.is_starred,
            });
            
            if (newEntry) {
              await query(
                'UPDATE content_items SET wallabag_id = $1, wallabag_updated_at = $2, url = $3 WHERE id = $4',
                [newEntry.id, newEntry.updated_at, url, item.id]
              );
              count++;
            } else {
              errors.push(`Failed to recreate item ${item.id} in Wallabag`);
            }
          } else {
            errors.push(`Failed to update item ${item.id} (Wallabag ID: ${item.wallabag_id})`);
          }
        }
      } else {
        // CREATE new Wallabag entry
        const result = await wallabag.createEntry({
          url,
          title: item.title,
          content: contentToSync,
          tags: finalTags,
          archive: item.is_archived,
          starred: item.is_starred,
          published_at: item.published_at,
        });

        if (result) {
          // Store Wallabag ID and update URL if we generated a synthetic one
          await query(
            'UPDATE content_items SET wallabag_id = $1, wallabag_updated_at = $2, url = COALESCE(url, $3) WHERE id = $4',
            [result.id, result.updated_at, url, item.id]
          );
          count++;
        } else {
          errors.push(`Failed to create item ${item.id} in Wallabag`);
        }
      }
    } catch (error) {
      errors.push(`Item ${item.id} (${item.title}): ${error}`);
    }
  }

  return { count, errors };
}
```

#### [ ] 3.5 Implement fullSync

```typescript
export async function fullSync(userId: number): Promise<FullSyncResult> {
  // Pull first to get latest from Wallabag
  const pullResult = await syncFromWallabag(userId);
  
  // Then push so that Wallacast changes win any conflicts
  const pushResult = await syncToWallabag(userId);

  return {
    pulled: pullResult.count,
    pushed: pushResult.count,
    errors: [...pullResult.errors, ...pushResult.errors],
  };
}
```

#### [ ] 3.6 Implement deleteFromWallabag

```typescript
export async function deleteFromWallabag(
  userId: number, 
  wallabagId: number
): Promise<boolean> {
  const wallabag = new WallabagService(userId);
  
  if (!(await wallabag.isEnabled())) {
    return false;  // Not an error, just skip
  }
  
  return wallabag.deleteEntry(wallabagId);
}
```

#### [ ] 3.7 Add helper functions for user settings

```typescript
async function getUserSetting(userId: number, key: string): Promise<string | null> {
  const result = await query(
    'SELECT setting_value FROM user_settings WHERE user_id = $1 AND setting_key = $2',
    [userId, key]
  );
  return result.rows[0]?.setting_value || null;
}

async function setUserSetting(
  userId: number, 
  key: string, 
  value: string, 
  isSecret = false
): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, setting_key, setting_value, is_secret)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, setting_key) DO UPDATE SET
       setting_value = EXCLUDED.setting_value,
       updated_at = NOW()`,
    [userId, key, value, isSecret]
  );
}
```

---

### Phase 4: API Routes

#### [x] 4.1 Create `backend/src/routes/wallabag.ts`

**Done:** Created route with /test and /status endpoints. Sync endpoints are stubbed for later implementation.

```typescript
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { WallabagService } from '../services/wallabag-service.js';
import { fullSync, syncFromWallabag, syncToWallabag } from '../services/wallabag-sync.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Test connection with current credentials
router.post('/test', async (req, res) => {
  try {
    const service = new WallabagService(req.user!.userId);
    const result = await service.testConnection();
    res.json(result);
  } catch (error) {
    console.error('Wallabag test error:', error);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Get sync status
router.get('/status', async (req, res) => {
  try {
    const service = new WallabagService(req.user!.userId);
    const enabled = await service.isEnabled();
    
    // Get last sync time
    const lastSyncResult = await query(
      'SELECT setting_value FROM user_settings WHERE user_id = $1 AND setting_key = $2',
      [req.user!.userId, 'wallabag_last_sync']
    );
    const lastSync = lastSyncResult.rows[0]?.setting_value || null;
    
    // Count pending changes (items that would be pushed)
    const pendingResult = await query(
      `SELECT COUNT(*) as count FROM content_items 
       WHERE user_id = $1 
       AND (wallabag_id IS NULL OR updated_at > COALESCE(wallabag_updated_at, '1970-01-01'::timestamp))`,
      [req.user!.userId]
    );
    const pendingChanges = parseInt(pendingResult.rows[0].count, 10);
    
    res.json({
      enabled,
      lastSync,
      pendingChanges,
    });
  } catch (error) {
    console.error('Wallabag status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Full bidirectional sync
router.post('/sync', async (req, res) => {
  try {
    const result = await fullSync(req.user!.userId);
    res.json(result);
  } catch (error) {
    console.error('Wallabag sync error:', error);
    res.status(500).json({ error: 'Sync failed', details: String(error) });
  }
});

// Pull only (Wallabag → Wallacast)
router.post('/pull', async (req, res) => {
  try {
    const result = await syncFromWallabag(req.user!.userId);
    res.json({ pulled: result.count, errors: result.errors });
  } catch (error) {
    console.error('Wallabag pull error:', error);
    res.status(500).json({ error: 'Pull failed' });
  }
});

// Push only (Wallacast → Wallabag)
router.post('/push', async (req, res) => {
  try {
    const result = await syncToWallabag(req.user!.userId);
    res.json({ pushed: result.count, errors: result.errors });
  } catch (error) {
    console.error('Wallabag push error:', error);
    res.status(500).json({ error: 'Push failed' });
  }
});

export default router;
```

#### [x] 4.2 Register route in `backend/src/index.ts`

Add import and use:

```typescript
import wallabagRoutes from './routes/wallabag.js';

// ... after other route registrations
app.use('/api/wallabag', wallabagRoutes);
```

**Done:** Imported wallabagRouter and registered at /api/wallabag.

---

### Phase 5: Integrate with Existing Code

#### [ ] 5.1 Modify content deletion to also delete from Wallabag

In `backend/src/routes/content.ts`, update the DELETE handler:

```typescript
import { deleteFromWallabag } from '../services/wallabag-sync.js';

router.delete('/:id', async (req, res) => {
  try {
    // Get item first to check for wallabag_id
    const itemResult = await query(
      'SELECT wallabag_id FROM content_items WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const wallabagId = itemResult.rows[0].wallabag_id;

    // Delete from Wallabag if synced (fire and forget, don't fail local delete if this fails)
    if (wallabagId) {
      deleteFromWallabag(req.user!.userId, wallabagId).catch(err => {
        console.error(`Failed to delete from Wallabag (ID: ${wallabagId}):`, err);
      });
    }

    // Delete locally
    await query(
      'DELETE FROM content_items WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting content:', error);
    res.status(500).json({ error: 'Failed to delete content' });
  }
});
```

#### [ ] 5.2 Update timestamp when content is modified

Verify that when content is updated (title, content, starred, archived), `updated_at` is set to `NOW()`. This is already done in most UPDATE queries, but verify all update endpoints do this:

- [ ] PATCH `/api/content/:id` (general updates)
- [ ] POST `/api/content/:id/star` or similar (if exists)
- [ ] POST `/api/content/:id/archive` or similar (if exists)
- [ ] Any content editing endpoints

---

### Phase 6: Frontend Updates

#### [x] 6.1 Add Wallabag API functions to `frontend/src/api.ts`

**Done:** Added wallabagAPI object with testConnection, getStatus, sync, pull, and push methods.

```typescript
// Test Wallabag connection
export async function testWallabagConnection(): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`${API_URL}/wallabag/test`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

// Get sync status
export async function getWallabagStatus(): Promise<{
  enabled: boolean;
  lastSync: string | null;
  pendingChanges: number;
}> {
  const response = await fetch(`${API_URL}/wallabag/status`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

// Full sync
export async function syncWallabag(): Promise<{
  pulled: number;
  pushed: number;
  errors: string[];
}> {
  const response = await fetch(`${API_URL}/wallabag/sync`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

// Pull only
export async function pullFromWallabag(): Promise<{
  pulled: number;
  errors: string[];
}> {
  const response = await fetch(`${API_URL}/wallabag/pull`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

// Push only
export async function pushToWallabag(): Promise<{
  pushed: number;
  errors: string[];
}> {
  const response = await fetch(`${API_URL}/wallabag/push`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}
```

#### [x] 6.2 Add sync controls to SettingsPage.tsx

**Done:** Added test connection button, connection status display, error messages, and Wallabag status info (last sync, pending changes).

#### [ ] 6.3 Add sync status indicator in app header

Add a sync status indicator next to settings button in the app header (App.tsx):
- Only shown when `wallabag_sync_enabled` is true
- Shows last sync time (e.g., "Synced 2m ago")
- Shows pending changes count if > 0 (e.g., "3 pending")
- Includes a "Sync Now" button
- Status updates after manual sync
- Clicking shows more details or triggers sync

**Implementation notes:**
- Add state in App.tsx for wallabag status
- Poll `/api/wallabag/status` periodically (every 5 min) when enabled
- Show compact status: last sync relative time + pending count
- Style to match existing header buttons

Add state:

```typescript
const [syncing, setSyncing] = useState(false);
const [syncResult, setSyncResult] = useState<{
  pulled: number;
  pushed: number;
  errors: string[];
} | null>(null);
const [connectionStatus, setConnectionStatus] = useState<'untested' | 'success' | 'failed'>('untested');
const [wallabagStatus, setWallabagStatus] = useState<{
  enabled: boolean;
  lastSync: string | null;
  pendingChanges: number;
} | null>(null);
```

Add handlers:

```typescript
const handleTestConnection = async () => {
  try {
    const result = await testWallabagConnection();
    setConnectionStatus(result.success ? 'success' : 'failed');
    if (!result.success && result.error) {
      alert(`Connection failed: ${result.error}`);
    }
  } catch (error) {
    setConnectionStatus('failed');
    alert('Connection test failed');
  }
};

const handleSync = async () => {
  setSyncing(true);
  setSyncResult(null);
  try {
    const result = await syncWallabag();
    setSyncResult(result);
    
    // Refresh status after sync
    const status = await getWallabagStatus();
    setWallabagStatus(status);
    
    if (result.errors.length > 0) {
      console.warn('Sync completed with errors:', result.errors);
    }
  } catch (error) {
    alert('Sync failed. Check console for details.');
    console.error('Sync error:', error);
  } finally {
    setSyncing(false);
  }
};

// Load status on mount
useEffect(() => {
  const loadStatus = async () => {
    try {
      const status = await getWallabagStatus();
      setWallabagStatus(status);
    } catch {
      // Ignore errors, status just won't show
    }
  };
  loadStatus();
}, []);
```

Add UI in the Wallabag section:

```tsx
{/* Connection test */}
<div className="settings-row">
  <button 
    onClick={handleTestConnection}
    disabled={!formData.wallabag_url || !formData.wallabag_client_id}
  >
    Test Connection
  </button>
  {connectionStatus === 'success' && (
    <span style={{ color: 'green', marginLeft: '0.5rem' }}>✓ Connected</span>
  )}
  {connectionStatus === 'failed' && (
    <span style={{ color: 'red', marginLeft: '0.5rem' }}>✗ Failed</span>
  )}
</div>

{/* Sync controls */}
<div className="settings-row">
  <button 
    onClick={handleSync}
    disabled={syncing || !wallabagStatus?.enabled}
  >
    {syncing ? 'Syncing...' : 'Sync Now'}
  </button>
  
  {wallabagStatus && (
    <span style={{ marginLeft: '0.5rem', fontSize: '0.9em', color: '#666' }}>
      {wallabagStatus.lastSync 
        ? `Last sync: ${new Date(wallabagStatus.lastSync).toLocaleString()}`
        : 'Never synced'}
      {wallabagStatus.pendingChanges > 0 && 
        ` • ${wallabagStatus.pendingChanges} pending`}
    </span>
  )}
</div>

{/* Sync result */}
{syncResult && (
  <div className="settings-row" style={{ 
    padding: '0.5rem', 
    background: syncResult.errors.length > 0 ? '#fff3cd' : '#d4edda',
    borderRadius: '4px',
    marginTop: '0.5rem'
  }}>
    <span>
      Pulled: {syncResult.pulled} • Pushed: {syncResult.pushed}
      {syncResult.errors.length > 0 && (
        <> • {syncResult.errors.length} error(s)</>
      )}
    </span>
  </div>
)}
```

---

### Phase 7: Dependencies and Build

#### [ ] 7.1 Add uuid package for synthetic URL generation (if needed)

Check Node version first. Node.js 19+ has `crypto.randomUUID()` built-in.

If needed:
```bash
cd backend
npm install uuid
npm install -D @types/uuid
```

Update imports in wallabag-sync.ts:

```typescript
import { v4 as uuidv4 } from 'uuid';
// Or use built-in: crypto.randomUUID()
```

#### [ ] 7.2 Verify TypeScript compilation

```bash
cd backend
npm run build
```

Fix any type errors.

#### [ ] 7.3 Test frontend build

```bash
cd frontend
npm run build
```

Fix any errors.

---

## Error Handling Reference

| HTTP Code | Meaning | Action |
|-----------|---------|--------|
| 401 | Token expired or invalid | Refresh token and retry once |
| 403 | Forbidden (bad credentials) | Log error, prompt user to check credentials |
| 404 | Entry not found | On push update: entry deleted, try create instead. On pull: entry deleted from Wallabag, consider deleting locally |
| 429 | Rate limited | Exponential backoff: wait 1s, 2s, 4s, etc. |
| 5xx | Server error | Retry with backoff, max 3 attempts |

---

## Testing Checklist

### Authentication
- [ ] Fresh credentials: token acquired successfully
- [ ] Token refresh works when access token expires
- [ ] Invalid credentials show clear error message
- [ ] Missing credentials prevent sync (gracefully)

### Pull Sync (Wallabag → Wallacast)
- [ ] New article in Wallabag appears in Wallacast
- [ ] New text (with `text` tag) appears as text type
- [ ] New podcast (with `podcast` tag or audio URL) appears as podcast_episode
- [ ] Podcast content from Wallabag stored in `transcript` field
- [ ] Updated entry in Wallabag updates local item
- [ ] Entry with `nosync` tag is skipped
- [ ] Starred/archived status syncs correctly
- [ ] Tags sync correctly

### Push Sync (Wallacast → Wallabag)
- [ ] New local article creates Wallabag entry with `article` tag
- [ ] New local text creates entry with synthetic URL and `text` tag
- [ ] New local podcast creates entry with audio URL and `podcast` tag
- [ ] Podcast `transcript` field pushed as Wallabag `content`
- [ ] Updated local item updates Wallabag entry
- [ ] Edited content (article text, transcript) pushes correctly
- [ ] Type tag is always present after push

### Content Editing
- [ ] Edit article content in Wallacast, push; Wallabag shows new content
- [ ] Edit text content in Wallacast, push; Wallabag shows new content
- [ ] Edit podcast transcript in Wallacast, push; Wallabag shows new content

### Conflict Resolution
- [ ] Edit same item in both apps, sync; Wallacast version wins

### Deletion
- [ ] Delete local item with wallabag_id; deleted from Wallabag too
- [ ] Wallabag deletion doesn't crash (fails gracefully if already gone)

### Edge Cases
- [ ] Very long content (>100KB) handles gracefully
- [ ] Special characters in tags work
- [ ] Missing URL on text item gets synthetic URL
- [ ] Podcast without transcript syncs (empty content OK)
- [ ] Multiple rapid syncs don't cause issues
- [ ] Sync with empty Wallabag account works
- [ ] Sync with empty Wallacast library works

### UI
- [ ] Test Connection button works
- [ ] Sync Now button shows progress
- [ ] Sync result shows pulled/pushed counts
- [ ] Errors displayed to user
- [ ] Last sync time displayed
- [ ] Pending changes count accurate

---

## Files Summary

### Create:
- [ ] `backend/src/services/wallabag-service.ts`
- [ ] `backend/src/services/wallabag-sync.ts`
- [ ] `backend/src/routes/wallabag.ts`

### Modify:
- [ ] `backend/src/routes/users.ts` (add setting keys)
- [ ] `backend/src/routes/content.ts` (delete integration)
- [ ] `backend/src/index.ts` (register route)
- [ ] `frontend/src/api.ts` (add API functions)
- [ ] `frontend/src/components/SettingsPage.tsx` (add UI)
- [ ] `backend/package.json` (add uuid if needed)

---

## Future Enhancements (Not in Scope)

These are not part of this implementation but could be added later:

1. **Automatic background sync** using cron/scheduler
2. **Selective sync** (choose which items to sync)
3. **Offline queue** (queue changes when offline)
4. **Sync conflict UI** (show conflicts, let user choose)
5. **Sync history/log** for debugging
6. **Import all from Wallabag** button (one-time bulk import)
7. **Webhook support** (if Wallabag supports it) for real-time sync
8. **Auto-trigger TTS generation** for newly pulled articles
9. **Auto-trigger transcription** for newly pulled podcasts (if audio accessible)
