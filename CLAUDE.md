# Claude Code Instructions

## TL;DR
The user is a coding noob. ELI5 (Explain Like I'm 5) frequently when discussing technical concepts, code changes, and tradeoffs. Always make sure to update the README.md and TODO.md when making changes.

## After Every Prompt, Before Making Any Changes
Ex. When Solving a Bug or Implementing a Feature

**CRITICAL WORKFLOW - FOLLOW THIS ORDER:**

1. **Check README.md Quick Reference first** (lines 44-59)
   - This table tells you EXACTLY which file handles what functionality
   - Example: Bug with TTS? → `backend/src/services/openai-tts.ts`
   - Example: Bug with audio player UI? → `frontend/src/components/AudioPlayer.tsx`
   - **DO NOT GREP until you've checked this table**

2. **Read the relevant service/component descriptions in README.md**
   - Lines 79-178 (Backend structure) explain what each file does
   - Lines 179-215 (Frontend structure) explain components
   - This gives you the BIG PICTURE before diving into code

3. **Only THEN read the actual files**
   - Now that you know where to look, read the specific files
   - Use Grep only for finding specific patterns within the right files
   - Don't grep blindly across the entire codebase

4. **Generate at least 3 possible approaches** based on what you read
5. **Briefly explain the tradeoffs** of each (ELI5)
6. **Ask the user which approach they prefer** before writing code

**Why this order matters:** Grepping without context leads to local fixes that miss the big picture and create new bugs. README.md is your map - use it!

## After Making Changes
Update README.md if you changed:
   - File structure or added new files
   - Database schema
   - Environment variables
   - Processing flows
   - API endpoints

## Task Management: TODO.md vs TodoWrite Tool

There are TWO different task tracking systems. **Use the right one for the job:**

### TODO.md (Project-Level Tasks)
**This is the PRIMARY task list** for Wallacast development. It persists across all sessions and gives the user visibility into project progress.

- **File location**: `/home/user/wallacast/TODO.md`
- **Scope**: Project-wide tasks, bugs, features, roadmap
- **Persistence**: Survives across all Claude sessions (it's a file in the repo)
- **When to use**: When tracking work that relates to the overall project
- **How to update**: Edit the TODO.md file directly using the Read/Edit tools

### TodoWrite Tool (Session-Level Tasks)
A **temporary** task tracker for the current conversation only.

- **Scope**: Breaking down work within THIS conversation/session
- **Persistence**: Only lasts for this conversation (disappears after session ends)
- **When to use**: Planning multi-step work within a single session (e.g., "I need to do X, Y, Z in this session")
- **How to update**: Use the TodoWrite tool

**IMPORTANT:** When doing project work, always check and update TODO.md first. The TodoWrite tool is just for organizing your thoughts within a conversation.

### When to Update TODO.md

**Always update TODO.md when:**
1. **Starting a new task** - Mark it as in progress (change `[ ]` to current task)
2. **Completing a task** - Mark it done by changing `[ ]` to `[x]`
3. **Discovering new work** - Add new tasks to the appropriate section
4. **Encountering bugs** - Add them to "Bug Fixes" section
5. **Planning features** - Add to "Features to Implement" or "Future Ideas"

### Structure of TODO.md

- **Current Sprint**: Active work organized by priority
  - High Priority - Urgent tasks
  - Features to Implement - New functionality
  - Bug Fixes - Things that are broken
  - Performance & Optimization - Speed/efficiency improvements
  - Documentation - Guides, API docs, troubleshooting
  - Testing - Things to verify/test
- **Completed Recently**: Recent wins with dates (keep last ~10-15 items)
- **Future Ideas**: Nice-to-have features for later
- **Reference**: Links to other documentation

### Task Format

Use checkbox format with clear, actionable descriptions:
```markdown
- [ ] Fix speed toggle UI inconsistency (buttons don't show current speed)
- [ ] Add bulk podcast subscription import (OPML format)
```

When completed, add date:
```markdown
- [x] Fix podcast subscription multi-user bug (2026-01-23)
```

### Best Practices

1. **Be specific**: "Fix audio player size on mobile" not "Fix UI issues"
2. **Include context**: Add parenthetical notes for clarity
3. **Keep it fresh**: Move old completed items to archive periodically
4. **No duplicates**: If a task is already listed, don't add it again
5. **Link related docs**: Reference README.md or wallabag-api.md for implementation details

### What NOT to Put in TODO.md

Don't clutter TODO.md with:
- Implementation details (those go in README.md or code comments)
- API specifications (those go in wallabag-api.md)
- Wallabag sync design docs (those go in wallabag-api.md)
- Long-term vision/roadmap (use "Future Ideas" sparingly)

TODO.md is for **actionable tasks**, not documentation.

## Code Style
- Backend: ES modules with .js extensions in imports
- Frontend: Single CSS file (App.css), no CSS modules
- Use existing patterns in the codebase rather than introducing new ones

## Database Initialization Safety Rules (`backend/src/database/db.ts`)

**CRITICAL: `initializeDatabase()` is the ONLY thing standing between the user and a working app.** If it crashes, the entire backend returns 503 "service starting up" for ALL requests. The user cannot log in or use the app at all.

**Rules:**
1. **NEVER add queries that reference specific tables without try/catch.** Tables may not exist yet (migrations create them). A bare `ANALYZE podcast_subscriptions` will crash if that table was never created.
2. **NEVER add blocking operations without timeouts.** The function already uses `SET lock_timeout = '5s'` and `SET statement_timeout = '30s'` — respect this pattern.
3. **Always test mentally: "What if this table/column doesn't exist?"** Use `IF EXISTS`, `IF NOT EXISTS`, or try/catch for any operation that depends on specific schema.
4. **Migrations use `IF NOT EXISTS` / `DO $$ ... END $$` blocks** for safety. Follow this pattern.
5. **After changing `db.ts`, verify the server can start from scratch** (imagine a fresh database with no tables). The function must handle that gracefully.
