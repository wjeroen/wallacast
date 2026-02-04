# Image Alt-Text Generation Implementation Plan
## For Wallacast Read-It-Later & Podcast App

**Target API:** Gemini 3 Flash (gemini-3-flash-preview)  
**Implementation Date:** February 2026  
**Created for:** Claude Code execution

---

## Architecture Overview

### Integration Point: Inside TTS Generation
**Location in workflow:** Inside `generateAudioForContent()`, runs only when user requests audio

**Current flow:**
```
User clicks "Generate Audio" → POST /api/content/:id/generate-audio → 
  → generateAudioForContent() → fetch content from DB → 
  → scriptArticleForListening(html_content) → generate audio
```

**New flow:**
```
User clicks "Generate Audio" → POST /api/content/:id/generate-audio → 
  → generateAudioForContent() → fetch content from DB → 
  → CHECK user setting: image_alt_text_enabled? → 
  → IF enabled: IMAGE ALT-TEXT ENRICHMENT of html_content → 
  → scriptArticleForListening(enriched_html) → generate audio
```

### Why This Integration Point?
1. **Respects user choice:** Only runs when user explicitly requests audio generation
2. **Cost control:** Alt-text generation tied to TTS generation (user knows they're using AI)
3. **No blocking:** Article fetching remains fast, alt-text happens async during TTS
4. **Simple UX:** Global toggle in settings, no per-article prompts/dialogs
5. **Saves enriched HTML:** Updated html_content in DB for future use/display

---

## Database Schema Changes

### Add to `content_items` table
```sql
-- Track image alt-text generation status
ALTER TABLE content_items 
ADD COLUMN images_processed BOOLEAN DEFAULT FALSE;

ALTER TABLE content_items 
ADD COLUMN image_alt_text_data JSONB DEFAULT NULL;

-- Structure: URL-keyed descriptions with metadata
-- {
--   "descriptions": {
--     "https://example.com/img1.jpg": "A bar chart showing revenue growth from 2020 to 2025",
--     "https://example.com/img2.jpg": "Reddit thread where user alice discusses AI safety"
--   },
--   "total_images": 5,
--   "decorative_images": 2,
--   "cost_usd": 0.0023,
--   "model": "gemini-3-flash-preview",
--   "processed_at": "2026-02-04T10:30:00Z"
-- }
--
-- Note: Descriptions stored separately, never modify html_content.
-- Applied in memory during TTS only.
```

### User Settings
Add to `user_settings` table:
```sql
-- image_alt_text_enabled (boolean, default: true)
--   Controls whether image descriptions are generated during TTS
```

---

## Implementation Files

### 1. Create `backend/src/services/image-alt-text.ts`

This service handles:
- Image URL extraction from HTML
- Image classification (informative vs decorative)
- Gemini 3 Flash API calls
- HTML enrichment with alt-text

```typescript
import { GoogleGenAI } from "@google/genai";
import { JSDOM } from 'jsdom';
import { getUserSetting } from './ai-providers.js';

interface ImageDescriptions {
  [url: string]: string;
}

interface ImageAltTextData {
  descriptions: ImageDescriptions;
  total_images: number;
  decorative_images: number;
  cost_usd: number;
  model: string;
  processed_at: string;
}

export class ImageAltTextService {
  private userId: number;
  
  constructor(userId: number) {
    this.userId = userId;
  }

  /**
   * Get Gemini client using user's API key
   */
  private async getGeminiClient(): Promise<GoogleGenAI> {
    const apiKey = await getUserSetting(this.userId, 'gemini_api_key');
    if (!apiKey) {
      throw new Error('No Gemini API key configured. Please add your key in Settings.');
    }
    return new GoogleGenAI(apiKey);
  }

  /**
   * Main entry: Extract images, filter, generate descriptions, return JSONB data
   * Never modifies the input HTML
   */
  async generateDescriptions(
   * Extract all image URLs from HTML
   */
  private extractImageUrls(html: string): Array<{
    url: string;
    element: string; // Original <img> tag for replacement
    hasExistingAlt: boolean;
    existingAlt: string;
  }> {
    // Use cheerio to parse HTML and extract images
    // Return image URLs with context
  }

  /**
   * Filter out decorative images using heuristics
   */
  private filterDecorativeImages(
    images: Array<any>,
    html: string
  ): Array<any> {
    // Heuristic filtering (see "Image Filtering Strategy" below)
    // Return only images likely to be informative
  }

  /**
   * Call Gemini 3 Flash to analyze multiple images
   */
  private async analyzeImages(
    imageUrls: string[],
    articleContext: string
  ): Promise<ImageAnalysisResult[]> {
    // Batch API call to Gemini with url_context tool
    // Include article context for better alt-text
  }

  /**
   * Replace img tags in HTML with enriched versions
   */
  private enrichHtmlWithDescriptions(
    html: string,
    analyses: ImageAnalysisResult[]
  ): string {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const images = Array.from(doc.querySelectorAll('img'));
    
    // Create map of image URL to description for quick lookup
    const urlToDescription = new Map<string, string>();
    analyses.forEach(analysis => {
      if (analysis.description && !analysis.isDecorative) {
        urlToDescription.set(analysis.imageUrl, analysis.description);
      }
    });
    
    // Update each image's alt attribute
    images.forEach(img => {
      const src = img.getAttribute('src');
      if (!src) return;
      
      // Normalize URL (handle relative URLs, remove query params for matching)
      const normalizedSrc = src.split('?')[0];
      
      // Check if we have a Gemini description for this image
      for (const [url, description] of urlToDescription.entries()) {
        if (url.includes(normalizedSrc) || normalizedSrc.includes(url.split('?')[0])) {
          // REPLACE existing alt attribute with Gemini's description
          img.setAttribute('alt', description);
          break;
        }
      }
    });
    
    return doc.body.innerHTML;
  }
}
```

### 2. Modify `backend/src/services/ai-providers.ts`

Add Gemini API key to allowed settings:

```typescript
// In ALLOWED_SETTINGS array:
const ALLOWED_SETTINGS = [
  'openai_api_key',
  'deepinfra_api_key',
  'anthropic_api_key',
  'google_api_key',
  'gemini_api_key',  // NEW: For image alt-text generation
  // ... rest of settings
];

// In SECRET_KEYS array (for masking in responses):
const SECRET_KEYS = [
  'openai_api_key',
  'deepinfra_api_key',
  'anthropic_api_key',
  'google_api_key',
  'gemini_api_key',  // NEW
  // ... rest of secret keys
];
```

### 3. Modify `backend/src/services/openai-tts.ts`

**A. Add image processing inside `generateAudioForContent()`:**

```typescript
import { ImageAltTextService } from './image-alt-text.js';
import { getUserSetting } from './ai-providers.js';

export async function generateAudioForContent(contentId: number): Promise<{ audioUrl: string; warning?: string }> {
  try {
    const contentResult = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);
    if (contentResult.rows.length === 0) throw new Error('Content not found');
    const content = contentResult.rows[0];

    const imageAltTextEnabled = await getUserSetting(content.user_id, 'image_alt_text_enabled');
    
    let sourceContent = content.html_content || content.content || '';
    let imageAltTextData = content.image_alt_text_data;

    // Step 1: Process images (0-10% progress)
    // Uses smartRegenerate to handle refetches properly
    if (imageAltTextEnabled !== false && sourceContent) {
      try {
        console.log('[TTS] Processing image descriptions...');
        await query(
          'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
          ['processing_images', 0, contentId]
        );
        
        const imageService = new ImageAltTextService(content.user_id);  // Pass userId
        imageAltTextData = await imageService.smartRegenerate(
          sourceContent,
          imageAltTextData, // existing data or null
          content.url || '',
          { articleTitle: content.title, articleAuthor: content.author }
        );

        // Save JSONB data (never modify html_content)
        await query(
          'UPDATE content_items SET image_alt_text_data = $1, images_processed = $2, generation_progress = $3 WHERE id = $4',
          [imageAltTextData, true, 10, contentId]
        );
      } catch (error) {
        console.error('[TTS] Image alt-text generation failed:', error);
      }
    }

    // Step 2: Apply descriptions to HTML in memory (if we have any)
    if (imageAltTextData?.descriptions && Object.keys(imageAltTextData.descriptions).length > 0) {
      const imageService = new ImageAltTextService(content.user_id);  // Pass userId
      sourceContent = imageService.applyDescriptionsToHtml(sourceContent, imageAltTextData.descriptions);
      // sourceContent now has Gemini alt-text, but we DON'T save it back to DB
    }

    // Step 3: Script content for listening (10-20% progress)
    console.log('[TTS] Running Scriptwriter to format HTML for audio...');
    await query(
      'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
      ['scripting_content', 10, contentId]
    );
    
    const chatClient = await getOpenAIClientForUser(content.user_id);
    let articleBodyScript: string;
    if (chatClient && sourceContent.includes('<')) { 
        articleBodyScript = await scriptArticleForListening(sourceContent, chatClient);
    } else {
        articleBodyScript = htmlToNarrationText(sourceContent);
    }

    await query('UPDATE content_items SET generation_progress = $1 WHERE id = $2', [20, contentId]);

    // ... continue with existing title/author/comments assembly ...
    
    // Step 4: Generate audio chunks (20-90% progress)
    console.log(`[TTS] Sending script (${fullScript.length} chars) to audio engine...`);
    await query(
      'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
      ['synthesizing_audio', 20, contentId]
    );

    const { buffer: audioBuffer, chunks, chunkMetadata } = await generateArticleAudio(fullScript, content.user_id, {
      contentId: contentId,
    });

    // Step 5: Final processing (90-95% progress)
    await query(
      'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
      ['finalizing_audio', 90, contentId]
    );

    // ... existing audio storage code ...

    // Step 6: Transcription (95-100% progress)
    console.log('[TTS] Triggering auto-transcription for Read Along...');
    await query(
      'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
      ['transcribing', 95, contentId]
    );

    // ... rest of code ...
  }
}
```

**Key points:**
- **Never modifies html_content**: Gemini descriptions stored in JSONB only
- **Applied in memory**: `applyDescriptionsToHtml()` creates temp HTML for TTS
- **Smart regeneration**: `smartRegenerate()` diffs current images vs stored, only generates new ones
- **Refetch handling**: After refetch, `smartRegenerate()` removes deleted images, adds new ones

### 4. Frontend: `frontend/src/components/SettingsPage.tsx`

Add Gemini API key input field (place it near OpenAI/DeepInfra keys):

```typescript
// Add to formData state initialization:
gemini_api_key: '',

// Add to SECRET_KEYS check function:
const isSecretSet = (key: string) => {
  return loadedSettings[key] === '••••••••';
};

// Add input field in the AI Providers section:
<div className="form-group">
  <label>
    Gemini API Key 
    <span className="label-hint">(for image descriptions in audio)</span>
  </label>
  {isSecretSet('gemini_api_key') && <span className="secret-set">(configured)</span>}
  <div className="secret-input-wrapper">
    <input
      type={showSecrets['gemini_api_key'] ? 'text' : 'password'}
      value={formData.gemini_api_key}
      onChange={(e) => handleChange('gemini_api_key', e.target.value)}
      placeholder={isSecretSet('gemini_api_key') ? '••••••••' : 'Your Gemini API key...'}
    />
    <button 
      type="button" 
      onClick={() => toggleShowSecret('gemini_api_key')} 
      className="toggle-visibility"
    >
      {showSecrets['gemini_api_key'] ? <EyeOff size={18} /> : <Eye size={18} />}
    </button>
  </div>
  <small className="form-hint">
    Get your free API key at <a href="https://aistudio.google.com/app/apikey" target="_blank">Google AI Studio</a>
  </small>
</div>
```

Add image alt-text toggle (in Audio/TTS section):

```typescript
<div className="form-group">
  <label className="checkbox-label">
    <input
      type="checkbox"
      checked={formData.image_alt_text_enabled ?? true}
      onChange={(e) => handleChange('image_alt_text_enabled', e.target.checked)}
    />
    Generate image descriptions for audio
  </label>
  <small className="form-hint">
    Adds spoken descriptions of images during TTS generation (~$0.003 per article). 
    Requires Gemini API key.
  </small>
</div>
```

### 5. Frontend: Update `frontend/src/components/LibraryTab.tsx`

Modify status display to show all generation steps:

```typescript
const renderGenerationStatus = (item: ContentItem) => {
  let statusMessage = '';
  const progressPercent = item.generation_progress || 0;

  if (item.generation_status === 'starting') {
    statusMessage = 'Starting...';
  } else if (item.generation_status === 'extracting_content') {
    statusMessage = 'Extracting content...';
  } else if (item.generation_status === 'content_ready') {
    // NEW: Handle all processing stages
    switch (item.current_operation) {
      case 'processing_images':
        statusMessage = `Processing images... ${progressPercent}%`;
        break;
      case 'scripting_content':
        statusMessage = `Preparing narration script... ${progressPercent}%`;
        break;
      case 'synthesizing_audio':
        if (item.current_operation?.startsWith('audio_chunk_')) {
          const match = item.current_operation.match(/audio_chunk_(\d+)_of_(\d+)/);
          if (match) {
            const [, current, total] = match;
            statusMessage = `Generating audio: chunk ${current}/${total} (${progressPercent}%)`;
          } else {
            statusMessage = `Generating audio... ${progressPercent}%`;
          }
        } else {
          statusMessage = `Generating audio... ${progressPercent}%`;
        }
        break;
      case 'finalizing_audio':
        statusMessage = `Finalizing audio... ${progressPercent}%`;
        break;
      case 'transcribing':
        statusMessage = `Creating transcript... ${progressPercent}%`;
        break;
      case 'concatenating_audio':
        statusMessage = `Combining audio files... ${progressPercent}%`;
        break;
      default:
        statusMessage = `Generating audio... ${progressPercent}%`;
    }
  } else if (item.generation_status === 'generating_transcript') {
    statusMessage = `Generating transcript... ${progressPercent}%`;
  } else {
    statusMessage = `Processing... ${progressPercent}%`;
  }

  return (
    <div className="generation-status generating">
      <span>{statusMessage}</span>
      {progressPercent > 0 && (
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progressPercent}%` }}></div>
        </div>
      )}
    </div>
  );
};
```

### 4. Frontend: `frontend/src/components/SettingsPage.tsx`

Add simple toggle for image descriptions:

```typescript
// In Settings UI (Audio/TTS section)
<Toggle
  label="Generate image descriptions for audio"
  description="Adds spoken descriptions of images during TTS generation (~$0.003 per article)"
  checked={settings.image_alt_text_enabled ?? true}
  onChange={(enabled) => updateSetting('image_alt_text_enabled', enabled)}
/>
```

**That's it for UI.** Regeneration works automatically when user clicks "Regenerate Audio" in the context menu.

---

## Image Filtering Strategy

### Goal
Avoid processing decorative images (icons, logos, share buttons) that don't add informational value.

### Heuristic Filtering (Pre-API)

Apply these rules BEFORE sending to Gemini:

```typescript
function isLikelyDecorativeImage(img: ImageElement, html: string): boolean {
  // 1. Size heuristics
  if (img.width < 50 || img.height < 50) return true; // Too small to be informative
  if (img.width < 100 && img.height < 100) {
    // Small images are decorative unless they're standalone
    if (!img.isStandalone) return true;
  }

  // 2. Filename patterns
  const url = img.src.toLowerCase();
  const decorativePatterns = [
    /icon/i,
    /logo/i,
    /avatar/i,
    /profile/i,
    /badge/i,
    /button/i,
    /separator/i,
    /divider/i,
    /banner/i,
    /header/i,
    /footer/i,
    /share/i,
    /social/i,
    /spacer/i,
    /transparent\.png/i,
    /1x1/i,
    /pixel/i,
  ];
  if (decorativePatterns.some(pattern => pattern.test(url))) return true;

  // 3. CSS classes (if available)
  const decorativeClasses = [
    'icon', 'logo', 'avatar', 'badge', 'social-share',
    'decorative', 'ornament', 'separator'
  ];
  if (img.classes?.some(cls => decorativeClasses.includes(cls))) return true;

  // 4. Alt attribute analysis
  if (img.alt === '') return true; // Empty alt = explicitly decorative
  if (img.alt && img.alt.length < 5) return true; // "icon", "logo", etc.

  // 5. Position heuristics
  if (img.isInHeader || img.isInFooter || img.isInNav) return true;

  // 6. Parent element analysis
  if (img.parentElement?.tagName === 'A' && img.parentElement.href.includes('share')) {
    return true; // Share button images
  }

  return false; // Likely informative
}
```

### Gemini-Based Classification (Post-API)

For edge cases, ask Gemini to classify:

```typescript
const prompt = `You are analyzing images in an article to determine if they need descriptive alt-text for audio narration.

Article context: "${articleTitle}"

For each image URL below, respond with:
- "decorative" if it's just a design element (icon, logo, header, separator)
- "informative" if it adds content value (photo, diagram, screenshot, chart)

Be conservative: when unsure, mark as "decorative" to avoid unnecessary narration.

Images:
${imageUrls.map((url, i) => `${i+1}. ${url}`).join('\n')}

Respond in JSON:
[
  {"index": 1, "type": "decorative"|"informative", "confidence": 0.0-1.0},
  ...
]`;
```

### Combined Strategy

1. **Fast heuristic filter** removes obvious decorative images (icons, small images)
2. **Gemini classification** for remaining images (handles edge cases)
3. **Only process informative images** with full alt-text generation

This keeps costs low and reduces noise in TTS narration.

---

## Gemini 3 Flash API Implementation

### Basic Setup

```typescript
import { GoogleGenAI } from "@google/genai";

const client = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const model = "gemini-3-flash-preview";
```

### Alt-Text Generation Prompt

```typescript
async function generateAltText(
  imageUrls: string[],
  articleContext: { title: string; url: string; excerpt: string }
): Promise<ImageAnalysisResult[]> {
  
  const prompt = `You are generating alt-text for images in an article for audio narration (text-to-speech).

Article: "${articleContext.title}"
Source: ${articleContext.url}
Context: ${articleContext.excerpt}

For each image, provide a concise, informative description (1-2 sentences max) that:
- Describes what's visible and relevant to the article
- Avoids saying "image of" or "picture of"
- Uses clear, natural language suitable for audio
- Focuses on informational content, not decorative details

Images:
${imageUrls.map((url, i) => `${i+1}. ${url}`).join('\n')}

Respond in JSON format:
[
  {
    "index": 1,
    "description": "...",
    "is_decorative": false,
    "confidence": 0.95
  },
  ...
]`;

  const response = await client.models.generateContent({
    model: model,
    contents: prompt,
    config: {
      tools: [{ url_context: {} }], // Enable URL fetching
      temperature: 0.3, // Low temperature for consistent descriptions
      maxOutputTokens: 2048,
    },
  });

  const text = response.candidates[0].content.parts
    .map(part => part.text)
    .join('');
  
  // Parse JSON response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Failed to parse Gemini response');
  
  const results = JSON.parse(jsonMatch[0]);
  
  return results.map((r: any, i: number) => ({
    url: imageUrls[r.index - 1],
    description: r.description,
    isDecorative: r.is_decorative,
    confidence: r.confidence,
  }));
}
```

### Handling Large Images

For screenshots like Reddit threads:

```typescript
const config = {
  tools: [{ url_context: {} }],
  temperature: 0.3,
  maxOutputTokens: 4096, // More tokens for complex images
  
  // CRITICAL: Use high resolution for dense layouts
  generationConfig: {
    mediaResolution: "high", // 1120 tokens per image
  },
};

// For Reddit threads specifically:
const redditPrompt = `This is a screenshot of a Reddit comment thread. Provide a structured description that:
1. Identifies the post title/topic
2. Lists top-level comments with authors and upvote counts
3. Notes any significant reply chains
4. Mentions overall sentiment/discussion tone

Keep it under 3 sentences for audio narration.`;
```

### Gemini API Prompt

User-tested prompt that works well:

```typescript
const prompt = `You are an expert accessibility narrator for a text-to-speech article reader. Your task is to describe this image for a listener so they understand the context in a format that offers the best listening experience.

- **If it's a photo or visual:** Provide a concise, vivid description of the scene, identifying key subjects, text (if any), and the overall mood.
- **If it's a chart:** Summarize the primary trend or insight (e.g., "A line graph showing Bitcoin price rising from 2020 to 2024"). Provide key data points if legible.
- **If it's a social media thread (Reddit/Twitter):** Read it out like a script. Explicitly mention who is replying to whom to make the audio clear. (e.g., "User 'Jeroen' asks: [question]. 'TechGuy' replies: [answer].").

Output **only** the text to be spoken.`;
```

Optional article context can be included:
```typescript
const contextualPrompt = `${prompt}

Article context:
- Title: ${articleTitle}
- Author: ${articleAuthor}`;
```

### Batch Processing

Process multiple images in one API call to save costs:

```typescript
async function batchGenerateAltText(
  images: Array<{ url: string }>,
  articleContext: any
): Promise<ImageAnalysisResult[]> {
  
  // Group images into batches of 10
  const batchSize = 10;
  const batches = [];
  for (let i = 0; i < images.length; i += batchSize) {
    batches.push(images.slice(i, i + batchSize));
  }

  const results: ImageAnalysisResult[] = [];

  for (const batch of batches) {
    const batchResults = await generateAltText(
      batch.map(img => img.url),
      articleContext
    );
    results.push(...batchResults);
  }

  return results;
}
```

### Cost Estimation

```typescript
function estimateCost(imageCount: number): number {
  // Gemini 3 Flash pricing: $0.50 per 1M input tokens
  const tokensPerImage = 1120; // High resolution
  const tokensPerRequest = 500; // Prompt + article context
  const totalTokens = (imageCount * tokensPerImage) + tokensPerRequest;
  
  const inputCost = (totalTokens / 1_000_000) * 0.50;
  
  // Output tokens (alt-text descriptions): ~100 tokens per image
  const outputTokens = imageCount * 100;
  const outputCost = (outputTokens / 1_000_000) * 3.00; // $3.00 per 1M output
  
  return inputCost + outputCost;
}

// Example: 5 images = ~$0.003 total
```

### Error Handling & Retry Logic

```typescript
import { PROCESSING_CONFIG } from '../config/processing';

async function generateAltTextWithRetry(
  imageUrls: string[],
  articleContext: any,
  attempt: number = 1
): Promise<ImageAnalysisResult[]> {
  
  try {
    return await generateAltText(imageUrls, articleContext);
  } catch (error) {
    if (attempt >= PROCESSING_CONFIG.retry.maxAttempts) {
      console.error('Alt-text generation failed after max retries:', error);
      throw error;
    }

    // Exponential backoff
    const delay = Math.min(
      PROCESSING_CONFIG.retry.baseDelayMs * Math.pow(2, attempt - 1),
      PROCESSING_CONFIG.retry.maxDelayMs
    );

    console.log(`Retry attempt ${attempt} after ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));

    return generateAltTextWithRetry(imageUrls, articleContext, attempt + 1);
  }
}
```

---

## User Control & Settings

### Single Global Toggle

**Implementation:**
- `image_alt_text_enabled`: Boolean setting (default: `true`)
- Checked during TTS generation in `generateAudioForContent()`
- If true: generates alt-text, enriches HTML, saves to DB
- If false: skips image processing entirely

**Regeneration:**
- User clicks "Regenerate Audio" in context menu
- Triggers full TTS flow, which includes alt-text generation if enabled
- No separate UI controls needed

### Settings Backend

```typescript
// backend/src/routes/users.ts
router.patch('/settings', requireAuth, async (req, res) => {
  const { key, value } = req.body;
  
  const allowedKeys = [
    'image_alt_text_enabled',
    // ... other settings
  ];

  if (!allowedKeys.includes(key)) {
    return res.status(400).json({ error: 'Invalid setting key' });
  }

  await db.updateUserSetting(req.user.id, key, value);
  res.json({ success: true });
});
```

---

## Future-Proofing for JSON & Multiple Voices

### Current: Simple Alt-Text

Store alt-text directly in HTML:

```html
<img src="example.jpg" alt="A bar chart showing revenue growth from 2020 to 2025" />
```

### Future: Structured JSON

When upgrading to multiple TTS voices (e.g., different speakers for comments), store structured data:

```json
{
  "images": [
    {
      "url": "https://example.com/reddit-thread.jpg",
      "description": "Reddit discussion thread about AI safety",
      "type": "screenshot",
      "speakers": [
        {
          "name": "u/alice",
          "text": "I think alignment is the key challenge",
          "upvotes": 42
        },
        {
          "name": "u/bob",
          "text": "But what about interpretability?",
          "upvotes": 15
        }
      ]
    }
  ]
}
```

### Migration Path

**Phase 1 (Current):** Store alt-text in HTML `alt` attribute  
**Phase 2 (Later):** Extract alt-text to `image_alt_text_metadata` JSONB column  
**Phase 3 (Advanced):** Parse complex images (Reddit threads) into speaker-based JSON

### API Design for Future JSON

```typescript
// Future: Extended prompt for structured output
const futurePrompt = `For this Reddit thread screenshot, extract:
{
  "post_title": "...",
  "comments": [
    {
      "author": "u/username",
      "text": "comment text",
      "upvotes": 42,
      "is_reply_to": null
    },
    {
      "author": "u/other",
      "text": "reply text",
      "upvotes": 8,
      "is_reply_to": "u/username"
    }
  ]
}`;

// This structured data can later feed into multi-voice TTS
```

For now, keep it simple. The current HTML-based approach works for single-voice TTS, and the database schema supports future extensions.

---

## Implementation Verification

### What about images in EA Forum/LessWrong comments?

**Not currently handled (by design).** Comments are stored in JSONB, formatted to plain text via `formatCommentsForNarration()`, then appended to the script. They don't go through `scriptArticleForListening()` or HTML processing.

Handling comment images would require separate logic to parse JSONB comments, extract image URLs, generate descriptions, and inject them into the narration text. Given that images in comments are rare, this is deferred to future work.

### Will Gemini descriptions replace existing alt-text?

**Yes (90% confidence).** `applyDescriptionsToHtml()` calls `img.setAttribute('alt', geminiDescription)` which replaces any existing alt attribute. This happens in memory during TTS only, never saved to `html_content`.

When enrichment is disabled, we skip `applyDescriptionsToHtml()` entirely, so original alt-text stays in the HTML and gets narrated normally.

### Will image descriptions play at the right moment?

**Yes (95% confidence).** The `scriptArticleForListening()` prompt already says: "Locate the 'alt' text or context for <img> tags. Insert a narrative description such as: 'An image displays [alt text].'"

GPT-4o-mini reads whatever alt-text is in the HTML (whether original or Gemini-generated) and narrates it at the image's position. Flow:
1. Extract HTML from DB
2. Apply Gemini descriptions in memory (if enabled)
3. Pass enriched HTML to scriptArticleForListening()
4. GPT-4o-mini narrates images with alt-text at their positions

Fallback (`htmlToNarrationText()`): If scriptwriter fails, extracts alt-text and includes it in narration.

### Will there be double announcements?

**No (90% confidence).** The scriptwriter only sees HTML once, either with Gemini alt-text applied or without. It can't announce images twice because it only processes the HTML one time. No marker system needed.

With enrichment ON: sees Gemini alt-text, narrates it.  
With enrichment OFF: sees original alt-text (or no alt), narrates that.

### Will refetch wipe descriptions?

**No, smart regeneration handles it (85% confidence).** When you refetch and regenerate audio:
1. `smartRegenerate()` extracts current image URLs from new HTML
2. Keeps descriptions for images still in article
3. Removes descriptions for deleted images
4. Only calls Gemini for NEW images
5. Merges kept + new descriptions, saves to JSONB

Cost-efficient and handles content changes properly.

### Will it work if images are disabled or missing?

**Yes (95% confidence).** Three scenarios:
1. **Setting disabled:** Skips `applyDescriptionsToHtml()`. Original HTML goes to scriptwriter with whatever alt-text exists.
2. **No images in article:** Returns empty result, narration proceeds normally.
3. **Image processing fails:** Try-catch prevents blocking. TTS continues with original HTML.

### Will progress bar show all steps?

**Yes.** Updated progression:
- 0-10%: Image processing (`current_operation: 'processing_images'`)
- 10-20%: Scripting content (`current_operation: 'scripting_content'`)
- 20-90%: Audio chunk generation (`current_operation: 'audio_chunk_X_of_Y'`)
- 90-95%: Finalizing (`current_operation: 'finalizing_audio'`)
- 95-100%: Transcription (`current_operation: 'transcribing'`)

LibraryTab displays descriptive text for each step (already updated in plan).

---

## Testing Strategy

### Unit Tests

**Test file:** `backend/src/services/image-alt-text.test.ts`

```typescript
describe('ImageAltTextService', () => {
  test('extracts image URLs from HTML', () => {
    const html = '<img src="test.jpg" /><img src="icon.png" />';
    const urls = service.extractImageUrls(html);
    expect(urls).toHaveLength(2);
  });

  test('filters decorative images by size', () => {
    const images = [
      { url: 'icon.png', width: 20, height: 20 },
      { url: 'photo.jpg', width: 800, height: 600 },
    ];
    const filtered = service.filterDecorativeImages(images, '');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toBe('photo.jpg');
  });

  test('enriches HTML with alt-text', () => {
    const html = '<img src="test.jpg" />';
    const analyses = [{ 
      url: 'test.jpg', 
      description: 'A test image', 
      isDecorative: false 
    }];
    const enriched = service.enrichHtmlWithDescriptions(html, analyses);
    expect(enriched).toContain('alt="A test image"');
  });
});
```

### Integration Tests

**Test file:** `backend/src/services/image-alt-text.integration.test.ts`

```typescript
describe('Gemini API Integration', () => {
  test('generates alt-text for real image URL', async () => {
    const imageUrl = 'https://example.com/sample-chart.jpg';
    const result = await service.analyzeImages([imageUrl], {
      title: 'Test Article',
      url: 'https://example.com/article',
      excerpt: 'A test article about charts',
    });
    
    expect(result).toHaveLength(1);
    expect(result[0].description).toBeTruthy();
    expect(result[0].isDecorative).toBe(false);
  });

  test('handles API errors gracefully', async () => {
    // Test with invalid API key or rate limit
  });
});
```

### Manual Testing Checklist

1. **Basic flow:**
   - [ ] Add new article with images
   - [ ] Verify images are processed
   - [ ] Check alt-text in HTML
   - [ ] Listen to TTS narration

2. **Edge cases:**
   - [ ] Article with 0 images
   - [ ] Article with 100+ images
   - [ ] Article with only decorative images
   - [ ] Large screenshots (Reddit threads)
   - [ ] Invalid image URLs (404s)

3. **User controls:**
   - [ ] Disable alt-text generation globally
   - [ ] Enable "ask" mode
   - [ ] Manually regenerate for existing article

4. **Performance:**
   - [ ] Measure API latency for 5, 10, 20 images
   - [ ] Verify batch processing works
   - [ ] Check cost estimation accuracy

---

## Deployment Checklist

### Environment Variables

Add to `.env` or Railway/deployment config:

```bash
GEMINI_API_KEY=your_api_key_here
```

Get API key from: https://aistudio.google.com/app/apikey

### Database Migrations

Run migration to add new columns:

```bash
# Create migration file
npm run db:migrate:create add_image_alt_text_columns

# Apply migration
npm run db:migrate
```

### Cost Monitoring

Set up usage alerts in Google Cloud Console:
- Alert if Gemini API cost > $10/day
- Monitor token usage

### Rate Limits

Gemini 3 Flash free tier limits:
- 250 TPM (tokens per minute)
- 100-250 RPD (requests per day)

For production, upgrade to Tier 1 (requires billing):
- 1,000 RPD
- 1M TPM

### Rollback Plan

If issues arise:
1. Set `image_alt_text_enabled` to `false` for all users
2. Disable alt-text generation in `article-fetcher.ts`
3. Investigate errors in logs
4. Fix issues, re-enable gradually

---

## Cost Analysis

### Per-Article Breakdown

Assumptions:
- Average article: 5 images
- 3 informative, 2 decorative (filtered out)
- High resolution: 1120 tokens per image

**Input cost:**
- 3 images × 1120 tokens = 3,360 tokens
- Prompt overhead: ~500 tokens
- Total input: 3,860 tokens
- Cost: (3,860 / 1,000,000) × $0.50 = **$0.00193**

**Output cost:**
- 3 descriptions × 100 tokens = 300 tokens
- Cost: (300 / 1,000,000) × $3.00 = **$0.0009**

**Total per article: ~$0.003** (less than a third of a cent)

### Monthly Projections

| Usage Level | Articles/Month | Cost/Month |
|-------------|----------------|------------|
| Light user  | 50             | $0.15      |
| Regular user| 200            | $0.60      |
| Power user  | 1,000          | $3.00      |

### Comparison to TTS Costs

OpenAI TTS pricing: ~$15 per 1M characters  
Average article: 5,000 characters = $0.075 per article

**Image alt-text is ~4% of TTS cost** (negligible addition)

---

## Known Limitations & Mitigations

### Limitation 1: Gemini may misinterpret images
**Mitigation:** Use low temperature (0.3), provide article context, allow manual regeneration

### Limitation 2: Some decorative images may slip through
**Mitigation:** Conservative heuristic filtering, Gemini classification as backup

### Limitation 3: API rate limits for free tier
**Mitigation:** Batch processing, exponential backoff, upgrade to paid tier if needed

### Limitation 4: Large Reddit threads may exceed token limits
**Mitigation:** Split very large images into sections, or fall back to simpler description

### Limitation 5: Cost accumulates with heavy usage
**Mitigation:** User setting to disable, cost transparency in UI, efficient filtering

---

## FAQ for Claude Code

**Q: Where does this fit in the codebase?**  
A: New service file (`image-alt-text.ts`), modified `openai-tts.ts` (inside `generateAudioForContent()`), settings UI toggle in `SettingsPage.tsx`.

**Q: What if Gemini API key is missing?**  
A: Skip alt-text generation silently, log warning. TTS generation continues normally without image descriptions.

**Q: How do I test without using real API calls?**  
A: Mock the Gemini client in tests, use fixture responses. For manual testing, use free tier (250 RPD).

**Q: Should I process images during TTS generation or article fetch?**  
A: **TTS generation.** Runs only when user wants audio, respects user choice, ties cost to explicit AI usage. Enriched HTML saved back to DB for future use.

**Q: What if an image URL is broken (404)?**  
A: Gemini returns an error in `url_context_metadata`. Catch this, log it, skip that image, continue with others.

**Q: How do I handle articles with 100+ images?**  
A: Apply aggressive filtering (only large images >200px), batch process up to 50 images max, fall back to "contains N images" message for rest.

**Q: Should alt-text sync to Wallabag?**  
A: Yes. The enriched HTML with alt attributes syncs normally through existing Wallabag sync.

**Q: What about images in comments (EA Forum, Reddit)?**  
A: The `comments` field is separate JSONB. For now, only process images in main `html_content`. Future work: extend to comment images.

---

## Success Metrics

Track these to measure feature adoption and quality:

1. **Usage:** % of articles with `images_processed = true`
2. **Cost:** Total monthly spend on Gemini API
3. **Quality:** User feedback (thumbs up/down on generated alt-text)
4. **Performance:** P95 latency for alt-text generation
5. **Errors:** Rate of API failures, image fetch failures

Add telemetry in `image-alt-text.ts`:

```typescript
// Log to analytics/monitoring service
analytics.track('image_alt_text_generated', {
  article_id: articleId,
  image_count: totalImages,
  decorative_count: decorativeImages,
  cost_usd: costUsd,
  latency_ms: latencyMs,
});
```

---

## Next Steps for Claude Code

1. **Read this document thoroughly**
2. **Set up Gemini API:**
   - Get API key from Google AI Studio (https://aistudio.google.com/app/apikey)
   - Add `GEMINI_API_KEY` to environment variables
   - Test basic API call
3. **Database migration:**
   - Add `images_processed` BOOLEAN and `image_alt_text_metadata` JSONB columns
   - Add user setting `image_alt_text_enabled` (default: true)
4. **Implement core service:**
   - Create `image-alt-text.ts` with URL extraction, filtering, API calls, HTML enrichment
   - Write unit tests
5. **Integrate with TTS generation:**
   - Modify `openai-tts.ts` `generateAudioForContent()` function
   - Check user setting before generating audio
   - Call image service if enabled and not already processed
   - Save enriched HTML back to DB
6. **Add settings UI:**
   - Simple toggle in SettingsPage.tsx (under Audio/TTS section)
   - Description: "Generate image descriptions for audio (~$0.003 per article)"
7. **Test thoroughly:**
   - Unit tests for image service
   - Integration test: article with images → generate audio → verify alt-text in HTML
   - Manual test: various article types (news, Reddit, EA Forum, Substack)
8. **Deploy incrementally:**
   - Start with free tier, monitor usage
   - Upgrade to paid tier if needed (after 250 RPD)
9. **Monitor and iterate:**
   - Track usage metrics (% articles processed, cost, errors)
   - Collect user feedback
   - Refine filtering heuristics based on real data

---

**Document Version:** 1.0  
**Last Updated:** February 2026  
**Author:** Claude (Sonnet 4.5) for Jeroen's Wallacast project
