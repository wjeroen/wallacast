import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { JSDOM } from 'jsdom';
import { getUserSetting } from './ai-providers.js';
import { resolveCustomPrompt } from './prompt-resolver.js';
import { PROCESSING_CONFIG } from '../config/processing.js';
import { safeFetch } from './url-guard.js';

// Default prompt for generating audio-friendly image descriptions. User-editable via Settings
// (registered in prompt-registry.ts as `prompt_image_description`). Same prompt for Gemini + OpenRouter.
export const IMAGE_DESCRIPTION_DEFAULT = `Describe this image for audio narration of a blog post. Be concise and informative.

Guidelines:
- **If it's a photo or visual:** Describe the scene, identifying key subjects, and overall mood.
- **If it's a chart/diagram:** Summarize the primary trend or insight.
- **If it's a social media thread:** Read it out like a script. Never summarize blocks of text that are displayed on an image, always read sentences exactly as they are written, VERBATIM.

Important Constraints:
- Just output the description, nothing else.
- **DO NOT GUESS** the content based on context or filenames.`;

interface ImageDescriptions {
  [url: string]: string;
}

interface ImageAltTextData {
  descriptions: ImageDescriptions;
  total_images: number;
  decorative_images: number;
  /**
   * Images that were sent for description and came back WITHOUT one: the download failed,
   * or the model answered with nothing usable. These are NOT decorative. They used to be
   * reported as decorative, which hid the failure completely: the stored data then showed
   * 13 images, 1 decorative and 11 descriptions, and nothing said where the 13th went.
   * An image with no description is dropped from the narration and glued onto the previous
   * read-along element, so a silent failure here is visible to the user as a shared
   * highlight and an image the audio never mentions.
   */
  failed_images?: number;
  failed_image_urls?: string[];
  cost_usd: number;
  model: string;
  processed_at: string;
}

interface ImageElement {
  url: string;
  hasExistingAlt: boolean;
  existingAlt: string;
  width?: number;
  height?: number;
  classes?: string[];
}

interface ImageAnalysisResult {
  url: string;
  description: string;
  isDecorative: boolean;
  confidence: number;
  /** True when there is no description because something went wrong, not because the
   *  image carries no meaning. Kept apart from isDecorative so failures stay countable. */
  failed?: boolean;
}

/**
 * The image bytes could not be obtained.
 *
 * `permanent` means a retry can never succeed: the server states the image is gone or the
 * request itself is invalid. Those fail immediately instead of walking the whole backoff
 * ladder, which used to waste about 15 seconds per dead image. Everything else (timeouts,
 * network errors, rate limits, server errors) stays retryable, because a single failed
 * download among a dozen is usually a CDN hiccup.
 */
class ImageDownloadError extends Error {
  readonly permanent: boolean;
  readonly status?: number;

  constructor(message: string, permanent: boolean, status?: number) {
    super(`IMAGE_DOWNLOAD_FAILED: ${message}`);
    this.name = 'ImageDownloadError';
    this.permanent = permanent;
    this.status = status;
  }
}

/**
 * HTTP statuses where the image will not appear on a retry. 403 is deliberately absent:
 * bot protection returns it and often lets the same request through moments later.
 */
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 404, 410, 414, 415, 451]);

/**
 * Why an error is worth another attempt, or null when it is not. The returned string goes
 * straight into the retry log line, so the log names the real cause instead of always
 * claiming the API was overloaded.
 */
function retryReason(error: any): string | null {
  if (error instanceof ImageDownloadError) {
    return error.permanent ? null : 'image download failed';
  }
  const message = String(error?.message || '');
  if (error?.status === 503 || message.includes('503') || message.includes('overloaded')) {
    return 'API overloaded';
  }
  if (error?.status === 429 || message.includes('RESOURCE_EXHAUSTED') || message.includes('429')) {
    return 'API rate limit';
  }
  return null;
}

export class ImageAltTextService {
  private userId: number;
  private cachedModel: string | null = null;

  constructor(userId: number) {
    this.userId = userId;
  }

  // Model for image descriptions (Settings → free-text). The effective default depends on
  // the provider: the long-tested gemini-3-flash-preview on Gemini, its namespaced twin on
  // OpenRouter, and Gemma 4 26B A4B on DeepInfra (Gemini's open sibling, matched Gemini
  // Flash quality in live tests 2026-07-02).
  private async getModelName(defaultModel = 'gemini-3-flash-preview'): Promise<string> {
    if (this.cachedModel === null) {
      this.cachedModel = (await getUserSetting(this.userId, 'image_alt_text_model')) || defaultModel;
    }
    return this.cachedModel;
  }

  // Key-aware provider default: the first provider whose key is configured. Gemini keeps
  // precedence as the long-tested path.
  private async defaultImageProvider(): Promise<string> {
    if (await getUserSetting(this.userId, 'gemini_api_key')) return 'gemini';
    if (await getUserSetting(this.userId, 'deepinfra_api_key')) return 'deepinfra';
    if (await getUserSetting(this.userId, 'openai_api_key')) return 'openai';
    if (await getUserSetting(this.userId, 'openrouter_api_key')) return 'openrouter';
    return 'gemini';
  }

  /**
   * Get Gemini client using user's API key
   */
  private async getGeminiClient(): Promise<GoogleGenAI> {
    const apiKey = await getUserSetting(this.userId, 'gemini_api_key');
    if (!apiKey) {
      throw new Error('No Gemini API key configured. Please add your key in Settings.');
    }
    return new GoogleGenAI({ apiKey });
  }

  /**
   * Main entry: Smart regeneration that only processes new/missing images
   * Never modifies the input HTML - returns JSONB data only
   * @param forceRegenerate - If true, regenerate ALL images (not just new ones)
   */
  async smartRegenerate(
    currentHtml: string,
    existingData: ImageAltTextData | null,
    onProgress?: (current: number, total: number) => Promise<void>,
    forceRegenerate: boolean = false
  ): Promise<ImageAltTextData> {
    console.log(`[ImageAltText] Starting ${forceRegenerate ? 'FULL' : 'smart'} regeneration...`);

    // Extract current images from HTML
    const currentImages = this.extractImageUrls(currentHtml);
    console.log(`[ImageAltText] Found ${currentImages.length} images in HTML`);

    if (currentImages.length === 0) {
      return {
        descriptions: {},
        total_images: 0,
        decorative_images: 0,
        cost_usd: 0,
        model: await this.getModelName(),
        processed_at: new Date().toISOString()
      };
    }

    // Get existing descriptions (if any)
    const existingDescriptions: ImageDescriptions = existingData?.descriptions || {};
    const currentImageUrls = new Set(currentImages.map(img => this.normalizeUrl(img.url)));

    // Identify new images that need processing
    let newImages: ImageElement[];
    if (forceRegenerate) {
      // Regenerate ALL images when explicitly requested (e.g., audio regeneration)
      newImages = currentImages;
      console.log(`[ImageAltText] Force regenerate enabled - processing all ${newImages.length} images`);
    } else {
      // Smart mode: only process images without existing descriptions
      newImages = currentImages.filter(img => {
        const normalized = this.normalizeUrl(img.url);
        return !existingDescriptions[normalized];
      });
      console.log(`[ImageAltText] ${newImages.length} new images need processing`);
    }

    // Filter decorative images before sending to Gemini
    const informativeImages = this.filterDecorativeImages(newImages);
    console.log(`[ImageAltText] ${informativeImages.length} informative images after filtering`);

    let newDescriptions: ImageDescriptions = {};
    let costUsd = 0;
    // Images that were SENT for a description and came back without one. Tracked apart
    // from the decorative count so the failure cannot hide inside it. The reasons are for
    // the log only, so a dead image reads differently from a flaky CDN.
    const failedUrls: string[] = [];
    const failureReasons = new Map<string, string>();

    if (informativeImages.length > 0) {
      // Process each image individually (one API call per image)
      for (let i = 0; i < informativeImages.length; i++) {
        const img = informativeImages[i];
        console.log(`[ImageAltText] Processing image ${i + 1}/${informativeImages.length}: ${img.url}`);

        // Trigger the progress callback
        if (onProgress) {
          console.log(`[ImageAltText] Calling onProgress callback for image ${i + 1}/${informativeImages.length}`);
          await onProgress(i + 1, informativeImages.length);
          console.log(`[ImageAltText] onProgress callback completed`);
        } else {
          console.log(`[ImageAltText] WARNING: No onProgress callback provided!`);
        }

        try {
          const analysis = await this.analyzeImageWithRetry(img.url);

          if (!analysis.isDecorative && analysis.description) {
            const normalized = this.normalizeUrl(analysis.url);
            newDescriptions[normalized] = analysis.description;
          } else if (analysis.failed) {
            failedUrls.push(img.url);
            failureReasons.set(img.url, 'the model returned no usable description');
          }

          // Estimate cost per image
          costUsd += this.estimateCost(1);
        } catch (error: any) {
          console.error(`[ImageAltText] Failed to process image ${img.url}:`, error);
          failedUrls.push(img.url);
          failureReasons.set(
            img.url,
            error instanceof ImageDownloadError
              ? `download ${error.permanent ? 'permanently failed' : 'failed'}${error.status ? ` (HTTP ${error.status})` : ''}`
              : String(error?.message || error)
          );
          // Continue with next image - don't fail entire article
        }
      }
    }

    // Merge: keep old descriptions for images still in HTML, add new ones
    const mergedDescriptions: ImageDescriptions = {};

    if (forceRegenerate) {
      // Force regenerate: only use new descriptions, ignore existing ones
      Object.assign(mergedDescriptions, newDescriptions);
      console.log(`[ImageAltText] Force regenerate: replaced all descriptions`);
    } else {
      // Smart mode: keep existing descriptions if image still exists
      Object.keys(existingDescriptions).forEach(url => {
        if (currentImageUrls.has(url)) {
          mergedDescriptions[url] = existingDescriptions[url];
        }
      });

      // Add new descriptions
      Object.assign(mergedDescriptions, newDescriptions);
    }

    const decorativeCount = currentImages.length - informativeImages.length;

    if (failedUrls.length > 0) {
      // Loud on purpose. An image with no description is dropped from the narration and
      // merged into the previous read-along element, so the listener hears nothing where
      // the image is and the highlight covers two blocks at once.
      console.error(
        `[ImageAltText] ❌ ${failedUrls.length} of ${informativeImages.length} image(s) got NO description. ` +
        `They will be SILENT in the audio and will share the previous element's highlight:\n  ` +
        failedUrls.map(u => `${u}\n    reason: ${failureReasons.get(u) || 'unknown'}`).join('\n  ')
      );
    }
    console.log(
      `[ImageAltText] Summary: ${currentImages.length} image(s) total, ` +
      `${decorativeCount} decorative, ${Object.keys(newDescriptions).length} described, ${failedUrls.length} failed`
    );

    return {
      descriptions: mergedDescriptions,
      total_images: currentImages.length,
      decorative_images: decorativeCount,
      failed_images: failedUrls.length,
      failed_image_urls: failedUrls,
      cost_usd: forceRegenerate ? costUsd : (existingData?.cost_usd || 0) + costUsd,
      model: await this.getModelName(),
      processed_at: new Date().toISOString()
    };
  }

  /**
   * Extract all image URLs from HTML
   */
  private extractImageUrls(html: string): ImageElement[] {
    try {
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      const images = Array.from(doc.querySelectorAll('img'));

      return images.map(img => {
        const src = img.getAttribute('src') || '';
        const alt = img.getAttribute('alt') || '';
        const width = parseInt(img.getAttribute('width') || '0');
        const height = parseInt(img.getAttribute('height') || '0');
        const classes = (img.getAttribute('class') || '').split(/\s+/);

        return {
          url: src,
          hasExistingAlt: !!alt,
          existingAlt: alt,
          width: width || undefined,
          height: height || undefined,
          classes: classes.filter(c => c.length > 0)
        };
      });
    } catch (e) {
      console.error('[ImageAltText] Failed to extract image URLs:', e);
      return [];
    }
  }

  /**
   * Filter out decorative images using heuristics
   */
  private filterDecorativeImages(images: ImageElement[]): ImageElement[] {
    return images.filter(img => !this.isLikelyDecorativeImage(img));
  }

  /**
   * Check if image is likely decorative (to skip processing)
   */
  private isLikelyDecorativeImage(img: ImageElement): boolean {
    // 1. Size heuristics
    if (img.width && img.height) {
      if (img.width < 50 || img.height < 50) return true;
      if (img.width < 100 && img.height < 100) return true;
    }

    // 2. Filename patterns (skip for data: URIs, base64 can randomly match patterns)
    const url = img.url.toLowerCase();
    if (!url.startsWith('data:')) {
      const decorativePatterns = [
        /icon/i, /logo/i, /avatar/i, /profile/i, /badge/i,
        /button/i, /separator/i, /divider/i, /banner/i,
        /header/i, /footer/i, /share/i, /social/i,
        /spacer/i, /transparent\.png/i, /1x1/i, /pixel/i
      ];
      if (decorativePatterns.some(pattern => pattern.test(url))) return true;
    }

    // 3. CSS classes
    const decorativeClasses = [
      'icon', 'logo', 'avatar', 'badge', 'social-share',
      'decorative', 'ornament', 'separator'
    ];
    if (img.classes?.some(cls => decorativeClasses.includes(cls))) return true;

    // 4. Alt attribute analysis
    if (img.hasExistingAlt && img.existingAlt === '') return true; // Empty alt = explicitly decorative
    if (img.hasExistingAlt && img.existingAlt.length < 5) return true; // "icon", "logo", etc.

    return false; // Likely informative
  }

  /**
   * Analyze single image with exponential backoff retry logic
   */
  private async analyzeImageWithRetry(
    imageUrl: string,
    attempt: number = 1
  ): Promise<ImageAnalysisResult> {
    try {
      return await this.analyzeImage(imageUrl);
    } catch (error: any) {
      // A permanently missing image fails on the first attempt. Walking the backoff ladder
      // for a 404 only delays the run and tells the log nothing new.
      if (error instanceof ImageDownloadError && error.permanent) {
        console.error(
          `[ImageAltText] Permanent failure${error.status ? ` (HTTP ${error.status})` : ''}, not retrying: ${imageUrl}`
        );
        throw error;
      }

      const reason = retryReason(error);

      if (!reason || attempt >= PROCESSING_CONFIG.retry.maxAttempts) {
        console.error(`[ImageAltText] Failed after ${attempt} attempt(s):`, error);
        throw error;
      }

      // Exponential backoff
      const delay = Math.min(
        PROCESSING_CONFIG.retry.baseDelayMs * Math.pow(2, attempt - 1),
        PROCESSING_CONFIG.retry.maxDelayMs
      );

      console.log(`[ImageAltText] Retry attempt ${attempt + 1}/${PROCESSING_CONFIG.retry.maxAttempts} after ${delay}ms (${reason})`);
      await new Promise(resolve => setTimeout(resolve, delay));

      return this.analyzeImageWithRetry(imageUrl, attempt + 1);
    }
  }

  /**
   * Download image and convert to base64 for Gemini.
   * Handles data: URIs directly (from PDF image extraction) without network requests.
   *
   * Throws ImageDownloadError on every failure, carrying whether a retry could ever help.
   */
  private async downloadImage(imageUrl: string): Promise<{ data: string; mimeType: string }> {
    // Handle data: URIs (from PDF extraction) - already base64, no download needed
    if (imageUrl.startsWith('data:')) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        // The URI is part of the stored HTML. It will look exactly the same next time.
        throw new ImageDownloadError('invalid data URI format', true);
      }
      const mimeType = match[1];
      const data = match[2];
      const sizeMB = (data.length * 0.75) / (1024 * 1024); // base64 → bytes estimate
      console.log(`[ImageAltText] ✅ Using inline data URI: ${sizeMB.toFixed(2)}MB, type: ${mimeType}`);
      return { data, mimeType };
    }

    try {
      console.log(`[ImageAltText] Downloading image: ${imageUrl}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await safeFetch(imageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': new URL(imageUrl).origin,
        }
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const permanent = PERMANENT_HTTP_STATUSES.has(response.status);
        console.warn(
          `[ImageAltText] Failed to download ${imageUrl}: ${response.status} ${response.statusText}` +
          ` (${permanent ? 'permanent, no retry' : 'retryable'})`
        );
        throw new ImageDownloadError(
          `HTTP ${response.status} ${response.statusText} for ${imageUrl}`,
          permanent,
          response.status
        );
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Check file size (max 100MB for Gemini as of Jan 2026)
      const sizeMB = buffer.length / (1024 * 1024);
      if (sizeMB > 100) {
        // The file will be the same size on every retry.
        throw new ImageDownloadError(`image too large: ${sizeMB.toFixed(2)}MB (max 100MB)`, true);
      }

      const base64 = buffer.toString('base64');
      console.log(`[ImageAltText] ✅ Downloaded ${sizeMB.toFixed(2)}MB, type: ${contentType}`);

      return {
        data: base64,
        mimeType: contentType
      };

    } catch (error: any) {
      // Already classified above, keep the verdict instead of downgrading it to "transient".
      if (error instanceof ImageDownloadError) throw error;

      if (error.name === 'AbortError') {
        console.warn(`[ImageAltText] Download timeout for ${imageUrl}`);
        throw new ImageDownloadError(`timeout for ${imageUrl}`, false);
      }
      // A blocked URL is a rule of ours, not a server hiccup, so retrying is pointless.
      const blocked = String(error?.message || '').startsWith('Blocked URL:');
      console.warn(`[ImageAltText] Download failed for ${imageUrl}:`, error.message);
      throw new ImageDownloadError(`${error.message} for ${imageUrl}`, blocked);
    }
  }

  /**
   * Call Gemini to analyze a single image and generate description
   * Downloads the image ourselves and sends inline data (no urlContext)
   */
  private async analyzeImage(
  imageUrl: string
): Promise<ImageAnalysisResult> {
  // Download the image ourselves. This throws ImageDownloadError on failure, which
  // analyzeImageWithRetry retries unless the error is permanent. The old code returned
  // null here, gave up after one try, AND reported the image as decorative.
  const imageData = await this.downloadImage(imageUrl);

  const prompt = await resolveCustomPrompt(this.userId, 'prompt_image_description', IMAGE_DESCRIPTION_DEFAULT);

  try {
    // Provider: 'gemini' (native SDK, default), 'deepinfra' (Gemma 4), 'openai' (GPT-5 Mini),
    // or 'openrouter'. All non-Gemini paths are OpenAI-compatible vision.
    const provider = (await getUserSetting(this.userId, 'image_alt_text_provider')) || (await this.defaultImageProvider());
    console.log(`[ImageAltText] Sending ${(imageData.data.length / 1024).toFixed(1)}KB image to ${provider}`);

    const raw = provider === 'openrouter'
      ? await this.describeViaOpenRouter(prompt, imageData)
      : provider === 'deepinfra'
        ? await this.describeViaDeepInfra(prompt, imageData)
        : provider === 'openai'
          ? await this.describeViaOpenAI(prompt, imageData)
          : await this.describeViaGemini(prompt, imageData);

    const description = (raw || '').trim();

    // Check for model-reported failure
    if (description.includes("FAILED") || !description || description.length < 10) {
       console.warn(`[ImageAltText] ❌ Invalid or empty description for: ${imageUrl}`);
       return {
         url: imageUrl,
         description: "",
         isDecorative: false,
         failed: true,
         confidence: 0
       };
    }

    console.log(`[ImageAltText] ✅ Generated description: ${description.substring(0, 100)}...`);

    return {
      url: imageUrl,
      description,
      isDecorative: !description,
      confidence: 0.95
    };

  } catch (error) {
    console.error('[ImageAltText] Image description API call failed:', error);
    throw error;
  }
}

  // Gemini native-SDK path: inline base64 image data.
  private async describeViaGemini(prompt: string, imageData: { data: string; mimeType: string }): Promise<string> {
    const ai = await this.getGeminiClient();
    const response = await ai.models.generateContent({
      model: await this.getModelName(),
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: imageData.mimeType, data: imageData.data } }
          ]
        }
      ],
      config: {
        temperature: 0.3, // Lower temperature reduces creativity/hallucinations
        maxOutputTokens: 16384,
        thinkingConfig: { includeThoughts: false }
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error('No response candidates from Gemini');
    }
    return candidate.content.parts.map((part: any) => part.text).join('');
  }

  // OpenRouter path: OpenAI-compatible vision via chat.completions with a base64 data URL.
  // Tested with Gemini Flash models (e.g. google/gemini-3-flash-preview). Other vision models may vary.
  private async describeViaOpenRouter(prompt: string, imageData: { data: string; mimeType: string }): Promise<string> {
    const apiKey = await getUserSetting(this.userId, 'openrouter_api_key');
    if (!apiKey) {
      throw new Error('No OpenRouter API key configured. Please add your key in Settings.');
    }
    const client = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });
    const dataUrl = `data:${imageData.mimeType};base64,${imageData.data}`;
    const response = await client.chat.completions.create({
      model: await this.getModelName('google/gemini-3-flash-preview'),
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] as any,
        },
      ],
    });
    return response.choices[0]?.message?.content || '';
  }

  // DeepInfra path: same OpenAI-compatible vision call. Default model is Gemma 4 26B A4B,
  // Gemini's open-weight sibling, which matched Gemini Flash's description quality in live
  // tests (2026-07-02) at roughly 1/20th the cost.
  private async describeViaDeepInfra(prompt: string, imageData: { data: string; mimeType: string }): Promise<string> {
    const apiKey = await getUserSetting(this.userId, 'deepinfra_api_key');
    if (!apiKey) {
      throw new Error('No DeepInfra API key configured. Please add your key in Settings.');
    }
    const client = new OpenAI({ apiKey, baseURL: 'https://api.deepinfra.com/v1/openai' });
    const dataUrl = `data:${imageData.mimeType};base64,${imageData.data}`;
    const response = await client.chat.completions.create({
      model: await this.getModelName('google/gemma-4-26B-A4B-it'),
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] as any,
        },
      ],
    });
    return response.choices[0]?.message?.content || '';
  }

  // OpenAI path: same OpenAI-compatible vision call against api.openai.com. Default model is
  // GPT-5 Mini (vision-capable, verified 2026-07-02). No temperature param: the GPT-5 family
  // rejects non-default temperatures.
  private async describeViaOpenAI(prompt: string, imageData: { data: string; mimeType: string }): Promise<string> {
    const apiKey = await getUserSetting(this.userId, 'openai_api_key');
    if (!apiKey) {
      throw new Error('No OpenAI API key configured. Please add your key in Settings.');
    }
    const client = new OpenAI({ apiKey });
    const dataUrl = `data:${imageData.mimeType};base64,${imageData.data}`;
    const response = await client.chat.completions.create({
      model: await this.getModelName('gpt-5-mini'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] as any,
        },
      ],
    });
    return response.choices[0]?.message?.content || '';
  }

  /**
   * Normalize URL for comparison (remove query params, fragments)
   */
  private normalizeUrl(url: string): string {
    try {
      // Remove query params and fragments
      return url.split('?')[0].split('#')[0];
    } catch (e) {
      return url;
    }
  }

  /**
   * Estimate cost for image processing
   */
  private estimateCost(imageCount: number): number {
    // Gemini 3 Flash pricing:
    // Input: $0.50 per 1M tokens
    // Output: $3.00 per 1M tokens

    const tokensPerImage = 1120; // High resolution
    const tokensPerRequest = 500; // Prompt text (no article context is sent, each image goes alone)
    const totalInputTokens = (imageCount * tokensPerImage) + tokensPerRequest;

    const inputCost = (totalInputTokens / 1_000_000) * 0.50;

    // Output tokens (alt-text descriptions): ~100 tokens per image
    const outputTokens = imageCount * 100;
    const outputCost = (outputTokens / 1_000_000) * 3.00;

    return inputCost + outputCost;
  }
}
