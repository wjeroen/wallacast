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
| Authentication | JWT (access + refresh tokens), bcrypt password hashing |
| TTS | Kokoro via DeepInfra, fallback to OpenAI gpt-4o-mini-tts (per-user API keys) |
| Transcription | Whisper via DeepInfra, fallback to OpenAI whisper-1 (per-user API keys) |
| Narration / alignment / summary LLMs | Per-feature provider + model choice (OpenAI, DeepInfra, OpenRouter, Anthropic, Gemini) |
| Image descriptions | Gemini, DeepInfra, OpenAI, or OpenRouter vision (optional, per-user key) |
| Article fetching | GraphQL for EA Forum/LessWrong, Substack comment extraction, standard scraper elsewhere |
| Audio processing | FFmpeg (24kHz, 96kbps MP3, optimized for speech) |
| RSS/Atom parsing | Custom parser for podcasts and newsletters |
| Deployment | Railway (backend, frontend, PostgreSQL as separate services) |

The per-feature model picker, key-aware defaults, and voice/provider details live in **ARCHITECTURE.md**.

## Authentication and Multi-User

Wallacast supports multiple users with complete data isolation:

- Users register and log in via `/api/auth/*`. Sessions use JWT access tokens (15 min) plus refresh tokens (30 days) that renew automatically.
- Every content query filters by `user_id`, so users only ever see their own library.
- Each user stores their own API keys (OpenAI, DeepInfra, Gemini, and so on) in Settings, encrypted at rest. There is no global/shared API key.
- Audio endpoints (`/api/content/:id/audio`) are public so HTML5 players can stream them, but content IDs stay private and support byte-range seeking.

The full security model (encryption, storage layout, byte-range serving) is documented in **ARCHITECTURE.md**.

## Deployment (Railway)

The app deploys as 3 separate Railway services from the same repo: a PostgreSQL database, the backend (root `backend/`, uses a Dockerfile for FFmpeg), and the frontend (root `frontend/`, served via `npx serve`).

For the step-by-step beginner walkthrough, see **RAILWAY_DEPLOYMENT.md**. The environment variables are:

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

**Frontend:**
```
VITE_API_URL=https://your-backend.up.railway.app/api
```

**Audio storage (RAM cost fix):** Generated audio lives on the Railway volume at `/data/audio/{id}.mp3`, not in Postgres. On startup the backend auto-copies any remaining `audio_data` blobs to disk (non-destructive, logged as `🎵 [AudioMigration]`). Once you have confirmed playback works, set `CLEAR_AUDIO_BLOBS=true` to drop the in-DB blobs. The startup log also prints a `📦 [Storage]` size breakdown and a `🧠 [Postgres]` line showing `shared_buffers` and friends, so you can verify whether `POSTGRES_CONFIG` took effect (only the `feliperosenek/postgres-any-version` template reads that variable, Railway's default Postgres ignores it).

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

## More documentation

- **For the technical deep-dive (architecture, database schema, service internals) see ARCHITECTURE.md.**
- Tasks, bugs, and the roadmap live in **TODO.md**.
- The Wallabag API reference and sync details are in **wallabag-api.md**.

## License

Released under the [MIT License](LICENSE). Built with many open-source libraries (React, Express, turndown, marked, and more), each retains its own license.
