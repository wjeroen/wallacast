# Wallacast - Task List

> **How to use this file:** open work lives in **Current Sprint**, grouped by area and tagged with a priority. Finished work moves to **Completed Recently** (a rolling window, older wins get pruned). Nice-to-haves live in **Future Ideas**. Mark a task done by changing `[ ]` to `[x]`, then move it down to Completed. If something looks already done but is not checked, ask before marking it.

## Current Sprint

> **Priority key:** P1 = do first (launch-critical), P2 = high, P3 = medium, P4+ = later.

### 🚀 Launch readiness

> Goal: a smooth first session on the promoted hosted instance. Ordered by what a first-time visitor hits: land → register → get a key working → first article → first audio → come back tomorrow.

- [ ] **[P1]** Operator setup on Railway before promoting (one-time, all steps documented in RAILWAY_DEPLOYMENT.md):
  - Set `INVITE_CODE` on the backend to gate registration (unset = open registration).
  - Create a free resend.com account and set `RESEND_API_KEY` (and optionally `EMAIL_FROM` after verifying a domain) to activate the "Forgot password?" email flow. Without it, the reset form tells users to contact you.
  - Run the first `pg_dump` backup (Railway auto-backups are Pro-only, you are on Hobby). Audio is regenerable, the database is not. Repeat periodically. Post-launch idea: automate with a scheduled GitHub Action pushing dumps to private storage.
- [ ] **[P1]** Registration security warning. Add a short notice on the register form: this is a vibe-coded project, your data (password, API keys, saved content) might not be fully safe, choose a unique password, use at your own risk, and you can run it yourself from the public repo. Must be live before promotion. (`HomePage.tsx` register branch.)
- [ ] **[P2]** Home page finishing touches. The page is built (`HomePage.tsx`). Remaining: (1) replace the 5 red placeholder screenshots in `frontend/public/landing/` with real 600x1300 PNGs (library, read-along mid-highlight, player, podcast feed, summary tab), then drop the "red boxes" note in the carousel; (2) reword any copy, all current wording comes from the Claude Design mockup.
- [ ] **[P2]** Reword the demo onboarding guide and demo banner/toast copy if my wording is not quite your voice (`backend/scripts/seed-demo-content.mjs`, then re-run `npm run seed:demo`).
- Security review: you are running this separately on another model. Its findings plus the "Security, deferred" list below should land before promotion.

### Features to Implement
- [ ] **[P3]** Offline support + local caching (was P1, demoted: multi-week project, not a launch blocker). Use IndexedDB to cache content on-device so opening items is instant even online, and the app works fully offline.
  - **Non-audio content (auto-cached):** article HTML, metadata, alignment/transcript, comments (all tiny, ~50-100KB/item). Load from IndexedDB instantly, then background-sync with the server.
  - **Audio (opt-in):** "Auto-download audio for offline" setting: Off (default) / Articles & texts only / Everything. Podcasts are large (~30-100MB), so explicit opt-in.
  - **Explicit per-item "Download for offline" button** in library/player.
  - **Storage management UI in Settings:** "X MB used (N items)" + "Clear all offline data".
  - **Request persistent storage** (`navigator.storage.persist()`) so Android does not evict PWA data.
  - **Technical:** IndexedDB is per-device. Frontend checks IndexedDB first, falls back to server. Service worker stays out of audio requests (keeps the byte-range fix). App updates do not wipe IndexedDB.
- [ ] **[P4]** Implement import functionality (export already exists via "Download data (zip)").
- [ ] **[P4]** Bulk podcast subscription import (OPML format).
- [ ] **[P4]** Save and display podcast RSS thumbnails (episode artwork from feeds).
- [ ] **[P4]** For EA Forum articles, reuse the summarybot's existing comment summary instead of generating a new one, when present.
- [ ] **[P8]** Groq API compatibility (very low priority, DeepInfra already covers cheap TTS + transcription).
- [ ] **Confirm to close:** the "Content fetching overhaul" (free HTML fetch on add, LLM only for narration prep, manual generate uses available content) appears fully implemented. Name any missing delta, or say the word and it gets checked off.

### Bug Fixes
- [ ] **[P2]** Images not displaying in read-along for some articles (descriptions ARE read aloud, so they exist in alignment data). Likely stale alignment from before image extraction was added, try regenerating the transcript to confirm.
- [ ] **[P2]** TTS narration improvements:
  - Skip the author-list outline before the comment section on LessWrong (sidebar content is being read).
  - Reduce repetition in narration.
- [ ] **[P2]** Change TTS prompt so Dutch sounds Flemish. Modify the TTS instructions in `openai-tts.ts` (add a Belgian/Flemish accent hint for Dutch content). Worth testing whether OpenAI's TTS model honors regional accents.
- [ ] **[P2]** Fix podcast content provenance showing "fetched by wallabag" incorrectly.
- [ ] **[P3]** Newsletter/digest summaries only cover the lead story. The article prompt's "single central thesis" framing collapses multi-section newsletters (e.g. Transformer) to the big story. First nudge applied (dropped the "rather than cover them all" clause). Decide on a fuller default-prompt rewrite (essay vs digest shape detector), and verify the full newsletter text actually lands in `html_content`.
- [ ] **[P3]** Podcast transcription download has no retry. Seen on production 2026-07-07: downloading a 163 MB episode failed once with a bare "fetch failed" and worked on retry. Add 2-3 attempts with short backoff around the fetch in `transcription.ts`, and log `err.cause` (the generic undici message hides the real reason).
- [ ] **[P4]** Add link to an online PDF-to-HTML converter in the Upload tab hint (the sentence exists in `AddTab.tsx` but has no link). Needs you to pick which converter to endorse, then it is a one-line change.
- [ ] **[P4]** Strip MathJax `<style>` from EA Forum/LessWrong in the turndown HTML->Markdown path ONLY (`remove(['style','script'])`), not at fetch. That stylesheet is load-bearing for display (MathJax positions math via CSS), so it must stay in `html_content`. Bigger follow-up: render math ourselves (KaTeX from the LaTeX source) so it survives editing.
- [ ] **[P4]** Truncated LLM output follow-up. `chatCreateWithRetry` now logs a TRUNCATED warning when any provider hits its output-token ceiling, but nothing reaches the UI and there is no auto-retry. Decide whether narration should retry with a higher cap or show a "script was cut off" flag.
- [ ] **[P4]** Settings shows a broken (undecryptable) API key as configured ("••••••••"), because the GET route masks secrets without decrypting. After an ENCRYPTION_KEY rotation, keys look set but silently fail. Detect decrypt-to-empty secrets in the settings GET and return a "needs re-entry" marker.

### Read-along quality
- [ ] **[P2]** Test LLM alignment quality across content types (articles, EA Forum, LessWrong, podcasts).
- [ ] **[P2]** Fix `buildTimedTranscript()` merging headings/dates into surrounding text. It only splits at punctuation, ignoring timing gaps, so short elements like "JUN 2024" merge with the next heading. Also split at significant timing gaps (e.g. >0.5s between words) so the alignment LLM gets cleaner lines. File: `backend/src/services/llm-alignment.ts`.
- [ ] **[P3]** Read-along list splitting: a sub-list nested inside a list item, and the footnote section `<ol>`, are still one chunk each (could split the same way per-`<li>` splitting already works). Inter-item spacing not tuned yet.

### Performance & Optimization
- [ ] **[P2]** Run `VACUUM FULL content_items;` in DbGate to physically shrink the DB file (~2 GB down to a few hundred MB) now that audio blobs are cleared. CAUTION: locks the table 1-3 min, do it when not listening. Optional (disk is cheap) but makes the `📦 [Storage]` number honest.
- [ ] **[P2]** `POSTGRES_CONFIG=low`: the `feliperosenek/postgres-any-version-railway` template supports low/normal/high presets, but Railway's default Postgres image ignores the var. Check the `🧠 [Postgres]` startup log. If `shared_buffers` is still the stock default, redeploy Postgres from that template or `ALTER SYSTEM SET shared_buffers=...`.
- [ ] **[P3]** Audio file-size optimization, remaining part: convert TTS output to mono (`-ac 1`, ~50% smaller, fine for speech) and consider dropping the bitrate from 96k toward 64k. TEST QUALITY FIRST. The 96k + 24kHz halves are already live. Location: `concatenateAudioFiles()` in `openai-tts.ts`.
- [ ] **[P3]** Optional cleanup: the `CLEAR_AUDIO_BLOBS=true` env var can be removed now (harmless if left, each boot it finds 0 blobs).
- [ ] **[P4]** Batch audio generation (queue multiple articles). NOTE: a prior queuing attempt went badly and was abandoned (see the "Abandon the queuing attempt" / "Give up on queue generation" commits). Still wanted, just needs proper implementation.
- [ ] **[P4]** Add compression for stored audio (consider Opus codec).

### Technical Debt & Code Quality
- [ ] **[P4]** No database migration system: migration SQL files re-run on every boot (works via IF NOT EXISTS, but no version tracking or rollback). This is not theoretical, migration 022's one-time backfill re-ran every boot and re-dirtied the whole Wallabag library until it was gated behind a DO-block column-exists check. Any future migration with a data backfill has the same footgun. Fix: add a `schema_migrations` table (or adopt node-pg-migrate/knex).
- [ ] **[P4]** `console.log` everywhere clutters production logs. Adopt a leveled logger (e.g. pino). Worst offender: `llm-alignment.ts` logs the ENTIRE LLM response per call plus a ~60-line always-on diagnostic block.
- [ ] **[P4]** Migrate `updated_at` / `wallabag_updated_at` on content_items to `TIMESTAMPTZ`. Wallabag sends timezone-offset timestamps that plain TIMESTAMP silently strips. The `wallabag_needs_push` flag removes the worst effect, so this is deferred; ALTER TYPE briefly locks the table, do it in a quiet moment following the db.ts safety rules. Also fixes the pull-side `since` blind spot when the Wallabag clock is not UTC.
- [ ] **[P5]** No runtime input validation (routes accept `req.body` unchecked, TS types are compile-time only). Add zod/joi. Might partly overlap the security review.
- [ ] **[P5]** CORS only supports a single frontend URL (`origin: process.env.FRONTEND_URL`). Accept a comma-split array of origins.
- [ ] **[P5]** Unique constraint on content_items (wallabag_id, user_id) so one Wallabag entry can never map to multiple local rows (the nosync-removal path had to be widened to clean up exactly such duplicates).
- [ ] **[P5]** Parallelize the two remaining serial `deleteAudioFile` loops (bulk archive and bulk remove_audio in content.ts), same `Promise.allSettled` shape bulk delete already uses.
- [ ] **[P5]** Drop the `node-fetch` dependency: Node 22 has native fetch, the openai SDK already migrated off it, wallabag-service.ts already uses native fetch. 5 backend files still import it (grep first). Check for non-standard options at each call site.
- [ ] **[P5]** Align Node versions: `frontend/nixpacks.toml` pins `nodejs_20` while the backend Dockerfile uses `node:22-slim`. Low risk to bump the frontend to 22.
- [ ] **[P5]** `types.ts` cleanup: `transcript_words`/`tts_chunks`/`content_alignment` are typed `string` but sometimes arrive pre-parsed. Type them `string | T[]` and remove the defensive double-parsing.

### Documentation
- [ ] **[P5]** Create a user guide (how to set up an OpenAI API key, Wallabag, etc.).

### Needs your decision
> Product or style calls with more than one reasonable answer. Nothing changes until you pick.

- [ ] **Propagate Wallabag-side deletions?** Today, deleting an entry in Wallabag does nothing locally (the item stays and can even push back). Option A: mirror it (delete locally too), but a Wallabag cleanup spree would destroy local items INCLUDING generated audio you paid for. Option B: leave as-is and document that deletions do not propagate (safest for your audio). Middle path: archive locally instead of delete.
- [ ] **Startup query-killer scope.** `db.ts` kills any DB session older than 30s touching content_items at boot (added after a real stuck-lock). It is now constrained so it spares VACUUM / ANALYZE / pg_dump. Remaining question: delete it entirely and rely on the 5s lock_timeout + retry loop (reviewer's lean), or keep it as belt-and-suspenders. Current state: constrained version is live.

### Security, deferred for later, do not investigate yet
> One-line pointers only, for the separate security review. Deliberately not investigated or fixed here.

- `backend/src/routes/auth.ts` + `services/auth.ts`: no rate limiting, lockout, or password policy on register/login/forgot-password
- `backend/src/services/auth.ts`: JWT secret fallback behavior and session/token lifecycle
- `backend/src/services/encryption.ts`: crypto design, key management, plaintext fallback when ENCRYPTION_KEY unset
- `backend/src/database/db.ts`: startup secret-encryption migration behavior when the key is absent
- `backend/src/index.ts`: public audio endpoint uses sequential guessable integer ids
- `backend/src/index.ts`: 50mb JSON body limit applies to unauthenticated routes
- `backend/src/routes/queue.ts`: queue endpoints do not verify content-item ownership
- `backend/src/services/wallabag-service.ts`: OAuth credentials and tokens at rest and in logs
- `backend/src/services/article-fetcher.ts` + `podcast-service.ts` + `image-alt-text.ts` + `transcription.ts`: server-side fetching of user-supplied URLs (SSRF surface)
- `backend/src/services/podcast-service.ts`: regex-based HTML sanitization in cleanDescription()
- `frontend/src/api.ts`: JWT tokens stored in localStorage
- `frontend/src/components/FullscreenPlayer.tsx`: dangerouslySetInnerHTML on fetched article/comment HTML
- `frontend/src/components/SettingsPage.tsx`: settings object including API keys logged to browser console
- `frontend/src/markdown.ts`: footnote keys interpolated into HTML ids/hrefs without escaping
- `backend/mock-server.mjs`: accepts any credentials (local-only tool, by design)
- (Incidentally hardened during the pre-launch passes, still worth a second look: the `/wallabag/cleanup` `hoursAgo` SQL interpolation is now parameterized, and `decrypt()` failures now return an empty sentinel instead of the raw ciphertext.)

## Completed Recently ✅

> July 2026 onward. Older wins were pruned.

- [x] **Launch polish round 2** (2026-07-07): comment thread redesign refined (alternating background shades by nesting depth at ANY depth via a React-stamped `.comment-alt`, a gentle color-mix shade so deep nesting no longer goes flat dark, tighter reply indent, a tiny 3px right gap so nested borders do not read as one thick line). No-audio player controls laid out as previous / display-settings / next in a single row. New opt-in Playback setting "Start playing when opening an item" (`autoplay_on_open`, off by default). Open Graph + Twitter social-preview meta tags. Sweary git history reworded in place (2 commits from the abandoned queue experiment, full history preserved, branch trees verified identical, all branches force-pushed). Operator docs added to RAILWAY_DEPLOYMENT: password reset (email + manual SQL) and Hobby-plan `pg_dump` backups.

- [x] **Invite code + email password reset** (2026-07-07): invite-code registration gate (`INVITE_CODE` env var, field auto-appears via the public `GET /auth/config`). Full email password reset (Resend-based, `password_reset_tokens` migration 023, forgot + reset forms in the home page dropdown, all sessions revoked on reset, generic answers so usernames cannot be probed). RSS feed URL now shown on expanded feed cards. Honest Wallabag sync message ("everything already in sync" instead of a raw pulled count, backend counts only real changes). PWA colors unified on dark slate. Four stale TODO items verified and closed (fullscreen-on-first-click, podcast/text domain links, LessWrong display, JWT_SECRET confirmed set).

- [x] **Home page, public demo mode, demo Feed tab, and optimized summary prompts** (2026-07-07): all six summary prompt defaults replaced with the user's rewritten versions, Settings prompt hints simplified. Logged-out `HomePage.tsx` built from the Claude Design "Home Page v2" mockup (login in a top-right dropdown, hero, screenshot carousel, feature grid, cost card, GitHub footer, both themes). Read-only demo mode: `POST /api/auth/demo` passwordless login, demo-ness is a SESSION property in the JWT (passwordless = read-only, password login = writable operator, refresh re-locks), writes blocked centrally in `requireAuth` with carve-outs for the status poll and playback saves, demo banner + shared blocked-action toast + inert Settings. `backend/scripts/seed-demo.mjs` seeds the demo library over the real API (onboarding guide, EA Forum article, 80,000 Hours #235 with Ajeya Cotra) with the agreed models, then removes the keys. SEEDED AND VERIFIED on production: 3 items with audio/read-along/transcripts (435/3,139/31,699 words) + summaries, plus 3 feed subscriptions and 220 cached Recent Updates. Library cards now show progress for player-started operations too (polls write every status tick to the store). Two integration bugs caught in review and fixed (seeder lockout, case-sensitive demo lookup).

- [x] **Third pre-launch pass: all 16 code-review findings addressed** (2026-07-06): a separate multi-agent review (13 confirmed bugs, 1 plausible, 2 cleanups, 5 refuted) worked through by five parallel fixers, every diff re-reviewed. `/wallabag/cleanup` no longer interpolates `hoursAgo` into SQL (parameterized, clamped); `decrypt()` failures return "" instead of the raw ciphertext (+ an encrypt() double-wrap guard, all call sites audited); migration 022's backfill no longer re-runs every boot; five missed `wallabag_needs_push` write sites fixed; nosync items no longer inflate the pending badge; Anthropic native client gets per-model max_tokens ceilings (fixes silent narration truncation) and correct effort/budget routing for dated/capitalized model ids; every provider logs a TRUNCATED warning on finish_reason=length; read-along refresh fixed end to end (`ready`+current_operation counts as busy, regenerate-transcript stays non-terminal until alignment ends); service-worker offline-shell clone fix; audio-file deletions parallelized.

- [x] **Anthropic reasoning effort via native API adapter** (2026-07-06): proven by ~20 live probes that Anthropic's OpenAI-compat endpoint silently strips every effort control. Anthropic chat now goes through the native `/v1/messages` API via `AnthropicNativeChatClient` (same `chat.completions.create()` surface). Real graded effort on Sonnet 5 / Opus (`output_config.effort`, off/low/medium/high/xhigh/max), Haiku 4.5 / Sonnet 4.5 map to thinking budgets, invalid values fail visibly. Per-call request + response logging (`served_by`, tokens) so Railway logs show whether settings took effect.

- [x] **Pre-launch full-repo review sweep** (2026-07-05): six parallel review agents covered the whole codebase, then five fix batches (~60 fixes). Silent-failure bugs (Wallabag creds decrypt-on-read, alignment token cap + missing retry, decrypt crash on rotated key), data-usage bugs (queue `c.*`, full-item polls, 80GB-incident class), user-visible bugs (podcast add dropping audio URL, shuffle persistence, PWA offline fallback, orphaned mp3s), perf (comment tree remount, archive loading whole blob), hardening (Range 416s, invalid-date guards, generate double-start, version snapshot before sync overwrite), dead code + unused deps removed, and a big docs pass (README desyncs, RAILWAY_DEPLOYMENT rewritten, obsolete guides deleted).

- [x] **Defaults tuning, key-aware defaults, Settings polish** (2026-07-02): blank model fields no longer pin that day's default (blank = live default). Key-aware defaults for every feature (each picks a working provider from whichever keys exist, in a fixed order). DeepInfra chat default switched to gpt-oss-120b, OpenRouter to gpt-5-mini. Per-key trash buttons. OpenAI and DeepInfra added as image-description providers (Gemma 4 26B at ~1/20th the cost). Account feature-availability panel (green check / red X per feature). Kokoro voice-chip layout fix. Anthropic effort default correction (the compat endpoint was silently ignoring it, see the 2026-07-06 native-adapter entry).

- [x] **Provider keys smoke-tested + housekeeping** (2026-07-02): tiny live calls confirmed OpenAI, Anthropic, OpenRouter chat + vision all work; documented that OpenRouter TTS/STT wiring was broken and STT has no word timestamps. Rewrote `backend/.env.example`, deleted superseded plan docs.

- [x] **EA Forum links use the bot-friendly mirror** (2026-07-01): EA Forum posts are stored on `forum-bots.effectivealtruism.org` (rewritten in `normalizeEAForumUrl()`), detection goes through a shared `isEAForumUrl()` helper, GraphQL still hits the main host with a same-origin Referer, and humans see the normal `forum.effectivealtruism.org` link via a display-only `displayUrl()` helper. The stored value is never changed by display.

- [x] **Whisper transcript loop + read-along fixes** (2026-07-01): fixed runaway repetition loops and dropped speech on long podcasts (switched the DeepInfra path to its native endpoint with `condition_on_previous_text=false`, added a turbo-vs-large-v3 preset dropdown, sent `word_timestamps=true` + a segment-interpolation fallback). Fixed page-wide horizontal scroll from long links in comments and article bodies (`overflow-wrap: anywhere` + scrollable tables).

## Future Ideas (Nice to Have)

- Podcast speaker labels (diarization), someday when a cheap solution exists. The "prettier transcripts" LLM-rewrite idea was considered and dropped: Whisper output already reads well (even in Dutch), and a rewrite risks introducing more problems than it solves.
- Automated database backups: a scheduled GitHub Action running `pg_dump` to private storage (needs `DATABASE_URL` as an encrypted Actions secret).
- Lightweight uptime monitoring (e.g. UptimeRobot pinging the backend health endpoint) so you hear about downtime before users do.
- Privacy-friendly analytics (Plausible, GoatCounter, or Railway metrics), post-launch, so you can tell whether promotion works.
- Rough cost hints in the UI ("Generate audio, ~$0.03") so users with their own keys are not afraid to click. The image-description code already tracks per-call cost, so half the plumbing exists.
- A small "preparing read-along" indicator in the player while transcription/alignment runs after audio lands, so users know highlighting is coming.
- UI bloat / intuitiveness review on the mock server (`npm run mock`), postponed until the big pre-launch changes land (you may run it with Opus).
- Investigate Gemini native TTS as a voice provider (native SDK, returns raw PCM, so a new client path + voice catalog). Gemini transcription is not viable for read-along (no word timestamps).
- Fullscreen reading mode, keyboard shortcuts for the player, share-article-with-audio, export to audiobook (M4B with chapters).

## Reference

For implementation details, see:
- **README.md** - short user-facing project overview
- **ARCHITECTURE.md** - technical reference and codebase map (structure, endpoints, database schema)
- **RAILWAY_DEPLOYMENT.md** - step-by-step deploy guide, env vars, password resets, backups
- **wallabag-api.md** - Wallabag API reference and sync implementation details
- **CLAUDE.md** - instructions for Claude Code when working on this project
