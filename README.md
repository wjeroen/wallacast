# Wallacast

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-enabled-5A0FC8?logo=pwa&logoColor=white)

A personal read-it-later and podcast PWA that converts articles to audio (TTS) and podcasts to text (transcription). Think Wallabag/Pocket meets Podcasting. It has bidirectional wallabag sync. Optimized for LessWrong, the Effective Altruism Forum, and Substack (supports comments and LLM blocks).

Deploy it yourself to try it out, or reach out to me for a link.

**Warning: This is a vibe-coded project.** Use at your own risk. The codebase was largely written by Claude. While it works, it has not been professionally audited for security or reliability.

**If you're using a public instance**: Your API keys (OpenAI, DeepInfra, Gemini) are encrypted in the database using AES-256-GCM, but the server operator could technically decrypt them since they hold the encryption key. Your password is bcrypt-hashed (one-way, not recoverable), but a unique password is still highly recommended. If this makes you uncomfortable, you can deploy your own instance, the source code is right here.

## Core Concept

- **Articles → Audio**: Add article URLs, they're extracted and converted to speech via TTS
- **File Upload → Audio**: Upload `.html` or `.htm` files directly, treated exactly like articles
- **Texts → Audio**: Paste Markdown, plain text, or HTML, converted to audio with read-along alignment
- **Editable**: Articles and texts can be edited in a built-in Markdown editor (round-trips with Obsidian); every edit/refetch/restore is snapshotted to version history
- **Podcasts → Text**: Subscribe to podcast feeds, episodes are auto-transcribed via Whisper
- **Newsletters → Audio**: Subscribe to newsletter RSS feeds (Substack, blogs), articles treated like regular content with TTS
- **Unified Library**: All content types appear in one library with playback position tracking
- **Read-Along**: Every audio item gets a synced read-along view with per-paragraph highlighting and auto-scroll

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js, Express, TypeScript |
| Frontend | React, Vite, TypeScript (PWA enabled) |
| Database | PostgreSQL |
| Authentication | JWT tokens (access + refresh), bcrypt password hashing |
| TTS | Kokoro (hexgrad/Kokoro-82M) via DeepInfra, fallback to OpenAI gpt-4o-mini-tts (per-user API keys) |
| Transcription | Whisper via DeepInfra native endpoint (turbo default, full large-v3 selectable in Settings) with anti-hallucination params, fallback to OpenAI whisper-1 (per-user API keys) |
| TTS Preparation | OpenAI or DeepSeek models. Auto-routes based on available API keys. |
| Image Descriptions | Google Gemini for alt-text narrations (model configurable in Settings, default gemini-3-flash-preview; per-user API key, optional) |
| Article Fetching | GraphQL APIs for EA Forum/LessWrong (via got-scraping), Substack comment extraction (via _preloads JSON), standard scraper for other sites |
| Audio Processing | FFmpeg (24kHz, 96kbps MP3 - optimized for speech) |
| RSS/Atom Parsing | Custom parser supporting both RSS 2.0 and Atom feeds (podcasts & newsletters) |
| Deployment | Railway (backend, frontend, PostgreSQL as separate services) |

## Authentication & Multi-User System

Wallacast supports multiple users with complete data isolation:

- **User Registration**: Users create accounts via `/api/auth/register`
- **Per-User API Keys**: Each user stores their own OpenAI API key in Settings (encrypted in `user_settings` table)
- **JWT Authentication**: Access tokens (15min) + refresh tokens (7 days) with automatic renewal
- **Data Isolation**: All queries filter by `user_id` - users only see their own content
- **Public Audio URLs**: Audio endpoints (`/api/content/:id/audio`) are public for HTML5 player compatibility, but content IDs remain private
- **Byte-Range Support**: Audio streaming supports HTTP range requests for seeking without re-downloading

**Security Model:**
- Content IDs are not enumerable (UUIDs would be better for production)
- Audio data stored in database with proper user isolation
- No global OpenAI API key - each user must set their own
- Orphaned content (created before multi-user) is auto-assigned to first user on startup

## Quick Reference

| When working on... | Look at... |
|-------------------|------------|
| Authentication | `backend/src/routes/auth.ts`, `backend/src/services/auth.ts`, `backend/src/middleware/auth.ts` |
| User settings | `backend/src/routes/users.ts` |
| Per-user API keys | `backend/src/services/ai-providers.ts` |
| Adding content | `backend/src/routes/content.ts` |
| Wallabag sync | `backend/src/routes/wallabag.ts`, `backend/src/services/wallabag-sync.ts`, `backend/src/services/wallabag-service.ts` |
| TTS generation | `backend/src/services/openai-tts.ts` |
| Summaries (article + comments) | `backend/src/services/summarizer.ts`, `frontend/src/components/SettingsPage.tsx`, `frontend/src/components/FullscreenPlayer.tsx` |
| Image descriptions | `backend/src/services/image-alt-text.ts` |
| Transcription | `backend/src/services/transcription.ts`, `backend/src/services/whisper-prompt.ts` |
| Content-transcript alignment (LLM) | `backend/src/services/llm-alignment.ts` |
| Content-transcript alignment (legacy) | `backend/src/services/content-alignment.ts` |
| Article extraction | `backend/src/services/article-fetcher.ts` |
| Podcast feeds | `backend/src/services/podcast-service.ts` |
| Audio player (mini + fullscreen) | `frontend/src/components/AudioPlayer.tsx`, `frontend/src/components/FullscreenPlayer.tsx` |
| Read-along tab (fullscreen) | `frontend/src/components/FullscreenPlayer.tsx` |
| Markdown editor / Copy content / HTML↔Markdown conversion | `frontend/src/markdown.ts` (turndown + marked), used by `FullscreenPlayer.tsx` |
| Editing articles/texts (backend) | `backend/src/routes/content.ts` (PATCH `is_edit`) |
| Version history (edit/refetch/restore snapshots) | `backend/src/routes/content.ts` (`/:id/versions*`), `content_versions` table, History tab in `FullscreenPlayer.tsx` |
| Adding content (URL/text/HTML/Markdown upload) | `frontend/src/components/AddTab.tsx` |
| Feed/Podcasts UI | `frontend/src/components/FeedTab.tsx` |
| Library UI | `frontend/src/components/LibraryTab.tsx` |
| Library filters/search/bulk actions | `frontend/src/components/LibraryTab.tsx`, `frontend/src/store/contentStore.ts` (filter model + matcher), `backend/src/routes/content.ts` (`POST /bulk`) |
| Login/registration | `frontend/src/components/LoginPage.tsx`, `frontend/src/store/authStore.ts` |
| Settings UI | `frontend/src/components/SettingsPage.tsx` |
| All CSS styles | `frontend/src/App.css` |
| Database schema | `backend/src/database/schema.sql` |
| All types | `frontend/src/types.ts` |

## Common Bug Locations

| Problem | Where to look |
|---------|---------------|
| TTS says wrong things / bad formatting | `backend/src/services/openai-tts.ts` - Check the system prompts in `extractArticleContent()` and `formatCommentsForNarration()`. Also check `htmlToNarrationText()` for quote announcements and `formatReactionsForNarration()` for score filtering |
| Comments not extracted correctly | `backend/src/services/openai-tts.ts` - Comment extraction prompt around lines 176-250 |
| Audio player UI issues | `frontend/src/components/AudioPlayer.tsx` - UI rendering and controls |
| Content not showing in library | `frontend/src/components/LibraryTab.tsx` + `frontend/src/store/contentStore.ts` - Check filters and store state |
| Generation stuck or failing | `backend/src/routes/content.ts` - Check status updates in PATCH endpoint and `backend/src/services/openai-tts.ts` - Check error handling |
| Playback position not saving | `frontend/src/components/AudioPlayer.tsx` - Check `savePlaybackPosition()` around line 133-147. Note: saves are debounced (3s minimum change) and effects depend on `content?.id` not `content` |
| Article content extraction broken | `backend/src/services/article-fetcher.ts` - HTML fetching and cleanup (dedup images, strip title/subtitle/byline/lede, remove forms/related boxes/author bios/asides/ads), then `backend/src/services/openai-tts.ts` - LLM extraction |
| Removing audio doesn't clear read-along | `backend/src/routes/content.ts` - PATCH update handler, audio removal section (~line 407). Must clear `content_alignment`, `transcript`, `transcript_words`, `tts_chunks` alongside `audio_data`/`audio_url` |
| Read-along not working for text items | `backend/src/services/openai-tts.ts` (alignment gate), `backend/src/services/llm-alignment.ts` (content fallback), `backend/src/routes/content.ts` (html_content population) |
| Read-along alignment wrong / missing elements | `backend/src/services/llm-alignment.ts` - check `extractContentElements()` for element extraction, `buildTimedTranscript()` for transcript quality. **Never use fuzzy matching**. Fix input data quality instead (see CLAUDE.md) |
| Read-along autoscroll jumpy or skipping | `frontend/src/components/FullscreenPlayer.tsx` - `scrollToActive()` callback. Short elements use `scrollIntoView`, tall elements use progressive scroll based on audio progress |
| Tweet embeds show giant profile picture | `frontend/src/App.css` - `.article-content blockquote.twitter-tweet img` rule (should be 24x24, not 100% width) |
| Horizontal scroll / content wider than screen (long URLs in comments or article body, wide tables) | `frontend/src/App.css` - `.comment-content` / `.article-content` need `overflow-wrap: anywhere; word-break: break-word;` so long unbreakable strings wrap; `table` needs `display: block; overflow-x: auto`. Images already capped via `img { max-width: 100% }`, code via `pre { overflow-x: auto }` |
| Podcast transcription issues | `backend/src/services/transcription.ts` - Whisper integration and chunking |
| Transcript repetition/looping ("even. even. even.") or skipped speech | `backend/src/services/transcription.ts` - DeepInfra path sends `condition_on_previous_text=false` + defaults via the **native** endpoint. If loops persist: try full `whisper-large-v3` in Settings (turbo's pruned decoder loops more), then stage-add `vad: true` / `no_repeat_ngram_size: 3` to `DEEPINFRA_WHISPER_PARAMS` |
| Wallabag sync not working | `backend/src/services/wallabag-service.ts` - OAuth and API client, `backend/src/services/wallabag-sync.ts` - Sync logic, `backend/src/routes/wallabag.ts` - Endpoints |
| Cost / API usage too high | Check: (1) `backend/src/services/openai-tts.ts` for LLM content extraction, (2) Auto-generation in `backend/src/routes/content.ts` POST endpoint |

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│     Backend     │────▶│   PostgreSQL    │
│   (React/Vite)  │     │ (Express/Node)  │     │    Database     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │    OpenAI APIs      │
                    │  (TTS, Whisper,     │
                    │   GPT-5-Nano)       │
                    └─────────────────────┘
```

## Project Structure

### Backend (`/backend/src/`)

#### Entry Point
- **`index.ts`**: Express server setup, CORS, JWT auth middleware, route mounting. **Important**: Public audio endpoint (`/api/content/:id/audio`) registered BEFORE protected routes to match first. Includes database initialization with retry logic and graceful shutdown handling. On every startup, logs a `📦 [Storage]` database-size breakdown to the Railway logs (audio blobs, transcripts, word timestamps, HTML, comments, table + whole-DB totals). Check the Railway backend logs after a deploy/restart to see how much disk the data uses (used for sizing the audio-to-volume migration).

#### Configuration
- **`config/storage.ts`**: Storage directory management. Uses `/data` if Railway volume is mounted, otherwise `./public` for local dev. Provides `getAudioDir()`, `getTempDir()`, and `ensureStorageDirectories()`
- **`services/audio-storage.ts`**: File-based storage for generated article/text audio (`{id}.mp3` on the volume). Audio used to live in Postgres as a `audio_data` BYTEA blob, which Postgres cached in RAM for days (expensive, costing RAM is ~$10/GB/mo vs. disk ~$0.15-0.25/GB/mo). Generated audio now writes to disk; serving (`index.ts`) reads the disk file first and **falls back to the DB blob** for not-yet-migrated items. Provides `saveAudioFile`, `getAudioFileSize`, `deleteAudioFile`, `createAudioReadStream`, plus the one-time `migrateAudioBlobsToDisk()` (non-destructive copy, auto-runs at startup) and `clearMigratedAudioBlobs()` (destructive, env-gated by `CLEAR_AUDIO_BLOBS=true`). Podcast episodes are unaffected, their audio is an external `audio_url`.
- **`config/processing.ts`**: Centralized constants for audio/text processing (TTS chunk size: 3500 chars, Whisper limits: 25MB/15min chunks, retry config: 5 attempts with exponential backoff). Makes tuning easier without code changes.

#### Database
- **`database/db.ts`**: PostgreSQL connection pool management with connection retry logic. Auto-detects Railway's `DATABASE_URL` or individual `PG*` variables. Includes `initializeDatabase()` which runs schema and all migrations sequentially. Performs startup cleanup to reset any stuck generation tasks. **Optimized logging**: Only logs slow queries (>100ms) and write operations (INSERT/UPDATE/DELETE) to reduce noise by ~90%
- **`database/schema.sql`**: Main table definitions (`content_items`, `podcasts`, `queue_items`)
- **`database/add_*.sql`**: Migration files for additional columns (word timestamps, generation status, article metadata, comments)
- **`database/migrations/`**: Additional migrations
  - `001_add_audio_data_column.sql`: Adds BYTEA column for storing audio in database
  - `002_add_performance_indexes.sql`: Adds indexes on created_at, type, is_archived, is_favorite for query performance
  - `003_remove_is_read_column.sql`: Removes unused is_read column (was only cosmetic)
  - `004_wallabag_compatibility.sql`: Adds wallabag_id and wallabag_updated_at for sync tracking
  - `005_add_users.sql`: Adds multi-user support (users, user_settings, user_sessions tables)
  - `006_add_content_source.sql`: Adds content_source field for provenance tracking (wallabag vs wallacast)
  - `007_fix_podcast_multi_user.sql`: Fixes podcast subscriptions with composite unique constraint (feed_url, user_id)
  - `008_optimize_playback_updates.sql`: Adds composite index (id, user_id) to speed up playback position updates
  - `009_expand_podcast_language_column.sql`: Expands language column to VARCHAR(100) for longer language codes
  - `010_fix_content_source_default.sql`: Fixes column default to 'wallacast' (wallabag-sync sets 'wallabag' explicitly)
  - `010_add_podcast_show_name.sql`: Adds podcast_show_name column to content_items for denormalized display
  - `012_add_feed_type.sql`: Adds type column to podcasts table for RSS feed type detection (podcast/newsletter/blog)
  - `014_add_image_alt_text.sql`: Adds image alt-text generation support (images_processed BOOLEAN, image_alt_text_data JSONB) and user setting for toggle
  - `019_add_summary_columns.sql`: Adds summary support (`summary` TEXT, `comment_summary` TEXT, `summary_status` VARCHAR, `summary_generated_at` TIMESTAMP) for article + comment summaries
  - `020_add_content_versions.sql`: Adds the `content_versions` table. Body snapshots (html_content/content/comments, never audio) are saved before each edit/refetch/restore so changes can be rolled back
  - `021_add_summary_error.sql`: Adds `summary_error` TEXT. The error message is stored when summary generation fails, surfaced on library cards with a Retry button

#### Middleware

- **`middleware/auth.ts`**: Authentication and database readiness middleware
  - `requireAuth()`: JWT token validation middleware, extracts user from token and adds to `req.user`
  - `requireDatabaseReady()`: Returns 503 if database isn't ready yet (prevents crashes during startup)

#### Routes

- **`routes/auth.ts`**: User authentication endpoints (public, no JWT required)
  - `POST /api/auth/register` - Create new user account
  - `POST /api/auth/login` - Login with username/password, returns access + refresh tokens
  - `POST /api/auth/refresh` - Refresh access token using refresh token
  - `POST /api/auth/logout` - Revoke refresh token

- **`routes/users.ts`**: User settings management (requires JWT auth)
  - `GET /api/users/settings` - Get all settings (secrets are masked)
  - `GET /api/users/settings/:key` - Get specific setting
  - `PUT /api/users/settings/:key` - Set specific setting
  - `PUT /api/users/settings` - Bulk update settings
  - `DELETE /api/users/settings/:key` - Delete setting
  - `GET /api/users/ai-providers` - Get available AI provider config
  - `GET /api/users/prompts` - The editable-prompt registry (every LLM prompt: id, category, label, description, placeholder vars, default text, optional warning) for the Settings "Custom prompts" editor

- **`routes/content.ts`**: CRUD for content items (requires JWT auth). **All queries filter by `user_id`** for data isolation. Handles article URL fetching, auto-triggers audio generation for articles and transcription for podcasts. Notable endpoints:
  - `GET /` - List all content (excludes audio_data, html_content, comments, transcript for performance)
  - `GET /:id` - Get single item (includes comments and transcript for display)
  - `POST /status` - **Batch generation-status poll.** Body: `{ ids: number[] }` (max 500). Returns ONLY the small status fields (`generation_status`, `generation_progress`, `current_operation`, `generation_error`, `summary_status`) for all requested ids in one request (a few hundred bytes total). The library's 2s poll uses this **instead of** `GET /:id` per item. `GET /:id` returns the full transcript + 9,000+ word timestamps + alignment (~0.5MB per transcribed podcast), which polled every 2s is the same class of bug as the 80GB data incident. The full item is still fetched once, at completion, via `GET /:id`. Keep this endpoint lean. Never add large columns.
  - `POST /` - Create content, auto-extracts article HTML if URL provided. **Text items**: content is stored in both `content` and `html_content` columns so read-along/alignment works identically to articles. **HTML upload cleanup**: strips scripts/styles, fixes broken Obsidian markdown image artifacts (local `<img>` paths replaced with real URLs from `](url)` text), removes images with relative paths that can't load on the server.
  - `PATCH /:id` - Update playback position, archive status, etc. Special operations:
    - Archiving deletes audio, alignment data, and transcript to save space (unless item is favorited)
    - Un-archiving regenerates audio, transcript, and alignment if missing
    - `audio_data: null, audio_url: null` removes audio from articles/texts
    - `summary: null` removes the article + comment summaries from articles/texts
    - `dismiss_generation_error: true` / `dismiss_summary_error: true` reset a `failed` generation/summary status to `idle` and clear the stored error (the card's red error box is dismissed via its X button)
    - `regenerate_content: true` re-extracts article content through the narration LLM
    - `regenerate_transcript: true` re-transcribes podcast audio through Whisper
    - `is_edit: true` (with `html_content` + `content`). Manual Markdown/HTML edit of an article/text body. Snapshots the current body into `content_versions` first, sanitizes the HTML (strips `<script>`/`<style>`/`javascript:`), sets `content_fetched_at = now`, and leaves audio + read-along untouched (so the provenance shows content is newer than the narration). The frontend converts Markdown→HTML before sending.
  - `POST /:id/generate-audio` - Manually trigger audio generation. Body: `{ regenerate?: boolean, exclude_comments?: boolean }`. When `exclude_comments` is true, comments are omitted from the TTS narration script.
  - `POST /:id/generate-summary` - Manually trigger summary generation. Articles/texts: body + comments. Podcast episodes: the Whisper TRANSCRIPT (podcast-specific prompt). Body: `{ regenerate?: boolean, generate_transcript?: boolean }`. For podcasts without a transcript, `generate_transcript: true` runs Whisper first and chains the summary after; without it the request returns 400 with `code: 'no_transcript'` so the UI can warn. Uses the independent `summary_status` field, so it can run alongside audio generation.
  - `POST /bulk` - Bulk actions on many items in one request (used by the library's Select mode). Body: `{ action, ids }` (max 500 ids). Actions: `star`, `unstar`, `archive`, `unarchive`, `delete`, `remove_audio`, `remove_summary`. `archive` mirrors the single-item PATCH: wipes generated audio + read-along data for non-starred articles/texts (podcasts and starred items keep everything). `unarchive` deliberately does NOT auto-regenerate audio (use bulk Generate audio afterwards). `remove_audio` only touches articles/texts (podcast audio_url is source media). `delete` also fires Wallabag deletions for synced items. Returns `{ affected }`.
  - `GET /:id/audio` - **PUBLIC** endpoint (no auth) for streaming audio with byte-range support. Registered in `index.ts` before protected routes. This is required for HTML5 `<audio>` elements which can't send JWT tokens. **Serving order**: (A) podcast episodes proxy the external `audio_url`; (B) **preferred** - generated article/text audio is streamed from the disk file on the volume (`audio-storage.ts`) with 2MB-capped range requests; (C) **fallback** - if there's no disk file yet, the legacy in-DB `audio_data` blob is served via PostgreSQL `substring()` (reads only the needed bytes, never the whole blob). The live handler is the one in `index.ts`; the near-identical one in `content.ts` is shadowed dead code (TODO: remove).
  - `GET /:id/export` - Export all database fields for the item (except `audio_data`) as a zip file. Accepts JWT via `?token=` query param for direct browser download via `window.open()`. Used by the "Download data (zip)" button for debugging.
  - `GET /:id/original-html` - Fetch raw HTML from source URL (no cleaning, for debugging). Returns the page exactly as the web server sends it.
  - `GET /:id/versions` - List version-history snapshots (lean metadata only: `id`, `source`, `title`, `created_at`, `html_bytes`, `has_comments`; no bodies).
  - `GET /:id/versions/:versionId` - Fetch one version's full body (for viewing before restoring).
  - `POST /:id/versions/:versionId/restore` - Restore a version (snapshots the current body first, then overwrites; audio/read-along untouched).
  - `DELETE /:id` - Delete content and clean up audio files

- **`routes/podcasts.ts`**: Podcast and RSS feed subscription management (requires JWT auth, all queries filter by `user_id`)
  - `GET /search?q=` - Smart search: iTunes directory for text queries, RSS feed fetch for URLs (auto-detects)
  - `POST /subscribe` - Subscribe to podcast or RSS feed URL (auto-detects type: podcast/newsletter/blog)
  - `GET /:id/preview-episodes?limit&offset` - Get episodes without saving to library (for subscribed feeds), server-side paginated
  - `GET /preview-by-url?url=&limit&offset` - Preview episodes/articles from any RSS feed URL without subscribing, server-side paginated
  - `GET /search-feed?url=&q=` - Search full RSS feed for episodes matching query (searches cached XML server-side)
  - **Feed Caching (Performance Optimization)**:
    - `GET /feed-items?feedId&limit&offset` - Get cached feed items from database with pagination (instant, no network requests)
    - `POST /refresh-feeds` - Refresh all subscribed feeds from network, update cache (fetches RSS, saves to `feed_items` table)
    - `GET /last-refresh` - Get timestamp of last feed refresh

- **`routes/queue.ts`**: Manual play queue (per-user)
  - `GET /` - List queue items joined with content (aliases queue_id/queue_position/queue_added_at)
  - `POST /` - Append item to end of queue
  - `POST /front` - Insert at position 0 (used when deferred audio generation finishes)
  - `DELETE /:id` - Remove from queue and renumber positions
  - `PUT /reorder` - Update positions in bulk
  - `DELETE /` - Clear entire queue

- **`routes/transcription.ts`**: Dedicated transcription endpoint
  - `POST /content/:id` - Trigger transcription for podcast episode

- **`routes/wallabag.ts`**: Wallabag synchronization endpoints (requires JWT auth, all queries filter by `user_id`)
  - `POST /test` - Test connection with configured Wallabag instance
  - `GET /status` - Get sync status (pending changes count)
  - `POST /sync/pull` - Pull articles from Wallabag to Wallacast
  - `POST /sync/push` - Push Wallacast articles to Wallabag
  - `POST /sync/full` - Bidirectional sync (pull then push)
  - `POST /sync/cleanup` - Remove orphaned Wallabag mappings
  - `POST /full-refresh` - Nuclear option: delete all Wallabag-synced items and re-pull

#### Services

- **`services/auth.ts`**: User authentication and session management
  - `hashPassword()`, `verifyPassword()`: bcrypt password hashing
  - `generateAccessToken()`, `generateRefreshToken()`: JWT token generation
  - `verifyAccessToken()`, `verifyRefreshToken()`: JWT verification
  - `bootstrapFirstUser()`: Assigns orphaned content to first user on startup

- **`services/ai-providers.ts`**: Per-user API key management with intelligent routing
  - **Provider registry (`CHAT_PROVIDERS`)**: OpenAI, DeepInfra, OpenRouter, Anthropic, Google Gemini. All are spoken to via the **OpenAI SDK** (just a different `baseURL` + key), so one client handles every provider. OpenRouter is the easy on-ramp for Claude/Gemini/etc. (`provider/model` ids).
  - `getChatClientForJob(userId, job)`: per-job model selection. The `job` parameter is `'narration'` (prepares text for TTS) | `'alignment'` (read-along) | `'summary'`. Each job has its own `{provider, model, reasoning_effort}` setting; read-along & summaries can defer to narration ("use same model as narration"). Returns `{ client, model, extraParams }` where `extraParams` carries the reasoning_effort param (empty = provider default, so behavior is unchanged unless set). **Read-time fallback**: if a job isn't configured yet, it derives from the legacy `narration_llm` routing, so existing users keep working and the Settings fields pre-fill with the model actually in use.
  - `getChatClientForUser(userId)`: back-compat wrapper (narration job, no reasoning extraParams).
  - `getTTSClientForUser(userId, modelId)`: Intelligent router returning `{ client, model }`. DeepInfra is used for Kokoro models; for OpenAI-family models, OpenAI directly OR via OpenRouter when `openai_tts_provider === 'openrouter'` (same voices, but the model id is namespaced to `openai/…` for OpenRouter). Callers use the returned `model` for the API call.
  - `getTranscriptionClientForUser(userId)`: returns a `TranscriptionConfig` discriminated union. It can be `{ kind: 'deepinfra', apiKey, model }` (native endpoint, anti-hallucination params) or `{ kind: 'openai', client, model }` (OpenAI SDK, used for both OpenAI and OpenRouter). Built from explicit `transcription_provider` (`deepinfra` | `openai` | `openrouter`) + `transcription_model` settings, with legacy auto-routing (DeepInfra preferred) as the fallback when unset
  - `getDeepInfraClientForUser(userId)`, `getOpenAIClientForUser(userId)`: Provider-specific clients
  - `getUserSetting(userId, key)`: Fetches setting from `user_settings` table
  - No global API keys - each user must configure their own (OpenAI and/or DeepInfra, or both)

- **`services/audio-utils.ts`**: Shared audio utilities
  - `getAudioDuration()`: Get audio file duration using ffprobe (used by both TTS and transcription services)

- **`services/article-fetcher.ts`**: Fetches articles using GraphQL APIs for EA Forum/LessWrong (via got-scraping with human-like headers), standard scraping for other sites (simple fetch without custom headers to avoid Cloudflare). **EA Forum domain rewrite**: exports `normalizeEAForumUrl()` (rewrites `forum.effectivealtruism.org` → the bot-friendly mirror `forum-bots.effectivealtruism.org`, applied at add-time in `POST /api/content` so both the Add tab and RSS "add to library" store the mirror link) and `isEAForumUrl()` (the shared EA-Forum detector, matches BOTH hosts, since `forum-bots.effectivealtruism.org` does not contain the substring `forum.effectivealtruism.org`; used by `llm-alignment.ts`, `openai-tts.ts`, `wallabag-sync.ts`). The GraphQL fetch itself still targets the main host's `/graphql` endpoint (with a main-host `Referer`), so fetching is unaffected. **Substack support**: Detects Substack pages via `substackcdn.com` references (works on custom domains), targets `.body.markup` for cleaner content, extracts comments from `/comments` page via `window._preloads` JSON (structured data, not fragile CSS selectors), cleans up subscribe widgets/navbar/footer using stable `data-component-name` and `data-testid` attributes. **General cleanup**: Deduplicates images with same src URL, removes first h1 matching og:title, strips subtitle matching og:description, removes byline/lede sections, newsletter forms, "Related" boxes, share buttons, SVGs. **Strips author-set text colours** (`color`/`background-color` from inline `style` attributes, plus `data-color`) via `stripInlineColors()`. This is applied on BOTH the GraphQL and standard/Substack paths, so the reader's theme controls text colour (otherwise an author's explicit black renders black-on-dark in dark mode); other style props like `width` are kept. Extracts metadata (title, author, date, karma, comments with reactions). Returns both HTML and structured data. No LLM usage for extraction. (Note: only affects NEW fetches/refetches. Existing items need a refetch to clean up.)

- **`services/image-alt-text.ts`**: Image description generation for TTS. Provider via `image_alt_text_provider`: `gemini` (native `@google/genai` SDK, default) or `openrouter` (OpenAI-compatible vision through `chat.completions` with a base64 `image_url`, only tested with Gemini Flash 3). Requires the matching per-user key.
  - `smartRegenerate()`: Intelligently processes only new images after refetch, merges with existing descriptions. Accepts `forceRegenerate` parameter to regenerate ALL images (used when regenerating audio)
  - `downloadImage()`: Downloads images ourselves with proper headers (User-Agent, Referer) to bypass CDN blocking. 30s timeout, 100MB max size
  - `analyzeImage()`: Sends downloaded image data inline to Gemini (not urlContext). Rejects if download fails or description is invalid
  - `analyzeImageWithRetry()`: Exponential backoff retry logic (up to 5 attempts) for 503/overloaded errors
  - **Anti-hallucination protection**: Downloads images ourselves instead of relying on Gemini's urlContext (which CDNs often block). No more hallucinations from failed fetches
  - Heuristic filtering: Automatically skips decorative images (icons, logos, small images <100px) before sending to Gemini
  - Stores descriptions in JSONB (image_alt_text_data) with metadata (cost, model, processed_at)
  - Cost: ~$0.003 per article (4% of TTS cost) using Gemini 3 Flash

- **`services/openai-tts.ts`**: Main TTS service (requires per-user DeepInfra or OpenAI API key)
  - `scriptArticleForListening()`: Uses narration LLM (DeepSeek-V3.2 or GPT-5-Nano) to prepare HTML for TTS narration (formatting, date conversion, removing navigation elements). NOT used for initial article extraction.
  - `generateArticleAudio()`: Generates TTS audio using Kokoro (via DeepInfra) or OpenAI gpt-4o-mini-tts, handles chunking for long articles, concatenates with FFmpeg
  - `generateAudioForContent(contentId, regenerate)`: Orchestrates the full pipeline with progress tracking:
    - 0-20%: Process image descriptions (if enabled) using Gemini, save to JSONB. When `regenerate=true`, regenerates ALL images instead of just new ones
    - 20-30%: Prepare content for narration (scriptwriter or fallback text extraction)
    - 30-90%: Generate TTS audio chunks
    - 90-95%: Finalize audio (save to DB with `user_id`)
    - 95-97%: Auto-transcription for Read Along
    - 97-100%: LLM-based content alignment (maps HTML elements to transcript timestamps)
  - TTS features: Quote block announcements ("Quote:" / "End quote."), LessWrong score filtering (only reads user-visible karma + agreement), URL narration (reads domain name instead of full URL for links in comments)
  - Comment processing: `htmlToNarrationText()` removes emojis, announces quotes, replaces URLs with domain names (e.g., "link to example.com")
  - Uses centralized config from `processing.ts` for chunk sizes, retry logic with exponential backoff

- **`services/summarizer.ts`**: Twitter-thread style summaries (requires per-user DeepInfra or OpenAI API key)
  - `generateSummaryForContent(contentId)`: Produces TWO summaries: an article-body summary and (optionally) a comment-discussion summary. Uses the same narration LLM router as TTS (`getChatClientForUser`). Runs independently of audio via its own `summary_status` column, so audio + summary can generate at the same time. **Retries** each LLM call with exponential backoff (`chatCreateWithRetry`, using `PROCESSING_CONFIG.retry`) on connection errors (e.g. "Premature close" on a reused keep-alive socket, such as Node #63989) and 429/5xx; 4xx are not retried. On final failure it stores the message in `summary_error`. (Summaries previously had no retry, so these surfaced as failures while TTS/transcription, which already retry, silently recovered.)
  - **Podcast episodes**: summarizes the Whisper TRANSCRIPT with a podcast-specific prompt (names hosts/guests, ignores ads/sponsor reads) and an `EPISODE/SHOW/HOST` header; no comment summary. The RSS episode description is included as a labeled CONTEXT block. It usually spells guest names correctly while the transcript mangles them, so the prompt says to trust the description's spelling on conflicts; the description itself is never summarized and is excluded from the length-tier character count (transcript only).
  - **Length logic**: the article/comment character count is measured **in code** (never by the model); the matching tier from `summary_tiers` sets `maxTweets`, which is injected into the prompt. The unbounded catch-all tier stores `maxChars` as `null` (Infinity).
  - The comment summarizer is given the article as **context only**; the article summarizer is not given the comments.
  - **Custom prompts**: all six summary prompts (article / comment / podcast, each with a single-paragraph and a multi-paragraph variant) are exported defaults (`*_SUMMARY_MULTI_DEFAULT` / `*_SUMMARY_SINGLE_DEFAULT`) and editable from Settings via the **central prompt registry** (see `prompt-registry.ts` / `prompt-resolver.ts` below). `buildSummaryPrompt()` picks the single- vs multi-paragraph variant by the tier's `maxTweets`, then `resolveCustomPrompt()` applies the user's override (key `prompt_summary_<kind>_<single|multi>`) or the default and fills `{maxTweets}`/`{maxWords}`. **Known gotcha for newsletters/digests**: the default multi-paragraph article prompt's "develop a single central thesis / single line of reasoning" framing pushes the model to summarize only the lead story of a multi-section newsletter. (The old "...rather than trying to cover them all" clause on the roundup line was removed 2026-06-27.) Edit `summary_article_multi` in Settings to make it cover every section.
  - User settings: `auto_generate_summary` (auto-create on add), `summarize_comments` (default on), `summary_tiers` (editable JSON list of `{ maxChars, maxTweets }`). Prompt overrides live under `prompt_*` keys (see the prompt registry).

- **`services/prompt-resolver.ts`** + **`services/prompt-registry.ts`**: **Central editable-prompt system.** Every LLM prompt in the app keeps its built-in default as an exported const in its own service file, and resolves it at call time through `resolveCustomPrompt(userId, 'prompt_<id>', DEFAULT, vars)` (prompt-resolver.ts). A non-empty per-user override from `user_settings` wins, else the default; `{placeholders}` are filled via `fillPrompt()`. `prompt-registry.ts` collects all 10 defaults + UI metadata (id, category, label, description, placeholder vars) and is served to Settings via `GET /api/users/prompts`. **The 10 editable prompts**: 6 summary (article/comment/podcast × single/multi, in `summarizer.ts`), 2 narration (`NARRATION_SCRIPT_DEFAULT` + retry addendum, in `openai-tts.ts`), 1 read-along alignment rules block (`ALIGNMENT_RULES_DEFAULT`, in `llm-alignment.ts`), 1 image description (`IMAGE_DESCRIPTION_DEFAULT`, in `image-alt-text.ts`). The registry refactor kept the defaults identical to the old inline strings (they've since been lightly copy-edited, e.g. em dashes removed), so behavior only changes when a user overrides a prompt. prompt-registry imports the service defaults; services import only prompt-resolver, so there's no import cycle. (Note: editing the narration scriptwriter or alignment rules can affect audio/read-along quality, but per project rules the read-along alignment must stay LLM-only. Never add fuzzy/algorithmic matching to the *code*, regardless of prompt wording.)

- **`services/whisper-prompt.ts`**: Shared utility for building Whisper prompt hints
  - `buildWhisperPrompt(item)`: Builds a prompt string from content metadata (title, author, date, podcast show name, comments) so Whisper recognizes key phrases like "Comments section:", commenter names, and dates
  - Used in all three transcription paths: POST / (auto-transcribe), PATCH /:id (regenerate), and transcription route

- **`services/transcription.ts`**: Podcast transcription using Whisper (requires per-user OpenAI/DeepInfra API key)
  - `transcribeWithTimestamps(audioUrl, userId, initialPrompt?)`: Returns word-level timestamps for sync. Accepts optional Whisper prompt hint to improve recognition of key phrases like "Comments section:" and comment headers
  - Uses centralized config from `processing.ts` for file size limits, chunk duration, compression thresholds
  - Handles large files by splitting into chunks (uses actual ffprobe duration for chunk time offsets), compresses audio before transcription if needed
  - **Two transports (branch on `TranscriptionConfig.kind`)**: **DeepInfra** uses the **native** inference endpoint (`POST /v1/inference/{model}`, raw multipart via `globalThis.fetch`) because only the native endpoint honors Whisper's anti-hallucination params. We send `chunk_level=word` + `word_timestamps=true` (**required**, the native endpoint defaults `chunk_level=segment`/`word_timestamps=false`, which returns segment text only and breaks read-along; `extractDeepInfraWords()` then reads the per-word data whether it lands in the top-level `words` array or nested in `segments[].words`), `condition_on_previous_text=false` (the headline fix: stops the 30s-window repetition loops like "even. even. even."), `temperature=0`, and the Whisper default thresholds (`vad` / `no_repeat_ngram_size` are intentionally NOT set yet. These are staged follow-ups). Native returns words as `{start, end, text}`, remapped to `{word, start, end}`; if words are ever missing, `wordsFromSegments()` interpolates timings from the segment spans so read-along degrades gracefully instead of breaking. **OpenAI/OpenRouter** stay on the OpenAI SDK (`client.audio.transcriptions.create`, OpenAI-shaped endpoint, no such params).
  - **Prompt strategy**: OpenAI-shaped path keeps the hybrid prompt (chunk 1 = full prompt up to 1000 chars, chunk 2+ = metadata first 600 chars + last 200 chars of previous transcript). The DeepInfra path sends **no prompt**. Feeding the previous chunk's tail is exactly what seeds cross-chunk loops, and `condition_on_previous_text=false` covers continuity.

- **`services/llm-alignment.ts`**: LLM-based content-to-transcript alignment for read-along tab (replaces Needleman-Wunsch approach)
  - `generateLLMAlignment(contentId, userId, words)`: Main entry point. Extracts HTML content elements, builds timed transcript from Whisper words, sends both to the user's configured narration LLM, parses timestamps
  - `extractContentElements()`: Parses HTML with JSDOM into block-level elements (h1-h6, p, ul, ol, blockquote, figure, img, pre, table, div.llm-content-block), prepends title/author/date/karma as meta elements. **Lists are split into one element per `<li>`** (each re-wrapped in its `<ul>`/`<ol start=N>` so bullets/numbers still render) so read-along highlights item-by-item instead of the whole list at once. This only shapes the alignment data, the stored `html_content` is untouched. LessWrong/EA Forum LLM content blocks are extracted as `llm-block` type with `modelName` from `data-model-name` attribute
  - `extractCommentElements()`: Flattens nested comments recursively with depth tracking and metadata (username, date, karma, reactions)
  - `buildTimedTranscript()`: Groups Whisper words into sentences (splitting at `.?!` boundaries) with one timestamp per line (e.g., `[14.2] I've just started a blog about effective altruism.`), giving the LLM natural sentence context for text matching
  - Uses `getChatClientForUser()` for LLM routing (DeepSeek-V3.2 via DeepInfra preferred, OpenAI GPT-5-Nano fallback)
  - **IMPORTANT**: Alignment is done EXCLUSIVELY by the LLM. Never use fuzzy matching or algorithmic alignment (see CLAUDE.md)
  - Returns `LLMAlignmentResult` with `version: 'llm-v1'`, `elements[]` (each with type, html, startTime), `commentsStartTime`
  - Enforces non-decreasing timestamps in output
  - Post-processing: fixes comment-divider placement and searches for body text in raw Whisper words when headers are dropped (applies to ALL comments, not just the first)
  - Prompt includes explicit rules for images (spoken as "An image shows...") and footnotes (not spoken, inherit previous timestamp)
  - Stored in `content_alignment` JSONB column (same column as old Needleman-Wunsch data)

- **`services/content-alignment.ts`**: Legacy Needleman-Wunsch content alignment (no longer used for new alignments, kept for backward compatibility with existing data)

- **`services/podcast-service.ts`**: RSS feed parsing (podcasts, newsletters, blogs) with database caching
  - `searchPodcasts()`: Search iTunes podcast directory (returns podcast feeds only)
  - `searchRSSByUrl()`: Fetch and parse any RSS feed by URL (auto-fixes Substack URLs by adding /feed suffix)
  - `fetchPodcastDetails()`: Extracts feed metadata and auto-detects type (podcast vs newsletter) based on MIME types
  - `detectFeedType()`: Analyzes feed items - checks if enclosures are `audio/*` (podcast) or `image/*` (newsletter)
  - `fetchPodcastEpisodes()`: Gets episodes and saves to DB
  - `getPreviewEpisodes()`: Gets episodes/articles without saving, with server-side pagination via offset/limit (iterative regex parsing, stops early)
  - `searchFeedEpisodes()`: Searches full cached XML feed for episodes matching a query string
  - `extractNestedXMLTag()`: Handles nested XML structures like Substack's `<image><url>...</url></image>`
  - **XML Cache**: In-memory cache for downloaded RSS XML (5-min TTL, max 20 feeds). Avoids re-downloading on each Load More or search request. Used by `getPreviewEpisodes()` and `searchFeedEpisodes()`.
  - **Feed Caching (Performance Optimization)**:
    - `refreshFeedFromNetwork()`: Fetches RSS feed, parses items, saves to `feed_items` table, cleans up old items (keeps 100 most recent)
    - `refreshAllFeedsFromNetwork()`: Refreshes all subscribed feeds for a user sequentially
    - `getCachedFeedItems()`: Loads feed items from database (instant, no network requests)
    - `getLastRefreshTime()`: Returns timestamp of last feed refresh
  - Simple regex-based XML parsing (no XML library) with support for both attributes and nested tags

- **`services/wallabag-service.ts`**: Wallabag API client (requires per-user credentials)
  - `testConnection()`: Validates Wallabag credentials (URL, client ID/secret, username/password)
  - `getToken()`: OAuth2 token acquisition with automatic refresh
  - `getEntries()`: Fetch articles from Wallabag (supports pagination, filtering by archived/starred)
  - `createEntry()`, `updateEntry()`, `deleteEntry()`: CRUD operations for Wallabag articles
  - Each service instance is tied to a specific user's credentials from `user_settings`

- **`services/wallabag-sync.ts`**: Bidirectional sync logic between Wallacast and Wallabag
  - `syncFromWallabag()`: Pull articles from Wallabag, create/update in Wallacast
  - `syncToWallabag()`: Push Wallacast articles to Wallabag, handles creates and updates
  - Auto-refetches EA Forum and LessWrong articles from the web after import (wallabag can't handle SPAs)
  - `fullSync()`: Orchestrates bidirectional sync (pull then push)
  - Conflict resolution: Wallacast always wins (uses `wallabag_updated_at` to detect changes)
  - Tracks sync state with `wallabag_id` and `wallabag_updated_at` fields on `content_items`

### Frontend (`/frontend/src/`)

#### Entry Point
- **`main.tsx`**: React root with StrictMode
- **`App.tsx`**: Main app component. Manages tab navigation and current playing content state.

#### State Management
- **`store/contentStore.ts`**: Zustand store for centralized content state management
  - Fetches all items once on mount, stores in `allItems` master list; `items` is the filtered view
  - **Filter model**: `LibraryFilter` = `{ typeFilter: 'all'|'articles'|'texts'|'podcasts', statusFilter: 'active'|'favorites'|'archived', searchQuery }`. The exported `itemMatchesFilter(item, filter)` is the single matcher, also used by `queueStore` for the "Up next" stream; `getSearchSnippet()` returns the "matched in text" excerpt for cards
  - **Client-side filtering**: switching filters or typing in search is instant, no API call, just an array `.filter()` on the master list (an internal `commit()` helper re-derives `items` + `allCount` after every mutation)
  - Provides optimistic updates for instant UI feedback (star, archive, delete), all mutations update both `allItems` and `items`
  - Handles Wallabag bidirectional sync state

- **`store/authStore.ts`**: Zustand store for authentication state
  - Manages user login/logout state, JWT token storage in localStorage
  - `login()`, `register()`, `logout()`: Auth operations with automatic token management
  - `checkAuth()`: Validates existing tokens on app load
  - Token refresh handled automatically by API client

#### Components

- **`components/LoginPage.tsx`**: User authentication UI
  - Login/registration form with toggle between modes
  - Displays auth errors from authStore
  - Uses lucide-react icons for visual polish
- **`components/LibraryTab.tsx`**: Main library view. Uses Zustand store for state. Polls for generation progress updates; cards display karma (upvote count) and comment count with icons. "Generate All Audio" button is in the user dropdown menu (top-right).
  - **Filters (two dimensions, one row)**: search icon + status selector + type chips (All / Articles / Texts / Podcasts). The status selector always shows the current status's icon and label with a chevron (Inbox "Active" / Star "Favorites" / Archive "Archived", always highlighted) and opens a menu with the same icons; the dimensions combine (e.g. Podcasts + Archived). The active type chip shows its item count. Only the type-chip strip scrolls horizontally on small screens (search/status selector stay fixed so the dropdown isn't clipped). Semantics: Active = not archived, Favorites = starred (incl. archived), Archived = archived. Filtering is client-side via `itemMatchesFilter()` in `contentStore.ts` (shared with the queue's "Up next" stream).
  - **Search**: search icon expands into a full-width debounced search bar. Client-side, case-insensitive substring over title, author, description, tags, podcast show name AND the full body text (`content` column, already in the list response). Cards matching only in the body show a "matched in text: …" snippet. No fuzzy matching.
  - **Bulk selection mode**: Select button toggles checkboxes; cards keep their star/archive buttons visible (they show each item's state), while delete and the per-item dropdown hide. Bulk bar (shown immediately, even at 0 selected): count, All/None, then Gmail-style smart toggles. Star stars mixed selections and unstars when everything selected is already starred (gold icon); Archive likewise flips to Unarchive (blue) when all selected are archived, and Delete (red). Each is ONE request via `POST /content/bulk`. The overflow (⋮) menu holds Remove audio, Remove summaries, and sequential Generate audio / Generate summaries / Refetch from web (cost-confirm dialogs with item counts, progress counter, per-card status badges via the existing poll). Bulk Generate summaries includes podcasts: episodes without a transcript trigger a warning modal that can chain transcript + summary, or skip them. Selection is cleared whenever filters or search change, so select-all only ever acts on visible items.
  - Each content card has a dropdown menu (3 dots) with context-specific options:
  - **Articles/Texts**: Generate audio, Regenerate audio (if exists), Remove audio (if exists)
  - **Articles only**: Regenerate content (re-extracts through LLM)
  - **Podcasts**: Generate transcript (if none), Regenerate transcript (if exists)

- **`components/ContentCard.tsx`**: The library item card (thumbnail, title, metadata badges, generation status, star/archive/delete + dropdown menu). Extracted from LibraryTab, all state/handlers stay in LibraryTab and come in as props. **Failed generation AND failed summary both show a red error box with the message, a Retry button and a dismiss X** (`onDismissError` → PATCH `dismiss_generation_error`/`dismiss_summary_error`). The generation Retry re-runs the step that actually failed: the backend tags refetch/transcript failures via `current_operation` (`'failed_refetch'`/`'failed_transcript'`), podcasts always retry transcription, and everything else retries audio generation; summary Retry regenerates the summary.

- **`components/FeedCards.tsx`**: Shared Feed tab cards, `FeedCard` (podcast/newsletter rows + the expanded selected-feed card, variants: `search-result`/`subscription`/`expanded`) and `FeedEpisodeCard` (episode/article rows used by all three Feed tab lists). Action buttons are passed in by the caller. Replaces seven copy-pasted card JSX blocks.

- **`format.ts`**: Shared formatting helpers (`cleanHtml`, `formatDuration`, `getDomainFromUrl`, `toTweets`) previously duplicated across components. (`htmlToMarkdown` moved to `markdown.ts`.)

- **`markdown.ts`**: Shared HTML↔Markdown conversion used by the editor AND "Copy content" (so they produce identical output). `htmlToMarkdown()` uses **turndown** + **turndown-plugin-gfm**; `markdownToHtml()` uses **marked** (GFM). Custom rules make Wallacast's special structures round-trip losslessly while staying Obsidian-friendly: LessWrong/EA Forum LLM blocks (`div.llm-content-block`) ↔ Obsidian callout `> [!ai] <model name>`, tweet embeds (`blockquote.twitter-tweet`) ↔ `> [!tweet]`. Tables → GFM pipe tables, links/bold/italic native. Images use standard `![alt](url)`, and a bare image's explicit pixel width is preserved via Obsidian's `![alt|WIDTH](url)` resize syntax (stored back as a `width` attribute). **Footnotes** (LessWrong/EA Forum `#fnXXX`, Substack `#footnote-N`) convert to/from Markdown footnote syntax, `[^n]` references + `[^n]: …` definitions (renumbered 1..N, back-link carets dropped); `markdownToHtml()` rebuilds them into one canonical, clickable `<section class="footnotes">` with `fn-N`/`fnref-N` ids. **`<figure>` elements that carry a caption or a width are kept as raw HTML** (Markdown can't express a `<figcaption>` or a percentage width). A bare `<figure><img></figure>` still flattens to a plain Markdown image. Other specific tags with no clean Markdown equivalent (`iframe`, `sub`, `kbd`, `video`, `audio`, and non-footnote `sup`) are likewise kept raw. (Note: turndown's default for *unlisted* wrapper tags is to unwrap them, so this raw-keep is an explicit per-structure list, not a blanket guarantee.) `markdownToHtml()` strips `<script>`/`<style>` (the backend strips again on save).

The matching CSS (`App.css`) caps every image at the column width (`max-width: 100% !important`, so no horizontal scrollbars) and only force-stretches images that have **no** explicit width, so a bare narrow image keeps its size instead of ballooning.

- **`components/FeedTab.tsx`**: Podcast and RSS feed discovery and management with database caching
  - **Smart Search**: Detects URLs vs search terms - iTunes podcast search for text, RSS feed fetch for URLs (auto-fixes Substack by adding /feed)
  - **Search Results**: Click any result to preview episodes/articles before subscribing. "Show All Search Results" button clears preview and returns to search results
  - **Episode Search**: Search within any podcast/RSS feed for specific episodes (searches full feed server-side via XML cache)
  - **Subscriptions**: Collapsible section (collapsed by default) showing all subscribed feeds (podcasts + newsletters) with type icons and unsubscribe option
  - **Recent Updates**: Server-side paginated feed items from database cache. Load More fetches next 50 items via offset.
  - **Podcast/Search Detail**: Server-side paginated via XML cache. Load More fetches next 50 episodes from cached RSS XML without re-downloading.
  - **Refresh Button**: Next to "Recent Updates" heading - refreshes all feeds from network, shows last refresh time ("5 mins ago")
  - **Performance**: Database caching eliminates 70+ network requests per page load (instant instead of 30+ seconds for 70 subscriptions)
  - **Feed Detail View**: Click a feed to see expanded card with full description + that feed's content. "Show All Subscriptions" button to return to full list
  - **Feed Type Icons**: Podcast icon (microphone) for podcasts, Newspaper icon for newsletters. Link icon in search bar when URL detected
  - **Add to Library**: Plus button on each episode/article adds it to library (respects auto-generate audio setting for articles)
  - **Authentication**: Uses axios API client with automatic Bearer token injection (no raw fetch)
  - Uses same card styling as Library tab (content-card class, 80x80 thumbnails, `1h 23m` duration format)

- **`components/AddTab.tsx`**: Content addition form. Supports article URLs, plain text, HTML file uploads, and manual podcast episodes. Adds created content directly to store. HTML uploads are stored as `type='text'` items with the HTML as content, getting the same read-along/alignment/TTS treatment as regular articles. The **Text** type has a **Markdown / HTML format toggle** (Markdown is the friendly default, converted to HTML via `markdown.ts` `markdownToHtml()` before saving; HTML mode passes raw HTML through, cleaned server-side).

- **`components/SettingsPage.tsx`**: User settings management UI
  - **Section order** (top to bottom): Account, Audio generation, Summaries, Playback, API keys, Models, Wallabag sync.
  - **Audio generation** section is deliberately thin, only the "what runs automatically" toggles: auto-generate audio for articles, auto-transcribe podcasts, and the comment-narration toggles (EA Forum/LessWrong, Substack) + the max-comments cutoff. No model pickers live here anymore.
  - **Summaries** section has a "Length settings" collapsible (words-per-paragraph + the length-tier editor). The editable-prompt UI is now its own top-level **"Custom prompts (advanced)"** section (covers all prompt categories, not just summaries).  - **API keys** section (**OpenRouter listed first**): OpenRouter, DeepInfra, OpenAI, **Anthropic** (key page at `platform.claude.com`), Gemini. The section intro links to OpenRouter's **Compare model pricing** page (useful for picking any model, not just OpenRouter's). Each key has a two-line description, with line 1 listing the jobs it can power (from: narration, read-along, summaries, TTS, transcription, image descriptions), and line 2 is a "Get a key" link. **OpenRouter covers chat jobs, image descriptions, and Kokoro TTS voices**, but NOT transcription (verified 2026-07-02: its audio endpoint returns no word timestamps, which read-along needs) and not the OpenAI voices (OpenRouter carries no OpenAI TTS models). So transcription always needs a DeepInfra or OpenAI key. **Gemini does chat too**, so it covers narration/read-along/summaries on top of image descriptions.
  - **Models** section (below API keys): every provider/model picker lives here as a uniform "AI job card". Narration / Read-along alignment / Summaries each get a **provider dropdown + free-text model field** (placeholder hints change per provider) + a **reasoning-effort field** (blank = provider default). Read-along & summaries have a left-aligned "Use the same model as Narration" checkbox (ticked by default). Transcription has its own provider (DeepInfra/OpenAI) + model. **TTS voices** is its own card (voice picker grouped by `Model name (Provider)`, e.g. `gpt-4o-mini-tts (OpenAI)`, `Kokoro-82M (DeepInfra or OpenRouter)`), with a **"Kokoro voices via" toggle (DeepInfra | OpenRouter)**, same Kokoro voices routed through whichever key (OpenAI voices always use the OpenAI key). **Image descriptions** is its own card with the enable checkbox inside it; **provider toggle Gemini | OpenRouter** + free-text model field (noted as only tested with Gemini Flash 3). Chat cards render via the `renderChatJob()` helper. Each field (Provider / Model / Reasoning effort) has a small caption above it so placeholders only show examples. Fields pre-fill with the model actually in use, such as chat jobs from your current `narration_llm`, and Transcription/Image descriptions with their effective defaults (`whisper-1` or `openai/whisper-large-v3-turbo`, and `gemini-3-flash-preview`), so the blanks don't make it look like nothing's configured.
  - **Custom prompts (advanced)** section (placed below the Models section): a registry-driven editor fetched from `GET /api/users/prompts`. One collapsible per category (Summaries / Narration / Read-along alignment / Image descriptions), each header showing an "(N customized)" count; inside, an editable textarea per prompt pre-filled with the saved override or the built-in default, with the prompt's description, its `{placeholder}` list, a "(customized)" tag, and a "Reset to default" button. On save, a box left identical to the default is stored empty (= keep the built-in default, so future default tweaks still flow through); only genuine edits persist to `prompt_<id>`.
  - All settings descriptions use one consistent muted colour (`.settings-hint` / `.section-description` → `var(--t3)`); section intros use `.section-description`. No more ad-hoc `#666`/`#888`/blue inline colours.
  - Comment Narration toggles: separate on/off toggles for EA Forum/LessWrong comments and Substack comments (allows users to skip comment audio on a per-platform basis). When disabled, comments still display in read-along view but without audio sync
  - Wallabag integration settings (URL, client ID/secret, username/password)
  - Test connection buttons for validating credentials
  - Sync controls (pull, push, full sync) with status indicators

- **`components/AudioPlayer.tsx`**: Manages audio playback state (HTMLAudioElement, position saving, speed, sleep timer). Renders either the compact MiniPlayer (above the bottom tab bar) or the FullscreenPlayer overlay. Items WITHOUT audio render fullscreen only (the mini player is playback chrome, so it never shows for them and the fullscreen minimize button hides). Handles the iOS headphone-disconnect guard, play/pause icon sync, and podcast audio proxying through the backend.

- **`components/FullscreenPlayer.tsx`**: The expanded fullscreen overlay. Contains all tab rendering:
  - **Content tab** (articles/texts; default when there's no read-along): the current `html_content` rendered as formatted text, plus comments below. Has an **Edit** button → opens a **Markdown editor** (textarea with Write/Preview toggle; uses `markdown.ts`). Saving converts Markdown→HTML, snapshots the old body to version history, and treats the edit like a fresh fetch (audio + read-along are left untouched-but-outdated until regenerated). Articles also keep the **Refetch from web** button here. **Footnotes are clickable**: a small handler (`handleAnchorNav`) intercepts in-page `#…` link clicks and smooth-scrolls the target into view inside the player (marker → definition and back) without changing the URL, working on native LessWrong/EA/Substack anchors and our canonical `fn-N` ones.
  - **Read-along tab** (articles/texts with audio/alignment, podcasts): synced read-along view with LLM alignment, where every paragraph, heading, image, and comment gets its own timestamp and blue-left-border highlight as audio plays. Read-only and tied to the **audio version** of the text. Default tab when it exists. (Content and Read-along were one merged tab before; they're split so the editable live text and the frozen synced view are cleanly separated.)
  - **History tab** (articles/texts, only once at least one prior snapshot exists): lists version-history snapshots (saved before each edit/refetch/restore, never audio) with View and Restore. Restore snapshots the current body first (so it's undoable).
  - **Description tab** (podcasts only): Podcast episode description with HTML formatting
  - **Queue tab**: Spotify-style play queue. "In queue" section lists user-added items (with per-row remove + Clear). A horizontal divider separates it from "Up next from [filter]", a virtual queue derived from the library filter captured at click-time (frozen snapshot of type + status + search query; matching uses the shared `itemMatchesFilter` from `contentStore.ts`). The stream pivot is position-based on the full id stream (shuffle order or library order), so archiving the playing item mid-track doesn't reset the stream. Shuffle preference persists via the `queue_shuffle` setting; the order is built lazily on first use (safe even when settings hydrate before the library loads). Per-session shuffle toggle reorders only the non-manual stream. Manual items without audio prompt generate-or-skip; on generate, the item re-inserts at position 0 once audio is ready (pending-requeue poller in App.tsx). Autoplay toggle (Repeat icon in player options) gates continuation into non-manual items. Prev/Next buttons in playback controls jump through manual items then non-manual when autoplay is on. State lives in `store/queueStore.ts`.
  - **Auto-scroll**: Toggle in tab header. Short elements snap to center; tall elements (bullet lists, long comment blocks) use progressive intra-element scrolling that follows audio progress, with the top visible at start and bottom at end
  - Clickable elements seek the audio to that timestamp
  - Tweet embeds (`blockquote.twitter-tweet`) styled as cards with 24px circular profile pictures (not full-width)
  - LLM content blocks (LessWrong/EA Forum `div.llm-content-block`): displayed in serif font with purple left border and model name badge (e.g., "Claude Opus 4.6"). TTS narration announces model attribution
  - Content versioning: two-line provenance display showing "Content fetched/updated by [source] on [date]" and "Audio & read-along generated on [date]" with Show/Shown toggle. Shows "(newer)"/"(older)" labels when content and audio are out of sync. Works for both articles and texts.
  - **Dropdown menu** (three-dot icon, left of minimize button): Same options as library item dropdown, including generate/regenerate audio, remove audio, regenerate transcript, refetch from web, "Copy content" (copies title/author/date/link/body/nested comments to the clipboard as Markdown via `htmlToMarkdown()` in `markdown.ts`, now preserving images, links, and inline formatting identical to what the editor shows), and "Download data (zip)"

#### Other Files
- **`api.ts`**: Axios-based API client with credential support for HTTP Basic Auth
- **`types.ts`**: TypeScript interfaces for ContentItem, Podcast, QueueItem, Comment, Settings (field names aligned with Wallabag API)
- **`App.css`**: All styles (single CSS file, no modules)
- **`index.css`**: Base styles from Vite template

### Progressive Web App (PWA)

Wallacast is a fully-functional Progressive Web App that can be installed on mobile and desktop devices:

**Installation:**
- **Mobile (iOS/Android)**: Visit the site in your browser, tap the Share button (iOS) or browser menu (Android), and select "Add to Home Screen" or "Install app"
- **Desktop**: When you visit the site, modern browsers (Chrome, Edge, Safari) will show an install prompt in the address bar

**PWA Features:**
- **Standalone App Window**: Launches in its own window without browser UI (no address bar, tabs)
- **App Icons**: Custom wallacast icons at all required sizes (48px to 512px) for home screen, taskbar, and app launcher
- **Offline Support**: Service worker caches static assets (HTML, CSS, JS) for offline access to the app shell
- **Background Caching**: Network-first strategy for API calls with cache fallback ensures functionality even with poor connectivity
- **Theme Colors**: Custom theme color (`#2563eb`) for browser/OS UI integration

**Implementation Files:**
- **`public/manifest.json`**: Web app manifest defining app name, icons, display mode, theme colors
- **`public/service-worker.js`**: Service worker implementing caching strategies (cache-first for static assets, network-first for API calls, audio streams bypass SW for native byte-range seeking)
- **`main.tsx`**: Service worker registration on app load
- **`index.html`**: PWA meta tags, manifest link, favicons, iOS-specific meta tags
- **`public/AppIcons/`**: Icon assets organized by platform (android, ios, windows11)

**Caching Strategy:**
- Static assets (HTML, CSS, JS, icons): Cache-first with background refresh for responsiveness
- API calls (`/api/*`): Network-first with cache fallback for reliability
- Cache version: `wallacast-v1` (increment to force cache refresh on updates)

**Note**: The PWA works best when deployed over HTTPS (required for service workers). Railway automatically provides HTTPS.

## Database Schema

Field names are aligned with Wallabag API for future bidirectional sync. All content tables have `user_id` foreign keys for multi-user data isolation.

### users
- `id`: Primary key (auto-increment)
- `username`: Unique username for login
- `email`: User email (optional)
- `password_hash`: bcrypt hashed password
- `display_name`: Display name
- `is_active`: Account status
- `created_at`, `last_login_at`

### user_sessions (JWT refresh tokens)
- `id`: Primary key
- `user_id`: FK to users table
- `refresh_token_hash`: bcrypt hashed refresh token
- `expires_at`: Token expiration (7 days)
- `revoked_at`: Manual revocation timestamp
- `created_at`

### user_settings (per-user configuration)
- `id`: Primary key
- `user_id`: FK to users table
- `setting_key`: Setting name (e.g., 'openai_api_key', 'openai_tts_voice')
- `setting_value`: Setting value (encrypted for secrets)
- `is_secret`: Boolean flag for masking in API responses
- Summary-related keys: `auto_generate_summary` ('true'/'false'), `summarize_comments` ('true'/'false', default on), `summary_tiers` (JSON list of `{ maxChars, maxTweets }`; the unbounded tier stores `maxChars: null` = Infinity), `summary_max_words` (max words per paragraph/"tweet"; default 40), `library_show_summary` ('true'/'false')
- **Editable-prompt overrides**: `prompt_<id>` keys (e.g. `prompt_summary_article_multi`, `prompt_narration_script`, `prompt_alignment_rules`, `prompt_image_description`) hold an optional custom system prompt for each LLM job; blank/whitespace = use the built-in default. The full id list + defaults come from `services/prompt-registry.ts` (served at `GET /api/users/prompts`). The whitelist of valid keys is spread from `PROMPT_SETTING_KEYS`, so adding a prompt to the registry automatically makes its key saveable. When on, library cards show the article `summary` instead of the description (falls back to the description when no summary exists; the list endpoint now also returns `summary`)
- `tts_voices`: JSON array of `{ model, voice }`. When non-empty, each audio generation picks one of these voices at random (can mix providers, e.g. OpenAI + Kokoro). Empty = always use the single `openai_tts_voice`. Implemented via `pickRandomTTSVoice()` in `ai-providers.ts`, applied in `generateArticleAudio()`.
- **Provider keys**: `openai_api_key`, `deepinfra_api_key`, `openrouter_api_key`, `anthropic_api_key`, `gemini_api_key` (all secret/masked)
- **Per-job model config** (read by `getChatClientForJob`): `{job}_provider` / `{job}_model` / `{job}_reasoning_effort` for `job` ∈ `narration | alignment | summary`; `alignment_same_as_narration` / `summary_same_as_narration` ('true'/'false') defer to the narration config. `narration_llm` is the LEGACY routing kept only as the read-time fallback/pre-fill source.
- **Transcription**: `transcription_provider` (`deepinfra` | `openai`, OpenRouter removed since its endpoint has no word timestamps), `transcription_model`. **TTS routing**: `kokoro_tts_provider` (`deepinfra` | `openrouter`) routes the Kokoro voices through either (same voices, OpenAI voices always use the OpenAI key). **Image descriptions**: `image_alt_text_provider` (`gemini` | `openrouter`), `image_alt_text_model` (free-text; default `gemini-3-flash-preview`).
- `created_at`, `updated_at`
- **Unique constraint**: (user_id, setting_key)

### content_items (main table)
- `id`: Primary key
- `user_id`: FK to users table (all queries filter by this)
- `type`: 'article' | 'podcast_episode' | 'pdf' | 'text'
- `title`, `url`, `content`, `html_content`
- `author`, `description`, `preview_picture` (Wallabag: preview_picture)
- `audio_url`: URL to generated/original audio file
- `audio_data`: BYTEA column for storing audio in DB
- `transcript`, `transcript_words`: Transcription text and word-level timestamps (JSON)
- `tts_chunks`: TTS chunk metadata for seeking (JSON)
- `duration`, `file_size`
- `podcast_id`: FK to podcasts table
- `podcast_show_name`: Denormalized podcast title (for direct display without querying podcasts table)
- `published_at`, `karma`, `agree_votes`, `disagree_votes`
- `comments`: Structured comments JSON (for EA Forum/LessWrong/Substack)
- `comment_source`: 'ea_forum' | 'lesswrong' | 'substack' | NULL, reliable comment detection for TTS/alignment
- `comment_count_total`: Total comments including nested replies (computed by article-fetcher)
- `is_starred`, `is_archived` (Wallabag: starred/archived; archiving deletes audio unless starred)
- `tags`: Comma-separated tags (Wallabag style)
- `wallabag_id`, `wallabag_updated_at`: For Wallabag sync tracking
- `playback_position`, `playback_speed` (deprecated - speed now stored globally in user settings + localStorage), `last_played_at`
- `generation_status`: 'idle' | 'starting' | 'extracting_content' | 'content_ready' | 'generating_audio' | 'generating_transcript' | 'completed' | 'failed'
- `generation_progress`, `generation_error`, `current_operation`
- `summary`: Article-body summary (Twitter-thread style, paragraphs separated by blank lines)
- `comment_summary`: Comment-discussion summary (nullable)
- `summary_status`: 'idle' | 'generating' | 'completed' | 'failed', **independent of `generation_status`** so audio and summary can generate at the same time
- `summary_generated_at`: When the summary was last generated
- `summary_error`: Error message stored when `summary_status='failed'` (cleared on success/removal). Surfaced on library cards with a Retry button so summary failures are visible in-app, not just in the Railway logs

### podcasts
- `id`: Primary key
- `user_id`: FK to users table (subscriptions are per-user)
- `title`, `author`, `description`
- `feed_url`, `website_url`, `preview_picture`
- `category`, `language`
- `type`: `'podcast' | 'newsletter' | 'blog'` - Auto-detected based on feed content (audio enclosures vs text articles)
- `is_subscribed`, `last_fetched_at`, `last_refreshed_at`
- **Unique constraint**: `(feed_url, user_id)` - Multiple users can subscribe to the same feed

### feed_items (RSS feed cache)
- `id`: Primary key
- `feed_id`: FK to podcasts table
- `item_type`: `'podcast_episode' | 'article'`
- `title`, `description` (max 2000 chars, contains RSS description/summary)
- `url`: Article URL (for newsletters/blogs)
- `audio_url`: Episode audio URL (for podcasts)
- `published_at`, `duration` (seconds, podcasts only)
- `preview_picture`: Episode/article thumbnail
- `guid`: Unique identifier from RSS feed (for deduplication)
- `created_at`, `updated_at`
- **Purpose**: Caches parsed RSS feed items to avoid fetching from network on every page load. Keeps up to 100 most recent items per feed.
- **Unique constraint**: `(feed_id, guid)` - Prevents duplicate items in the same feed
- **Performance**: Loading 70 feeds with 100 items each = instant database query instead of 70 network requests

### content_versions (article/text version history)
- `id`: Primary key
- `content_item_id`: FK to content_items (ON DELETE CASCADE)
- `user_id`: FK to users (ON DELETE CASCADE)
- `source`: `'fetch' | 'refetch' | 'edit' | 'restore'`, the action that overwrote this snapshot
- `title`, `html_content`, `content`: snapshot of the body before the overwrite
- `comments`: JSONB snapshot of comments at that time
- `created_at`
- **Purpose**: lets a bad edit or poor refetch be rolled back. Audio is deliberately NOT versioned (too large). The app keeps the most recent 25 snapshots per item (pruned in app code on insert).
- **Index**: `(content_item_id, created_at DESC)` for fast newest-first listing

### queue_items (manual play queue)
- `id`: Primary key
- `user_id`: FK to users table (queues are per-user)
- `content_item_id`: FK to content_items table
- `position`: integer ordering (0 = head). Renumbered on delete / bumped on insert-at-front
- `added_at`: timestamp for display
- **Note**: Only the *manual* queue is persisted here. The Spotify-style "Up next from library" stream is computed client-side from the captured library filter + `contentStore.allItems`, so no migration was needed when the Queue tab landed.

## Deployment (Railway)

The app deploys as 3 separate Railway services from the same repo:

1. **PostgreSQL Database**: Provisioned via Railway's database service
2. **Backend**: Root directory set to `backend/`, uses Dockerfile for FFmpeg
3. **Frontend**: Root directory set to `frontend/`, served via `npx serve`

### Required Environment Variables

**Backend:**
```
PORT=3001
DATABASE_URL=(auto-provided by Railway)
FRONTEND_URL=https://your-frontend.up.railway.app
JWT_SECRET=your-secret-key-here  # Optional but recommended for persistent sessions
BACKEND_URL=https://your-backend.up.railway.app  # For audio URL generation
CLEAR_AUDIO_BLOBS=true  # ONE-TIME, optional: after verifying audio plays from the volume,
                        # set this to NULL the old audio_data blobs in Postgres and free
                        # the RAM/disk they used. Safe to leave set (idempotent). See the
                        # audio-storage migration. Requires a volume mounted at /data.
```

**Audio storage migration (RAM cost fix):** Generated audio lives on the Railway volume at `/data/audio/{id}.mp3`, not in Postgres. On startup the backend auto-copies any remaining `audio_data` blobs to disk (non-destructive, logged as `🎵 [AudioMigration]`). Once you've confirmed playback works, set `CLEAR_AUDIO_BLOBS=true` to drop the in-DB blobs. The startup log also prints a `📦 [Storage]` size breakdown and a `🧠 [Postgres]` line showing `shared_buffers` etc. (so you can verify whether `POSTGRES_CONFIG` took effect, noting that only the `feliperosenek/postgres-any-version` template reads that variable, while Railway's default Postgres ignores it).

**Frontend:**
```
VITE_API_URL=https://your-backend.up.railway.app/api
```

### Important Notes
- Backend has a Dockerfile that installs FFmpeg (required for audio processing)
- JWT authentication protects all `/api/*` routes except `/api/auth/*` and `/api/content/:id/audio`
- Each user must set their own OpenAI API key in Settings (no global API key)
- Audio data stored in database (PostgreSQL BYTEA column), not filesystem
- Audio endpoint is public for HTML5 player compatibility, supports byte-range requests for seeking
- CORS is configured for single frontend URL only
- If JWT_SECRET not set, sessions won't persist across server restarts (uses random secret)

## Content Processing Flows

### Article Flow
1. User submits URL via AddTab
2. Backend fetches HTML (`article-fetcher.ts`)
3. GPT-4o-mini extracts readable content (`openai-tts.ts`)
4. Content is chunked (max 3500 chars per chunk)
5. Each chunk is converted to audio via gpt-4o-mini-tts
6. Chunks are concatenated via FFmpeg
7. Final audio URL saved to DB

### Podcast Flow
1. User subscribes to RSS feed
2. Episodes are parsed and saved
3. When user adds episode to library, transcription starts automatically
4. Whisper transcribes with word timestamps
5. Transcript saved for display and seeking

## Common Tasks

**Add a new field to content_items:**
1. Create migration SQL file in `backend/src/database/` or `backend/src/database/migrations/`
2. Add `fs.readFile` call in `db.ts initializeDatabase()`
3. Update `types.ts` in frontend
4. Add to SELECT queries in content.ts (explicit column list for both list and single-item endpoints)
5. If it's a large field (text/json), consider excluding from list query for performance

**Add database indexes:**
1. Create migration file in `backend/src/database/migrations/`
2. Use `CREATE INDEX IF NOT EXISTS` for safety
3. Add to db.ts initialization sequence
4. Consider composite indexes for common filter combinations

**Tune processing parameters:**
Edit `backend/src/config/processing.ts` to adjust TTS chunk sizes, Whisper file limits, retry behavior, etc. No code changes needed in services.

**Modify TTS behavior:**
Edit the system prompts in `openai-tts.ts extractArticleContent()` around lines 77-107 (main content) and 176-210 (comment extraction)

**Modify transcription:**
Edit `transcription.ts transcribeWithTimestamps()`

**Add new API endpoint:**
Add route in appropriate file in `backend/src/routes/`, import in `index.ts`

## Performance Optimizations

The app implements several performance optimizations:

**Backend:**
- List queries exclude large columns (html_content, comments, transcript) that aren't needed for display
- Single-item queries include all necessary display data (comments, transcript)
- Database indexes on frequently filtered/sorted columns (created_at, type, is_archived, is_starred)
- Composite indexes for common filter combinations
- Build process uses `copyfiles` to ensure SQL migrations are included in dist/

**Frontend:**
- Zustand store for centralized state management
- Optimistic UI updates: star/archive/delete happen instantly, then sync with server
- Client-side filtering: all items fetched once, filter switching is instant (no API call per filter click)
- Polling for generation status uses a lean batch endpoint (`POST /content/status`) that returns only status fields for all generating items in one request, never the full transcript/timestamps/alignment. The full item is fetched once, at completion.
- Large data only fetched when viewing individual items

**Critical Performance Fix (January 2026):**
The app had a catastrophic data leak that caused 80GB mobile data usage when away from WiFi. Root causes:
- PATCH endpoint used `RETURNING *` which included the full `audio_data` BYTEA column (10-50MB) in every response
- List queries included audio_data for all items instead of just metadata
- Every click on an item fetched the full audio blob unnecessarily
- Playback position saves every 10s were transferring the entire audio file

Fixed by using explicit column lists everywhere, excluding audio_data from list/update queries, only fetching it when actually playing audio.

**Result:** App is now dramatically faster, clicking items is instant, mobile data usage reduced by ~99%, query times <100ms

## Task Tracking

See **TODO.md** for current tasks, bug fixes, and feature roadmap.

## Development

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Requires PostgreSQL running locally or set `DATABASE_URL`.

### Previewing the UI without a database

To look at the app's screens (Settings, menus, layout) without a real account or a real Postgres database, run the mock backend instead of the real one:

```bash
cd backend
npm run mock
```

This starts a small stand-in server on port 3001 that always "logs in" successfully (any username/password works) and returns empty or default data for everything else, so the real frontend renders normally with no live content. It never touches Railway or any real database, so it's safe to leave running. It's a plain file (`backend/mock-server.mjs`) that the real deploy command (`npm start`) never touches, so it has no effect on production.

## License

Released under the [MIT License](LICENSE). Built with many open-source libraries (React, Express, turndown, marked, and more), each retains its own license.
