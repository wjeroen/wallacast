# Obsidian read access: a lean index, Copy content as an endpoint, read-only tokens

Status: built on 2026-09-04 (branch `claude/obsidian-read-access`, stacked on `claude/wallabag-tag-sync`). Verified in Node with `backend/scripts/test-markdown-export.mts` and `frontend/scripts/test-migration-029.mjs`, not yet against a deployed instance. The Obsidian-side commands are still to be written in the vault.

## Why

Jeroen keeps his research notes in an Obsidian vault. Every source note there (`Content Creation/Sources/`) is a Wallacast "Copy content" export, pasted by hand: frontmatter, the `ad-summary` block, `# Title`, the turndown body, `# Comments`. He wants two Templater commands in Obsidian, on desktop and phone:

1. **Wallacast inbox**: a note that lists his library grouped by priority (starred and not archived first, then not archived, then archived, and at the end the items that already exist as notes), each row a `[[Title]]` link plus the article URL, author, date and tags. Clicking a link creates the note.
2. **Import from wallacast**: run inside a note that holds an article URL (or a note created from an inbox link), it fetches the Copy content markdown for the library item with that URL, writes it into the note, renames it after the title, and moves it into Sources. Run again later, it refreshes the note (a summary that appeared after the import gets in).

Wallacast is read, never written. Nothing in this plan adds items, changes items, or triggers audio or summary generation. The identity of an item, seen from the vault, is its URL, not its database id.

Two facts force the design:

- The markdown conversion lives only in the frontend (`frontend/src/markdown.ts`: `contentToMarkdown`, `buildFrontmatter`, `htmlToMarkdown`, using the browser's `DOMParser` and turndown). Obsidian cannot run it, and the vault must keep getting byte-identical output.
- Access tokens live 15 minutes and refresh tokens rotate, so a Templater command needs a long-lived token of its own. It will sit as plain text in a synced vault, so it must be able to do nothing but read.

## What to build

### 1. Read-only API tokens

- Migration 029, following the `db.ts` safety rules (`IF NOT EXISTS`, `DO $$` blocks, nothing without try/catch): `api_tokens (id, user_id, name, token_hash, scope, created_at, last_used_at, revoked_at)`. `scope` is `'read'` for now, so a wider scope can exist later without a schema change.
- Token format `wcr_` + 40 random hex characters, shown once at creation, stored as a sha256 hash like refresh tokens (`hashRefreshToken`).
- `requireAuth` (`backend/src/middleware/auth.ts`): when the Bearer value starts with `wcr_`, look the hash up, reject revoked, set `req.user` like a normal session (never demo), update `last_used_at` (at most once a minute per token, so a busy inbox refresh does not write on every request). Then enforce the allow-list: a read token may call ONLY the three routes below. Every other route answers 403 `{ error: 'This token is read-only' }`, including every GET elsewhere (`GET /api/users/settings` exists and has no business being reachable with a vault token). The JWT path stays exactly as it is.
- Routes under `/api/auth`: `POST /tokens { name }` returns `{ id, name, token }`, `GET /tokens` lists id, name, created_at, last_used_at, `DELETE /tokens/:id` revokes. JWT sessions only, demo sessions get 403 on create, a dedicated `tokenLimiter` (30 per hour per IP) on create and revoke. Listing is not limited, Settings lists on every open. At most 20 live tokens per user.
- Settings page: a "Read-only API tokens" section (create with a name, list with last used, revoke), so he can copy a token into the Templater command on each device.

### 2. Lean index: `GET /api/content/index`

The existing `GET /api/content` returns every item's full plain text plus `tts_chunks` and `transcript_words`, far too heavy to pull into a phone on every inbox refresh (same class of problem as the 80GB incident in ARCHITECTURE.md, keep this one as lean as `POST /status`).

- Define it before `GET /:id`, like `/status`.
- One row per item of the user, ordered by `created_at DESC`, no filters needed (Obsidian groups and filters client-side): `id, type, title, url, author, published_at, created_at, updated_at, tags, is_starred, is_archived, summary_status, comment_count, karma`, plus `description` as plain text (HTML stripped) cut to 300 characters. Never `content`, `html_content`, `comments`, `transcript`, `transcript_words`, `tts_chunks`, `content_alignment`.
- `url` is the human URL, the form Copy content writes into `source` (the EA Forum bot mirror rewritten back to `forum.effectivealtruism.org`, see `displayUrl` in `frontend/src/format.ts`; the backend has the forward rewrite `normalizeEAForumUrl` and needs the reverse). Synthetic `wallacast://` URLs are returned as null.

### 3. Copy content as an endpoint

`GET /api/content/:id/markdown` and `GET /api/content/markdown?url=...` (define the second before `/:id`). Both respond `{ id, title, author, published_at, url, tags, is_starred, is_archived, summary_status, markdown }`.

- `markdown` is what the Copy content button produces for that item, rendered server-side with the user's copy settings from user settings (`copy_include_summary` default off, `copy_include_comment_summary` default on, `copy_summary_code_label`, `copy_include_comments` default on, the same defaults as `frontend/src/copy-settings.ts`). Same item, same settings, byte-identical output. That is the acceptance test.
- URL lookup: compare the stored `url` and the human form of it against the query, first exactly, then normalised (http and https equal, host lowercased, `www.` dropped, trailing slash dropped, fragment dropped, `utm_*`, `fbclid` and `ref` query parameters dropped, the EA Forum mirror rewrite applied in both directions). Several items match (the same URL added twice): prefer the one that is not archived, then the newest `created_at`. No match: 404 `{ error: 'No item in your library has this URL' }`. Obsidian shows that message and he adds the article in the app first.
- Running the conversion in Node: the backend runs `frontend/src/markdown.ts` itself, as byte-identical copies of `markdown.ts`, `format.ts`, `tags.ts`, `types.ts` and `turndown-plugin-gfm.d.ts` in `backend/src/shared/` (rendered by `backend/src/services/markdown-export.ts`). One shared folder both packages import cannot deploy: Railway builds each service from its own Root Directory (`backend/`, `frontend/`) and cannot see a folder outside it. Two small edits to the frontend files make the copies possible with no change in behaviour: the relative imports carry a `.js` extension (Node's loader needs it, Vite and TypeScript resolve it to the `.ts` file) and the two `new DOMParser()` calls go through a `setHtmlParser()` hook, which the backend points at jsdom's parser (`new JSDOM('').window.DOMParser`). `turndown`, `turndown-plugin-gfm` and `marked` are backend dependencies now. `backend/scripts/test-markdown-export.mts` byte-compares every copy against its original and renders fixtures through both the backend service and the frontend module, asserting identical output. The frontend's own Copy content is unchanged.

### 4. Docs, per the repo's CLAUDE.md

ARCHITECTURE.md (Quick Reference rows, the three endpoints, the token section under auth, the shared markdown module), README (one paragraph), TODO, and the demo seed onboarding guide if the Settings UI gains the tokens section (mention that the demo account cannot create tokens).

## What the Obsidian side will do

For the contract, not for you to build. Both commands send `Authorization: Bearer wcr_...`.

- **Wallacast inbox** calls `/index`, decides "already in Sources" by matching each item's `url` against the `source` property of the vault's source notes (same normalisation as above, applied in Obsidian), and writes the grouped table. Link names are the titles with the characters Obsidian forbids in file names taken out.
- **Import from wallacast** finds a URL in the note (a bare URL line, or the `source` property of an already imported note), or, for an empty note created by clicking an inbox link, looks the note's name up in the inbox table to get the URL. Then `GET /markdown?url=...`, writes `markdown`, renames the note to `title`, moves it into Sources. A rerun in an imported note repeats the call and replaces the note.

So the backend contract is: the index is lean and complete, the markdown endpoint is idempotent and finds items by URL with the duplicate rule above, the markdown stands on its own (no internal ids, the note keeps `source`).

## Quick check when done

```
curl "$API/content/index" -H "Authorization: Bearer wcr_..."
curl "$API/content/markdown?url=https://forum.effectivealtruism.org/posts/..." -H "Authorization: Bearer wcr_..."
curl -X DELETE "$API/content/123" -H "Authorization: Bearer wcr_..."
```

Expected: a small JSON array with no article text in it, then `markdown` that starts with `---\ntitle: "..."` and matches the Copy content button for that item, then 403 with the read-only message.

## Boundaries

Finish or park the tag-sync work first, his call. No write endpoints for tokens, no LLM calls anywhere in this plan, no change to what Copy content produces, and the summary stays the async thing it is today.
