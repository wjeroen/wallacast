# Wallacast - Task List

> **Instructions for Claude Code:** This is a general task list for Wallacast development. Mark tasks done by changing `[ ]` to `[x]`. Add new tasks as they come up. Keep it organized and actionable. If you notice a to-do has already been completed by the user or a previous Claude instance but it it hasn't been marked yet, ask the user whether you can mark it done.

## Current Sprint

> **Priority Key:** 1 = Highest priority (do first, saves money!), 2 = High priority, 3 = Medium priority, 4+ = Lower priority (do later)

### Features to Implement
- [ ] **[P1]** Groq API compatibility & custom transcription/TTS prompts in settings (pre-filled with a default prompt for new users) - SAVES MONEY!
- [ ] **[P1]** Don't auto-generate podcast episodes, or make auto-generation optional in settings when adding articles/podcasts - SAVES MONEY!
- [ ] **[P3]** Use icons instead of showing the full word 'articles' etc. in library filter buttons on smaller screens, only show full words with the icons on wide enough screens
- [ ] **[P3]** Set website title to "wallacast" (all lowercase), add icon, and turn site into PWA - search entire project for "frontend" used as website title in <title> tag or metadata objects, replace with "wallacast" (all lowercase)
- [ ] **[P3]** Add dark/bright mode switcher to the left of "Hi, [user]" button
- [ ] **[P4]** Bulk podcast subscription import (OPML format)
- [ ] **[P3]** Allow texts (not articles) to be edited with markdown support, doesn't immediately regenerate audio
- [ ] **[P5]** Add button to summarize content (low priority) - if it's an EA forum article, check whether there's already a summary written by the summarybot in the comments and use that instead
- [ ] **[P4]** Keep version history of all previous content/comment fetches in case articles get deleted or regeneration went poorly (don't do this with audio, would take up too much space)
- [ ] **[P4]** Implement import/export functionality including data that doesn't sync with wallabag, make audio files optional

### Bug Fixes
- [ ] **[P2]** Verify Wallabag sync works end-to-end with real Wallabag instance
- [ ] **[P2]** Play audio immediately upon clicking an item, don't forget last position
- [ ] **[P2]** Remember last-set speed toggle (one setting applies to all items)
- [ ] **[P2]** Fix library card button positioning: move buttons currently in the middle right to the top right (currently some information like audio status and generation status overlaps with the buttons)
- [ ] **[P2]** Fix podcast tab "+ Add to library" button to match other button styles - use a simple + button instead (podcast cards should look similar to library tab podcast cards)
- [ ] **[P2]** Don't show audio player timeline when there's no audio (buttons are fine), show "generate audio" button instead
- [ ] **[P2]** Change TTS prompt so Dutch sounds Flemish - modify TTS instructions in openai-tts.ts: `const instructions = options.instructions || 'Read this article clearly and naturally. If the content is in Dutch, use a Belgian/Flemish accent and pronunciation. Focus on the main content. Use appropriate pacing and emphasis for readability.';` (worth testing if OpenAI's TTS model supports Dutch regional accents)
- [ ] **[P3]** EA Forum and Lesswrong comment extraction unreliable (Apollo state JSON parsing), sites might work slightly differently

### Performance & Optimization
- [ ] **[P4]** Implement batch audio generation (queue multiple articles)
- [ ] **[P4]** Add compression for stored audio (consider Opus codec)

### Technical Debt & Code Quality
- [ ] **[P4]** Issue: No Database Migration System - migrations are SQL files run every time server starts via fs.readFile(), works with IF NOT EXISTS but no version tracking or rollback capability. Fix: Use node-pg-migrate or knex migrations, or at minimum add schema_migrations table to track versions (see backend/src/database/db.ts)
- [ ] **[P4]** Issue: console.log everywhere throughout codebase - production logs will be cluttered. Fix: Use proper logger with levels like pino: `import pino from 'pino'; export const logger = pino({ level: process.env.LOG_LEVEL || 'info' });`
- [ ] **[P5]** Low priority issue (might already be solved): No input validation - all routes accept req.body without validation, TypeScript types only exist at compile time not runtime. Fix: Use zod or joi for runtime validation
- [ ] **[P5]** Issue (low priority): CORS only supports single frontend URL - backend/src/index.ts line 561 has `origin: process.env.FRONTEND_URL` which only allows one origin. Fix: Accept array of origins split by comma to support multiple frontends (mobile app, different domain)

### Documentation
- [ ] **[P3]** Add security warning on registration page: "This is a vibe-coded project. Your user data, including password and API keys and all your saved content, might not be safe. Choose a unique password and use this project at your own risk. If you want to be in control, feel free to ask for the source code and run all of this yourself."
- [ ] **[P5]** Create user guide (how to set up OpenAI API key, Wallabag, etc.)

## Audio Player and Content Overhaul

> **⚠️ IMPORTANT:** Only start implementing this entire section after you see a file called "PLAYEROVERHAUL.md"

### Core Player Changes (Do Later)
- [ ] **[P5]** Audio player should be smaller by default (with just the player control buttons), positioned above the tab bar, and should remain there while visiting other tabs
- [ ] **[P5]** On the smaller audio player, add a button to expand the player to fullscreen
- [ ] **[P5]** In fullscreen mode, add minimize button to make it smaller again - exiting/minimizing fullscreen does not stop the audio from playing
- [ ] **[P5]** Remove volume slider from player (unnecessary, space could be used for something else or just move the sleep timer there)

### Fullscreen Player Tabs
In fullscreen mode, there should be three or four tabs: Content, Comments (EA Forum and LessWrong only for now), Read-along, and Queue

#### Content Tab (Do First - Saves Money!)
- [ ] **[P1]** Stop using LLMs for content extraction (might still be necessary for TTS though, unsure) - use exact same article fetching process as Wallabag including thumbnails - SAVES MONEY!
- [ ] **[P1]** Change "Regenerate content" to "Refetch content" with a simple refresh button (useful when changes are made to an article)
- [ ] **[P1]** Display content just like Wallabag displays it, with nice headers and images etc. (current design with clickable words and no formatting will be used for read-along tab)

#### Comment Tab (Do First)
- [ ] **[P1]** Create nicely organized comment section with clear UI showing karma and replies etc.
- [ ] **[P1]** Add refetch comments button that looks like a refresh button

#### Read-along Tab (Do First - Without Timesync)
- [ ] **[P1]** Create read-along tab that shows current content tab UI (clickable words, no formatting)
- [ ] **[P1]** TTS should describe images in the article
- [ ] **[P1]** Add refresh button here as well to regenerate the text and audio to match any new content/comment refetches
- [ ] **[P6]** This should show the exact same text as the TTS - used to follow along with text-to-speech and implement function where clicking a word skips audio to that word (TIMESYNC - DO LATER)
- [ ] **[P6]** Don't make tab automatically follow the audio (expect too many annoyances and bugs) - instead add a button that jumps to where the audio currently is (TIMESYNC - DO LATER)
- [ ] **[P6]** Ensure jump-to-current-position button works properly on various screen display sizes (TIMESYNC - DO LATER)

#### Queue Tab Implementation (Do Later)
- [ ] **[P6]** Connect existing queue table/routes to UI - add queue state to App.tsx or Zustand store
- [ ] **[P6]** Queue works like Spotify (library is essentially a playlist), but doesn't autoplay items that aren't manually added to queue
- [ ] **[P6]** Add toggle to enable autoplay and shuffle for non-manually added items (they always come after manually added items)
- [ ] **[P6]** Add player buttons to go to previous and next items, and shuffle button (applies to non-manually added items only, manually added items in queue still play in set order)
- [ ] **[P6]** LibraryTab should have "Add to queue" action in dropdown menu
- [ ] **[P6]** If manually added item in queue doesn't have audio file: pop-up asks whether to generate audio or skip. With generate audio, continue to next item on queue but add the item back to queue (as next item to play) once audio generation finishes
- [ ] **[P6]** If item is not manually added but from list, just skip items without audio

## Completed Recently ✅

- [x] Switch main content extraction to gpt-5-mini (128k token limit) (2026-01-23)
- [x] Fix infinite comment repetition bug in content extraction (2026-01-23)
- [x] Fix migration crash loop and optimize playback position updates (2026-01-23)
- [x] Fix GPT-5-mini reasoning_effort compatibility (2026-01-23)
- [x] Fix audio regeneration to use existing content from content regeneration (2026-01-23)
- [x] Fix podcast subscription multi-user bug (composite unique constraint) (2026-01-23)
- [x] Complete Wallabag bidirectional sync implementation
- [x] Add full refresh button for Wallabag sync edge cases
- [x] Add cleanup tool for Wallabag sync
- [x] Fix content regeneration for Wallabag-synced articles
- [x] Fix conflict resolution (Wallacast always wins)
- [x] Implement two-way delete (Wallacast ↔ Wallabag)
- [x] Add pending changes indicator to sync button
- [x] Add GPT-5-mini for comment extraction (faster, cheaper than GPT-4o-mini)
- [x] Add content provenance tracking (wallabag vs wallacast)

## Future Ideas (Nice to Have)

- Share article with audio generation
- Export to audiobook format (M4B with chapters)

## Reference

For implementation details, see:
- **README.md** - Project overview, architecture, database schema
- **wallabag-api.md** - Wallabag API reference and sync implementation details
- **CLAUDE.md** - Instructions for Claude Code when working on this project
