# Player Overhaul Implementation Guide

This document provides detailed instructions for implementing the Wallacast audio player and content overhaul. It covers cost optimizations, content extraction changes, and the new fullscreen player UI.

## Table of Contents

1. [Cost Optimization Summary](#cost-optimization-summary)
2. [Content Extraction: Switch to Readability](#content-extraction-switch-to-readability)
3. [TTS and Timestamp Pipeline](#tts-and-timestamp-pipeline)
4. [Fullscreen Player UI](#fullscreen-player-ui)
5. [Image Description for TTS (Future)](#image-description-for-tts-future)
6. [Implementation Order](#implementation-order)

---

## Cost Optimization Summary

### Current Stack (Baseline)

| Component | Model | Cost |
|-----------|-------|------|
| Content Extraction | GPT-5-mini | ~$0.005/article |
| TTS | gpt-4o-mini-tts | ~$0.015/min audio (~$0.06 for 4min) |
| Timestamps | None | $0 |
| **Total (4min article)** | | **~$0.065** |

### New Stack

| Component | Model | Cost |
|-----------|-------|------|
| Content Extraction | HTML fetch (immediate) + Wallabag (background if enabled) | **$0 (free)** |
| Content Extraction Fallback | User-selected LLM (for non-Wallabag users) | ~$0.001-0.005/article |
| TTS | gpt-4o-mini-tts (unchanged) | ~$0.015/min |
| Timestamps | OpenAI Whisper (whisper-1) | ~$0.006/min ($0.024 for 4min) |
| **Total (4min article, Wallabag user)** | | **~$0.084** |
| **Total (4min article, no Wallabag)** | | **~$0.089** |

**Whisper Pricing**: $0.006 per minute of audio.

**Trade-off**: Slightly higher per-article cost (+~30%) but gains word-level timestamps for read-along functionality. Wallabag users get free content extraction. Non-Wallabag users can select cheaper models for fallback.

**Model Selection**: Users can choose their fallback extraction model in settings with cost/token displayed for each option.

### Why This Approach?

1. **Whisper for everything**: Podcasts already need Whisper for transcription. Using Whisper for article timestamps too means one consistent pipeline for all content types.
2. **Native timestamps unavailable**: Only ElevenLabs and Cartesia offer native TTS timestamps. Both are more expensive and would require provider migration.
3. **Already implemented**: The codebase already has `transcribeWithTimestamps()` with word-level timing. Just need to wire it into the article generation flow automatically.

---

## Content Extraction: FREE Content, PAID Audio

### Current Problem

The app uses LLM to extract article content from HTML automatically. This:
- Costs money per article (~$0.005)
- Runs even when user doesn't listen to the article
- Wastes money on articles that are never played

### Solution: Separate FREE Content from PAID Audio Generation

**Key principle**: Content fetching is ALWAYS FREE. Audio generation COSTS MONEY and is optional.

**FREE Content Flow:**
1. **Immediate display**: Use built-in HTML fetcher for instant content display
2. **Background upgrade**: If Wallabag sync enabled, fetch through Wallabag API (superior parsing)
3. **No LLM for extraction**: Content is displayed as-is from HTML/Wallabag

**PAID Audio Flow (optional, triggered manually or by setting):**
1. **Take FREE content**: Use the HTML/Wallabag content already fetched
2. **LLM prep for narration**: Send to LLM with prompt "prepare this for TTS narration" (~$0.001-0.005)
3. **TTS generation**: Convert prepped text to audio (~$0.06 for 4min)
4. **Whisper timestamps**: Transcribe audio for read-along feature (~$0.024 for 4min)

**Why this is better:**
- User adds 10 articles, only listens to 3 → Save 70% on LLM costs
- Content is always free and immediate
- Audio quality is optimized for narration (LLM prep makes it sound natural)
- User controls when to spend money (manual or auto-generate setting)

**Why Wallabag is superior**: Wallabag uses php-readability plus ftr-site-config (manually curated rules for tricky domains). This handles edge cases better than any generic parser.

### Implementation

#### 1. Built-in HTML Fetcher (Immediate Display)

The app already has basic HTML fetching in `article-fetcher.ts`. Use this for immediate display:

```typescript
// In article-fetcher.ts or similar
async function fetchArticleImmediate(url: string): Promise<string> {
  const response = await fetch(url);
  const html = await response.text();
  
  // Basic cleanup for display
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  
  // Remove obvious non-content
  const unwanted = document.querySelectorAll(
    'script, style, noscript, iframe, nav, footer, header'
  );
  unwanted.forEach(el => el.remove());
  
  return document.body.innerHTML;
}
```

#### 2. Background Wallabag Fetch (If Sync Enabled)

If user has Wallabag sync configured, fetch the article through Wallabag API in the background:

```typescript
async function upgradeWithWallabag(
  contentId: number, 
  url: string, 
  userId: number
): Promise<void> {
  const wallabagSettings = await getUserWallabagSettings(userId);
  
  if (!wallabagSettings?.enabled) {
    return; // Skip if Wallabag not configured
  }
  
  try {
    // Use Wallabag API to add and fetch article
    const wallabagArticle = await wallabagService.addArticle(url, userId);
    
    // Wallabag returns clean content with proper title, images, etc.
    await query(
      `UPDATE content_items 
       SET html_content = $1, title = $2, 
           content_source = 'wallabag', wallabag_id = $3
       WHERE id = $4`,
      [
        wallabagArticle.content,
        wallabagArticle.title,
        wallabagArticle.id,
        contentId
      ]
    );
    
    console.log('Wallabag upgrade complete:', contentId);
  } catch (error) {
    console.log('Wallabag fetch failed, keeping HTML version:', error);
    // Don't fail - keep the immediate HTML version
  }
}
```

#### 3. LLM Prep for Audio Generation (PAID, Optional)

**IMPORTANT**: LLM is NOT used for content extraction. It's ONLY used when generating audio.

When user clicks "Generate audio" (manually or via auto-generate setting):

```typescript
async function prepareTextForTTS(
  htmlContent: string,
  comments: Comment[] | null,
  userId: number
): Promise<string> {
  const userSettings = await getUserSettings(userId);
  const model = userSettings.tts_prep_model || 'gpt-4o-mini';

  // Combine content and comments
  let fullText = htmlContent;
  if (comments && comments.length > 0) {
    fullText += '\n\n[Comments section]\n' + formatCommentsForTTS(comments);
  }

  const response = await openai.chat.completions.create({
    model: model,
    messages: [{
      role: 'system',
      content: `Prepare this article for natural text-to-speech narration:
        - Remove navigation, ads, UI elements, and formatting artifacts
        - Keep main content structure and flow
        - Add natural transitions between sections
        - Clean up awkward phrasing that would sound bad when read aloud
        - Include image alt text where relevant (say "Image: [description]")
        - Make it flow naturally as a spoken article

        Return plain text optimized for audio narration.`
    }, {
      role: 'user',
      content: fullText
    }],
    max_tokens: 16000
  });

  return response.choices[0].message.content || '';
}
```

**Key points:**
- This is called ONLY when generating audio (not when fetching content)
- Uses latest available content (HTML or Wallabag, whichever is better)
- Includes EA Forum/LessWrong comments in the audio
- Output goes to TTS, then Whisper creates transcript for Read-along tab
- User never sees the LLM-prepped text directly (they see Whisper transcript instead)

#### 4. Model Selection in Settings

Add UI for model selection with cost information:

```typescript
// In SettingsPage.tsx or similar
const CONTENT_MODELS = [
  { id: 'gpt-4o-mini', name: 'GPT-4o-mini', cost: '$0.15/1M tokens', recommended: true },
  { id: 'gpt-4o', name: 'GPT-4o', cost: '$2.50/1M tokens', quality: 'high' },
  { id: 'gpt-5-mini', name: 'GPT-5-mini', cost: '$0.30/1M tokens', quality: 'balanced' },
];

<select>
  {CONTENT_MODELS.map(model => (
    <option value={model.id}>
      {model.name} ({model.cost})
      {model.recommended && ' - Recommended'}
    </option>
  ))}
</select>
```

### Content Display in Frontend

Display titles, headers, and images properly in Content tab:

```tsx
// In ContentTab.tsx
function ContentTab({ content }: { content: ContentItem }) {
  return (
    <div className="content-display">
      <h1>{content.title}</h1>
      <div 
        className="article-content"
        dangerouslySetInnerHTML={{ __html: content.html_content }}
      />
      <style>{`
        .article-content h1, .article-content h2, .article-content h3 {
          margin: 1em 0 0.5em;
          font-weight: 600;
        }
        .article-content img {
          max-width: 100%;
          height: auto;
          margin: 1em 0;
        }
        .article-content p {
          margin: 0.8em 0;
          line-height: 1.6;
        }
      `}</style>
    </div>
  );
}
```

### EA Forum / LessWrong Comments

Comments for these sites are still fetched via Wallacast (Wallabag doesn't support comments):

- Keep existing comment extraction in `openai-tts.ts`
- TTS should read article content + comments together
- Comments appear in separate Comments tab in fullscreen player

### Testing

Test the fallback chain:
1. Wallabag user adding article → Should use Wallabag fetch
2. Non-Wallabag user adding article → Should use LLM fallback
3. Wallabag fetch failure → Should gracefully keep HTML version or fallback to LLM
4. EA Forum article → Content via Wallabag/LLM, comments via Wallacast
5. Check that titles, headers, images display properly

---

## TTS and Timestamp Pipeline

### Known Issue: Whisper Timestamps Not Working

**Current Problem**: Clicking words in the transcript doesn't seek to the correct position in audio. The Whisper timestamp implementation may not be working properly.

**Investigation needed**:
1. Check if `transcribeWithTimestamps()` is actually being called for articles
2. Verify `transcript_words` JSONB data structure in database
3. Test if timestamps are being stored correctly
4. Debug word-click seeking logic in frontend

**Location**: 
- Backend: `backend/src/services/transcription.ts`
- Frontend word click: `frontend/src/components/AudioPlayer.tsx` or read-along tab
- Database: `transcript_words` column in `content_items` table

### Current State

The Whisper implementation is **fully functional** but only auto-runs for podcasts:

- `transcribeWithTimestamps()` in `transcription.ts` is complete and working
- `transcript_words` JSONB column exists in database
- Frontend has word-click seeking logic that reads from `transcript_words`
- **Podcast episodes**: Auto-transcription runs when added (line ~1725 in routes)
- **Articles**: Whisper is NOT called after TTS generation

The fix is straightforward: call `transcribeWithTimestamps()` after article TTS completes, same as podcasts do.

### Old Flow (Wasteful)

```
Article added → Automatic LLM extraction ($$$) → TTS → No timestamps
(Cost: ~$0.005 per article, even if never played)
```

### New Flow (Cost-Optimized)

**Content fetching (FREE):**
```
Article URL → HTML fetch (immediate, free) → Wallabag upgrade (background, free if enabled)
                                              ↓
                                    Display in Content tab (free)
```

**Audio generation (PAID, optional):**
```
User clicks "Generate audio" (or auto-generate if enabled in settings)
                                              ↓
Take HTML/Wallabag content + EA/LW comments (already fetched, free)
                                              ↓
LLM: "Prepare for TTS narration" (~$0.001-0.005)
                                              ↓
gpt-4o-mini-tts generates audio (~$0.06 for 4min)
                                              ↓
Whisper transcribes audio with word timestamps (~$0.024 for 4min)
                                              ↓
Transcript displayed in Read-along tab (clickable words for seeking)
```

**Total cost per article:**
- If never played: $0 (FREE)
- If audio generated: ~$0.085-0.09 (only when needed)

**Savings:** Add 10 articles, listen to 3 → Save $0.035 (70% reduction in LLM costs)

### Implementation Changes

#### 1. Find Where TTS Completes

Search `openai-tts.ts` for where article audio generation finishes. Look for patterns like:
- `generation_status = 'completed'` 
- `generation_progress = 100`

#### 2. Add Whisper Call After TTS (Same Pattern as Podcasts)

Copy the pattern from podcast auto-transcription (around line 1725 in routes):

```typescript
import { transcribeWithTimestamps } from './transcription.js';

// After TTS audio is saved and audio_url is set, BEFORE marking complete:
async function runWhisperAfterTTS(contentId: number, audioUrl: string, userId: number) {
  // Update status
  await query(
    'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
    ['generating_transcript', 85, 'transcript', contentId]
  );

  transcribeWithTimestamps(audioUrl, userId)
    .then(async (result) => {
      await query(
        `UPDATE content_items 
         SET transcript = $1, transcript_words = $2, 
             generation_status = 'completed', generation_progress = 100, 
             current_operation = NULL 
         WHERE id = $3`,
        [result.text, JSON.stringify(result.words), contentId]
      );
      console.log('TTS + transcription complete:', contentId);
    })
    .catch(async (error) => {
      console.error('Transcription failed (audio still usable):', error);
      // Don't fail the whole process; audio is still usable without timestamps
      await query(
        `UPDATE content_items 
         SET generation_status = 'completed', generation_progress = 100,
             generation_error = 'Transcription failed - word timestamps unavailable',
             current_operation = NULL
         WHERE id = $1`,
        [contentId]
      );
    });
}
```

#### 3. Update Progress Tracking

Adjust TTS progress to leave room for Whisper:
- 0-80%: TTS generation
- 80-95%: Whisper transcription  
- 95-100%: Finalization

Update progress to reflect both steps:

| Progress | Operation |
|----------|-----------|
| 0-80% | TTS generation (chunked) |
| 80-95% | Whisper transcription |
| 95-100% | Finalization |

---

## Fullscreen Player UI

### Tab Structure

Tabs vary by content type:

| Content Type | Tabs Available |
|--------------|----------------|
| Articles | Content, Comments*, Read-along, Queue |
| Texts | Content, Read-along, Queue |
| Podcasts | Read-along, Queue |

*Comments tab only for EA Forum/LessWrong articles

**Content tab differences by type**:
- **Articles**: Render HTML from Wallabag/Readability (read-only)
- **Texts**: Render markdown, eventually editable

**Note on read-along**: Texts and podcasts already have Whisper transcription with clickable timestamps. We're just reorganizing into tabs. For articles, we're adding this capability (auto-Whisper after TTS).

```
Articles:
┌─────────────────────────────────────────────────────┐
│  [Content]  [Comments]  [Read-along]  [Queue]       │
├─────────────────────────────────────────────────────┤
│                   Tab Content Area                  │
├─────────────────────────────────────────────────────┤
│  ▶ advancement bar        🔀 ⏮ ⏯ ⏭ 🔁  💤 ⚙️    │
└─────────────────────────────────────────────────────┘

Podcasts:
┌─────────────────────────────────────────────────────┐
│  [Read-along]  [Queue]                              │
├─────────────────────────────────────────────────────┤
│                   Tab Content Area                  │
├─────────────────────────────────────────────────────┤
│  ▶ advancement bar        🔀 ⏮ ⏯ ⏭ 🔁  💤 ⚙️    │
└─────────────────────────────────────────────────────┘
```

### Content Tab (Articles and Texts)

**Purpose**: Display the original content with nice formatting.

**Differences by type**:
- **Articles**: Render HTML from Wallabag/Readability. Read-only. "Refetch content" button.
- **Texts**: Render markdown. Eventually editable (future feature).

Podcasts don't have this tab since there's no textual content to display.

**Implementation (Articles)**:
- Use the HTML content from Wallabag/Readability (not the TTS transcript)
- Render with proper styling (headers, paragraphs, images, links)
- Include article metadata (title, author, date, reading time)
- "Refetch content" button (refresh icon) to re-fetch from source URL

**Key differences from current**:
- NOT the clickable-word TTS text
- Full formatting preserved
- Images displayed (not described)

**Component**: `ContentTab.tsx`

```tsx
interface ContentTabProps {
  content: ContentItem;
  onRefetch: () => void;
}

function ContentTab({ content, onRefetch }: ContentTabProps) {
  return (
    <div className="content-tab">
      <div className="content-header">
        <h1>{content.title}</h1>
        {content.author && <p className="author">By {content.author}</p>}
        <button onClick={onRefetch} className="refetch-btn" title="Refetch content">
          <RefreshIcon />
        </button>
      </div>
      <div 
        className="article-content"
        dangerouslySetInnerHTML={{ __html: content.content }}
      />
    </div>
  );
}
```

### Comments Tab (EA Forum/LessWrong Only)

**Purpose**: Display EA Forum/LessWrong comments in a structured way.

**Visibility**: Only show tab for EA Forum and LessWrong articles (check URL domain). Hidden for all other content.

**Implementation**:
- Parse the `comments` JSON field
- Display in threaded format with:
  - Author name
  - Karma score
  - Agree/Disagree votes (if available)
  - Reply depth indicator
  - Timestamp
- "Refetch comments" button (refresh icon)

**Component**: `CommentsTab.tsx`

```tsx
interface Comment {
  id: string;
  author: string;
  content: string;
  karma: number;
  agreeVotes?: number;
  disagreeVotes?: number;
  replies?: Comment[];
  createdAt: string;
}

function CommentsTab({ comments, onRefetch }: { comments: Comment[]; onRefetch: () => void }) {
  return (
    <div className="comments-tab">
      <div className="comments-header">
        <h2>Comments ({comments.length})</h2>
        <button onClick={onRefetch} className="refetch-btn" title="Refetch comments">
          <RefreshIcon />
        </button>
      </div>
      <div className="comments-list">
        {comments.map(comment => (
          <CommentThread key={comment.id} comment={comment} depth={0} />
        ))}
      </div>
    </div>
  );
}
```

### Read-along Tab

**Purpose**: Follow along with audio using clickable words for timestamp seeking.

**What it displays**: Whisper transcript with word-level timestamps (NOT the LLM-prepped text).

**Flow:**
1. User generates audio → LLM preps text → TTS creates audio → Whisper transcribes audio
2. Whisper transcript is what you see in Read-along tab (with clickable words)
3. This is the actual narrated content, timestamped to the audio

**Current state**:
- **Podcasts**: Whisper already runs, but word-click seeking doesn't work yet (needs debugging)
- **Articles**: Whisper needs to auto-run after TTS generation

**Implementation**:
- Display the Whisper transcript text (plain, no formatting)
- Each word is clickable
- Clicking a word seeks audio to that position
- "Jump to current position" button (floats in corner)
- No auto-scroll (too buggy), manual jump only
- "Regenerate audio" button to re-generate TTS + Whisper timestamps using latest content

**Word click handler** (already exists in codebase):

```tsx
const handleWordClick = (wordIndex: number) => {
  if (!transcriptWords || !transcriptWords[wordIndex]) return;
  
  const timestamp = transcriptWords[wordIndex].start;
  handleSeek(timestamp);
};
```

**Jump to current button**:

```tsx
const jumpToCurrent = () => {
  if (!transcriptWords || !audioRef.current) return;
  
  const currentTime = audioRef.current.currentTime;
  const currentWordIndex = transcriptWords.findIndex(
    (word, i) => word.start <= currentTime && 
                 (i === transcriptWords.length - 1 || transcriptWords[i + 1].start > currentTime)
  );
  
  if (currentWordIndex >= 0) {
    const wordElement = document.querySelector(`[data-word-index="${currentWordIndex}"]`);
    wordElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};
```

### Queue Tab

**Purpose**: Manage playback queue like Spotify.

**Implementation**:

1. **Queue State**: Add to App.tsx or create Zustand store:
   ```typescript
   interface QueueState {
     manualQueue: string[];      // Manually added item IDs (play in order)
     autoQueue: string[];        // Auto-added from library (can be shuffled)
     currentIndex: number;
     shuffle: boolean;
     autoplay: boolean;          // Whether to auto-play non-manual items
   }
   ```

2. **Queue Behavior**:
   - Manual queue items play first, in order, and play automatically after each other
   - Auto queue items (non-manually added) play after manual queue
   - Shuffle only affects auto queue
   - Autoplay toggle controls whether auto queue plays at all

3. **Audio Generation Prompt**:
   When a manually-queued item doesn't have audio:
   ```tsx
   const handleNoAudio = (item: ContentItem) => {
     const action = await showDialog({
       title: 'No Audio Available',
       message: `"${item.title}" doesn't have audio yet.`,
       options: ['Generate Audio', 'Skip']
     });
     
     if (action === 'Generate Audio') {
       // Move to next item
       playNext();
       // Generate audio in background
       generateAudio(item.id);
       // Re-add to queue after current item once done
       onAudioGenerated(item.id, () => {
         addToQueueAfterCurrent(item.id);
       });
     } else {
       playNext();
     }
   };
   ```

4. **Library Integration**:
   Add "Add to queue" option in LibraryTab dropdown menu:
   ```tsx
   <DropdownMenuItem onClick={() => addToManualQueue(item.id)}>
     Add to queue
   </DropdownMenuItem>
   ```

5. **Player Controls**:
   - Previous: Go to previous item in queue
   - Next: Go to next item in queue  
   - Shuffle: Toggle shuffle for auto queue

---

## Image Description for TTS (Future)

This is planned for later implementation.

### Approach

When generating TTS for an article that contains images:

1. Extract image URLs from the article HTML
2. For each image, call a vision model to get a description
3. Insert descriptions into the TTS text at appropriate positions
4. Mark image descriptions in transcript so they can be styled differently

### Implementation Sketch

```typescript
async function prepareTextWithImageDescriptions(
  html: string, 
  textContent: string
): Promise<string> {
  const dom = new JSDOM(html);
  const images = dom.window.document.querySelectorAll('img');
  
  let enhancedText = textContent;
  
  for (const img of images) {
    const src = img.src;
    const alt = img.alt;
    
    // Get image description from vision model
    const description = await describeImage(src, alt);
    
    // Find where this image was in the text flow
    // Insert: "[Image: description]"
    // This is tricky - need to map DOM position to text position
  }
  
  return enhancedText;
}

async function describeImage(url: string, existingAlt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url } },
        { 
          type: 'text', 
          text: `Describe this image for a text-to-speech narration. Be concise (1-2 sentences). 
                 Existing alt text: "${existingAlt || 'none'}"`
        }
      ]
    }],
    max_tokens: 100
  });
  
  return response.choices[0].message.content || '';
}
```

### Cost Consideration

- GPT-4o-mini vision: ~$0.00015/image (low-res)
- Average article: 2-5 images
- Additional cost: ~$0.0003-0.00075/article

This is relatively cheap and adds significant value for articles with important diagrams/charts.

---

## Implementation Order

Recommended order of implementation:

### Phase 1: High Priority Fixes and Optimizations

1. **Fix podcast content provenance** (P2 bug)
   - Podcasts incorrectly show "fetched by wallabag"
   - Update `content_source` field logic for podcast episodes

2. **Add HTTP caching headers** (P2 optimization, easy win)
   - Add to `/api/content/:id/audio` endpoint in `backend/src/index.ts`
   - Set `Cache-Control: public, max-age=31536000, immutable`
   - Prevents re-downloading same audio files repeatedly

3. **Audio optimization** (P3, test quality first!)
   - Location: `backend/src/services/openai-tts.ts` in `concatenateAudioFiles()`
   - Update FFmpeg output options:
     ```typescript
     .outputOptions([
       '-c:a libmp3lame',  // MP3 encoder
       '-b:a 96k',         // 96kbps bitrate (standard is 64-128k, might sound compressed)
       '-ac 1'             // Mono (saves ~50% size, fine for speech)
     ])
     ```
   - Expected savings: ~60-70% smaller files
  
4. **Fix Whisper timestamp seeking** (can be done later)
   - Debug why clicking words doesn't seek correctly
   - Check `transcribeWithTimestamps()` implementation
   - Verify `transcript_words` data structure

### Phase 2: Content Fetching Overhaul
1. **Implement Wallabag-first content fetching** (SAVES MONEY!)
   - Create immediate HTML fetch function
   - Add background Wallabag fetch (conditional on sync being enabled)
   - Implement LLM fallback with model selection
   - Add model selection UI in settings with cost/token info
   - Update content display to show titles, headers, images properly
   - Test on EA Forum, LessWrong, Substack, Medium
   - Verify EA Forum/LessWrong comments still work via Wallacast

### Phase 3: Auto-Timestamps
1. Modify TTS generation to auto-run Whisper on completion
2. Update progress tracking (0-80% TTS, 80-95% Whisper)
4. Test that transcript_words is populated automatically

### Phase 3: Player UI Foundation
1. Create FullscreenPlayer with tab structure
2. Implement ContentTab (Wallabag-style rendering)
3. Move current word-click UI to ReadAlongTab
4. Add "Jump to current" button

### Phase 4: Comments Tab
1. Implement CommentsTab component
2. Show/hide based on URL domain
3. Style threaded comments with karma display
4. Add refetch functionality

### Phase 5: Queue System
1. Add queue state (Zustand store recommended)
2. Implement manual vs auto queue logic
3. Add "Add to queue" to library
4. Handle no-audio items with generation prompt
5. Add previous/next/shuffle controls

### Phase 6: Image Descriptions (Later)
1. Image extraction from HTML
2. Vision API integration
3. Description insertion in TTS text
4. UI indicator for image descriptions

---

## File Changes Summary

| File | Changes |
|------|---------|
| `package.json` | Add jsdom if not already present |
| `article-fetcher.ts` | Immediate HTML fetch, background Wallabag fetch |
| `wallabag-service.ts` | Add content fetching via Wallabag API |
| `openai-tts.ts` | Auto-run Whisper after TTS, LLM fallback for content extraction |
| `SettingsPage.tsx` | Add model selection dropdown with costs |
| `FullscreenPlayer.tsx` | Add tab structure |
| `ContentTab.tsx` | New file, display HTML content with proper styling |
| `CommentsTab.tsx` | New file |
| `ReadAlongTab.tsx` | New file (move existing word-click UI) |
| `QueueTab.tsx` | New file |
| `useQueue.ts` or `queueStore.ts` | Queue state management |
| `LibraryTab.tsx` | Add "Add to queue" action |
| `AudioPlayer.tsx` | Replace volume slider with Queue Autoplay toggle |

---

## Testing Checklist

- [ ] Readability extracts content from EA Forum article
- [ ] Readability extracts content from LessWrong article
- [ ] Readability extracts content from Substack newsletter
- [ ] LLM fallback triggers when Readability fails
- [ ] TTS generation auto-runs Whisper
- [ ] transcript_words is populated after generation
- [ ] Word click seeks to correct position
- [ ] Content tab renders HTML properly
- [ ] Comments tab shows threaded replies
- [ ] Queue tab shows manual and auto items
- [ ] Adding to queue from library works
- [ ] Previous/next/shuffle controls work
- [ ] Sleep timer works in new location
