# Claude Code Instructions

## User Context
The user is a coding noob. ELI5 (Explain Like I'm 5) frequently when discussing technical concepts, code changes, and tradeoffs.

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

## Code Style
- Backend: ES modules with .js extensions in imports
- Frontend: Single CSS file (App.css), no CSS modules
- Use existing patterns in the codebase rather than introducing new ones
