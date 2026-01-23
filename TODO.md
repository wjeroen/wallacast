# Wallacast - Task List

> **Instructions for Claude Code:** This is a general task list for Wallacast development. Mark tasks done by changing `[ ]` to `[x]`. Add new tasks as they come up. Keep it organized and actionable. If you notice a to-do has already been completed by the user or a previous Claude instance but it it hasn't been marked yet, ask the user whether you can mark it done.

## Current Sprint

### High Priority
- [ ] Verify Wallabag sync works end-to-end with real Wallabag instance
- [ ] Play audio immediately upon clicking an item, don't forget last position
- [ ] Remember last-set speed toggle (one setting applies to all items)
- [ ] Fix library card button positioning: move buttons currently in the middle right to the top right (currently some information like audio status and generation status overlaps with the buttons)
- [ ] Fix podcast tab "+ Add to library" button to match other button styles - use a simple + button instead (podcast cards should look similar to library tab podcast cards)
- [ ] Don't show audio player timeline when there's no audio (buttons are fine), show "generate audio" button instead

### Features to Implement
- [ ] Groq API compatibility & custom transcription/TTS prompts in settings (pre-filled with a default prompt for new users)
- [ ] Don't auto-generate podcast episodes, or make auto-generation optional in settings when adding articles/podcasts
- [ ] Use icons instead of showing the full word 'articles' etc. in library filter buttons on smaller screens, only show full words with the icons on wide enough screens
- [ ] Set website title to "wallacast" (all lowercase), add icon, and turn site into PWA - search entire project for "frontend" used as website title in <title> tag or metadata objects, replace with "wallacast" (all lowercase)
- [ ] Add dark/bright mode switcher to the left of "Hi, [user]" button
- [ ] Bulk podcast subscription import (OPML format)
- [ ] Allow texts (not articles) to be edited with markdown support, doesn't immediately regenerate audio
- [ ] Add button to summarize content (low priority) - if it's an EA forum article, check whether there's already a summary written by the summarybot in the comments and use that instead
- [ ] Keep version history of all previous content/comment fetches in case articles get deleted or regeneration went poorly (don't do this with audio, would take up too much space)
- [ ] Implement import/export functionality including data that doesn't sync with wallabag, make audio files optional

### Bug Fixes
- [ ] Change TTS prompt so Dutch sounds Flemish - modify TTS instructions in openai-tts.ts: `const instructions = options.instructions || 'Read this article clearly and naturally. If the content is in Dutch, use a Belgian/Flemish accent and pronunciation. Focus on the main content. Use appropriate pacing and emphasis for readability.';` (worth testing if OpenAI's TTS model supports Dutch regional accents)
- [ ] EA Forum and Lesswrong comment extraction unreliable (Apollo state JSON parsing), sites might work slightly differently

### Performance & Optimization
- [ ] Implement batch audio generation (queue multiple articles)
- [ ] Add compression for stored audio (consider Opus codec)

### Technical Debt & Code Quality
- [ ] Issue: No Database Migration System - migrations are SQL files run every time server starts via fs.readFile(), works with IF NOT EXISTS but no version tracking or rollback capability. Fix: Use node-pg-migrate or knex migrations, or at minimum add schema_migrations table to track versions (see backend/src/database/db.ts)
- [ ] Issue: console.log everywhere throughout codebase - production logs will be cluttered. Fix: Use proper logger with levels like pino: `import pino from 'pino'; export const logger = pino({ level: process.env.LOG_LEVEL || 'info' });`
- [ ] Low priority issue (might already be solved): No input validation - all routes accept req.body without validation, TypeScript types only exist at compile time not runtime. Fix: Use zod or joi for runtime validation
- [ ] Issue (low priority): CORS only supports single frontend URL - backend/src/index.ts line 561 has `origin: process.env.FRONTEND_URL` which only allows one origin. Fix: Accept array of origins split by comma to support multiple frontends (mobile app, different domain)

### Documentation
- [ ] Add security warning on registration page: "This is a vibe-coded project. Your user data, including password and API keys and all your saved content, might not be safe. Choose a unique password and use this project at your own risk. If you want to be in control, feel free to ask for the source code and run all of this yourself."
- [ ] Create user guide (how to set up OpenAI API key, Wallabag, etc.)

## Audio Player and Content Overhaul

> **⚠️ IMPORTANT:** Only start implementing this entire section after you see a file called "PLAYEROVERHAUL.md"

### Core Player Changes
- [ ] Audio player should be smaller by default (with just the player control buttons), positioned above the tab bar, and should remain there while visiting other tabs
- [ ] On the smaller audio player, add a button to expand the player to fullscreen
- [ ] In fullscreen mode, add minimize button to make it smaller again - exiting/minimizing fullscreen does not stop the audio from playing
- [ ] Remove volume slider from player (unnecessary, space could be used for something else or just move the sleep timer there)

### Fullscreen Player Tabs
In fullscreen mode, there should be three or four tabs: Content, Comments (EA Forum and LessWrong only for now), Read-along, and Queue

#### Content Tab
- [ ] Stop using LLMs for content extraction (might still be necessary for TTS though, unsure) - use exact same article fetching process as Wallabag including thumbnails
- [ ] Change "Regenerate content" to "Refetch content" with a simple refresh button (useful when changes are made to an article)
- [ ] Display content just like Wallabag displays it, with nice headers and images etc. (current design with clickable words and no formatting will be used for read-along tab)

#### Comment Tab
- [ ] Create nicely organized comment section with clear UI showing karma and replies etc.
- [ ] Add refetch comments button that looks like a refresh button

#### Read-along Tab
- [ ] This should show the exact same text as the TTS - used to follow along with text-to-speech and implement function where clicking a word skips audio to that word
- [ ] TTS should describe images in the article
- [ ] Don't make tab automatically follow the audio (expect too many annoyances and bugs) - instead add a button that jumps to where the audio currently is
- [ ] Ensure jump-to-current-position button works properly on various screen display sizes
- [ ] Add refresh button here as well to regenerate the text and audio to match any new content/comment refetches
- [ ] Use the original content tab UI (clickable words, no formatting) for this tab

#### Queue Tab Implementation
- [ ] Connect existing queue table/routes to UI - add queue state to App.tsx or Zustand store
- [ ] Queue works like Spotify (library is essentially a playlist), but doesn't autoplay items that aren't manually added to queue
- [ ] Add toggle to enable autoplay and shuffle for non-manually added items (they always come after manually added items)
- [ ] Add player buttons to go to previous and next items, and shuffle button (applies to non-manually added items only, manually added items in queue still play in set order)
- [ ] LibraryTab should have "Add to queue" action in dropdown menu
- [ ] If manually added item in queue doesn't have audio file: pop-up asks whether to generate audio or skip. With generate audio, continue to next item on queue but add the item back to queue (as next item to play) once audio generation finishes
- [ ] If item is not manually added but from list, just skip items without audio

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
