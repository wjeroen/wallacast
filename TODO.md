# Wallacast - Task List

> **Instructions for Claude Code:** This is a general task list for Wallacast development. Mark tasks done by changing `[ ]` to `[x]`. Add new tasks as they come up. Keep it organized and actionable. If you notice a to-do has already been completed by the user or a previous Claude instance but it it hasn't been marked yet, ask the user whether you can mark it done.

## Current Sprint

> **Priority Key:** 1 = Highest priority (do first, saves money!), 2 = High priority, 3 = Medium priority, 4+ = Lower priority (do later)

### Features to Implement
- [x] **[P1]** GraphQL and got-scraper for better LessWrong and EA forum fetching (2026-01-27)
- [x] **[P4]** Allow following/subscribing to non-podcast RSS feeds in the feed tab (similar to podcast subscriptions, but for general RSS/Atom feeds like blogs) (2026-01-31)
- [ ] **[P3]** Create comments tab for Substack newsletters (extract and display comments like EA Forum/LessWrong)
- [ ] **[P4]** Save and display podcast RSS thumbnails (episode artwork from RSS feeds)
- [ ] **[P8]** Groq API compatibility (VERY LOW PRIORITY - DeepInfra now implemented for both Kokoro TTS and Whisper transcription, much cheaper than OpenAI)
- [x] **[P1]** Make auto-generating podcast transcriptions optional in settings when adding podcasts - SAVES MONEY! (2026-01-24)
- [ ] **[P3]** Use icons instead of showing the full word 'articles' etc. in library filter buttons on smaller screens, only show full words with the icons on wide enough screens
- [x] **[P3]** Set website title to "wallacast" (all lowercase), add icon, and turn site into PWA - search entire project for "frontend" used as website title in <title> tag or metadata objects, replace with "wallacast" (all lowercase) (2026-02-12)
- [ ] **[P3]** Add dark/bright mode switcher to the left of "Hi, [user]" button
- [ ] **[P4]** Bulk podcast subscription import (OPML format)
- [ ] **[P3]** Allow texts (not articles) to be edited with markdown support, doesn't automatically regenerate audio
- [ ] **[P7]** Add button to summarize content (low priority) - if it's an EA forum article, check whether there's already a summary written by the summarybot in the comments and use that instead
- [ ] **[P4]** Keep version history of all previous content/comment fetches in case articles get deleted or regeneration went poorly (don't do this with audio, would take up too much space)
- [ ] **[P4]** Implement import/export functionality including data that doesn't sync with wallabag, make audio files optional

### Bug Fixes
- [x] **[P1]** CRITICAL: Add stop/cancel button for audio generation in progress (2026-02-06)
- [ ] **[P1]** CRITICAL: Frontend doesn't refresh after refetch - content updates in database but UI still shows old data (need to reload content item after refetch completes)
- [ ] **[P2]** Open fullscreen player by default when clicking an item (currently requires 2 clicks: first on item, then on mini player to expand)
- [x] **[P2]** Default fullscreen player tab should be Content tab, not Read-along tab — read-along is now the default, renamed to "Content"; old Content/Comments tabs hidden (2026-02-18)
- [ ] **[P2]** TTS narration improvements:
  - Skip the author list outline that appears before the comment section in LessWrong (sidebar content is being read)
  - Fix vote numbers on EA Forum and LessWrong being read as concatenated digits: "4 upvotes, 3 agree votes, 2 disagree votes" is currently read as "fourhundredthirtytwo"
  - Reduce repetition in narration
  - NOTE: Quote announcements (2026-01-29) and LessWrong score filtering (2026-01-29) already implemented
  - [x] Fix TTS reading emoji names in comment author usernames (e.g. "small orange diamond" for 🔸) - stripped emojis from usernames and article author in narration (2026-02-06)
- [x] **[P2]** CRITICAL: Fixed 80GB mobile data usage and slow queries (2026-01-27):
  - App was returning entire audio files with every click and update (caused 80GB mobile data usage)
  - Root cause: `RETURNING *` in PATCH, list queries included audio_data for all items
  - Fixed: explicit column lists everywhere, audio_data only when needed
  - Result: App dramatically faster, clicking items is instant, 99% reduction in data usage
- [ ] **[P2]** Remove clickable domain URL links for podcasts (and texts if shown) in library cards and fullscreen player - they're pointless since podcasts don't have source URLs to visit
- [ ] **[P2]** Verify Wallabag sync works end-to-end with real Wallabag instance
- [ ] **[P2]** Play audio immediately upon clicking an item, don't forget last position
- [x] **[P2]** Remember last-set speed toggle (like Spotify - one global setting that remembers last used speed across all items) - Fixed: now uses localStorage + backend user setting instead of per-item database column (2026-02-05)
- [x] **[P2]** Fix library card button positioning: move buttons currently in the middle right to the top right (currently some information like audio status and generation status overlaps with the buttons) (2026-01-30)
- [x] **[P2]** Fix podcast tab "+ Add to library" button to match other button styles - use a simple + button instead (podcast cards should look similar to library tab podcast cards) (2026-01-30)
- [ ] **[P2]** Don't show audio player timeline when there's no audio (buttons are fine), show "generate audio" button instead
- [ ] **[P2]** Change TTS prompt so Dutch sounds Flemish - modify TTS instructions in openai-tts.ts: `const instructions = options.instructions || 'Read this article clearly and naturally. If the content is in Dutch, use a Belgian/Flemish accent and pronunciation. Focus on the main content. Use appropriate pacing and emphasis for readability.';` (worth testing if OpenAI's TTS model supports Dutch regional accents)

### Performance & Optimization
- [ ] **[P2]** Audio optimization:
  - Convert to mono (saves ~50% size, fine for speech)
  - Use 96k bitrate
  - Location: backend/src/services/openai-tts.ts in concatenateAudioFiles
  - FFmpeg options: `-c:a libmp3lame -b:a 96k -ac 1`
- [ ] **[P4]** Implement batch audio generation (queue multiple articles) - NOTE: Gemini attempted generation queuing on 2026-01-29 but completely fucked it up, abandoned after multiple attempts (see commits "Fuck queuing", "Gave up on queue"). Still want this feature eventually, just needs proper implementation.
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

> See PLAYEROVERHAUL.md for detailed implementation instructions

### Core Player Changes
- [x] **[P1]** Audio player should be smaller by default (with just the player control buttons), positioned above the tab bar, and should remain there while visiting other tabs (2026-01-24)
- [x] **[P1]** On the smaller audio player, add a button to expand the player to fullscreen (2026-01-24)
- [x] **[P1]** In fullscreen mode, add minimize button to make it smaller again - exiting/minimizing fullscreen does not stop the audio from playing (2026-01-24)

#### Whisper Timestamps & Audio (P2-P3)
- [x] **[P2]** Fix Whisper timestamp seeking - clicking words now works correctly (2026-01-29). Read-along auto-scroll implemented (2026-01-27), transcript drift fixed (2026-01-27)
- [ ] **[P2]** Fix podcast content provenance - shows "fetched by wallabag" incorrectly
- [ ] **[P2]** Add HTTP caching headers to /api/content/:id/audio endpoint:
  - Set Cache-Control: public, max-age=31536000, immutable
  - Prevents re-downloading same files
  - Location: backend/src/index.ts
- [ ] **[P3]** Audio optimization (TEST QUALITY FIRST before deploying!):
  - Convert to mono (saves ~50% size)
  - Use 64k bitrate (might sound compressed, standard is 64-128k)
  - Location: backend/src/services/openai-tts.ts in concatenateAudioFiles
  - FFmpeg options: `-c:a libmp3lame -b:a 64k -ac 1`

### Fullscreen Player Tabs
In fullscreen mode, there should be two to four tabs (depending on the type of item): Content (texts and articles only), Comments (EA Forum and LessWrong articles only), Read-along, and Queue
- [x] **[P1]** Create fullscreen player with these tabs despite features not being fully implemented yet (ex. queue tab can say "Work in progress") (2026-01-24)

#### Content Tab (Do First - Saves Money!)
- [ ] **[P1]** Content fetching overhaul - SAVES MONEY! MAJOR CHANGE!
  - **FREE content fetching**: HTML fetch (immediate) → Wallabag upgrade (background, if enabled) → NO automatic LLM
  - **PAID audio generation** (optional in settings): Takes FREE content → LLM prepares for TTS narration → TTS → Whisper timestamps
  - Display titles, headers, images properly in content tab for items saved through wallacast
  - EA Forum/LessWrong comments still fetched via Wallacast for FREE (Wallabag doesn't support these comments)
  - Audio generation waits for Wallabag upgrade to complete (if enabled), then uses best available content
  - Manual "Generate audio" button uses latest AVAILABLE content (no refetch, just what's there)
  - LLM prep is ONLY for making text sound natural when narrated, NOT for extraction
  - NOTE: GraphQL fetching for EA Forum/LessWrong implemented (2026-01-27), LLM already only used for TTS prep not extraction
- [x] **[P1]** Fix EA Forum/LessWrong comment extraction issues (2026-01-25):
  - LessWrong: Fixed with robust JavaScript tokenizer for ApolloSSRDataTransport parsing
  - EA Forum: Fixed by resolving both user AND contents references
  - Both platforms: Dynamic extendedScore support for all reaction types
  - HTML content rendering with dangerouslySetInnerHTML for blockquotes/formatting
- [x] **[P1]** Change "Regenerate content" to "Refetch from web" in library dropdown (2026-01-25)
- [x] **[P1]** Display content just like Wallabag displays it, with nice headers and images etc. (current design with clickable words and no formatting will be used for read-along tab) (2026-01-24)

#### Comment Tab (Do First)
- [x] **[P1]** Create nicely organized comment section with clear UI showing karma and replies etc. (2026-01-24)
- [x] **[P1]** Add refetch comments button that looks like a refresh button (2026-01-24)
- [ ] **[P1]** Wire refetch button to actually update the display after refetching

#### Read-along Tab
- [x] **[P1]** Create read-along tab that shows Whisper transcript with clickable words (2026-01-24)
- [x] **[P4]** TTS should describe images in the article (2026-02-04)
- [x] **[P1]** Add "Regenerate audio" button to generate new TTS + Whisper timestamps (2026-01-24)
- [ ] **[P1]** Wire regenerate audio button to actually regenerate and update display
- [x] **[P2]** Fix Whisper timestamp seeking - clicking words works correctly now (2026-01-29)
- [x] **[P1]** LLM-based content alignment (replaces Needleman-Wunsch) - read-along tab now looks exactly like content+comments tabs with per-element timestamps (2026-02-14)
- [x] **[P2]** Auto-scroll toggle in tab header (persisted to localStorage) (2026-02-14)
- [x] **[P1]** Fix LLM alignment timestamp precision - changed from 5-second time buckets to sentence-chunked transcript (one timestamp per sentence line) giving sub-second precision; also fixed M:SS→M.SS format confusion; removed broken algorithmic post-processing; improved LLM prompt clarity (2026-02-14)
- [x] **[P1]** Fix LLM alignment count mismatch causing last 30-40% of audio to be unmatched - replaced destructive array truncation with linear resampling to preserve full timestamp range; added tail-stretching when LLM doesn't cover enough of the audio duration (2026-02-14)
- [x] **[P2]** Fix LLM alignment comment timestamps pointing to body instead of header - comment element text now matches TTS scriptwriter format ("Username on Date with N upvotes: ...") so LLM finds the spoken header, not just the body text; also simplified chain-of-thought prompt (2026-02-15)
- [x] **[P2]** Fix LLM alignment title/author/karma - kept as 3 separate elements (title, author+date, karma); removed redundant URL from content/read-along tabs (already in header) (2026-02-15)
- [x] **[P2]** Add "Regenerate transcript" option to articles/texts in library card dropdown - re-runs Whisper + LLM alignment on existing audio without regenerating TTS (2026-02-15)
- [x] **[P2]** Fix LLM comment-divider hallucination - removed hardcoded timestamp from prompt example; added fallback rule to use last content timestamp when "Comments section" not in Whisper transcript (2026-02-15)
- [x] **[P2]** Add date and karma to content tab header - content tab now shows "By Author Date Karma" matching what read-along tab shows (2026-02-15)
- [x] **[P2]** Improve Whisper transcription accuracy — pass prompt hint with title, author, "Comments section:", and first comment header so Whisper recognizes these key phrases; extend post-processing to fix ALL comments with dropped headers (not just first); increase LLM token limit for long articles (2026-02-15)
- [x] **[P1]** Fix Whisper prompt not applied during auto-transcribe (POST route) — extracted shared `buildWhisperPrompt()` helper, applied in all 3 transcription paths, fixed `published_at` destructuring bug causing deploy failure, moved temp file cleanup to `finally` block (2026-02-15)
- [x] **[P2]** Fix image narrations dropped by scriptwriter — image descriptions were generated by Gemini but silently removed by the scriptwriter LLM because they were injected as bare text nodes; fixed by wrapping in `<p>` tags so scriptwriter preserves them as real content paragraphs (2026-02-16)
- [x] **[P2]** Fix LLM alignment 40.3 anchoring — example in prompt contained literal timestamp `40.3` which the LLM copied for any unmatched element (images, footnotes); replaced with two varied examples from different fictional articles, added explicit image/footnote rules, strengthened anti-copy warnings (2026-02-16)
- [ ] **[P2]** Test LLM alignment quality across different content types (articles, EA Forum, LessWrong, podcasts)
- [ ] **[P2]** Fix `buildTimedTranscript()` merging headings/dates into surrounding text — currently only splits at punctuation (`.?!:,;`), ignoring timing gaps between words. Short elements like "JUN 2024" get merged with the next heading if Whisper doesn't add punctuation after them. Should also split at significant timing gaps (e.g., >0.5s between words) so the alignment LLM gets cleaner, more distinct lines. File: `backend/src/services/llm-alignment.ts`
- [x] **[P2]** Fix Whisper dropping "Comments section:" and first comment header — root cause: Whisper prompt only influences first ~30-60s of audio, useless for comments at minute 25+. Fixed by: (1) emptying the Whisper prompt entirely (it was also causing title drops), (2) replacing 2-word "Comments section:" with 15-word natural sentence "Now, let's move on to the comments section, where N readers have shared their thoughts" which Whisper can't skip (2026-02-17)
- [x] **[P2]** Fix image description toggle not fully working — root cause: English Gemini descriptions injected into non-English articles caused Whisper to drop 8+ seconds of content during English→Dutch language transitions (headings, dates, paragraph starts completely missing from transcript). Fixed: `injectImageNarrations()` and `extractContentElements()` now check `image_alt_text_enabled` toggle before using stored descriptions (2026-02-17)
- [x] **[P2]** Fix images being highlighted instead of text in read-along — when image descriptions are disabled, bare `[Image: image]` placeholders were still included in the alignment element list, causing the LLM to assign them timestamps that overlap with actual text. Fixed: filter out image elements from alignment when toggle is off (2026-02-17)
- [x] **[P2]** Investigate Whisper dropping first ~7.5s of audio (title/author/date not transcribed) — fixed by injecting synthetic title anchor word at 0.0s when Whisper's first word starts after 3s (2026-02-17)
- [x] **[P2]** Add GPT-5-Mini as narration LLM option — users can now choose between GPT-5-Nano (fast, cheap) and GPT-5-Mini (smarter, slower) in Settings; also fixed stale DB model values overriding defaults (2026-02-17)
- [x] **[P2]** Add batched LLM alignment for long articles — articles with >30 elements are now split into batches of 20, each getting the full transcript but only their subset of elements, preventing GPT-5-Nano from losing sequential discipline on long content (2026-02-17)
- [x] **[P3]** Make read-along tab the default content tab — done! Renamed to "Content", old Content/Comments tabs hidden but kept in code (2026-02-18)

#### Queue Tab Implementation (Do Later)
- [ ] **[P6]** Connect existing queue table/routes to UI - add queue state to App.tsx or Zustand store
- [ ] **[P6]** Queue works like Spotify (library is essentially a playlist), but doesn't autoplay items that aren't manually added to queue (manually added items and non-manually items are clearly differentiated by a horizontal bar in the queue UI, similar to spotify)
- [ ] **[P6]** Add "queue autoplay" toggle to enable autoplay, it replaces volume slider (since I never use it)
- [ ] **[P6]** Add shuffle button that applies to non-manually added items (they always come after manually added items), autoplay toggle 
- [ ] **[P6]** Add player buttons to go to previous and next items, and shuffle button (applies to non-manually added items only, manually added items in queue still play in set order)
- [ ] **[P6]** LibraryTab should have "Add to queue" action in dropdown menu
- [ ] **[P6]** If manually added item in queue doesn't have audio file: pop-up asks whether to generate audio or skip. With generate audio, continue to next item on queue but add the item back to queue (as next item to play) once audio generation finishes
- [ ] **[P6]** If item is not manually added but from list, just skip items without audio

## Completed Recently ✅

- [x] **Proxy podcast audio through backend** (2026-02-20): Substack (and other CDNs) block cross-origin range requests from the browser. Podcast episodes now stream through `/api/content/:id/audio` — backend forwards the `Range` header byte-for-byte so only requested chunks are fetched from upstream, never the full file
- [x] **Fix stuck pause icon when audio errors** (2026-02-20): Added `error` DOM event listener — CDN range-request failures fire `error` not `pause`, so icon got stuck; also fixed stale closure via `contentRef`
- [x] **Podcast audio error logging** (2026-02-20): Railway logs now show `[PodcastDebug]` (URL on load) and `[AudioError]` (MediaError code, networkState, readyState) to diagnose which CDN pattern causes the 1-second stop
- [x] **Fix play/pause icon mismatch** (2026-02-20): Added `play`/`pause` DOM event listeners so React `isPlaying` always mirrors actual audio element state — icon is now always correct even after external pauses
- [x] **Fix headphone disconnect auto-resume** (2026-02-20): Added `userPausedRef` guard — when user explicitly pauses and then removes headphones, iOS-initiated `play` event is immediately cancelled so audio stays paused
- [x] **Comments count in fullscreen player header** (2026-02-19): Added total comment count (including replies) to article header next to upvotes — now shows "Author • Date • N upvotes • N comments"
- [x] **"Narration generated on" provenance display** (2026-02-19): Added `audio_generated_at` and `content_fetched_at` DB columns; fullscreen player now shows "Fetched by X on DD/MM/YYYY • Narration generated on DD/MM/YYYY"
- [x] **"Show newest fetch (not synced)" toggle** (2026-02-19): When article is refetched after audio generation, a link appears to toggle between newest html_content (not synced) and LLM alignment (synced with audio)
- [x] **Fix podcast audio only playing first second** (2026-02-19): Removed cache-buster query parameter from external podcast episode URLs — only applies it to our own /api/content/:id/audio endpoint now. Also fixed play() promise rejection handling.
- [x] **Switched narration/alignment LLM from GPT-4o-mini to GPT-5-Nano** (2026-02-17):
  - Model change in `ai-providers.ts` — default OpenAI model now `gpt-5-nano` instead of `gpt-4o-mini`
  - GPT-5-Nano provides detailed reasoning about alignment difficulties (e.g., explains when headings/dates aren't clean standalone lines in Whisper transcript)
  - Scriptwriter (`openai-tts.ts`) and LLM alignment (`llm-alignment.ts`) both use the new model via `getChatClientForUser()`
  - Discovered key insight: GPT-5-Nano's refusal to align revealed that `buildTimedTranscript()` merges short elements (dates, headings) into surrounding text when Whisper doesn't add punctuation, making alignment unreliable
  - **RULE**: Never suppress GPT-5-Nano's reasoning — its feedback about data quality issues is valuable diagnostic information
  - **RULE**: Never use fuzzy matching or algorithmic alignment for read-along sync (see CLAUDE.md). Fix input data quality instead.
- [x] **Added GPT-5-Mini as narration LLM option + batched alignment** (2026-02-17):
  - Users can now choose GPT-5-Mini (smarter, slower) in Settings alongside GPT-5-Nano
  - Setting: `narration_llm` now supports `'openai-mini'` value → routes to `gpt-5-mini`
  - Fixed stale DB model values: removed `getUserSetting('openai_model')` lookups that could return old `gpt-4o-mini`
  - Batched alignment: articles with >30 elements split into batches of 20, each getting full transcript + subset of elements
  - Prevents GPT-5-Nano from losing sequential discipline on long articles (observed jumps every ~25 elements)
- [x] **LLM-Based Read-Along Alignment (v3)** (2026-02-14):
  - Replaced Needleman-Wunsch algorithm with LLM-based alignment that semantically maps HTML content elements to Whisper timestamps
  - Read-along tab now renders content EXACTLY like the content tab + comments tab (same CSS classes, same layout)
  - Each block element (paragraph, heading, image, blockquote, list, comment) gets its own timestamp
  - Uses user's configured narration LLM (DeepSeek-V3.2 via DeepInfra preferred, OpenAI GPT-5-Nano fallback) via `getChatClientForUser()`
  - Added auto-scroll toggle in tab header bar (persisted to localStorage, icon-only on mobile)
  - Clickable elements to seek audio to that section
  - Active element highlighted with blue left border and subtle background
  - Comments rendered with full metadata (username, date, karma, reactions) matching comments tab
  - New service: `backend/src/services/llm-alignment.ts`
  - Frontend: Rewrote FullscreenPlayer.tsx read-along renderer with three-tier fallback: LLM alignment → legacy Needleman-Wunsch → word-by-word transcript
  - Backward compatible: old alignment data still works via legacy renderer
- [x] **Content-Transcript Alignment for Read-Along Tab** (2026-02-06):
  - Implemented Needleman-Wunsch global sequence alignment to sync original HTML content with Whisper transcript
  - Read-along tab now displays formatted content (images, headers, paragraphs) instead of plain transcript
  - Smart chunking: long paragraphs auto-split into ~50-word sections (15-20 sec audio each)
  - Section-based highlighting with smooth transitions (blue background + border)
  - Auto-scroll keeps active section centered during playback
  - Handles image descriptions gracefully (treated as gaps in alignment)
  - Tolerates transcription errors with fuzzy matching
  - Clickable sections to seek audio
  - Comment section detection for timeline markers
  - New service: backend/src/services/content-alignment.ts using seqalign library
  - Database migration: 015_add_content_alignment.sql (JSONB column)
  - Alignment runs automatically after Whisper transcription (95% → 97% → 100% progress)
  - Accuracy stats logged to console
  - Falls back to word-by-word transcript for podcasts or if alignment unavailable
- [x] **Timeline Markers & Progress Bar Improvements** (2026-02-06):
  - Added orange timeline marker showing where comments section begins (EA Forum/LessWrong)
  - Fixed transcription progress display (was showing 100% too early, now shows full pipeline)
  - Added "aligning_content" operation status (97% progress)
  - Progress bar now accurately shows: audio generation → transcription → alignment → completed
- [x] **Stop/Cancel Button for Audio Generation** (2026-02-06):
  - Added cancel endpoint: POST /api/content/:id/cancel-generation
  - Red X button appears on LibraryTab progress bars during generation
  - Immediately marks generation as cancelled when clicked
  - Prevents wasted API calls when user changes their mind
- [x] **DeepSeek Narration LLM + Settings Reorganization** (2026-02-06):
  - Added DeepSeek-V3.2 via DeepInfra as narration prep LLM (much cheaper than GPT-4o-mini)
  - Smart auto-routing: prefers DeepSeek if DeepInfra key is set, falls back to OpenAI
  - User can override with explicit choice (Auto/DeepSeek/OpenAI) in settings
  - With just a DeepInfra key, users get full functionality (no OpenAI key needed)
  - Reorganized Settings page: API Keys section + Audio Generation section (clearer layout)
  - New setting: `narration_llm` ('auto'|'deepseek'|'openai'|'openai-mini')
  - New function: `getChatClientForUser()` in ai-providers.ts
- [x] **Image Alt-Text Generation for TTS** (2026-02-04):
  - Implemented Gemini 3 Flash powered image description generation for audio narration
  - Smart regeneration: only processes new images after refetch, merges with existing descriptions
  - Batch processing: images processed in groups of 10 to avoid overwhelming API
  - Exponential backoff retry logic: up to 5 attempts for 503/overloaded errors (1s, 2s, 4s, 8s, 16s delays)
  - Heuristic filtering: automatically skips decorative images (icons, logos, <100px) before API calls
  - Stores descriptions in JSONB (image_alt_text_data) with metadata - never modifies html_content
  - Applies descriptions in memory during TTS generation only
  - Progress tracking: 0-10% image processing, 10-20% scripting, 20-90% audio, 90-95% finalization, 95-100% transcription
  - User controls: Gemini API key in Settings, image_alt_text_enabled toggle (default: true)
  - Cost: ~$0.003 per article (4% of TTS cost)
  - New service: backend/src/services/image-alt-text.ts
  - Database migration: 014_add_image_alt_text.sql
  - Frontend updates: Settings UI for Gemini key and toggle, LibraryTab status messages for all stages
- [x] **RSS Feed Loading Optimization** (2026-02-04):
  - Added database caching for RSS feed items to eliminate 70+ network requests per page load
  - Created `feed_items` table to store parsed RSS items (up to 100 most recent per feed)
  - Added refresh button to FeedTab with last refresh timestamp display ("5 mins ago")
  - Performance improvement: Feed tab now loads instantly instead of 30+ seconds for 70 subscriptions
  - Auto-cleanup keeps only 100 most recent items per feed to prevent database bloat
  - New endpoints: `GET /api/podcasts/feed-items`, `POST /api/podcasts/refresh-feeds`, `GET /api/podcasts/last-refresh`
  - Stores only metadata (title, description, URL, date) - full article text fetched when adding to library
- [x] **Audio Quality Optimization** (2026-02-01):
  - Reduced audio frequency from 44.1kHz to 24kHz (optimized for speech)
  - Reduced bitrate from 192kbps to 96kbps (smaller files, still excellent quality for TTS)
  - Result: ~70% smaller audio files with no perceptible quality loss for speech
- [x] **RSS/Atom Feed Improvements** (2026-02-01):
  - Added full Atom feed support (in addition to RSS 2.0)
  - Fixed HTML entity decoding in descriptions (&#8217; → ', &#163; → £, &#8212; → —)
  - Now properly decodes ALL HTML entities including numeric ones using JSDOM
  - Fixed RSS feed thumbnails appearing in Library tab
- [x] **Feed Type Icon Colors** (2026-02-01):
  - Podcast icon: Purple (#a855f7)
  - Article/Newsletter icon: Blue (#3b82f6) - matches app's border/button blue
  - Text icon: Green (#10b981)
  - Icons now visually distinct and color-coded by content type
- [x] **Fetch Timestamp Display** (2026-02-01):
  - Added "Fetched by Wallacast/Wallabag on (date)" in fullscreen player
  - Shows which service fetched the content and when
  - Updates when you refetch articles from web
  - Helps track content freshness
- [x] **Substack UI Cleanup** (2026-02-01):
  - Removed email subscription widgets from article display
  - Removed header anchor link buttons (those link icons next to headings)
  - Cleaner reading experience for Substack articles
- [x] **Substack Article Fetching Fix** (2026-01-31):
  - Fixed Cloudflare false positive detection blocking Substack articles
  - Removed special handling for Substack domains (was using got-scraping unnecessarily)
  - Simplified to use basic fetch for ALL sites except EA Forum/LessWrong (which need GraphQL)
  - Changed Cloudflare detection from fatal error to warning (logs but continues parsing)
  - Result: All Substack domains now work (both *.substack.com and custom domains)
- [x] **Substack and RSS Feed Subscriptions + Improvements** (2026-01-31):
  - Smart URL detection in search bar (detects URLs vs search terms automatically, shows Link icon for URLs)
  - Subscribe to newsletters (Substack, blogs) alongside podcasts
  - Auto-detect feed type (podcast vs newsletter) based on MIME types (`audio/*` vs `image/*`)
  - Preview feed content before subscribing (click to browse episodes/articles)
  - Feed type icons (Podcast icon for podcasts, Newspaper icon for newsletters)
  - Renamed sections: "Subscribed Podcasts" → "Subscriptions", "Latest Episodes" → "Recent Updates"
  - Auto-fix Substack URLs (adds /feed if missing, removes trailing slashes)
  - Database: Added `type` column to podcasts table (podcast/newsletter)
  - Backend: RSS parser handles both audio enclosures and article links
  - New endpoint: `/api/podcasts/preview-by-url` for previewing feeds (requires auth via axios)
  - Fixed navigation bug: "Show All Search Results" now properly clears preview episodes
  - Improved Substack article extraction: targets `.body.markup` for cleaner content
  - Removes UI chrome: social buttons (`.post-ufi`), navigation footers, Previous/Next buttons
  - Dual article fetcher: got-scraping for EA Forum/LessWrong GraphQL, simple fetch for other sites
  - TTS comment improvements: URLs read as domain names ("link to example.com") instead of full URLs
  - Comment processing: emojis removed, quotes announced, links replaced with domain references
  - Thumbnail extraction: handles nested XML tags (`<image><url>...</url></image>`) and image enclosures
- [x] **Feed Tab & Library Tab UI Improvements** (2026-01-30):
  - Collapsible "Subscribed Podcasts" section (collapsed by default) - chevron icon immediately after text
  - Matched duration format to Library tab (`1h 23m` instead of `1:23:45`)
  - Matched metadata layout (podcast name + date on same line)
  - Added "Show All Podcasts" button when viewing a specific podcast's episodes
  - Expanded podcast card view shows full description when selected
  - "Load More" button to see more episodes (API now returns up to 100 instead of 20)
  - Fixed card gaps (display flex + gap) including search results
  - Feed tab uses 80x80 thumbnails, Library tab uses 100x100
  - Added dark blue "Transcript" badge for podcasts in Library tab (checks transcript_words field)
  - Added bottom padding (5rem) to Feed and Library tabs (including mobile)
  - Card action buttons moved to top-right (position: absolute) - only title has reduced width
  - Metadata order: Audio badge, Transcript badge, % complete, duration
  - Fixed spacing between search bar, sections, and items
  - Refetch buttons now show text: "Refetch from web" (or "Refetch" on mobile)
  - Read-along tab shows "Regenerate audio" for articles AND texts
  - Only show "Fetched by wallacast" for articles, not texts
  - Reduced gap between title and content in fullscreen player content tab
- [x] **Feed Tab HTML Cleanup**: Fixed HTML tags showing in podcast descriptions in Feed tab - added cleanHtml() to strip tags and decode entities, matching Library tab behavior (2026-01-30)
- [x] **Feed Tab Button Styling**: Changed "Add to Library" button to icon-only style matching Library tab action buttons (2026-01-30)
- [x] **CRITICAL: Fixed 80GB mobile data usage**: App was returning entire audio files (10-50MB blobs) with every click and playback update. Fixed by using explicit column lists, excluding audio_data from list queries. App is now dramatically faster and mobile data usage reduced by ~99% (2026-01-27)
- [x] **Whisper Word Clicking**: Fixed read-along word clicking to seek correctly in podcasts and articles (2026-01-29)
- [x] **Podcast Description HTML Rendering**: FullscreenPlayer now renders podcast descriptions as HTML with whiteSpace: 'pre-wrap' to preserve formatting (2026-01-28)
- [x] **Optional Auto-Generation**: Made auto-generating audio for articles and auto-transcribing podcasts optional settings (both default to off) - major cost savings (2026-01-24)
- [x] **Kokoro TTS via DeepInfra**: Implemented intelligent routing for Kokoro (hexgrad/Kokoro-82M) TTS model via DeepInfra, falls back to OpenAI (2026-01-29)
- [x] **Whisper via DeepInfra**: Implemented automatic preference for DeepInfra Whisper (openai/whisper-large-v3-turbo) with OpenAI fallback (2026-01-29)
- [x] **GraphQL for EA Forum/LessWrong**: Replaced HTML scraping with GraphQL API fetching using got-scraping with human-like headers (2026-01-27)
- [x] **Quote Block Announcements**: TTS now says "Start quote:" and "End quote." around blockquotes in comments and articles (2026-01-31)
- [x] **LessWrong TTS Score Fix**: Fixed TTS reading internal scores - now only reads user-visible karma + agreement for LessWrong (2026-01-29)
- [x] **Podcast Description HTML**: Preserved HTML formatting in podcast descriptions while sanitizing dangerous tags - chapters now show on separate lines (2026-01-29)
- [x] **Read-along Auto-scroll**: Added auto-scroll to center active word when switching to read-along tab (2026-01-27)
- [x] Auto-refetch EA Forum/LessWrong articles from web after wallabag import (wallabag can't handle SPAs — misses comments, author, date) (2026-01-27)
- [x] **FIX**: content_source showed 'wallabag' for all posts — POST route missing 'wallacast', column default was wrong. Migration 010 fixes existing data. (2026-01-27)
- [x] **FIX**: EA Forum/LessWrong author+date missing - meta tags (og:author, article:published_time) don't work on SPAs. Now extracted from Apollo state Post objects with meta tag fallback for regular articles. (2026-01-27)
- [x] **FIX**: Content provenance display - shows "Fetched by wallabag/wallacast" in content tab. Added content_source to GET API and refetch marks items as wallacast. (2026-01-27)
- [x] **FIX**: Read-along tab shows proper status messages when no audio, audio generating, transcribing, or no transcript instead of broken clickable words. (2026-01-27)
- [x] **FIX**: Read-along transcript drift - highlighting ran ~13 seconds ahead of audio by end of 21-minute content. Root cause: display split `content.transcript` by whitespace (different word count than Whisper's `words` array). Fixed by using Whisper words directly for display. Also fixed hardcoded `timeOffset += 900` to use actual chunk duration. (2026-01-27)
- [x] **CRITICAL FIX**: 80GB mobile data leak - App returned entire audio files (10-50MB) with every click/update. Caused 80GB mobile data usage when away from WiFi. Fixed with explicit column lists excluding audio_data from list/update queries. App now dramatically faster, clicking items is instant, mobile data usage reduced 99%. (2026-01-27)
- [x] **CRITICAL FIX**: Settings not saving - add auto_transcribe_podcasts and auto_generate_audio_for_articles to VALID_SETTING_KEYS (backend was silently skipping them!) (2026-01-25)
- [x] Add comprehensive logging to settings endpoint (shows which keys saved vs skipped, values, summary) (2026-01-25)
- [x] **CRITICAL FIX**: LessWrong comments now extract with hybrid parser (handles both Direct Object and IIFE formats) (2026-01-25)
- [x] Deep recursive search for Comment objects in Apollo state (Gemini's solution) (2026-01-25)
- [x] Comprehensive logging for comment extraction (shows script tags, parse results, comment counts at each step) (2026-01-25)
- [x] **CRITICAL FIX**: Add auto_generate_audio_for_articles setting (defaults to FALSE, SAVES MONEY!) (2026-01-25)
- [x] Check auto_generate_audio_for_articles setting before auto-generating audio for new articles (2026-01-25)
- [x] Add UI checkbox in SettingsPage for controlling auto audio generation (2026-01-25)
- [x] Fix LessWrong comment extraction by checking __typename === 'Comment' instead of key prefix (2026-01-25)
- [x] Map LessWrong comments by multiple keys for flexible lookup and threading (2026-01-25)
- [x] Fix LessWrong comment extraction with robust JavaScript tokenizer (handles single/double quotes, IIFEs, undefined values) (2026-01-25)
- [x] Fix EA Forum comment content extraction (resolve contents reference, not just user reference) (2026-01-25)
- [x] Fix EA Forum/LessWrong comment reactions display - dynamic extendedScore support for all reaction types (agree, disagree, love, etc.) (2026-01-25)
- [x] Update comment metadata display to "7 upvotes • 1 agree • 1 laugh" format instead of "Karma: 7 Agree: 1 Laugh: 1" (2026-01-25)
- [x] Fix content display formatting - html_content was stored in database but not returned by GET /:id API (2026-01-25)
- [x] Add html_content to backend content.ts GET /:id SELECT query (2026-01-25)
- [x] Implement optional podcast auto-transcription setting (saves money!) (2026-01-24)
- [x] Create MiniPlayer component (compact player above bottom nav) (2026-01-24)
- [x] Create FullscreenPlayer component with tabs (Content, Comments, Read-along, Queue) (2026-01-24)
- [x] Implement Content tab for articles/texts with proper HTML formatting (2026-01-24)
- [x] Implement Comments tab for EA Forum/LessWrong articles (2026-01-24)
- [x] Implement Read-along tab with clickable words (2026-01-24)
- [x] Implement Queue tab placeholder (work in progress message) (2026-01-24)
- [x] Refactor AudioPlayer to manage state and switch between mini/fullscreen modes (2026-01-24)
- [x] Fix infinite comment repetition bug in content extraction (2026-01-23)
- [x] Fix migration crash loop and optimize playback position updates (2026-01-23)
- [x] Fix audio regeneration to use existing content from content regeneration (2026-01-23)
- [x] Fix podcast subscription multi-user bug (composite unique constraint) (2026-01-23)
- [x] Complete Wallabag bidirectional sync implementation
- [x] Add full refresh button for Wallabag sync edge cases
- [x] Add cleanup tool for Wallabag sync
- [x] Implement two-way delete (Wallacast ↔ Wallabag)
- [x] Add pending changes indicator to sync button
- [x] Add content provenance tracking (wallabag vs wallacast)

## Future Ideas (Nice to Have)

- Fullscreen player mode for reading
- Keyboard shortcuts for player
- Share article with audio generation
- Export to audiobook format (M4B with chapters)

## Reference

For implementation details, see:
- **README.md** - Project overview, architecture, database schema
- **wallabag-api.md** - Wallabag API reference and sync implementation details
- **CLAUDE.md** - Instructions for Claude Code when working on this project
