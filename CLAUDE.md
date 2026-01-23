# Claude Code Instructions

## TL;DR
The user is a coding noob. ELI5 (Explain Like I'm 5) frequently when discussing technical concepts, code changes, and tradeoffs. Always make sure to update the README.md and TODO.md when making changes.

## After Every Prompt, Before Making Any Changes
Ex. When Solving a Bug or Implementing a Feature
1. Read README.md and ALL relevant files to understand the project structure and current state.
2. Generate at least 3 possible approaches or hypotheses based on what you read
3. Briefly explain the tradeoffs of each (ELI5)
4. Ask the user which approach they prefer before writing code

## After Making Changes
Update README.md if you changed:
   - File structure or added new files
   - Database schema
   - Environment variables
   - Processing flows
   - API endpoints

## Task Management with TODO.md

TODO.md is the **primary task list** for Wallacast development. It's designed to help you track work and give the user visibility into progress.

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
