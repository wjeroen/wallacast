# Wallacast

A personal read-it-later and podcast app that converts articles to audio (TTS) and podcasts to text (transcription). Think Wallabag/Pocket meets Spotify Podcasts. It has bidirectional wallabag sync.

## Core Concept

- **Articles → Audio**: Add article URLs, they're extracted and converted to speech via OpenAI TTS
- **Podcasts → Text**: Subscribe to podcast feeds, episodes are auto-transcribed via OpenAI Whisper
- **Newsletters → Audio**: Subscribe to newsletter RSS feeds (Substack, blogs), articles treated like regular content with TTS
- **Unified Library**: All content types appear in one library with playback position tracking

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js, Express, TypeScript |
| Frontend | React, Vite, TypeScript |
| Database | PostgreSQL |
| Authentication | JWT tokens (access + refresh), bcrypt password hashing |
| TTS | Kokoro (hexgrad/Kokoro-82M) via DeepInfra, fallback to OpenAI gpt-4o-mini-tts (per-user API keys) |
| Transcription | Whisper (openai/whisper-large-v3-turbo) via DeepInfra, fallback to OpenAI whisper-1 (per-user API keys) |
| TTS Preparation | GPT-4o-mini (prepares content for natural narration - not for extraction) |
| Article Fetching | GraphQL APIs for EA Forum/LessWrong (via got-scraping), standard scraper for other sites |
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
| Transcription | `backend/src/services/transcription.ts` |
| Article extraction | `backend/src/services/article-fetcher.ts` |
| Podcast feeds | `backend/src/services/podcast-service.ts` |
| Audio player | `frontend/src/components/AudioPlayer.tsx` |
| Feed/Podcasts UI | `frontend/src/components/FeedTab.tsx` |
| Library UI | `frontend/src/components/LibraryTab.tsx` |
| Login/registration | `frontend/src/components/LoginPage.tsx`, `frontend/src/store/authStore.ts` |
| Settings UI | `frontend/src/components/SettingsPage.tsx` |
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
| Article content extraction broken | `backend/src/services/article-fetcher.ts` - HTML fetching, then `backend/src/services/openai-tts.ts` - LLM extraction |
| Podcast transcription issues | `backend/src/services/transcription.ts` - Whisper integration and chunking |
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
                    │   GPT-4o-mini)      │
                    └─────────────────────┘
```

## Project Structure

### Backend (`/backend/src/`)

#### Entry Point
- **`index.ts`**: Express server setup, CORS, JWT auth middleware, route mounting. **Important**: Public audio endpoint (`/api/content/:id/audio`) registered BEFORE protected routes to match first. Includes database initialization with retry logic and graceful shutdown handling.

#### Configuration
- **`config/storage.ts`**: Storage directory management. Uses `/data` if Railway volume is mounted, otherwise `./public` for local dev. Provides `getAudioDir()`, `getTempDir()`, and `ensureStorageDirectories()`
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

- **`routes/content.ts`**: CRUD for content items (requires JWT auth). **All queries filter by `user_id`** for data isolation. Handles article URL fetching, auto-triggers audio generation for articles and transcription for podcasts. Notable endpoints:
  - `GET /` - List all content (excludes audio_data, html_content, comments, transcript for performance)
  - `GET /:id` - Get single item (includes comments and transcript for display)
  - `POST /` - Create content, auto-extracts article HTML if URL provided
  - `PATCH /:id` - Update playback position, archive status, etc. Special operations:
    - Archiving deletes audio to save space (unless item is favorited)
    - Un-archiving regenerates audio if missing
    - `audio_data: null, audio_url: null` removes audio from articles/texts
    - `regenerate_content: true` re-extracts article content through GPT-4o-mini
    - `regenerate_transcript: true` re-transcribes podcast audio through Whisper
  - `POST /:id/generate-audio` - Manually trigger audio generation
  - `GET /:id/audio` - **PUBLIC** endpoint (no auth) for streaming audio with byte-range support. Registered in `index.ts` before protected routes. Required for HTML5 `<audio>` elements which can't send JWT tokens. **Optimized**: Range requests use PostgreSQL `substring()` to read only the needed bytes (not the entire blob), capped at 2MB chunks. This makes seeking near-instant even for 100MB+ files.
  - `DELETE /:id` - Delete content and clean up audio files

- **`routes/podcasts.ts`**: Podcast and RSS feed subscription management (requires JWT auth, all queries filter by `user_id`)
  - `GET /search?q=` - Smart search: iTunes directory for text queries, RSS feed fetch for URLs (auto-detects)
  - `POST /subscribe` - Subscribe to podcast or RSS feed URL (auto-detects type: podcast/newsletter/blog)
  - `POST /:id/refresh` - Fetch new episodes from feed
  - `GET /:id/preview-episodes` - Get episodes without saving to library (for subscribed feeds)
  - `GET /preview-by-url?url=` - Preview episodes/articles from any RSS feed URL without subscribing
  - **Feed Caching (Performance Optimization)**:
    - `GET /feed-items?feedId&limit` - Get cached feed items from database (instant, no network requests)
    - `POST /refresh-feeds` - Refresh all subscribed feeds from network, update cache (fetches RSS, saves to `feed_items` table)
    - `GET /last-refresh` - Get timestamp of last feed refresh

- **`routes/queue.ts`**: Queue management (partially implemented)
  - Standard CRUD for queue items with position management

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
  - `getAIProvider(userId)`: Returns configured AI provider (currently OpenAI)
  - `getTTSClientForUser(userId, modelId)`: Intelligent router - returns DeepInfra client for Kokoro models, OpenAI client otherwise
  - `getTranscriptionClientForUser(userId)`: Prefers DeepInfra Whisper if configured (cheaper), falls back to OpenAI
  - `getDeepInfraClientForUser(userId)`, `getOpenAIClientForUser(userId)`: Provider-specific clients
  - `getUserSetting(userId, key)`: Fetches setting from `user_settings` table
  - No global API keys - each user must configure their own (OpenAI and/or DeepInfra)

- **`services/audio-utils.ts`**: Shared audio utilities
  - `getAudioDuration()`: Get audio file duration using ffprobe (used by both TTS and transcription services)

- **`services/article-fetcher.ts`**: Fetches articles using GraphQL APIs for EA Forum/LessWrong (via got-scraping with human-like headers), standard scraping for other sites (simple fetch without custom headers to avoid Cloudflare). Substack-specific optimizations: targets `.body.markup` for cleaner content, removes UI chrome (social buttons, navigation footers, Previous/Next buttons). Extracts metadata (title, author, date, karma, comments with reactions). Returns both HTML and structured data. No LLM usage for extraction.

- **`services/openai-tts.ts`**: Main TTS service (requires per-user DeepInfra or OpenAI API key)
  - `extractArticleContent()`: Uses GPT-4o-mini to prepare HTML for TTS narration (formatting, date conversion, removing navigation elements). NOT used for initial article extraction.
  - `generateArticleAudio()`: Generates TTS audio using Kokoro (via DeepInfra) or OpenAI gpt-4o-mini-tts, handles chunking for long articles, concatenates with FFmpeg
  - `generateAudioForContent()`: Orchestrates the full pipeline (prepare content → generate TTS → save to DB with `user_id`)
  - TTS features: Quote block announcements ("Quote:" / "End quote."), LessWrong score filtering (only reads user-visible karma + agreement), URL narration (reads domain name instead of full URL for links in comments)
  - Comment processing: `htmlToNarrationText()` removes emojis, announces quotes, replaces URLs with domain names (e.g., "link to example.com")
  - Uses centralized config from `processing.ts` for chunk sizes, retry logic with exponential backoff

- **`services/transcription.ts`**: Podcast transcription using Whisper (requires per-user OpenAI API key)
  - `transcribeAudio()`: Basic transcription
  - `transcribeWithTimestamps()`: Returns word-level timestamps for sync
  - Uses centralized config from `processing.ts` for file size limits, chunk duration, compression thresholds
  - Handles large files by splitting into chunks (uses actual ffprobe duration for chunk time offsets), compresses audio before transcription if needed

- **`services/podcast-service.ts`**: RSS feed parsing (podcasts, newsletters, blogs) with database caching
  - `searchPodcasts()`: Search iTunes podcast directory (returns podcast feeds only)
  - `searchRSSByUrl()`: Fetch and parse any RSS feed by URL (auto-fixes Substack URLs by adding /feed suffix)
  - `fetchPodcastDetails()`: Extracts feed metadata and auto-detects type (podcast vs newsletter) based on MIME types
  - `detectFeedType()`: Analyzes feed items - checks if enclosures are `audio/*` (podcast) or `image/*` (newsletter)
  - `fetchPodcastEpisodes()`: Gets episodes and saves to DB
  - `getPreviewEpisodes()`: Gets episodes/articles without saving (handles both audio podcast episodes and text newsletter articles)
  - `extractNestedXMLTag()`: Handles nested XML structures like Substack's `<image><url>...</url></image>`
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
  - Holds content items array and current filter state
  - Provides optimistic updates for instant UI feedback (star, archive, delete)
  - Filter-aware: items automatically show/hide based on current filter
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
- **`components/LibraryTab.tsx`**: Main library view with filters (All, Articles, Texts, Podcasts, Favorites, Archived). Uses Zustand store for state. "All" filter excludes archived items by default. Shows content cards with generation status, handles bulk selection mode, playback position display. Polls for generation progress updates. Each content card has a dropdown menu (3 dots) with context-specific options:
  - **Articles/Texts**: Generate audio, Regenerate audio (if exists), Remove audio (if exists)
  - **Articles only**: Regenerate content (re-extracts through LLM)
  - **Podcasts**: Generate transcript (if none), Regenerate transcript (if exists)

- **`components/FeedTab.tsx`**: Podcast and RSS feed discovery and management with database caching
  - **Smart Search**: Detects URLs vs search terms - iTunes podcast search for text, RSS feed fetch for URLs (auto-fixes Substack by adding /feed)
  - **Search Results**: Click any result to preview episodes/articles before subscribing. "Show All Search Results" button clears preview and returns to search results
  - **Subscriptions**: Collapsible section (collapsed by default) showing all subscribed feeds (podcasts + newsletters) with type icons and unsubscribe option
  - **Recent Updates**: Shows 100 most recent episodes/articles across all subscribed feeds (loaded from database cache, instant)
  - **Refresh Button**: Next to "Recent Updates" heading - refreshes all feeds from network, shows last refresh time ("5 mins ago")
  - **Performance**: Database caching eliminates 70+ network requests per page load (instant instead of 30+ seconds for 70 subscriptions)
  - **Feed Detail View**: Click a feed to see expanded card with full description + that feed's content. "Show All Subscriptions" button to return to full list
  - **Feed Type Icons**: Podcast icon (microphone) for podcasts, Newspaper icon for newsletters. Link icon in search bar when URL detected
  - **Add to Library**: Plus button on each episode/article adds it to library (respects auto-generate audio setting for articles)
  - **Authentication**: Uses axios API client with automatic Bearer token injection (no raw fetch)
  - Uses same card styling as Library tab (content-card class, 80x80 thumbnails, `1h 23m` duration format)

- **`components/AddTab.tsx`**: Content addition form. Supports article URLs, podcast feeds, plain text, and file uploads (placeholder). Adds created content directly to store.

- **`components/SettingsPage.tsx`**: User settings management UI
  - OpenAI API key configuration (required for TTS/transcription)
  - TTS voice selection (alloy, echo, fable, onyx, nova, shimmer)
  - Wallabag integration settings (URL, client ID/secret, username/password)
  - Test connection buttons for validating credentials
  - Sync controls (pull, push, full sync) with status indicators

- **`components/AudioPlayer.tsx`**: Full audio player with:
  - Play/pause, seek, skip ±15/30s
  - Speed control (0.5x to 3x)
  - Sleep timer
  - Volume control
  - Transcript display with word-click-to-seek (for podcasts with timestamps)
  - Comments section display (for EA Forum articles)
  - Playback position persistence: Auto-saves every 10s during playback, on pause, and on component unmount
  - **Refetch button**: The "Refetch from web" button in the Content and Comments tabs refetches BOTH content AND comments together from the original URL (calls `POST /api/content/:id/refetch`). This is useful when article content or comments have been updated.

#### Other Files
- **`api.ts`**: Axios-based API client with credential support for HTTP Basic Auth
- **`types.ts`**: TypeScript interfaces for ContentItem, Podcast, QueueItem, Comment, Settings (field names aligned with Wallabag API)
- **`App.css`**: All styles (single CSS file, no modules)
- **`index.css`**: Base styles from Vite template

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
- `comments`: Structured comments JSON (for EA Forum)
- `is_starred`, `is_archived` (Wallabag: starred/archived; archiving deletes audio unless starred)
- `tags`: Comma-separated tags (Wallabag style)
- `wallabag_id`, `wallabag_updated_at`: For Wallabag sync tracking
- `playback_position`, `playback_speed`, `last_played_at`
- `generation_status`: 'idle' | 'starting' | 'extracting_content' | 'content_ready' | 'generating_audio' | 'generating_transcript' | 'completed' | 'failed'
- `generation_progress`, `generation_error`, `current_operation`

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

### queue_items (not fully implemented in UI)
- `id`: Primary key
- `user_id`: FK to users table (queues are per-user)
- `content_item_id`: FK to content_items table
- `position`, `added_at`

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
```

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
- Filter state preserved in store - no lost filter when updating items
- Polling for generation status with targeted item updates
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
