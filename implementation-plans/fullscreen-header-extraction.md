# Extract the repeated content header in FullscreenPlayer into one component

**Status: decided, not yet implemented.** This plan is the decision. The executor implements it, it does not re-litigate whether or how.

## Why

The title / author / date / karma / comment-count / provenance header block is copy-pasted three times inside `frontend/src/components/FullscreenPlayer.tsx` (a ~2,000 line file). Three repeats is the project's agreed threshold for extracting a shared component (see the component-strategy note in project memory). Divergence has already started: the blocks are only mostly identical, which is exactly how inconsistencies creep in.

## Where (line references from the pre-launch-review branch, re-locate by anchor if drifted)

All in `frontend/src/components/FullscreenPlayer.tsx`:

1. **Content tab header**, inside `renderTabContent()` case `'content'`, starting at the `<div className="content-header">` around line 1100. Includes: `<h2>` title, author + date + karma (`ArrowUp` icon) + comment count (`MessageCircle` icon) line, and the provenance paragraphs (article: "Fetched by X on date • Narration generated on date"; text: "Last edited on date • ...").
2. **Read-along (LLM alignment) header**, same structure, `ArrowUp`/`MessageCircle` pair around line 1354. This variant carries the two-line provenance with the Show/Shown sync toggle.
3. **Read-along legacy/fallback header**, `ArrowUp`/`MessageCircle` pair around line 1634.

Search anchor: the three occurrences of `<ArrowUp size={12} style={{ verticalAlign: '-1px' }} /> {content.karma}`.

## What to change

1. Diff the three blocks carefully first (they are NOT byte-identical). Catalog every difference: which provenance variant each shows, the Show/Shown toggle, wrapper class names (`content-header-with-button` etc.), and any buttons living inside the wrapper.
2. Create `ContentHeader` in a new file `frontend/src/components/ContentHeader.tsx` (module-scope component, props-driven):
   - Required props: `content: ContentItem`, `totalCommentCount: number`.
   - Variant props for the differences found in step 1, for example `provenance: 'article' | 'text' | 'synced' | 'none'` and an optional `children` or named slot for the Show/Shown toggle and buttons, so the three call sites can inject their extras.
   - Keep the exact same DOM structure and class names the current blocks render, this is a pure refactor, zero visual change.
3. Replace all three inline blocks with `<ContentHeader ...>`.
4. Do not touch App.css. If a class was only used by one variant, it stays as is.

## Acceptance criteria

- `npx tsc -b` passes in `frontend/`.
- `git diff` shows the three JSX blocks replaced and no other behavioral change in FullscreenPlayer.tsx.
- Rendered DOM is identical for all three tabs: verify by running the app (`npm run mock` in backend/ plus `npm run dev` in frontend/ per README) and comparing the Content and Read-along headers on an article before/after, including the provenance lines and the Show/Shown toggle.
- No em dashes introduced anywhere.

## Out of scope

- Any styling change.
- The library card header (`ContentCard.tsx`), it is already its own component.
- The podcast Description tab header, only extract it too if step 1 shows it is a fourth literal copy, otherwise leave it.
