# Wallacast Architecture

This is the technical reference and codebase map for Wallacast (backend structure, frontend structure, database schema, service internals, and processing flows). For the user-facing introduction (what the app is, how to deploy it, how to run it locally), see **README.md**.

## Quick Reference

| When working on... | Look at... |
|-------------------|------------|
| Authentication | `backend/src/routes/auth.ts`, `backend/src/services/auth.ts`, `backend/src/middleware/auth.ts` |
| User settings | `backend/src/routes/users.ts` |
| Per-user API keys | `backend/src/services/ai-providers.ts` |
| Adding content | `backend/src/routes/content.ts` |
| Wallabag sync | `backend/src/routes/wallabag.ts`, `backend/src/services/wallabag-sync.ts`, `backend/src/services/wallabag-service.ts` |
| Tags (rules, chips, picker, filter, sync) | `backend/src/services/tags.ts` (normalization + reserved names), `frontend/src/tags.ts` (same rules + tag counts), `frontend/src/components/TagEditor.tsx` (picker popup), chips in `ContentCard.tsx` + `FullscreenPlayer.tsx`, tag filter in `LibraryTab.tsx` + `contentStore.ts`, Wallabag rules + reconciliation in `wallabag-sync.ts` |
| Markdown export/import with Obsidian properties | `frontend/src/markdown.ts` (`buildFrontmatter`, `parseFrontmatter`, `splitExportedComments`, `stripLeadingTitle`), import wiring in `frontend/src/components/AddTab.tsx`, `tags`/`comments` accepted by `POST /api/content` |
| TTS generation | `backend/src/services/openai-tts.ts` |
| Summaries (article + comments) | `backend/src/services/summarizer.ts`, `frontend/src/components/SettingsPage.tsx`, `frontend/src/components/FullscreenPlayer.tsx` |
| Summary audio ("Prefer summary audio" mode) | `backend/src/services/summary-audio.ts`, serving variant in `backend/src/index.ts`, effective-audio rule in `frontend/src/format.ts` (`getEffectiveAudio`/`hasAnyAudio`), player wiring in `frontend/src/components/AudioPlayer.tsx` + `FullscreenPlayer.tsx` |
| Image descriptions | `backend/src/services/image-alt-text.ts` |
| Transcription | `backend/src/services/transcription.ts`, `backend/src/services/whisper-prompt.ts` |
| Content-transcript alignment (LLM) | `backend/src/services/llm-alignment.ts` |
| Article extraction | `backend/src/services/article-fetcher.ts` |
| Podcast feeds | `backend/src/services/podcast-service.ts` |
| Audio player (mini + fullscreen) | `frontend/src/components/AudioPlayer.tsx`, `frontend/src/components/FullscreenPlayer.tsx` |
| Transcript tab (fullscreen read-along view, internal tab id `read-along`) | `frontend/src/components/FullscreenPlayer.tsx` |
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
| Article body starts with the author, the date, or a share menu | `article-fetcher.ts` container choice: prefer the `<main>` inside the chosen `<article>` (half-the-text guard), plus the text-based share-menu removal. Check the `[Fetcher] Using the <main> inside <article>` log line |
| A newsletter renders with huge gaps or a sideways scrollbar | Its layout tables did not match `EMAIL_LAYOUT_TABLES` in `article-fetcher.ts`, so `flattenEmailTables()` never ran. Add the sender's table marker there. Fetch-time only, so refetch the item afterwards |
| One read-along element covers a huge stretch of audio | `extractContentElements()` in `llm-alignment.ts` splits lists per `<li>` and long blockquotes per inner block (`splitQuoteIntoParts()`). Anything else (a giant `<div>`, a `<table>`) is still ONE element. Images inside a split quote only become their own element when an image description exists, since an undescribed image is never spoken |
| "Regenerate transcript" appears to do nothing | The item has no `audio_url` (archiving removes the audio of non-starred articles/texts). `PATCH /:id` now answers `400 { code: 'no_audio' }` with a readable reason, and both frontends show the server's message. It used to fall through to the generic "No valid fields to update" 400 with no log line |
| Read-along alignment wrong / missing elements | `backend/src/services/llm-alignment.ts` - check `extractContentElements()` for element extraction, `buildTimedTranscript()` for transcript quality. **Never use fuzzy matching**. Fix input data quality instead (see CLAUDE.md) |
| Read-along autoscroll jumpy or skipping | `frontend/src/components/FullscreenPlayer.tsx` - `scrollToActive()` callback. Short elements use `scrollIntoView`, tall elements use progressive scroll based on audio progress |
| Tweet embeds render or narrate badly | `backend/src/services/article-fetcher.ts` - `normalizeTweetEmbeds()` rewrites Substack rich cards and classic oEmbed blockquotes into one canonical author-first `blockquote.twitter-tweet` card at fetch time (fetch-time only, refetch to heal old items). Styling in `App.css` (`.tweet-author`/`.tweet-photo`/`.tweet-footer`), narration rule in `openai-tts.ts` ("A tweet by ..."), single `tweet` alignment element in `llm-alignment.ts` |
| Horizontal scroll / content wider than screen (long URLs in comments or article body, wide tables) | `frontend/src/App.css` - `.comment-content` / `.article-content` need `overflow-wrap: anywhere; word-break: break-word;` so long unbreakable strings wrap; `table` needs `display: block; overflow-x: auto`. Images already capped via `img { max-width: 100% }`, code via `pre { overflow-x: auto }` |
| Podcast transcription issues | `backend/src/services/transcription.ts` - Whisper integration and chunking |
| Transcript repetition/looping ("even. even. even.") or skipped speech | `backend/src/services/transcription.ts` - DeepInfra **native** endpoint. Schema-verified 2026-07-26: the endpoint's ONLY real inputs are audio/task/initial_prompt/temperature/language/chunk_level/chunk_length_s (no vad, no condition_on_previous_text, those fields we send are ignored; the loops stopped because the native pipeline differs from the OpenAI-compat one). For dropped speech: switch to full `whisper-large-v3` in Settings (turbo's pruned decoder bails on hard spans; measured 57 scattered mid-speech gaps in one 72-min episode, none at our 15-min seams), or experiment with `chunk_length_s` < 30 |
| Wallabag sync not working | `backend/src/services/wallabag-service.ts` - OAuth and API client, `backend/src/services/wallabag-sync.ts` - Sync logic, `backend/src/routes/wallabag.ts` - Endpoints |
| A tag added/removed in Wallabag does not show up in Wallacast | Wallabag never bumps `updated_at` for tag-only changes (Doctrine PreUpdate does not fire for collection changes), so neither the `since` pull nor a full refresh sees them. `reconcileTagsFromWallabag()` in `wallabag-sync.ts` runs after every pull with `detail=metadata` and three-way-merges every item's tags against `wallabag_synced_tags`. Check the `[Wallabag Sync] Tag reconciliation:` log line (a "skipped ... no type tag" warning means the response carried no tags) |
| A sync changed or removed something it should not have | It cannot delete local items or overwrite bodies Wallacast owns (see the safety rules under `services/wallabag-sync.ts`). Tags: a tag only disappears locally when Wallabag removed it since the last sync (`mergeTagSets`), and a `#nosync` chip appearing means the Wallabag entry carries that tag (the item is kept, just no longer pushed) |
| A tag typed in Wallacast comes back different / a tag is refused | Labels are normalized like Wallabag (trim, lowercase, no commas) in `services/tags.ts` + `frontend/src/tags.ts`; `article`/`text`/`podcast` are derived from the item type and `nosync` is Wallabag-only, all four are reserved (PATCH answers 400) |
| Cost / API usage too high | Check: (1) `backend/src/services/openai-tts.ts` for LLM content extraction, (2) Auto-generation in `backend/src/routes/content.ts` POST endpoint |

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│     Backend     │────▶│   PostgreSQL    │
│   (React/Vite)  │     │ (Express/Node)  │     │    Database     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                    ┌────────────────────────────────────┐
                    │          AI provider APIs          │
                    │  (OpenAI, DeepInfra, OpenRouter,   │
                    │   Anthropic, Gemini)               │
                    │  (TTS, Whisper, chat LLMs)         │
                    └────────────────────────────────────┘
```

## Project Structure

### Backend (`/backend/src/`)

#### Entry Point
- **`index.ts`**: Express server setup, CORS, JWT auth middleware, route mounting. **Important**: Public audio endpoint (`/api/content/:id/audio`) registered BEFORE protected routes to match first. Includes database initialization with retry logic and graceful shutdown handling. On every startup, logs a `📦 [Storage]` database-size breakdown to the Railway logs (audio blobs, transcripts, word timestamps, HTML, comments, table + whole-DB totals). Check the Railway backend logs after a deploy/restart to see how much disk the data uses (used for sizing the audio-to-volume migration). **Security**: sets `trust proxy` (so the auth rate limiters see the real client IP), caps the `/api/auth` request body at 100kb (vs 50mb elsewhere), and `warnMissingSecurityEnv()` logs a loud startup error in production when `ENCRYPTION_KEY`/`JWT_SECRET` are missing. The public audio endpoint requires an unguessable HMAC `?t=` token for private article/text narration (see `services/audio-token.ts`); podcasts (public CDN audio) are exempt. The old static `/audio/<id>.mp3` mount was removed (it let anyone enumerate audio by sequential id). The podcast audio proxy fetches through `safeFetch` (SSRF guard).

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
  - `024_add_version_metadata.sql`: Adds `author` + `published_at` to `content_versions` so metadata edits (title/author/date in the Markdown editor) are versioned and restorable alongside the body
  - `026_add_summary_audio.sql`: Adds summary-audio support (`summary_audio_url`, `summary_audio_duration`, `summary_audio_status`, `summary_audio_error`, `summary_audio_generated_at`, `summary_playback_position`), the TTS-of-the-summary second audio per item
  - `027_tags_array.sql`: `tags` becomes a `TEXT[]` (the old comma-separated TEXT column is renamed `tags_legacy` and backfilled once: split, trim, lowercase, type tags dropped), plus a GIN index. Also drops the never-used normalized `tags` + `content_tags` tables, only while they are empty

#### Middleware

- **`middleware/auth.ts`**: Authentication and database readiness middleware
  - `requireAuth()`: JWT token validation middleware, extracts user from token and adds to `req.user`
  - `requireDatabaseReady()`: Returns 503 if database isn't ready yet (prevents crashes during startup)
- **`middleware/rate-limit.ts`**: `express-rate-limit` limiters for the unauthenticated auth endpoints (login: 10/15min per IP, register + forgot-password: capped per hour), applied per-route in `routes/auth.ts`. In-memory store (fine for a single Railway instance). Relies on `app.set('trust proxy', 1)` in `index.ts` to key on the real client IP, not the proxy's.

#### Routes

- **`routes/auth.ts`**: User authentication endpoints (public, no JWT required)
  - `POST /api/auth/register` - Create new user account
  - `POST /api/auth/login` - Login with username/password, returns access + refresh tokens
  - `POST /api/auth/refresh` - Refresh access token using refresh token
  - `POST /api/auth/logout` - Revoke refresh token
  - `GET /api/auth/config` - Public instance config for the logged-out UI (currently `{ inviteRequired }`, driven by the `INVITE_CODE` env var; when set, register requires the matching `inviteCode` in the body)
  - `POST /api/auth/forgot-password` - Emails a password reset link (Resend, gated on `RESEND_API_KEY`, 503 when unconfigured). Always answers generically so usernames cannot be probed. Tokens live in the `password_reset_tokens` table (migration 023), SHA-256 hashed, 1 hour expiry, single use
  - `POST /api/auth/reset-password` - Consumes a reset token, sets the new password, and revokes all of the user's sessions
  - `POST /api/auth/demo` - Passwordless login into the shared READ-ONLY demo account (the ordinary users row named by the `DEMO_USERNAME` env var, default `demo`; 404 when that account does not exist). Demo-ness is a SESSION property carried as `demo: true` in the JWT: sessions from this endpoint are read-only, a PASSWORD login into the same account is a normal writable session (that is how `backend/scripts/seed-demo.mjs` populates the demo library), and token refresh re-locks any session on the demo username so a visitor session can never escape read-only (the operator just logs in again). `requireAuth` in `middleware/auth.ts` blocks every non-GET request for demo tokens with `403 { demo: true }`, except the lean status poll and playback-position PATCHes. The frontend shows a toast on that 403, renders a demo banner, and makes Settings read-only.

- **`routes/users.ts`**: User settings management (requires JWT auth)
  - `GET /api/users/settings` - Get all settings (secrets are masked)
  - `GET /api/users/settings/:key` - Get specific setting
  - `PUT /api/users/settings/:key` - Set specific setting
  - `PUT /api/users/settings` - Bulk update settings
  - `DELETE /api/users/settings/:key` - Delete setting
  - `GET /api/users/prompts` - The editable-prompt registry (every LLM prompt: id, category, label, description, placeholder vars, default text, optional warning) for the Settings "Custom prompts" editor

- **`routes/content.ts`**: CRUD for content items (requires JWT auth). **All queries filter by `user_id`** for data isolation. Handles article URL fetching, auto-triggers audio generation for articles and transcription for podcasts. Notable endpoints:
  - `GET /` - List all content (excludes audio_data, html_content, comments, transcript for performance)
  - `GET /:id` - Get single item (includes comments and transcript for display, plus a `versions_count` subquery so the player's History tab can render instantly without waiting for the versions list)
  - `POST /status` - **Batch generation-status poll.** Body: `{ ids: number[] }` (max 500). Returns ONLY the small status fields (`generation_status`, `generation_progress`, `current_operation`, `generation_error`, `summary_status`) for all requested ids in one request (a few hundred bytes total). The library's 2s poll uses this **instead of** `GET /:id` per item. `GET /:id` returns the full transcript + 9,000+ word timestamps + alignment (~0.5MB per transcribed podcast), which polled every 2s is the same class of bug as the 80GB data incident. The full item is still fetched once, at completion, via `GET /:id`. Keep this endpoint lean. Never add large columns.
  - `POST /` - Create content, auto-extracts article HTML if URL provided. **Text items**: content is stored in both `content` and `html_content` columns so read-along/alignment works identically to articles. An `article` that ARRIVES with `content` (a Markdown import naming a `source` URL) takes the same text path: URL kept, nothing fetched. Also accepts `tags` (normalized, reserved names dropped), `comments` (an array of `{ username, content, replies? }`, stored with `comment_count_total` computed), and `summary` + `comment_summary` (stored as a completed summary; auto-summarize is skipped) for Obsidian-properties imports. **HTML upload cleanup**: strips scripts/styles, fixes broken Obsidian markdown image artifacts (local `<img>` paths replaced with real URLs from `](url)` text), removes images with relative paths that can't load on the server.
  - `PATCH /:id` - Update playback position, archive status, etc. Special operations:
    - Archiving deletes audio, alignment data, and transcript to save space (unless item is favorited)
    - Un-archiving regenerates audio, transcript, and alignment if missing
    - `audio_data: null, audio_url: null` removes audio from articles/texts
    - `summary: null` removes the article + comment summaries from articles/texts
    - `dismiss_generation_error: true` / `dismiss_summary_error: true` reset a `failed` generation/summary status to `idle` and clear the stored error (the card's red error box is dismissed via its X button)
    - `tags: string[]` replaces the item's whole tag list (normalized; 400 for reserved names `article`/`text`/`podcast`/`nosync`). Counts as a content change, so `updated_at` and `wallabag_needs_push` are set and the next push sends the new set to Wallabag
    - `regenerate_transcript: true` re-transcribes podcast audio through Whisper
    - `is_edit: true` (with `html_content` + `content`, optionally `title`/`author`/`published_at`). Manual Markdown/HTML edit of an article/text body and its byline metadata. Snapshots the current body + metadata into `content_versions` first, sanitizes the HTML (strips `<script>`/`<style>`/`javascript:`), sets `content_fetched_at = now`, and leaves audio + read-along untouched (so the provenance shows content is newer than the narration). The frontend converts Markdown→HTML before sending and only includes the metadata fields that changed (`null` clears a field).
  - `POST /:id/generate-audio` - Manually trigger audio generation. Body: `{ regenerate?: boolean, exclude_comments?: boolean }`. When `exclude_comments` is true, comments are omitted from the TTS narration script.
  - `POST /:id/generate-summary` - Manually trigger summary generation. Articles/texts: body + comments. Podcast episodes: the Whisper TRANSCRIPT (podcast-specific prompt). Body: `{ regenerate?: boolean, generate_transcript?: boolean, generate_audio?: boolean }`. For podcasts without a transcript, `generate_transcript: true` runs Whisper first and chains the summary after; without it the request returns 400 with `code: 'no_transcript'` so the UI can warn. `generate_audio` (from the bulk dialogs) explicitly overrides the `auto_generate_summary_audio` setting for the chained summary-audio TTS; absent = follow the setting. Uses the independent `summary_status` field, so it can run alongside audio generation.
  - `POST /:id/generate-summary-audio` - TTS audio of the item's summary, opening with the shared spoken header (`buildNarrationIntro(..., 'summary')`) and including the comment summary after a spoken `Summary of N comments.` divider. Requires an existing summary (400 `code: 'no_summary'` otherwise), 409 while generating. Runs on its own `summary_audio_status` column; no scriptwriter LLM, no Whisper, no alignment (the Summary tab has no read-along by design). See `services/summary-audio.ts`.
  - `POST /:id/refetch` - Re-fetches the article from the web (articles with a URL only). Snapshots the current body to version history first, sets `generation_status` to `'fetching'` (with `current_operation` `'fetching_article'`) while it runs, and on error sets `'failed'` with `current_operation` `'failed_refetch'` (so the card's Retry re-runs a refetch, not audio generation).
  - `POST /bulk` - Bulk actions on many items in one request (used by the library's Select mode). Body: `{ action, ids }` (max 500 ids). Actions: `star`, `unstar`, `archive`, `unarchive`, `delete`, `remove_audio`, `remove_summary`. `archive` mirrors the single-item PATCH: wipes generated audio + read-along data for non-starred articles/texts (podcasts and starred items keep everything). `unarchive` deliberately does NOT auto-regenerate audio (use bulk Generate audio afterwards). `remove_audio` only touches articles/texts (podcast audio_url is source media). `delete` also fires Wallabag deletions for synced items. Returns `{ affected }`.
  - `GET /:id/audio` - **PUBLIC** endpoint (no auth) for streaming audio with byte-range support. Registered in `index.ts` before protected routes. This is required for HTML5 `<audio>` elements which can't send JWT tokens. **Serving order**: (A) podcast episodes proxy the external `audio_url`; (B) **preferred** - generated article/text audio is streamed from the disk file on the volume (`audio-storage.ts`) with 2MB-capped range requests; (C) **fallback** - if there's no disk file yet, the legacy in-DB `audio_data` blob is served via PostgreSQL `substring()` (reads only the needed bytes, never the whole blob). The handler lives in `index.ts`, registered before the protected routes. **`?variant=summary`** serves the item's summary-audio file (`<id>-summary.mp3`, PATH-B-style disk streaming only) and requires the HMAC token for EVERY content type, podcasts included, since summary audio is always our generated private TTS (unlike public podcast enclosures).
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
  - `POST /test` - Test connection with the configured Wallabag instance
  - `GET /status` - Get sync status (enabled flag, last sync time, pending-changes count)
  - `POST /sync` - Full bidirectional sync (pull then push)
  - `POST /pull` - Pull changes from Wallabag into Wallacast. `?full=true` forces a full refresh (clears the last-sync timestamp so everything is re-pulled)
  - `POST /push` - Push Wallacast changes to Wallabag
  - `POST /cleanup` - Emergency cleanup: delete recently synced, non-starred, audio-less items and reset the last-sync timestamp

#### Services

- **`services/auth.ts`**: User authentication and session management
  - `hashPassword()`, `verifyPassword()`: bcrypt password hashing
  - `generateAccessToken()`, `generateRefreshToken()`: JWT token generation
  - `verifyAccessToken()`, `verifyRefreshToken()`: JWT verification
  - `bootstrapFirstUser()`: Assigns orphaned content to first user on startup
- **`services/url-guard.ts`**: SSRF guard. `assertPublicHttpUrl()` rejects non-http(s) schemes and any host resolving to a loopback/private/link-local/reserved IP; `safeFetch()` wraps node-fetch, validating the initial URL and re-validating every redirect hop. Used at every user-supplied-URL fetch (article/feed/image/podcast-audio + the audio proxy in `index.ts`). Default redirect cap is 5 hops; the podcast-audio call sites (audio proxy + transcription download) pass `AUDIO_REDIRECT_HOPS` (12) because episode URLs chain through ~7 measurement hosts in the wild, every hop still validated.
- **`services/audio-token.ts`**: Unguessable per-item audio token (`audioToken(id)` = HMAC of the id, keyed by the server secret). `verifyAudioToken()` gates the `/api/content/:id/audio` route for article/text narration AND the `?variant=summary` audio of every type; `withAudioToken()` appends the token to `audio_url` (article/text) and `summary_audio_url` (all types) at serialization (list / getById / patch in `content.ts`, and `queue.ts`) so the frontend needs no change. Derived from the id, so no DB storage and no backfill.

- **`services/summary-audio.ts`**: Summary audio, a second independent TTS audio per item generated from the stored `summary` (+ `comment_summary` after a spoken `Summary of N comments.` divider, counted from `comment_count_total`, the same number the full audio announces). The narration opens with `buildNarrationIntro(item, 'summary')` from `openai-tts.ts`, the same header builder the full audio uses. Metadata is read fresh on every run, so regenerating after a title or author edit narrates the corrected version. `generateSummaryAudioForContent()` reuses `generateArticleAudio()` WITHOUT `options.contentId` (so the main audio's `generation_*` columns are never touched) and deliberately skips the scriptwriter LLM, Whisper, and alignment (the Summary tab has no read-along). File stored as `<id>-summary.mp3` via `audio-storage.ts` (string keys; integer ids can never collide). `clearSummaryAudio()` deletes file + columns; called from summary removal (PATCH `summary: null`, bulk `remove_summary`) and on summary REGENERATION (the old audio would narrate stale text), after which `summarizer.ts` re-chains generation when `auto_generate_summary_audio` is on or the request's `generate_audio` flag says so. Archiving deliberately KEEPS summary audio (1-2MB, keeps archived items triageable); item deletion paths remove the file. Status lives in `summary_audio_status`/`summary_audio_error` (own startup stuck-reset in db.ts), polled via the lean `POST /content/status`. `summary_playback_position` is a separate saved position so summary listening never corrupts the original audio's progress (cards/continue-listening remain original-only).

- **`services/ai-providers.ts`**: Per-user API key management with intelligent routing
  - **Provider registry (`CHAT_PROVIDERS`)**: OpenAI, DeepInfra, OpenRouter, Anthropic, Google Gemini. All are spoken to via the **OpenAI SDK** (just a different `baseURL` + key), so one client handles every provider. OpenRouter is the easy on-ramp for Claude/Gemini/etc. (`provider/model` ids).
  - `getChatClientForJob(userId, job)`: per-job model selection. The `job` parameter is `'narration'` (prepares text for TTS) | `'alignment'` (read-along) | `'summary'`. Each job has its own `{provider, model, reasoning_effort}` setting; read-along & summaries can defer to narration ("use same model as narration"). Returns `{ client, model, extraParams }` where `extraParams` carries the reasoning_effort param (empty = provider default, so behavior is unchanged unless set). **Read-time fallback**: if a job isn't configured yet, it derives from the legacy `narration_llm` routing, so existing users keep working and the Settings fields pre-fill with the model actually in use.
  - `getChatClientForUser(userId)`: back-compat wrapper (narration job, no reasoning extraParams).
  - `getTTSClientForUser(userId, modelId)`: Intelligent router returning `{ client, model }`. Kokoro voices route via DeepInfra (the default) or OpenRouter, per the `kokoro_tts_provider` setting, with OpenRouter used as a fallback when no DeepInfra key exists (same voices either way, OpenRouter lists Kokoro under the lowercase model id). OpenAI-family voices always go through the OpenAI key (OpenRouter carries no OpenAI TTS models). Callers use the returned `model` for the API call.
  - `getTranscriptionClientForUser(userId)`: returns a `TranscriptionConfig` discriminated union. It can be `{ kind: 'deepinfra', apiKey, model }` (native endpoint, anti-hallucination params) or `{ kind: 'openai', client, model }` (OpenAI SDK, used for both OpenAI and OpenRouter). Built from explicit `transcription_provider` (`deepinfra` | `openai` | `openrouter`) + `transcription_model` settings, with legacy auto-routing (DeepInfra preferred) as the fallback when unset
  - `getDeepInfraClientForUser(userId)`, `getOpenAIClientForUser(userId)`: Provider-specific clients
  - `getUserSetting(userId, key)`: Fetches setting from `user_settings` table
  - No global API keys - each user must configure their own (OpenAI and/or DeepInfra, or both)

- **`services/audio-utils.ts`**: Shared audio utilities
  - `getAudioDuration()`: Get audio file duration using ffprobe (used by both TTS and transcription services)

- **`services/article-fetcher.ts`**: Fetches articles using GraphQL APIs for EA Forum/LessWrong (via got-scraping with human-like headers), standard scraping for other sites (simple fetch without custom headers to avoid Cloudflare). **EA Forum domain rewrite**: exports `normalizeEAForumUrl()` (rewrites `forum.effectivealtruism.org` → the bot-friendly mirror `forum-bots.effectivealtruism.org`, applied at add-time in `POST /api/content` so both the Add tab and RSS "add to library" store the mirror link) and `isEAForumUrl()` (the shared EA-Forum detector, matches BOTH hosts, since `forum-bots.effectivealtruism.org` does not contain the substring `forum.effectivealtruism.org`; used by `llm-alignment.ts`, `openai-tts.ts`, `wallabag-sync.ts`). The GraphQL fetch itself still targets the main host's `/graphql` endpoint (with a main-host `Referer`), so fetching is unaffected. **Substack support**: Detects Substack pages via `substackcdn.com` references (works on custom domains), targets `.body.markup` for cleaner content, extracts comments from `/comments` page via `window._preloads` JSON (structured data, not fragile CSS selectors), cleans up subscribe widgets/navbar/footer using stable `data-component-name` and `data-testid` attributes. **General cleanup**: Deduplicates images with same src URL, removes first h1 matching og:title, strips subtitle matching og:description, removes byline/lede sections, newsletter forms, "Related" boxes, share buttons, SVGs. **Share menus** are also removed by their text (`Share`, `Share via X/Facebook/email`, `Copy link` on a link or button), the same approach as the Previous/Next removal, because several sites render them as ordinary in-article links that end up narrated. **Container choice**: when the generic path falls back to `<article>`, a `<main>` INSIDE that article wins if it holds at least half the article's text; sites like Compact wrap a page header (author line, date, share menu) and the story in one `<article>`, so taking the article alone dragged the header into the body. **archive.is mirrors** (`isArchiveMirrorUrl()`, covers archive.is/ph/today/li/vn/fo/md) go through `restoreArchivedParagraphs()`: the mirror keeps the words but rebuilds every block as a generic `<div>` with a wall of inline styles and zero `<p>`, so the reader showed one undivided wall of text and read-along got a single element. The mirror's inline styles are dropped and every text-only `<div>` becomes a `<p>`. Marked UNTESTED beyond one mirror; menu lines and captions become paragraphs too. **Strips author-set text colours** (`color`/`background-color` from inline `style` attributes, plus `data-color`) via `stripInlineColors()`. This is applied on BOTH the GraphQL and standard/Substack paths, so the reader's theme controls text colour (otherwise an author's explicit black renders black-on-dark in dark mode); other style props like `width` are kept. **Flattens email newsletters** via `flattenEmailTables()`: gated on the `EMAIL_LAYOUT_TABLES` selector (`role="presentation"` plus Mailchimp's own markers `#bodyTable`, `.templateContainer`, `.columnWrapper`, `[class*="mcn"]`, since Mailchimp never sets the role attribute; one real campaign held 31 tables, 29 of them matching and none holding data, so ordinary articles stay untouched), it removes hidden elements FIRST (mobile/desktop duplicate blocks, invisible preheaders, which would otherwise surface and narrate twice), drops tracking beacons (1-2px images and images whose URL carries per-recipient params), unwraps the nested fixed-width table scaffolding bottom-up into divs (a table's own `rows`/`cells` only, so genuine data tables nested inside survive), and prunes emptied spacer debris. Fixes the horizontal-scrollbar overflow AND gives read-along/scriptwriter real paragraphs instead of one giant table block. Also applied to uploaded/pasted HTML in `POST /api/content` (text items). **Normalizes tweet embeds** via `normalizeTweetEmbeds()` (standard, forum, and uploaded-HTML paths): Substack's server-rendered `div.twitter-embed` cards (their `data-attrs` JSON carries the full structured tweet) and classic oEmbed `blockquote.twitter-tweet` embeds both become one canonical author-first card (`.tweet-author` with bold name + muted @handle, verbatim text paragraphs, `.tweet-photo` images, `.tweet-footer` with linked date • likes • replies), so the reader, the narration, and the read-along all agree on what a tweet is. Unparseable embeds are left untouched. **Author fallback**: when neither `meta[name="author"]` nor a `.author`/`.byline`/`a[rel="author"]` element yields a byline, `authorFromJsonLd()` reads the page's schema.org `application/ld+json` block (Article-shaped nodes only, `@graph` and array authors handled, malformed JSON skipped). Compact publishes its author only there. It is captured BEFORE the fetcher strips `<script>` elements, and only fills an otherwise-empty byline, so no site that already resolves an author changes behaviour. Extracts metadata (title, author, date, karma, comments with reactions). Returns both HTML and structured data. No LLM usage for extraction. (Note: only affects NEW fetches/refetches. Existing items need a refetch to clean up.)

- **`services/image-alt-text.ts`**: Image description generation for TTS. Provider via `image_alt_text_provider`: `gemini` (native `@google/genai` SDK, default), `deepinfra` (default model Gemma 4 26B A4B, matched Gemini Flash quality in live tests 2026-07-02 at ~1/20th the cost), `openai` (default `gpt-5-mini`, vision verified 2026-07-02, sends no temperature since GPT-5 rejects non-default values), or `openrouter` (tested with Gemini Flash 3). The non-Gemini paths use OpenAI-compatible vision through `chat.completions` with a base64 `image_url`. Requires the matching per-user key.
  - `smartRegenerate()`: Intelligently processes only new images after refetch, merges with existing descriptions. Accepts `forceRegenerate` parameter to regenerate ALL images (used when regenerating audio)
  - `downloadImage()`: Downloads images ourselves with proper headers (User-Agent, Referer) to bypass CDN blocking. 30s timeout, 100MB max size
  - `analyzeImage()`: Sends downloaded image data inline to Gemini (not urlContext). Rejects if download fails or description is invalid
  - `analyzeImageWithRetry()`: Exponential backoff retry logic (up to 5 attempts) for 503/overloaded errors
  - **Anti-hallucination protection**: Downloads images ourselves instead of relying on Gemini's urlContext (which CDNs often block). No more hallucinations from failed fetches
  - Heuristic filtering: Automatically skips decorative images (icons, logos, small images <100px) before sending to Gemini
  - Stores descriptions in JSONB (image_alt_text_data) with metadata (cost, model, processed_at)
  - Cost: ~$0.003 per article (4% of TTS cost) using Gemini 3 Flash

- **`services/openai-tts.ts`**: Main TTS service (requires per-user DeepInfra or OpenAI API key)
  - `scriptArticleForListening()`: Uses narration LLM (DeepSeek-V3.2 or GPT-5-Nano) to prepare HTML for TTS narration (formatting, date conversion, removing navigation elements). NOT used for initial article extraction. Extremely long articles (cleaned HTML > 150k chars, ~2x an average long article) are scripted in heading-aligned chunks of ~75k chars each and concatenated, since the whole script cannot fit in one model reply. A conversational-reply guard (`assertLooksLikeScript`) fails the generation loudly if the model answers with a question instead of a script (that reply used to be narrated verbatim); the frontend additionally confirms before generating audio for articles over ~100k plain-text chars (`isVeryLongArticle` in `format.ts`).
  - `generateArticleAudio()`: Generates TTS audio using Kokoro (via DeepInfra) or OpenAI gpt-4o-mini-tts, handles chunking for long articles, concatenates with FFmpeg. Every final encode is loudness-normalized (EBU R128, two-pass linear loudnorm) to -19 LUFS integrated / -1.5 dBTP, the mono spoken-word norm, because raw provider voices span -19.7 to -28.8 LUFS (measured 2026-07-18). See `LOUDNORM_TARGET`; on analysis failure it falls back to single-pass dynamic mode.
  - `generateAudioForContent(contentId, regenerate)`: Orchestrates the full pipeline with progress tracking:
    - 0-20%: Process image descriptions (if enabled) using Gemini, save to JSONB. When `regenerate=true`, regenerates ALL images instead of just new ones
    - 20-30%: Prepare content for narration (scriptwriter or fallback text extraction)
    - 30-90%: Generate TTS audio chunks
    - 90-95%: Finalize audio (save to DB with `user_id`)
    - 95-97%: Auto-transcription for Read Along
    - 97-100%: LLM-based content alignment (maps HTML elements to transcript timestamps)
  - `buildNarrationIntro(content, mode)`: the spoken header an audio opens with, shared by the full audio (`mode: 'full'`) and the summary audio (`mode: 'summary'`) so the two formats can never drift apart. Full: `Title: X. Written by Y. Published on 14th of March 2026. It has 12 upvotes.` Summary: the same block with `Summary of X.` in place of the title announcement. Podcast summaries use an episode-shaped variant (`Summary of X, an episode of SHOW. Published on ...`), since a podcast's full audio is the raw episode and announces nothing. Untitled items get no header. "likes" replaces "upvotes" on Substack, and an author that is only emoji is dropped rather than narrated as "Written by."
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
  - `transcribeWithTimestamps(audioSource: string | Buffer, userId, initialPrompt?)`: Returns word-level timestamps for sync. Accepts optional Whisper prompt hint to improve recognition of key phrases like "Comments section:" and comment headers
  - Uses centralized config from `processing.ts` for file size limits, chunk duration, compression thresholds
  - Handles large files by splitting into chunks (uses actual ffprobe duration for chunk time offsets), compresses audio before transcription if needed
  - **Two transports (branch on `TranscriptionConfig.kind`)**: **DeepInfra** uses the **native** inference endpoint (`POST /v1/inference/{model}`, raw multipart via `globalThis.fetch`) because only the native endpoint honors Whisper's anti-hallucination params. We send `chunk_level=word` + `word_timestamps=true` (**required**, the native endpoint defaults `chunk_level=segment`/`word_timestamps=false`, which returns segment text only and breaks read-along; `extractDeepInfraWords()` then reads the per-word data whether it lands in the top-level `words` array or nested in `segments[].words`), `temperature=0` plus several legacy fields (`condition_on_previous_text`, `word_timestamps`, thresholds) that the schema-verified endpoint does NOT list as inputs and presumably ignores (kept unremoved because the loop fix demonstrably works and removal deserves its own test; the schema's only real extra knob is `chunk_length_s`, 1-30s). Native returns words as `{start, end, text}`, remapped to `{word, start, end}`; if words are ever missing, `wordsFromSegments()` interpolates timings from the segment spans so read-along degrades gracefully instead of breaking. **OpenAI/OpenRouter** stay on the OpenAI SDK (`client.audio.transcriptions.create`, OpenAI-shaped endpoint, no such params).
  - **Prompt strategy**: OpenAI-shaped path keeps the hybrid prompt (chunk 1 = full prompt up to 1000 chars, chunk 2+ = metadata first 600 chars + last 200 chars of previous transcript). The DeepInfra path sends **no prompt**. Feeding the previous chunk's tail is exactly what seeds cross-chunk loops, and `condition_on_previous_text=false` covers continuity.

- **`services/llm-alignment.ts`**: LLM-based content-to-transcript alignment for read-along tab (replaces Needleman-Wunsch approach). Robustness layers (all numeric post-processing or prompt context, the LLM still does all text matching): (1) batch seam anchor, each batch's prompt names the previous batch's rough end timestamp so a batch's first element doesn't latch onto a duplicate occurrence of its text later in the audio; (2) outlier repair, before the non-decreasing clamp the longest non-decreasing subsequence of timestamps is kept as consensus and dropped values are re-interpolated between kept neighbors (a lone duplicate-match spike used to make the clamp overwrite dozens of correct timestamps); (3) quality retry, each pass is scored by the fraction of timestamps that strictly advance (ignoring the legitimate trailing plateau of unnarrated tails); below 70% on content over 1500 chars the failed batches are re-run ONCE and the best-scoring attempt is kept; (4) NO silent fallback: a failed LLM call, an unusable response, or an empty timestamp set THROWS (there used to be an evenly-spread fake alignment returned as success, which made a quota-dead provider look like "very bad alignment" with no error), so the callers' visible failed state + Retry fire, and quota/billing-looking errors carry a check-your-key hint
  - `generateLLMAlignment(contentId, userId, words)`: Main entry point. Extracts HTML content elements, builds timed transcript from Whisper words, sends both to the user's configured narration LLM, parses timestamps
  - `extractContentElements()`: Parses HTML with JSDOM into block-level elements (h1-h6, p, ul, ol, blockquote, figure, img, pre, table, div.llm-content-block), prepends title/author/date/karma as meta elements. Image elements match on the first `IMAGE_MATCH_CHARS` (400) characters of their description: at 150 two of a dozen similar descriptions were indistinguishable, so the LLM ordered two images wrongly and the outlier repair had to interpolate their timestamps. **Lists are split into one element per `<li>`** (each re-wrapped in its `<ul>`/`<ol start=N>` so bullets/numbers still render) so read-along highlights item-by-item instead of the whole list at once. **Long `<blockquote>`s are split the same way** (`splitQuoteIntoParts()`): one element per block inside the quote (paragraph, heading, list, image), each re-wrapped in its own `<blockquote>` so it still renders as a quote. Only the FIRST piece carries the `Quote: ` matcher prefix, because the narration announces a quote once. A quote holding fewer than 2 blocks (or only bare text) stays a single element, and tweet cards are untouched. Before this, a quote-shaped article (e.g. a quoted tweet thread) produced ONE element covering 20 minutes of audio. **Tweets are ONE `tweet` element each** (canonical `blockquote.twitter-tweet` cards from `normalizeTweetEmbeds()`), with matcher text mirroring the narration ("A tweet by [author]: [text]"); unnormalized legacy tweet markup falls back to a plain blockquote element. This only shapes the alignment data, the stored `html_content` is untouched. LessWrong/EA Forum LLM content blocks are extracted as `llm-block` type with `modelName` from `data-model-name` attribute
  - `extractCommentElements()`: Flattens nested comments recursively with depth tracking and metadata (username, date, karma, reactions)
  - `buildTimedTranscript()`: Groups Whisper words into sentences (splitting at `.?!` boundaries) with one timestamp per line (e.g., `[14.2] I've just started a blog about effective altruism.`), giving the LLM natural sentence context for text matching
  - Uses `getChatClientForUser()` for LLM routing (DeepSeek-V3.2 via DeepInfra preferred, OpenAI GPT-5-Nano fallback)
  - **IMPORTANT**: Alignment is done EXCLUSIVELY by the LLM. Never use fuzzy matching or algorithmic alignment (see CLAUDE.md)
  - Returns `LLMAlignmentResult` with `version: 'llm-v1'`, `elements[]` (each with type, html, startTime), `commentsStartTime`
  - Enforces non-decreasing timestamps in output
  - Post-processing: fixes comment-divider placement and searches for body text in raw Whisper words when headers are dropped (applies to ALL comments, not just the first)
  - Prompt includes explicit rules for images (spoken as "An image shows...") and footnotes (not spoken, inherit previous timestamp)
  - Stored in `content_alignment` JSONB column (same column as old Needleman-Wunsch data)

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

- **`services/podcast-cache.ts`**: Transient on-volume cache for podcast episode audio from problem hosts (suffix-matched `CACHEABLE_HOSTS` against the stored `audio_url`'s host). When a transcript is generated for an episode from a listed host, the already-downloaded file is re-encoded CBR (96k mono, loudness-normalized) and stored; the audio route then serves it with exact byte ranges instead of proxying. Covers two failure classes: bad seek behavior (SoundCloud VBR files, read-along drift after far seeks) and dynamically ad-stitched audio (AdsWizz chains, e.g. NYT/Simplecast behind podtrac/pdst.fm: every listening session can be a DIFFERENT file, so transcript timestamps only line up when playback is pinned to the exact bytes Whisper heard). Evicted on archive plus a 2GB LRU (serving touches mtime). Takes effect when an episode's transcript is (re)generated.

- **`services/wallabag-service.ts`**: Wallabag API client (requires per-user credentials)
  - `testConnection()`: Validates Wallabag credentials (URL, client ID/secret, username/password)
  - `getToken()`: OAuth2 token acquisition with automatic refresh
  - `iterateEntryPages(since?, { detail, perPage })`: async generator yielding one page of entries at a time (`null` once when a page fetch fails, then it stops). `detail=metadata` omits `content`, used by the tag reconciliation pass; Wallabag enforces no `perPage` cap
  - `fetchEntries(since?, opts)`: collects every page from the generator into `{ entries, complete }` (used by the content pull; `complete=false` means a failed page, so the sync cursor is never advanced)
  - `createEntry()`, `updateEntry()`, `deleteEntry()`: CRUD operations for Wallabag articles
  - Each service instance is tied to a specific user's credentials from `user_settings`

- **`services/tags.ts`**: The tag rules every write path shares. `normalizeTag()` / `normalizeTagList()` mirror Wallabag's `TagsAssigner` (split on comma, trim, lowercase; plus no commas, collapsed whitespace, 100-char cap, dedupe). `RESERVED_TAGS` = the three type tags (`article`/`text`/`podcast`, derived from `content_items.type`, never stored) + `nosync` (Wallabag-only). `wallabagTagString(type, tags)` builds the comma string a push sends (type tag first), `userTagsFromWallabagLabels()` strips the reserved names from a pulled entry, `hasNosyncTag()` and `sameTagSet()` are the shared predicates. `frontend/src/tags.ts` repeats the same rules for the picker and the Markdown export (`obsidianTag()`: spaces to hyphens, Obsidian-illegal characters dropped, export-only).

- **`services/wallabag-sync.ts`**: Bidirectional sync logic between Wallacast and Wallabag
  - `syncFromWallabag()`: Pull articles from Wallabag, create/update in Wallacast
  - `syncToWallabag()`: Push Wallacast articles to Wallabag, handles creates and updates
  - Auto-refetches EA Forum and LessWrong articles from the web after import (wallabag can't handle SPAs)
  - `fullSync()`: Orchestrates bidirectional sync (pull then push)
  - Conflict resolution: Wallacast always wins (uses `wallabag_updated_at` to detect changes)
  - Tracks sync state with `wallabag_id` and `wallabag_updated_at` fields on `content_items`
  - **Safety rules (a sync must never ruin the library)**: a pull never deletes a local item (a `nosync` tag seen in Wallabag MARKS the local item: its tags gain `nosync`, the push skips it, later pulls skip it, and removing the chip resumes syncing); a pull never overwrites a body Wallacast owns (`content_source != 'wallabag'`, i.e. our fetcher, the editor, an import: Wallabag's copy is its purified re-parse of what we pushed, classes and data attributes stripped, so pulling it back would degrade LLM blocks, tweets, footnotes, and read-along elements), such items only take star/archive/tags; bodies that came FROM Wallabag are still refreshed, with a version snapshot first; deletions never propagate from Wallabag
  - **Tags**: `content_items.tags` holds only the user's tags; the push prepends the type tag (`wallabagTagString`) and Wallabag's PATCH `tags` REPLACES the entry's whole set (verified in 2.6.13, `removeAllTags()` then assign), so every push sends the full list. Tags are merged **three-way** (`mergeTagSets()` in `tags.ts`) against `wallabag_synced_tags`, the set both sides had at the last sync (written on every successful push and every pull apply; migration 027 backfills it from the converted array): additions on either side survive, a tag only disappears when one side deliberately removed it, and with no local edits the result is exactly Wallabag's set. **`reconcileTagsFromWallabag()`** runs after every pull: Wallabag never bumps `updated_at` for tag-only changes (its `updatedAt` is a Doctrine `PreUpdate` callback, which does not fire for ManyToMany collection changes, and no tag code calls `setUpdatedAt`), so tags edited in Wallabag's UI are invisible to the `since` pull AND to a full refresh. The pass streams the whole library with `detail=metadata&perPage=100` (only the `content` field is dropped, verified in `EntryRepository::findEntries`; one request per 100 entries, and only ONE page is in memory at a time via `iterateEntryPages()`, so the cost is flat for any library size), merges tag sets without touching `updated_at` (so no fake conflict next time), and honors a newly added `nosync` (marks the local item). Guard rails: an entry without one of our type tags is skipped (every entry we pushed has one, so its absence means the response carried no tags or the user stripped everything, and neither may be read as "remove all local tags"), and a metadata response where NO entry has a type tag aborts the pass with a warning. Entries missing from Wallabag are left alone

### Frontend (`/frontend/src/`)

#### Entry Point
- **`main.tsx`**: React root with StrictMode
- **`App.tsx`**: Main app component. Manages tab navigation and current playing content state.

#### State Management
- **`store/contentStore.ts`**: Zustand store for centralized content state management
  - Fetches all items once on mount, stores in `allItems` master list; `items` is the filtered view
  - **Filter model**: `LibraryFilter` = `{ typeFilter: 'all'|'articles'|'texts'|'podcasts', facets, tags, searchQuery }`. `facets` is a `FacetFilter` with five combinable rows (archive: active/archived, star: starred/unstarred, audio: audio/no_audio, summary: summary/no_summary, transcript: transcript/no_transcript). Each row is one-of-two or null (no preference) and rows AND together. Default: archive 'active', rest null; all-null shows literally everything. Summary/transcript presence mirrors the card badges (`summary_generated_at` / `transcript_words`). **`tags`** is the multi-select tag filter (`tagFilter` in the store, `setTagFilter`/`toggleTagFilter`): an item matches when it carries ANY of the selected tags ("any of", like the one-of-many facet rows), empty = no tag filter. A search query starting with `#` searches tags only. The exported `itemMatchesFilter(item, filter)` is the single matcher, also used by `queueStore` for the "Up next" stream; `getSearchSnippet()` returns the "matched in text" excerpt for cards. The LibraryTab filter button shows the selected facet icons (funnel when none selected) and opens a 2x5 grid menu that stays open so rows can be combined. `typeFilter` + `facets` + `tags` + `sortDir` persist per device in localStorage (`wallacast-filters`, validated on load, search query deliberately not persisted), so a refresh or app restart reopens the library as last left. `setItemTags(id, tags)` is the optimistic tag write (one PATCH with the full list, rolled back on error), used by the TagEditor from both the library and the player. **Sort**: `sortDir` ('desc' newest-added-first default | 'asc') is applied to `allItems` inside `commit()` by `created_at`, so the library list AND the queue's "Up next" stream (which reads `allItems` directly) always share the same order; queue shuffle overrides it while on
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
- **`components/LibraryTab.tsx`**: Main library view. Uses Zustand store for state. Polls for generation progress updates; cards display karma (upvote count) and comment count with icons. "Generate All Audio" button is in the user dropdown menu (top-right). A "Continue listening" strip under the filters shows in-progress audio items from the current filtered view (1%-99% progress, sorted by `last_played_at`, max 12, hidden in bulk-select mode; clicking behaves exactly like clicking the list row so queue semantics are unchanged; toggle via setting `show_continue_listening`). Cards without an image show no placeholder (the title takes the width; the muted type icon right of the title already identifies the type). The 3px bottom progress bar carries the type color instead, using the type-pill trio: article #3b82f6, text #10b981, podcast #a855f7.
  - **Toolbar responsiveness**: `.filter-buttons` and `.filter-chips-scroll` are `flex-wrap: nowrap` at EVERY width, and the chip strip carries `overflow-x: auto`. With wrapping on, the type chips dropped to a second row in a narrow band of window widths and jumped back up above it. The labels (`.filter-label`) appear only above **950px**: the row measures 874px wide with labels and small counts, so 950 leaves room for a four-digit count on the active chip. `.type-label` on the card type pills keeps its own 740px cut-off.
  - **Toolbar row**: Search icon, the bulk-select toggle (ListChecks "Select" flipping to X "Cancel" while active, a regular toolbar icon button whose label collapses under 740px), the date-added sort toggle (arrow down "Newest" / arrow up "Oldest", drives `contentStore.sortDir`), the facet funnel, the **Tags** button (Tag icon + selected count, opens a multi-select checklist of every tag in the library with usage counts, a find box once there are more than 6 tags, and a "Clear tag filter" row; the menu stays open so several tags can be combined), then the type chips.
  - **Tag editor**: `components/TagEditor.tsx`, a popup (same modal shell as the comment/transcript dialogs) opened by tapping any hashtag chip or the "tag +" chip on a card, by "Edit tags" in the card/player dropdown, or from the player's own chips. A find-or-create box on top (Enter toggles an exact match or creates the typed tag; reserved names show an inline reason), a checklist of every library tag most-used-first plus the item's own, and Save sends ONE full list via `contentStore.setItemTags`. The known-tag list comes from `collectTagCounts(allItems)` in `frontend/src/tags.ts` (client-side, no endpoint).
  - **Filters (two dimensions, one row)**: search icon + status selector + type chips (All / Articles / Texts / Podcasts). The status selector always shows the current status's icon and label with a chevron (Inbox "Active" / Star "Favorites" / Archive "Archived", always highlighted) and opens a menu with the same icons; the dimensions combine (e.g. Podcasts + Archived). The active type chip shows its item count. Only the type-chip strip scrolls horizontally on small screens (search/status selector stay fixed so the dropdown isn't clipped). Semantics: Active = not archived, Favorites = starred (incl. archived), Archived = archived. Filtering is client-side via `itemMatchesFilter()` in `contentStore.ts` (shared with the queue's "Up next" stream).
  - **Search**: search icon expands into a full-width debounced search bar. Client-side, case-insensitive substring over title, author, description, tags, podcast show name AND the full body text (`content` column, already in the list response). Cards matching only in the body show a "matched in text: …" snippet. No fuzzy matching.
  - **Bulk selection mode**: Select button toggles checkboxes; cards keep their star/archive buttons visible (they show each item's state), while delete and the per-item dropdown hide. Bulk bar (shown immediately, even at 0 selected): count, All/None, then Gmail-style smart toggles. Star stars mixed selections and unstars when everything selected is already starred (gold icon); Archive likewise flips to Unarchive (blue) when all selected are archived, and Delete (red). Each is ONE request via `POST /content/bulk`. The overflow (⋮) menu holds Remove audio, Remove summaries, and sequential Generate audio / Generate summaries / Refetch from web (cost-confirm dialogs with item counts, progress counter, per-card status badges via the existing poll). Bulk Generate summaries includes podcasts: episodes without a transcript trigger a warning modal that can chain transcript + summary, or skip them. Selection is cleared whenever filters or search change, so select-all only ever acts on visible items.
  - Each content card has a dropdown menu (3 dots) with context-specific options:
  - **Articles/Texts**: Generate audio, Regenerate audio (if exists), Remove audio (if exists)
  - **Articles only**: Regenerate content (re-extracts through LLM)
  - **Podcasts**: Generate transcript (if none), Regenerate transcript (if exists)

- **`components/ContentCard.tsx`**: The library item card (thumbnail, title, metadata badges, generation status, star/archive/delete + dropdown menu). Extracted from LibraryTab, all state/handlers stay in LibraryTab and come in as props. The metadata row wraps onto further lines on narrow screens (it used to overflow into a horizontal scroll once the summary/transcript badges were added). Listening state is one chip: `34% • 1h 23m` while in progress, just the length before the first play (there is no separate plain-text duration anymore). After the badges come the item's tags as dimmed `#hashtag` chips and a trailing "tag +" chip (Tag + Plus icons); tapping any of them fires `onEditTags` (the TagEditor), and in bulk-select mode the chips are inert so the card tap selects. The dropdown also has "Edit tags". **Failed generation AND failed summary both show a red error box with the message, a Retry button and a dismiss X** (`onDismissError` → PATCH `dismiss_generation_error`/`dismiss_summary_error`). The generation Retry re-runs the step that actually failed: the backend tags refetch/transcript failures via `current_operation` (`'failed_refetch'`/`'failed_transcript'`), podcasts always retry transcription, and everything else retries audio generation; summary Retry regenerates the summary.

- **`components/FeedCards.tsx`**: Shared Feed tab cards, `FeedCard` (podcast/newsletter rows + the expanded selected-feed card, variants: `search-result`/`subscription`/`expanded`) and `FeedEpisodeCard` (episode/article rows used by all three Feed tab lists). Action buttons are passed in by the caller. Replaces seven copy-pasted card JSX blocks.

- **`format.ts`**: Shared formatting helpers (`cleanHtml`, `formatDuration`, `getDomainFromUrl`, `toTweets`) previously duplicated across components. (`htmlToMarkdown` moved to `markdown.ts`.)

- **`markdown.ts`**: Shared HTML↔Markdown conversion used by the editor AND "Copy content" (so they produce identical output). `htmlToMarkdown()` uses **turndown** + **turndown-plugin-gfm**; `markdownToHtml()` uses **marked** (GFM). Custom rules make Wallacast's special structures round-trip losslessly while staying Obsidian-friendly: LessWrong/EA Forum LLM blocks (`div.llm-content-block`) ↔ Obsidian callout `> [!ai] <model name>`, tweet embeds (`blockquote.twitter-tweet`) ↔ `> [!tweet]`. Tables → GFM pipe tables, links/bold/italic native. Images use standard `![alt](url)`, and a bare image's explicit pixel width is preserved via Obsidian's `![alt|WIDTH](url)` resize syntax (stored back as a `width` attribute). **Footnotes** (LessWrong/EA Forum `#fnXXX`, Substack `#footnote-N`) convert to/from Markdown footnote syntax, `[^n]` references + `[^n]: …` definitions (renumbered 1..N, back-link carets dropped); `markdownToHtml()` rebuilds them into one canonical, clickable `<section class="footnotes">` with `fn-N`/`fnref-N` ids. **`<figure>` elements that carry a caption or a width are kept as raw HTML** (Markdown can't express a `<figcaption>` or a percentage width). A bare `<figure><img></figure>` still flattens to a plain Markdown image. Other specific tags with no clean Markdown equivalent (`iframe`, `sub`, `kbd`, `video`, `audio`, and non-footnote `sup`) are likewise kept raw. (Note: turndown's default for *unlisted* wrapper tags is to unwrap them, so this raw-keep is an explicit per-structure list, not a blanket guarantee.) `markdownToHtml()` strips `<script>`/`<style>` (the backend strips again on save).

The matching CSS (`App.css`) caps every image at the column width (`max-width: 100% !important`, so no horizontal scrollbars) and only force-stretches images that have **no** explicit width, so a bare narrow image keeps its size instead of ballooning.

  **Obsidian properties (frontmatter) round-trip.** `contentToMarkdown(item, comments, opts)` now opens with `buildFrontmatter()`: a YAML block with `title`, `author`, `show` (podcasts), `source` (the human URL via `displayUrl`, never a synthetic `wallacast://` one), `published` and `saved` as ISO dates, `tags` (the type tag first, then the user's tags through `obsidianTag()`), `description` (articles/texts), `duration` (podcasts), `upvotes`, `comments`. The old byline/link lines under the H1 are gone (the frontmatter carries them), the `# Title`, body, and `## Comments` section remain. With the `copy_include_summary` setting on, the summary and the comment summary sit at the very top, between the properties and the `# Title`, each in a fenced code block labeled with `copy_summary_code_label` (a longer fence is used automatically when the summary itself contains backticks); `copy_include_comments` (default on) controls the `## Comments` section. No internal ids: an import always creates a NEW item. The reverse: `parseFrontmatter()` reads the Obsidian subset of YAML (scalars, `- item` lists, inline `[a, b]`), `splitExportedSummary()` takes a fenced block that opens the text (any label) as the summary plus a following "Comments summary:" block as the comment summary (only applied when a properties block was present, which is what makes a leading code block unambiguous; stored via `POST /api/content` `summary`/`comment_summary` as a completed summary, so auto-summarize is skipped), `stripLeadingTitle()` drops a repeated `# Title`, and `splitExportedComments()` parses an exported `## Comments` section back into structured `Comment[]` (our own deterministic format: `**name • N points • dd/mm/yyyy**` headers, replies nested one `> ` per depth, top-level comments separated by `---`), leaving the section in the body untouched when it does not match. `AddTab.tsx` applies all of that: a properties block in the Markdown text or an uploaded `.md` fills title/author/date/tags once (fields the user already typed are left alone, a notice lists what was found), and on save the body is stripped of the block, comments go up as `comments`, tags as `tags`, `description` is kept, and a `source` http(s) URL turns the item into an `article` with that URL (content supplied, nothing fetched, "Refetch from web" still works later).

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

- **`components/AddTab.tsx`**: Content addition form. Supports article URLs, plain text, file uploads (HTML or Markdown), and manual podcast episodes. Adds created content directly to store. Uploads are stored as `type='text'` items and get the same read-along/alignment/TTS treatment as regular articles; `.md`/`.markdown`/`.txt` files are converted with `markdownToHtml()` first, `.html`/`.htm` pass through raw (backend sanitizes either way). The **Text** type has a **Markdown / HTML format toggle** (Markdown is the friendly default, converted to HTML via `markdown.ts` `markdownToHtml()` before saving; HTML mode passes raw HTML through, cleaned server-side) plus optional Author, Date, and Tags (comma-separated) fields; Upload has the same three. Markdown with an Obsidian properties block (including a Wallacast "Copy content" export) pre-fills those fields and imports comments, description, and source URL on save (see `markdown.ts` above).

- **`components/SettingsPage.tsx`**: User settings management UI. Each TTS voice chip has a speaker button that plays a static sample from `public/voice-previews/` (generated by `frontend/scripts/generate-voice-previews.mjs`, then loudness-normalized with `frontend/scripts/normalize-voice-previews.mjs`; rerun both + commit after changing `VOICE_CATALOG`). The Playback section also holds the speed-button cycle chips (setting `playback_speed_options`, JSON array of speeds from `SPEED_CATALOG` in `format.ts`; blank = the default 1x-2x set)
  - **Section order** (top to bottom): Account, Audio generation, Summaries, Playback, API keys, Models, Custom prompts (advanced), Wallabag sync.
  - **Account** section shows a feature-availability list driven by which API keys are configured: a green check per available feature, a red X plus the required key for missing ones, and a link that scrolls to the API keys section. When every feature is covered it collapses to a single green "All features available".
  - **Audio generation** section is deliberately thin, only the "what runs automatically" toggles: auto-generate audio for articles, auto-transcribe podcasts, and the comment-narration toggles (EA Forum/LessWrong, Substack) + the max-comments cutoff. No model pickers live here anymore.
  - **Summaries** section has a "Length settings" collapsible (words-per-paragraph + the length-tier editor). The editable-prompt UI is now its own top-level **"Custom prompts (advanced)"** section (covers all prompt categories, not just summaries).
  - **API keys** section (DeepInfra listed first): DeepInfra, OpenAI, OpenRouter, **Anthropic** (key page at `platform.claude.com`), Gemini. The section intro carries the one-line recommendation (GPT-5 Mini via OpenAI for narration and read-along, DeepInfra for transcription and TTS) and links to OpenRouter's **Compare model pricing** page. Each key has a two-line description, with line 1 listing the features it can power (from: narration, read-along, summaries, TTS, transcription, image descriptions), and line 2 is a "Get a key" link. Configured keys show a trash button that clears the stored value (the backend treats `''` as unset). **DeepInfra covers every feature**: chat features, Kokoro TTS voices, Whisper transcription, and image descriptions via Gemma 4 (verified 2026-07-02 to match Gemini Flash description quality at ~1/20th the cost). **OpenAI also covers every feature** (GPT-5 Mini is vision-capable for image descriptions, verified 2026-07-02). **OpenRouter covers chat features, image descriptions, and Kokoro TTS voices**, but NOT transcription (verified 2026-07-02: its audio endpoint returns no word timestamps, which read-along needs) and not the OpenAI voices (OpenRouter carries no OpenAI TTS models). **Gemini does chat too**, so it covers narration/read-along/summaries on top of image descriptions.
  - **Models** section (below API keys): every provider/model picker lives here as a uniform "AI job card". Narration / Read-along alignment / Summaries each get a **provider dropdown + free-text model field** (placeholder hints change per provider) + a **reasoning-effort field** (blank = provider default). Read-along & summaries have a left-aligned "Use the same model as Narration" checkbox (ticked by default). Transcription has its own provider (DeepInfra/OpenAI) + model. **TTS voices** is its own card (voice picker grouped by `Model name (Provider)`, e.g. `gpt-4o-mini-tts (OpenAI)`, `Kokoro-82M (DeepInfra or OpenRouter)`), with a **"Kokoro voices via" toggle (DeepInfra | OpenRouter)**, same Kokoro voices routed through whichever key (OpenAI voices always use the OpenAI key). **Image descriptions** is its own card with the enable checkbox inside it; **provider dropdown DeepInfra | Gemini | OpenRouter** + free-text model field (tested with Gemini Flash 3 and Gemma 4). Switching the provider auto-swaps the model field to the new provider's default when it still holds a known default, so a Gemini id never gets sent to DeepInfra. **Chat model fields left blank now genuinely use a per-provider default** (`CHAT_DEFAULT_MODELS` in `ai-providers.ts`, e.g. `gpt-5-mini` for OpenAI), and every model/effort placeholder advertises its default as `default = ...`. With nothing configured at all, defaults are **key-aware**: chat features pick the first configured key in the order OpenAI (gpt-5-mini) → DeepInfra (openai/gpt-oss-120b, chosen over DeepSeek V3.2 which DeepInfra serves at a crawling ~20 tok/s) → Anthropic (claude-haiku-4-5, whose reasoning effort defaults to **high** because Haiku degrades without thinking) → Gemini → OpenRouter (openai/gpt-5-mini). TTS defaults to **Kokoro's Puck** (`am_puck`) whenever a DeepInfra or OpenRouter key exists (Kokoro serving falls back to OpenRouter when DeepInfra is missing), else OpenAI's `gpt-4o-mini-tts` with coral. Image descriptions pick the first configured key in the order Gemini → DeepInfra → OpenAI → OpenRouter. Chat cards render via the `renderChatJob()` helper. Each field (Provider / Model / Reasoning effort) has a small caption above it so placeholders only show examples. Model fields stay **blank unless explicitly set**: the `default = ...` placeholders communicate what blank means, and saving a blank field keeps the account on the live default, so future default upgrades flow through automatically instead of being pinned into user settings at save time (the same never-pin principle the custom-prompts editor uses). Provider dropdowns still pre-fill (a select needs a value).
  - **Custom prompts (advanced)** section (placed below the Models section): a registry-driven editor fetched from `GET /api/users/prompts`. One collapsible per category (Summaries / Narration / Read-along alignment / Image descriptions), each header showing an "(N customized)" count; inside, an editable textarea per prompt pre-filled with the saved override or the built-in default, with the prompt's description, its `{placeholder}` list, a "(customized)" tag, and a "Reset to default" button. On save, a box left identical to the default is stored empty (= keep the built-in default, so future default tweaks still flow through); only genuine edits persist to `prompt_<id>`.
  - All settings descriptions use one consistent muted colour (`.settings-hint` / `.section-description` → `var(--t3)`); section intros use `.section-description`. No more ad-hoc `#666`/`#888`/blue inline colours.
  - Comment Narration toggles: separate on/off toggles for EA Forum/LessWrong comments and Substack comments (allows users to skip comment audio on a per-platform basis). When disabled, comments still display in read-along view but without audio sync
  - Wallabag integration settings (URL, client ID/secret, username/password)
  - Test connection buttons for validating credentials
  - Sync controls (pull, push, full sync) with status indicators

- **`components/AudioPlayer.tsx`**: Manages audio playback state (HTMLAudioElement, position saving, speed, sleep timer). Renders either the compact MiniPlayer (above the bottom tab bar) or the FullscreenPlayer overlay. Items WITHOUT audio render fullscreen only (the mini player is playback chrome, so it never shows for them and the fullscreen minimize button hides). Handles the iOS headphone-disconnect guard, play/pause icon sync, and podcast audio proxying through the backend.

- **`components/FullscreenPlayer.tsx`**: The expanded fullscreen overlay. Contains all tab rendering:
  - **Content tab** (articles/texts; default when there's no read-along): the current `html_content` rendered as formatted text, plus comments below. Has an **Edit** button → opens a **Markdown editor** (textarea with Write/Preview toggle; uses `markdown.ts`) with Title/Author/Date fields above it (only changed fields are sent; clearing a field clears it on the item). Saving converts Markdown→HTML, snapshots the old body + byline metadata to version history, and treats the edit like a fresh fetch (audio + read-along are left untouched-but-outdated until regenerated, so they keep speaking the old title/author until then). Articles also keep the **Refetch from web** button here. **Footnotes are clickable**: a small handler (`handleAnchorNav`) intercepts in-page `#…` link clicks and smooth-scrolls the target into view inside the player (marker → definition and back) without changing the URL, working on native LessWrong/EA/Substack anchors and our canonical `fn-N` ones.
  - **Read-along tab** (articles/texts with audio/alignment, podcasts): synced read-along view with LLM alignment, where every paragraph, heading, image, and comment gets its own timestamp and blue-left-border highlight as audio plays. Read-only and tied to the **audio version** of the text. Default tab when it exists. (Content and Read-along were one merged tab before; they're split so the editable live text and the frozen synced view are cleanly separated.)
  - **History tab** (articles/texts, only once at least one prior snapshot exists): lists version-history snapshots (saved before each edit/refetch/restore, never audio) with View and Restore. An **audio badge** marks the snapshot the current narration was generated from (the oldest snapshot created after `audio_generated_at`; snapshots capture the state *before* an overwrite, so that snapshot holds the text the audio saw. No badge = the audio narrates the current text, and the hint line says so). Restore snapshots the current state first (so it's undoable) and also rolls back title/author/date (COALESCE keeps current values where an old snapshot predates migration 024).
  - **Description tab** (podcasts only): Podcast episode description with HTML formatting
  - **Queue tab**: Spotify-style play queue. "In queue" section lists user-added items (with per-row remove + Clear). A horizontal divider separates it from "Up next from [filter]", a virtual queue derived from the library filter captured at click-time (frozen snapshot of type + status + search query; matching uses the shared `itemMatchesFilter` from `contentStore.ts`). The stream pivot is position-based on the full id stream (shuffle order or library order), so archiving the playing item mid-track doesn't reset the stream. Shuffle preference persists via the `queue_shuffle` setting; the order is built lazily on first use (safe even when settings hydrate before the library loads). Per-session shuffle toggle reorders only the non-manual stream. Manual items without audio prompt generate-or-skip; on generate, the item re-inserts at position 0 once audio is ready (pending-requeue poller in App.tsx). Autoplay toggle (Repeat icon in player options) gates continuation into non-manual items. **Prev/Next buttons navigate EVERY item matching the captured filter, audio or not** (manual queue items first): landing on an audio-less item just opens it for reading (no play attempt, no generate prompt), so reading flows article-to-article. The visible "Up next" list and autoplay continuation still require audio (`matches` vs `matchesAnyAudio` in `getStream`), and the Queue tab is hidden on audio-less items. State lives in `store/queueStore.ts`. **The active tab persists across item changes** (e.g. Summary stays open pressing next); when the new item lacks that tab, the auto-select effect snaps to its first available tab (the old per-type default). Three separate effects can move `activeTab` on an item change (auto-select-first-available, honor a "Read more"-requested `initialTab`, follow-playing-summary below); the item-change scroll-reset effect can't just read `activeTab` for its "jump to highlight vs scroll to top" decision, since those effects' `setActiveTab()` hasn't committed yet in the same render pass, so it re-derives the landing tab itself, mirroring their conditions (marked "KEEP THIS IN SYNC" in `FullscreenPlayer.tsx`). **Archive in the player**: the 10s delayed archive with undo only runs when archiving would actually wipe generated audio (non-starred article/text with audio); podcasts, starred, and audio-less items archive instantly.
  - **Summary audio / "Prefer summary audio" mode**: a global playback preference (user setting `prefer_summary_audio`, owned by App.tsx) toggled from the **playback-options panel**, the RIGHTMOST button in the player's options row (it replaced the sleep-timer button; the panel holds sleep-timer chips, Off cancels a running timer, under a Clock-iconed heading, and the mode toggle, a label-plus-fading-checkmark row; the button face shows sliders+clock icons when idle and Clock plus a LIVE counting-down "29m" while a timer is armed, via `sleepTimerEndAt` from AudioPlayer). The shared rule `getEffectiveAudio(item, mode)` in `format.ts` decides what plays: both audios -> the preferred one; one audio -> that one regardless of mode. `hasAnyAudio()` makes summary-audio-only items playable everywhere (autoplay, Up next, mini player, queue tab). **The default tab follows the PLAYING audio**: opening/advancing into an item effectively playing its summary snaps to the Summary tab (overriding tab persistence); toggling the mode mid-item swaps audio live (per-variant saved positions, playback continues) and flips the tab iff the target audio exists. While summary audio plays, ALL read-along machinery is disabled (highlighting, word coloring, read-along auto-scroll, click-to-seek, the timeline comments marker), because those timestamps describe the original audio. The Summary tab has its own timestamp-free auto-scroll instead, see below. The duration write-back guard in AudioPlayer also only runs for the original variant. **Summary-tab banner**: when summary audio exists, a slim banner at the top of the Summary tab offers Play (a PER-ITEM override via `onSelectAudioVariant`, switching to the summary audio for just this item without touching the persisted mode; keyed by item id in AudioPlayer so it expires on track change) or, while the summary is playing, "Switch to full audio". Pressing the global toggle clears any override so the toggle always visibly wins.
  - **Auto-scroll**: one shared preference (`readAlongAutoScroll` in localStorage), one toggle, shown in the tab header on whichever of the two following-tabs is open. On the **Read-along/Transcript tab**: short elements snap to center; tall elements (bullet lists, long comment blocks) use progressive intra-element scrolling that follows audio progress, with the top visible at start and bottom at end. On the **Summary tab** (only shown when summary audio exists, only acts while the summary audio is the variant playing): summary audio has no timestamps by design, so the audio fraction maps straight onto page height and is centered: `target = clamp(progress * scrollHeight - clientHeight / 2, 0, maxScroll)`. Split across two rates on purpose. `computeSummaryTarget()` runs only when the audio position changes (~4x/s) and is the only thing that measures the page. A `requestAnimationFrame` loop then eases `scrollTop` toward that target, closing `SUMMARY_SCROLL_EASING` (0.08) of the remaining distance per frame, which is one subtract/multiply/write with no measuring. Moving the page at 4x/s reads as a visible hop however it is done, and the browser's own smooth scroll cannot fix it here because a new destination arrives before each animation finishes; the read-along tabs get away with `scrollIntoView` only because their destination stays put for seconds at a time. `snapSummaryToProgress()` is the no-easing variant used when landing on the tab. The centering is deliberately what produces the pause at each end: pinned at the top while the reading point is still in the top half-screen, pinned at the bottom for the last half-screen, roughly 15-20 seconds each way at any summary length (audio duration and page height both scale with the text). **Never anchor this to words, sentences, or paragraphs**, see the CLAUDE.md ban
  - **Read-along performance**: the body and comment element trees are memoized per alignment and render WITHOUT the active class; a small always-running effect moves `ra-active` between the two affected DOM nodes as playback advances (plus a precomputed element-index map). Before this, the inline active-class computation made React rebuild every element ~4x/second during playback, which lagged phones on very long articles. If the read-along highlight ever misbehaves, look at this imperative effect and the `readAlongBodyTree`/`readAlongCommentsTree` memos in `FullscreenPlayer.tsx`
  - **Podcast transcript performance** (stage 2 of the same fix): podcasts get no LLM alignment, so their Transcript tab is one `<p>` with one `<span class="transcript-word">` per word (~18k spans for a 2h episode). That tree is now memoized per transcript (`transcriptTree` in `FullscreenPlayer.tsx`) with a single delegated click handler; the blue read state is painted imperatively by toggling `.transcript-word.read` (CSS rule in App.css, no inline styles) on only the words that changed since the last tick, auto-scroll fires only when the active word actually changes (aligned articles keep per-tick progressive scrolling), and `activeWordIndex` in `AudioPlayer.tsx` uses a binary search over a memoized numeric start-time array instead of a per-tick linear scan. Before this, React rebuilt all ~18k spans ~4x/second during playback
  - Clickable elements seek the audio to that timestamp
  - Tweet embeds (`blockquote.twitter-tweet`) styled as cards with 24px circular profile pictures (not full-width)
  - LLM content blocks (LessWrong/EA Forum `div.llm-content-block`): displayed in serif font with purple left border and model name badge (e.g., "Claude Opus 4.6"). TTS narration announces model attribution
  - Content versioning: two-line provenance display showing "Content fetched/updated by [source] on [date]" and "Audio & read-along generated on [date]" with Show/Shown toggle. Shows "(newer)"/"(older)" labels when content and audio are out of sync. Works for both articles and texts.
  - **Tags in the header**: the item's tags render as the same `#hashtag` chips the cards use (one `.tag-chip` rule for both surfaces, matching `.metadata .badge` box so every chip in a row is the same height), in a row under the author/date line, closed by a "tag +" chip; with no tags the "tag +" chip sits at the end of the author row instead (no extra row). `.fullscreen-author` is a wrapping flex row whose first item is a span holding the byline text, so the chip sits to the RIGHT of the byline when it fits and drops FLUSH LEFT onto its own line when it does not (as an inline element with a left margin it landed indented on the wrapped line).
  - **Busy messages on the Transcript tab** are ordered transcript, then alignment, then audio. The transcript job sets `current_operation` to `'transcript'` (PATCH route) or `'transcribing'` (service) AND a busy `generation_status`, so a check on `generation_status` alone claimed "Audio is being generated..." during a plain transcript regeneration. Any chip opens the TagEditor; saving writes through `contentStore.setItemTags` and `onContentUpdated`. The header's buttons are top-aligned so the title area can grow. The Queue tab's "Up next from ..." label appends the captured `#tags`.
  - **Dropdown menu** (three-dot icon, left of minimize button): Same options as library item dropdown, including "Edit tags", generate/regenerate audio, remove audio, regenerate transcript, refetch from web, "Copy content" (copies title/author/date/link/body/nested comments to the clipboard as Markdown via `htmlToMarkdown()` in `markdown.ts`, now preserving images, links, and inline formatting identical to what the editor shows; for podcast episodes the body is the episode description followed by the Whisper transcript, each only when present, and the `content` field is never used), and "Download data (zip)"

#### Other Files
- **`api.ts`**: Axios-based API client. A request interceptor injects the JWT access token as a `Bearer` header, and a response interceptor auto-refreshes the token on a 401 (retrying the original request once, or clearing tokens and redirecting to login when the refresh itself fails)
- **`sanitize.ts`**: DOMPurify wrappers (`safeHtml` strict for comments/descriptions, `safeArticleHtml` also keeps `<style>` so LessWrong/EA Forum MathJax survives) applied at every `dangerouslySetInnerHTML` sink in `FullscreenPlayer.tsx`. This is the XSS defense for fetched article/comment/description HTML: JWTs live in localStorage, so an unsanitized sink would mean account takeover from a single poisoned forum comment.
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
- `expires_at`: Token expiration (30 days)
- `revoked_at`: Manual revocation timestamp
- `created_at`

### user_settings (per-user configuration)
- `id`: Primary key
- `user_id`: FK to users table
- `setting_key`: Setting name (e.g., 'openai_api_key', 'openai_tts_voice')
- `setting_value`: Setting value (encrypted for secrets)
- `is_secret`: Boolean flag for masking in API responses
- "Copy content" keys (the "Copy content" group at the bottom of the Summaries settings section): `copy_include_summary` ('true'/'false', default off; puts the summary at the top of the copied Markdown, right under the properties block, as a fenced code block), `copy_include_comment_summary` ('true'/'false', default on; the comment summary as a second block, only used while the summary is on), `copy_summary_code_label` (the text after the opening backticks, e.g. `ad-summary` for Obsidian's Admonition plugin; blank = plain block), and `copy_include_comments` ('true'/'false', default on; the `## Comments` section). Read fresh on every copy via `frontend/src/copy-settings.ts`
- Summary-related keys: `auto_generate_summary` ('true'/'false'), `auto_generate_summary_audio` ('true'/'false', default off; chains TTS of the summary after every summary generation, bulk flows ask via dialog), `prefer_summary_audio` ('true'/'false', default off; the player's global mode playing summary audio over the original when both exist), `summarize_comments` ('true'/'false', default on), `summary_tiers` (JSON list of `{ maxChars, maxTweets }`; the unbounded tier stores `maxChars: null` = Infinity), `summary_max_words` (max words per paragraph/"tweet"; default 40), `library_show_summary` ('true'/'false')
- **Editable-prompt overrides**: `prompt_<id>` keys (e.g. `prompt_summary_article_multi`, `prompt_narration_script`, `prompt_alignment_rules`, `prompt_image_description`) hold an optional custom system prompt for each LLM job; blank/whitespace = use the built-in default. The full id list + defaults come from `services/prompt-registry.ts` (served at `GET /api/users/prompts`). The whitelist of valid keys is spread from `PROMPT_SETTING_KEYS`, so adding a prompt to the registry automatically makes its key saveable. When on, library cards show the article `summary` instead of the description (falls back to the description when no summary exists; the list endpoint now also returns `summary`)
- `tts_voices`: JSON array of `{ model, voice }`. When non-empty, each audio generation picks one of these voices at random (can mix providers, e.g. OpenAI + Kokoro). Empty = always use the single `openai_tts_voice`. Implemented via `pickRandomTTSVoice()` in `ai-providers.ts`, applied in `generateArticleAudio()`.
- **Provider keys**: `openai_api_key`, `deepinfra_api_key`, `openrouter_api_key`, `anthropic_api_key`, `gemini_api_key` (all secret/masked)
- **Per-job model config** (read by `getChatClientForJob`): `{job}_provider` / `{job}_model` / `{job}_reasoning_effort` for `job` ∈ `narration | alignment | summary`; `alignment_same_as_narration` / `summary_same_as_narration` ('true'/'false') defer to the narration config. A set provider with a blank model uses `CHAT_DEFAULT_MODELS[provider]`, and a blank reasoning effort uses `CHAT_DEFAULT_EFFORT[provider]` (currently only Anthropic → `high`), both in ai-providers.ts. `narration_llm` is the LEGACY routing kept only as the read-time fallback/pre-fill source.
- **Transcription**: `transcription_provider` (`deepinfra` | `openai`, OpenRouter removed since its endpoint has no word timestamps), `transcription_model`. **TTS routing**: `kokoro_tts_provider` (`deepinfra` | `openrouter`) routes the Kokoro voices through either (same voices, OpenAI voices always use the OpenAI key). **Image descriptions**: `image_alt_text_provider` (`gemini` | `deepinfra` | `openai` | `openrouter`), `image_alt_text_model` (free-text, effective default per provider: `gemini-3-flash-preview`, `google/gemma-4-26B-A4B-it`, `gpt-5-mini`, or `google/gemini-3-flash-preview`).
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
- `tags`: `TEXT[] NOT NULL DEFAULT '{}'` (migration 027, GIN-indexed). ONLY the user's own tags, normalized like Wallabag (lowercase, trimmed, no commas). The type tags `article`/`text`/`podcast` are derived from `type` (added on push, stripped on pull) and `nosync` is Wallabag-only; all four are reserved. `tags_legacy` is the pre-027 comma string, kept for one release then to be dropped
- `wallabag_synced_tags`: `TEXT[]`, nullable (migration 027). The user-tag set both sides agreed on at the last sync, the base of the three-way tag merge. Written on every successful push and every pull/reconcile apply; NULL is treated as "equal to the local tags"
- `wallabag_id`, `wallabag_updated_at`: For Wallabag sync tracking
- `wallabag_needs_push`: Explicit dirty flag for the push (migration 022). Set TRUE by every write that changes syncable data (single-item PATCH, bulk star/archive/unarchive, refetch, version restore, transcript writes), cleared only after a successful push. Replaces the old `updated_at > wallabag_updated_at` comparison, which was unreliable because those two columns run on different clocks. Items tagged `nosync` are never pushed and are excluded from the pending-changes count (shared `hasNosyncTag()` helper in wallabag-sync.ts)
- `playback_position`, `playback_speed` (deprecated - speed now stored globally in user settings + localStorage), `last_played_at`
- `generation_status`: 'idle' | 'starting' | 'fetching' | 'extracting_content' | 'content_ready' | 'generating_audio' | 'generating_transcript' | 'ready' | 'completed' | 'failed'. Note: 'ready' means the audio is saved but Whisper transcription and LLM alignment may still be running afterwards, so 'ready' only counts as still-working while `current_operation` is set (the frontend poll keys on both fields)
- `generation_progress`, `generation_error`, `current_operation`
- `summary`: Article-body summary (Twitter-thread style, paragraphs separated by blank lines)
- `comment_summary`: Comment-discussion summary (nullable)
- `summary_status`: 'idle' | 'generating' | 'completed' | 'failed', **independent of `generation_status`** so audio and summary can generate at the same time
- `summary_generated_at`: When the summary was last generated
- `summary_error`: Error message stored when `summary_status='failed'` (cleared on success/removal). Surfaced on library cards with a Retry button so summary failures are visible in-app, not just in the Railway logs
- **Summary audio** (migration 026): `summary_audio_url` (our endpoint + `?variant=summary`, token-less in DB), `summary_audio_duration`, `summary_audio_status` ('idle'|'generating'|'completed'|'failed', independent of the other two status columns), `summary_audio_error` (card red box with Retry/dismiss), `summary_audio_generated_at` (also the frontend cache-buster), `summary_playback_position` (separate saved position; card progress stays original-audio-only)

### podcasts
- `id`: Primary key
- `user_id`: FK to users table (subscriptions are per-user)
- `title`, `author`, `description`
- `feed_url`, `website_url`, `preview_picture`
- `category`, `language`
- `type`: `'podcast' | 'newsletter' | 'blog'` - Auto-detected based on feed content (audio enclosures vs text articles). The column allows `'blog'`, but `detectFeedType()` currently only ever assigns `'podcast'` or `'newsletter'`.
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
- `author`, `published_at`: byline metadata snapshot (migration 024; NULL on older snapshots, restore uses COALESCE so those keep the item's current values)
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

## Content Processing Flows

### Article Flow
1. User submits a URL via AddTab
2. Backend fetches and cleans the HTML (`article-fetcher.ts`), no LLM involved
3. Audio generation (automatic only if the auto-generate-audio setting is on, otherwise triggered manually): the scriptwriter LLM (the per-job configured chat model) prepares the narration script (`openai-tts.ts`)
4. TTS with the key-aware default voice (Kokoro Puck via DeepInfra or OpenRouter when such a key exists, else OpenAI `gpt-4o-mini-tts`), chunked at 3500 chars, concatenated with FFmpeg, and loudness-normalized to -19 LUFS
5. Whisper transcription with word timestamps (`transcription.ts`)
6. LLM alignment maps content elements to timestamps for the read-along view (`llm-alignment.ts`)

### Podcast Flow
1. User subscribes to RSS feed
2. Episodes are parsed and saved
3. Transcription runs automatically only when the auto-transcribe-podcasts setting is enabled (default off), otherwise it is triggered via the Generate transcript action
4. Whisper transcribes with word timestamps
5. Transcript saved for display and seeking

## Common Tasks

**Add a new field to content_items:**
1. Create migration SQL file in `backend/src/database/` or `backend/src/database/migrations/`
2. Add `fs.readFile` call in `db.ts initializeDatabase()`
3. Update `types.ts` in frontend
4. Add to SELECT queries in content.ts (explicit column list for both list and single-item endpoints)
5. If it's a large field (text/json), consider excluding from list query for performance

**Dry-run a migration without a Postgres server:** `frontend/scripts/test-migration-027.mjs` runs migration 027 on PGlite (WASM Postgres, `npm i --no-save @electric-sql/pglite` in `frontend/`, then `node scripts/test-migration-027.mjs`) against an "existing database" shape, a fresh `schema.sql`, and a second run for idempotency. Copy the pattern for any migration with a DO block or a data backfill: it catches SQL errors that would otherwise crash `initializeDatabase()` and take the whole backend down.

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

**Critical rule (audio_data must never enter list or update queries):** Use explicit column lists everywhere and never include the `audio_data` BYTEA blob in list or update queries, only fetch it when actually playing audio. This rule stays documented because a past broad-select regression shipped multi-megabyte audio blobs on every list response and every playback-position save, so future code must keep large columns out of these query paths.
