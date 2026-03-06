# Plan: Fix HTML Read-Along Issues + HTML Upload

## Context
Five issues with the Wallacast read-along tab and content system need fixing:
- (0) The PDF tab in AddTab is broken/unused — replace with HTML file upload
- (1) Embedded tweets display as giant profile pictures instead of readable content
- (2) Undescribed images steal the read-along highlight from the paragraph being spoken
- (3) Long elements (bullet lists, big comments) make autoscroll unusable — can't see start/end
- (4) Plain text items without HTML tags produce zero visible content in read-along

---

## Issue 0: Replace PDF Tab with HTML File Upload

### Why
The PDF tab in AddTab accepts a URL but the backend never processes PDFs. Replace it with an HTML file upload so users can upload `.html`/`.htm` files as content.

### Files to modify
- `frontend/src/components/AddTab.tsx`
- `backend/src/routes/content.ts`

### Frontend: AddTab.tsx

**Step 1:** Change the ContentType union type (line ~6):
```
BEFORE: type ContentType = 'article' | 'text' | 'pdf' | 'podcast_episode';
AFTER:  type ContentType = 'article' | 'text' | 'html_upload' | 'podcast_episode';
```

**Step 2:** Add state for the uploaded HTML content. Near the other state declarations (around line ~10-15), add:
```typescript
const [uploadedHtml, setUploadedHtml] = useState<string>('');
const [uploadedFileName, setUploadedFileName] = useState<string>('');
```

**Step 3:** Find the tab button that says "PDF" with the `FileText` icon (around line ~83-88). Change:
- The label from "PDF" to "HTML" (or "Upload")
- The `onClick` from `setContentType('pdf')` to `setContentType('html_upload')`
- The active check from `contentType === 'pdf'` to `contentType === 'html_upload'`

**Step 4:** Find the PDF form section (around lines ~152-177, the section that renders when `contentType === 'pdf'`). Replace the ENTIRE pdf section with an HTML upload section:

```tsx
{contentType === 'html_upload' && (
  <>
    <div className="form-group">
      <label>HTML File</label>
      <input
        type="file"
        accept=".html,.htm"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            setUploadedFileName(file.name);
            const reader = new FileReader();
            reader.onload = (event) => {
              setUploadedHtml(event.target?.result as string || '');
            };
            reader.readAsText(file);
            // Auto-fill title from filename (without extension) if title is empty
            if (!title) {
              setTitle(file.name.replace(/\.(html|htm)$/i, ''));
            }
          }
        }}
      />
      {uploadedFileName && (
        <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.5rem' }}>
          Selected: {uploadedFileName}
        </p>
      )}
    </div>
    <div className="form-group">
      <label>Title (required)</label>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Enter a title..."
        required
      />
    </div>
  </>
)}
```

**Step 5:** In the `handleSubmit` function (around line ~25-44), find where form data is built. Add a case for `html_upload`. The submit function builds a `data` object — add this logic:

```typescript
if (contentType === 'html_upload') {
  if (!uploadedHtml || !title) return; // Don't submit without file + title
  data.type = 'text';           // Reuse text type
  data.title = title;
  data.content = uploadedHtml;   // Send HTML as the content string
  // No URL needed
}
```

**Step 6:** After successful submission, clear the upload state:
```typescript
setUploadedHtml('');
setUploadedFileName('');
```

### Backend: content.ts

**Step 7:** In the POST route (around line ~200-379), text items already store content in both `content` and `html_content` columns (lines ~231-234):
```typescript
if (type === 'text' && processedContent) {
  htmlContent = processedContent;
}
```
This means uploaded HTML will automatically be stored in `html_content` — **no backend changes needed**. The HTML file content comes in as `data.content`, gets stored in both columns, and the read-along system picks it up from `html_content`.

### Reset state when switching tabs

**Step 8:** In the content type tab switching logic, clear upload state when switching away. Find where `setContentType()` is called and also clear: `setUploadedHtml('')` and `setUploadedFileName('')`. OR add a `useEffect` that clears upload state when `contentType` changes away from `'html_upload'`.

---

## Issue 1: Twitter Embeds Show Giant Profile Picture

### Why
Twitter embeds come as `<blockquote class="twitter-tweet">` containing profile picture `<img>` tags. The CSS rule `.article-content img { width: 100% !important; }` (App.css line ~2566) blows up the tiny profile picture to full viewport width. The tweet text is barely visible compared to the giant image.

### Files to modify
- `frontend/src/App.css`

### Step 1: Add Twitter embed CSS rules

Find the `.article-content img` rule (around line 2566-2572 in App.css). AFTER that rule block, add these new rules:

```css
/* Twitter/X embed styling - override full-width img for tweet profile pics */
.article-content blockquote.twitter-tweet {
  border: 1px solid #334155;
  border-left: 4px solid #1d9bf0;
  border-radius: 12px;
  padding: 16px;
  margin: 1.5em 0;
  background: #1e293b;
  max-width: 550px;
  font-style: normal;
  color: #e2e8f0;
}

.article-content blockquote.twitter-tweet img {
  width: 24px !important;
  height: 24px !important;
  border-radius: 50% !important;
  display: inline-block !important;
  vertical-align: middle;
  margin: 0 8px 0 0 !important;
  object-fit: cover;
}

.article-content blockquote.twitter-tweet p {
  margin: 0.5em 0;
  color: #e2e8f0;
  font-style: normal;
  line-height: 1.5;
}

.article-content blockquote.twitter-tweet > a {
  color: #60a5fa;
  font-size: 0.85rem;
  text-decoration: none;
}

.article-content blockquote.twitter-tweet > a:hover {
  text-decoration: underline;
}
```

The `.article-content blockquote.twitter-tweet img` selector has HIGHER specificity than `.article-content img`, so it overrides the `width: 100% !important` rule. Profile pictures become 24x24 circles. The blockquote gets a card-like dark background with a Twitter-blue left border.

Also add the same rules for the read-along element context (since read-along wraps elements in `.read-along-element` divs):

```css
.read-along-element blockquote.twitter-tweet {
  border: 1px solid #334155;
  border-left: 4px solid #1d9bf0;
  border-radius: 12px;
  padding: 16px;
  margin: 1.5em 0;
  background: #1e293b;
  max-width: 550px;
  font-style: normal;
  color: #e2e8f0;
}

.read-along-element blockquote.twitter-tweet img {
  width: 24px !important;
  height: 24px !important;
  border-radius: 50% !important;
  display: inline-block !important;
  vertical-align: middle;
  margin: 0 8px 0 0 !important;
}
```

---

## Issue 2: Merge Undescribed Images into Previous Element

### Why
When image descriptions are enabled but an individual image has no description, the LLM gives it the same timestamp as the previous paragraph. But the `activeElementIndex` logic picks the LAST element with `startTime <= currentTime`, so the image steals the highlight from the paragraph that's actually being spoken.

### Files to modify
- `backend/src/services/llm-alignment.ts`

### Step 1: Add merge logic in extractContentElements()

In `extractContentElements()`, find the end of the for-loop that processes `topLevelBlocks` (around line 243, just before `return elements;`). Insert this post-processing step BETWEEN the end of the loop and the return:

```typescript
  // Merge undescribed images into previous element.
  // When an image has no description (text === '[Image]'), it won't be spoken
  // in the audio, so it shouldn't be a separate alignment element. Merging its
  // HTML into the previous element means it still renders visually but shares
  // the highlight with the content being spoken.
  const mergedElements: ContentElement[] = [];
  for (const el of elements) {
    if (
      el.type === 'image' &&
      el.text === '[Image]' &&
      mergedElements.length > 0
    ) {
      // Append image HTML to previous element
      const prev = mergedElements[mergedElements.length - 1];
      prev.html = prev.html + '\n' + el.html;
      // Don't modify prev.text — the image adds nothing to spoken content
    } else {
      mergedElements.push(el);
    }
  }

  return mergedElements;
```

**IMPORTANT:** Change the existing `return elements;` (line ~246) to `return mergedElements;` — or more precisely, replace it entirely with the code above that ends with `return mergedElements;`.

### What this does
- An undescribed image (`[Image]`) gets its `<img>` HTML appended to the previous element (e.g., a paragraph)
- The image still renders visually (it's in the combined HTML) but doesn't steal the highlight
- Described images (`[Image: some description]`) remain separate elements (they ARE spoken in the audio)
- If an undescribed image is the very first element (no previous element), it stays standalone via the `mergedElements.length > 0` check

---

## Issue 3: Progressive Autoscroll for Long Elements

### Why
The current autoscroll uses `element.scrollIntoView({ block: 'center' })`, which centers the element. For tall elements (long bullet lists, comment blocks), the start and end are off-screen and unreadable. We need intra-element scrolling that progressively moves through the element as the audio plays.

### Files to modify
- `frontend/src/components/FullscreenPlayer.tsx`

### Step 1: Replace the scrollToActive callback

Find the `scrollToActive` callback definition (around line 278-288). It currently looks like:

```typescript
const scrollToActive = useCallback(() => {
  if (isLLMAlignment && activeElementIndex >= 0) {
    const element = document.getElementById(`ra-el-${activeElementIndex}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else if (activeWordIndex >= 0) {
    const element = document.getElementById(`word-${activeWordIndex}`);
    if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}, [activeWordIndex, activeElementIndex, isLLMAlignment, currentTime]);
```

Replace it with:

```typescript
const scrollToActive = useCallback(() => {
  // Legacy word-by-word scroll for podcasts
  if (!isLLMAlignment || activeElementIndex < 0) {
    if (activeWordIndex >= 0) {
      const el = document.getElementById(`word-${activeWordIndex}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  const element = document.getElementById(`ra-el-${activeElementIndex}`);
  if (!element) return;

  // Find the scrollable container (.fullscreen-tab-content)
  const container = element.closest('.fullscreen-tab-content');
  if (!container) return;

  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const viewportHeight = container.clientHeight;
  const elementHeight = elementRect.height;

  // For short elements (< 60% of viewport), use simple center scroll
  if (elementHeight < viewportHeight * 0.6) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  // Progressive scroll for tall elements
  const elements = (parsedAlignment?.elements || []) as LLMAlignmentElement[];
  const elStartTime = elements[activeElementIndex].startTime;
  const elEndTime = activeElementIndex + 1 < elements.length
    ? elements[activeElementIndex + 1].startTime
    : (duration || elStartTime + 10);

  const elDuration = elEndTime - elStartTime;
  if (elDuration <= 0) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Progress: 0 = start of element's audio, 1 = end
  const progress = Math.max(0, Math.min(1, (currentTime - elStartTime) / elDuration));

  // Calculate scroll target:
  // At progress=0: top of element is ~15% from top of viewport
  // At progress=1: bottom of element is ~15% from bottom of viewport
  const padding = viewportHeight * 0.15;

  // How far into the element we want to show at the top of the viewport
  const scrollOffset = progress * Math.max(0, elementHeight - viewportHeight + 2 * padding);

  // Target scroll position: element top + offset - padding
  const targetScroll = container.scrollTop + (elementRect.top - containerRect.top) - padding + scrollOffset;

  container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
}, [activeWordIndex, activeElementIndex, isLLMAlignment, currentTime, duration, parsedAlignment]);
```

### Step 2: Verify dependency arrays

The `scrollToActive` callback already has `currentTime` in its dependency array. The effect that calls it (around line 305-309) already fires on `currentTime` changes. So progressive scrolling will happen automatically — no new effects needed.

### Step 3: Verify the container class name

The scrollable container must be identified correctly. Search for `fullscreen-tab-content` in FullscreenPlayer.tsx to confirm that's the class of the scrollable container that wraps the read-along content. If the class is different, update `.closest('.fullscreen-tab-content')` accordingly.

---

## Issue 4: Plain Text Without HTML Shows Zero Content in Read-Along

### Why
When a text item has no HTML structure (no `<p>`, `<h1>`, etc. tags), JSDOM parses it but finds zero block elements. `extractContentElements()` returns only title/meta, with no body elements. The read-along tab renders an empty body.

### Files to modify
- `backend/src/services/llm-alignment.ts`

### Step 1: Add a fallback in extractContentElements()

Find the line `const topLevelBlocks = allBlocks.filter(...)` (around line 178-185). Right AFTER that filter block, and BEFORE the `for (const el of topLevelBlocks)` loop (around line 187), insert:

```typescript
  // Fallback: if no block elements found (e.g., plain text with no HTML tags),
  // wrap the entire body text content as a single paragraph element.
  // This ensures there's always at least one body element for alignment.
  if (topLevelBlocks.length === 0) {
    const bodyText = (doc.body.textContent || '').trim();
    if (bodyText) {
      // Use innerHTML to preserve any inline formatting (bold, links, etc.)
      elements.push({
        type: 'paragraph',
        html: `<p>${doc.body.innerHTML}</p>`,
        text: bodyText,
      });
    }
    return elements;
  }
```

This goes between line ~185 and line ~187 in the current code. If `topLevelBlocks` is empty, we wrap the entire body in a `<p>` and return early. If there ARE block elements, the existing loop handles them as before.

---

## Verification / Testing

After implementing all changes:

1. **Issue 0 (HTML upload):** In the Add tab, select "HTML", upload a `.html` file, give it a title, and submit. Verify it appears in the library as a text item. Open it — the HTML should render in the read-along tab with formatting (headings, images, etc.). Generate audio and verify read-along alignment works.

2. **Issue 1 (tweets):** Find or create an article with an embedded tweet. Open it in the read-along tab. The tweet should appear as a styled card with a small (24px) circular profile picture, not a giant full-width image. The tweet text should be readable.

3. **Issue 2 (image merge):** Open an article that has images, with image descriptions enabled but where some images failed to get descriptions. The undescribed images should appear within the previous paragraph's element, sharing the same highlight. They should NOT steal the highlight from the paragraph being spoken.

4. **Issue 3 (autoscroll):** Open an article with a long bullet list or long comment. Enable autoscroll. When the audio reaches that element, the view should progressively scroll through it (top visible at start, bottom visible at end). Short elements should still snap to center as before.

5. **Issue 4 (plain text):** Create a new text item with just plain text (no paragraphs, no HTML tags). Generate audio. Open the read-along tab — the text should be visible (wrapped in a single paragraph) and aligned with audio.

## Files Modified Summary

| File | Issues |
|------|--------|
| `frontend/src/components/AddTab.tsx` | 0 |
| `frontend/src/App.css` | 1 |
| `backend/src/services/llm-alignment.ts` | 2, 4 |
| `frontend/src/components/FullscreenPlayer.tsx` | 3 |
| `backend/src/routes/content.ts` | (none — text type already handles html_content) |
| `README.md` | Update after changes |
| `TODO.md` | Mark tasks done, add new items |

## Implementation Order
1. Issue 4 (plain text fix) — smallest, one location
2. Issue 2 (image merge) — same file as issue 4, backend only
3. Issue 1 (tweet CSS) — CSS only, zero risk
4. Issue 0 (HTML upload) — frontend changes
5. Issue 3 (progressive scroll) — most complex logic
