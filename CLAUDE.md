## Codebase map

This project's codebase map is the **Quick Reference table in `README.md`**. It tells you EXACTLY which file handles what functionality (e.g. a TTS bug points to the backend TTS service, an audio-player UI bug points to the frontend audio-player component). Read the relevant service/component descriptions in `README.md` (backend structure, then frontend structure) for the big picture before diving into code.

## NEVER Use Fuzzy Matching or Algorithmic Alignment

Do **NOT** propose, implement, or use any form of:

- Fuzzy text matching (string similarity, Levenshtein distance, etc.)
- Algorithmic sequence alignment (Needleman-Wunsch, Smith-Waterman, etc.)
- Any algorithm that tries to match text between content elements and transcript

This has been tried **multiple times** and **always fails**. The alignment between content elements and Whisper timestamps is done **exclusively by the LLM** (in `llm-alignment.ts`). The LLM understands context, meaning, and intent, algorithms don't.

If there's a problem with read-along alignment, fix the **input data quality** instead:

- Improve the Whisper prompt so Whisper transcribes more accurately
- Improve the TTS script so headings/dates are spoken more clearly
- Improve `buildTimedTranscript()` formatting so the LLM gets cleaner data
- Keep the LLM alignment prompt as-is

## Code Style

- Backend: ES modules with .js extensions in imports
- Frontend: Single CSS file (App.css), no CSS modules
- Use existing patterns in the codebase rather than introducing new ones

## Database Initialization Safety Rules (`backend/src/database/db.ts`)

**CRITICAL: `initializeDatabase()` is the ONLY thing standing between the user and a working app.** If it crashes, the entire backend returns 503 "service starting up" for ALL requests. The user cannot log in or use the app at all.

**Rules:**

1. **NEVER add queries that reference specific tables without try/catch.** Tables may not exist yet (migrations create them). A bare `ANALYZE podcast_subscriptions` will crash if that table was never created.
2. **NEVER add blocking operations without timeouts.** The function already uses `SET lock_timeout = '5s'` and `SET statement_timeout = '30s'`, respect this pattern.
3. **Always test mentally: "What if this table/column doesn't exist?"** Use `IF EXISTS`, `IF NOT EXISTS`, or try/catch for any operation that depends on specific schema.
4. **Migrations use `IF NOT EXISTS` / `DO $$ ... END $$` blocks** for safety. Follow this pattern.
5. **After changing `db.ts`, verify the server can start from scratch** (imagine a fresh database with no tables). The function must handle that gracefully.
