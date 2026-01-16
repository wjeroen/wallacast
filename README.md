# Readcast

A personal read-it-later and podcast app that converts articles to audio (TTS) and podcasts to text (transcription). Think Wallabag/Pocket meets Spotify Podcasts.

## Core Concept

- **Articles → Audio**: Add article URLs, they're extracted and converted to speech via OpenAI TTS
- **Podcasts → Text**: Subscribe to podcast feeds, episodes are auto-transcribed via OpenAI Whisper
- **Unified Library**: Both content types appear in one library with playback position tracking

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js, Express, TypeScript |
| Frontend | React, Vite, TypeScript |
| Database | PostgreSQL |
| TTS | OpenAI gpt-4o-mini-tts |
| Transcription | OpenAI Whisper (whisper-1, gpt-4o-mini-transcribe) |
| Content Extraction | GPT-4o-mini (HTML → readable text) |
| Audio Processing | FFmpeg (chunking, concatenation) |
| Deployment | Railway (backend, frontend, PostgreSQL as separate services) |

## Quick Reference

| When working on... | Look at... |
|-------------------|------------|
| Adding content | `backend/src/routes/content.ts` |
| TTS generation | `backend/src/services/openai-tts.ts` |
| Transcription | `backend/src/services/transcription.ts` |
| Article extraction | `backend/src/services/article-fetcher.ts` |
| Podcast feeds | `backend/src/services/podcast-service.ts` |
| Audio player | `frontend/src/components/AudioPlayer.tsx` |
| Library UI | `frontend/src/components/LibraryTab.tsx` |
| Database schema | `backend/src/database/schema.sql` |
| All types | `frontend/src/types.ts` |

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
- **`index.ts`**: Express server setup, CORS, HTTP Basic Auth middleware, route mounting, database initialization with retry logic, graceful shutdown handling

#### Configuration
- **`config/storage.ts`**: Storage directory management. Uses `/data` if Railway volume is mounted, otherwise `./public` for local dev. Provides `getAudioDir()`, `getTempDir()`, and `ensureStorageDirectories()`
- **`config/processing.ts`**: Centralized constants for audio/text processing (TTS chunk size: 3500 chars, Whisper limits: 25MB/15min chunks, retry config: 5 attempts with exponential backoff). Makes tuning easier without code changes.

#### Database
- **`database/db.ts`**: PostgreSQL connection pool management. Auto-detects Railway's `DATABASE_URL` or individual `PG*` variables. Includes `initializeDatabase()` which runs schema and all migrations sequentially. Also performs startup cleanup to reset any stuck generation tasks (items left in 'generating' status after server restart) to 'failed' status
- **`database/schema.sql`**: Main table definitions (`content_items`, `podcasts`, `queue_items`)
- **`database/add_*.sql`**: Migration files for additional columns (word timestamps, generation status, article metadata, comments)
- **`database/migrations/`**: Additional migrations
  - `001_add_audio_data_column.sql`: Adds BYTEA column for storing audio in database
  - `002_add_performance_indexes.sql`: Adds indexes on created_at, type, is_archived, is_favorite for query performance
  - `003_remove_is_read_column.sql`: Removes unused is_read column (was only cosmetic)

#### Routes
- **`routes/content.ts`**: CRUD for content items. Handles article URL fetching, auto-triggers audio generation for articles and transcription for podcasts. Notable endpoints:
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
  - `DELETE /:id` - Delete content and clean up audio files

- **`routes/podcasts.ts`**: Podcast subscription management
  - `GET /search?q=` - Search iTunes podcast directory
  - `POST /subscribe` - Subscribe to podcast feed URL
  - `POST /:id/refresh` - Fetch new episodes from feed
  - `GET /:id/preview-episodes` - Get episodes without saving to library

- **`routes/queue.ts`**: Queue management (partially implemented)
  - Standard CRUD for queue items with position management

- **`routes/transcription.ts`**: Dedicated transcription endpoint
  - `POST /content/:id` - Trigger transcription for podcast episode

#### Services
- **`services/audio-utils.ts`**: Shared audio utilities
  - `getAudioDuration()`: Get audio file duration using ffprobe (used by both TTS and transcription services)

- **`services/article-fetcher.ts`**: Fetches article HTML, extracts metadata (title, author, date). Has specific selectors for EA Forum (karma, votes, comments section). Returns raw HTML for GPT extraction

- **`services/openai-tts.ts`**: Main TTS service
  - `extractArticleContent()`: Uses GPT-4o-mini to extract readable text from HTML, also extracts structured comments with metadata
  - `generateArticleAudio()`: Generates TTS audio using gpt-4o-mini-tts, handles chunking for long articles, concatenates with FFmpeg
  - `generateAudioForContent()`: Orchestrates the full pipeline (extract content → generate TTS → save to DB)
  - Uses centralized config from `processing.ts` for chunk sizes, retry logic with exponential backoff

- **`services/transcription.ts`**: Podcast transcription using Whisper
  - `transcribeAudio()`: Basic transcription
  - `transcribeWithTimestamps()`: Returns word-level timestamps for sync
  - Uses centralized config from `processing.ts` for file size limits, chunk duration, compression thresholds
  - Handles large files by splitting into chunks, compresses audio before transcription if needed

- **`services/podcast-service.ts`**: RSS feed parsing
  - `parsePodcastFeed()`: Extracts podcast metadata from RSS
  - `fetchPodcastEpisodes()`: Gets episodes and saves to DB
  - `getPreviewEpisodes()`: Gets episodes without saving
  - Simple regex-based XML parsing (no library)

### Frontend (`/frontend/src/`)

#### Entry Point
- **`main.tsx`**: React root with StrictMode
- **`App.tsx`**: Main app component. Manages tab navigation, current playing content state, and content list state (lifted from LibraryTab for performance). Prevents refetching content on tab switches.

#### Components
- **`components/LibraryTab.tsx`**: Main library view with filters (All, Articles, Texts, Podcasts, Favorites, Archived). "All" filter excludes archived items by default. Receives content state and refresh callback as props. Shows content cards with generation status, handles bulk selection mode, playback position display. Polls for generation progress updates. Each content card has a dropdown menu (3 dots) with context-specific options:
  - **Articles/Texts**: Generate audio, Regenerate audio (if exists), Remove audio (if exists)
  - **Articles only**: Regenerate content (re-extracts through LLM)
  - **Podcasts**: Generate transcript (if none), Regenerate transcript (if exists)

- **`components/FeedTab.tsx`**: Podcast discovery and management. iTunes search, subscription list, episode preview, add-to-library functionality

- **`components/AddTab.tsx`**: Content addition form. Supports article URLs, podcast feeds, plain text, and file uploads (placeholder). Calls parent refresh callback on successful content creation.

- **`components/AudioPlayer.tsx`**: Full audio player with:
  - Play/pause, seek, skip ±15/30s
  - Speed control (0.5x to 3x)
  - Sleep timer
  - Volume control
  - Transcript display with word-click-to-seek (for podcasts with timestamps)
  - Comments section display (for EA Forum articles)
  - Playback position persistence: Auto-saves every 10s during playback, on pause, and on component unmount

#### Other Files
- **`api.ts`**: Axios-based API client with credential support for HTTP Basic Auth
- **`types.ts`**: TypeScript interfaces for ContentItem, Podcast, QueueItem, Comment, Settings
- **`App.css`**: All styles (single CSS file, no modules)
- **`index.css`**: Base styles from Vite template

## Database Schema

### content_items (main table)
- `id`: Primary key
- `type`: 'article' | 'podcast_episode' | 'pdf' | 'text'
- `title`, `url`, `content`, `html_content`
- `author`, `description`, `thumbnail_url`
- `audio_url`: URL to generated/original audio file
- `audio_data`: BYTEA column for storing audio in DB (not currently used, placeholder for Railway without volumes)
- `transcript`, `transcript_words`: Transcription text and word-level timestamps (JSON)
- `tts_chunks`: TTS chunk metadata for seeking (JSON)
- `duration`, `file_size`
- `podcast_id`: FK to podcasts table
- `published_at`, `karma`, `agree_votes`, `disagree_votes`
- `comments`: Structured comments JSON (for EA Forum)
- `is_favorite`, `is_archived` (archiving deletes audio unless favorited)
- `playback_position`, `playback_speed`, `last_played_at`
- `generation_status`: 'idle' | 'starting' | 'extracting_content' | 'content_ready' | 'generating_audio' | 'generating_transcript' | 'completed' | 'failed'
- `generation_progress`, `generation_error`, `current_operation`

### podcasts
- `id`, `title`, `author`, `description`
- `feed_url`, `website_url`, `thumbnail_url`
- `category`, `language`
- `is_subscribed`, `last_fetched_at`

### queue_items (not fully implemented in UI)
- `id`, `content_item_id`, `position`, `added_at`

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
AUTH_USERNAME=your-username
AUTH_PASSWORD=your-password
OPENAI_API_KEY=sk-...
```

**Frontend:**
```
VITE_API_URL=https://your-backend.up.railway.app/api
```

### Important Notes
- Backend has a Dockerfile that installs FFmpeg (required for audio processing)
- HTTP Basic Auth protects all /api/* routes
- Audio files are stored in /data if Railway volume is mounted, otherwise in ./public/audio
- CORS is configured for single frontend URL only

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
Edit the system prompt in `openai-tts.ts extractArticleContent()` around line 1750

**Modify transcription:**
Edit `transcription.ts transcribeWithTimestamps()`

**Add new API endpoint:**
Add route in appropriate file in `backend/src/routes/`, import in `index.ts`

## Performance Optimizations

The app implements several performance optimizations:

**Backend:**
- List queries exclude large columns (html_content, comments, transcript) that aren't needed for display
- Single-item queries include all necessary display data (comments, transcript)
- Database indexes on frequently filtered/sorted columns (created_at, type, is_archived, is_favorite)
- Composite indexes for common filter combinations
- Build process uses `copyfiles` to ensure SQL migrations are included in dist/

**Frontend:**
- Content state lifted to App.tsx to prevent refetching on tab switches
- LibraryTab receives content as props instead of managing its own state
- Optimistic UI updates with polling for generation status
- Large data only fetched when viewing individual items

**Result:** Query times reduced from 1-3 seconds to <100ms, instant tab switches

## Known Issues / TODO

See CODEBASE_CRITIQUE.md for detailed issues and fixes.

Key issues:
- Speed toggle UI inconsistent
- EA Forum comment extraction unreliable
- Queue functionality incomplete
- Audio player should be smaller/persistent across tabs

## Future Plans

- Export/import functionality (Wallabag compatibility?)
- Bulk podcast subscription import (OPML)
- Edit text content after adding
- Flemish-sounding Dutch TTS prompt
- Fullscreen player mode for reading

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
