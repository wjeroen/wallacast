# Wallacast - Task List

> **Instructions for Claude Code:** This is a general task list for Wallacast development. Mark tasks done by changing `[ ]` to `[x]`. Add new tasks as they come up. Keep it organized and actionable.

## Current Sprint

### High Priority
- [ ] Test multi-user podcast subscriptions (after migration 007 runs)
- [ ] Verify Wallabag sync works end-to-end with real Wallabag instance
- [ ] Fix speed toggle UI inconsistency (buttons don't always show current speed)

### Features to Implement
- [ ] Bulk podcast subscription import (OPML format)
- [ ] Edit text content after adding (currently read-only)
- [ ] Fullscreen reader mode for articles (hide player, show full text)
- [ ] Queue functionality (UI exists but incomplete)
- [ ] Persistent mini-player across tabs (currently reloads when switching tabs)
- [ ] Keyboard shortcuts for player (space = play/pause, arrows = seek)
- [ ] Article reading mode: click words to hear pronunciation

### Bug Fixes
- [ ] EA Forum comment extraction unreliable (Apollo state JSON parsing)
- [ ] Handle very long articles (>50k chars) gracefully
- [ ] Fix audio player size on mobile (too large)
- [ ] Improve error messages when OpenAI API key is missing/invalid

### Performance & Optimization
- [ ] Add caching for article HTML (avoid re-fetching on regenerate)
- [ ] Implement batch audio generation (queue multiple articles)
- [ ] Add compression for stored audio (consider Opus codec)
- [ ] Lazy load transcript/comments (only when viewing item)

### Documentation
- [ ] Create user guide (how to set up OpenAI API key, Wallabag, etc.)
- [ ] Add API documentation (for developers wanting to extend)
- [ ] Document podcast RSS feed requirements
- [ ] Create troubleshooting guide

### Testing
- [ ] Test with various podcast feed formats (iTunes, RSS 2.0, Atom)
- [ ] Test with different article sources (Medium, Substack, EA Forum, LessWrong)
- [ ] Load test with 1000+ articles
- [ ] Test Wallabag sync with 10,000+ entries

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

- Flemish-sounding Dutch TTS voice (custom prompt)
- Share article with audio generation
- Export to audiobook format (M4B with chapters)
- Collaborative playlists
- Reading statistics (words read, hours listened)
- Smart recommendations based on reading history
- Automatic tagging with GPT (genre, topic, difficulty)
- Spaced repetition for article recall
- Integration with Readwise for highlights

## Reference

For implementation details, see:
- **README.md** - Project overview, architecture, database schema
- **wallabag-api.md** - Wallabag API reference and sync implementation details
- **CLAUDE.md** - Instructions for Claude Code when working on this project
