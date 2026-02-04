import { GoogleGenAI } from '@google/genai';
import { JSDOM } from 'jsdom';
import { getUserSetting } from './ai-providers.js';
import { PROCESSING_CONFIG } from '../config/processing.js';

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
    return new GoogleGenAI({ apiKey });
  }

  /**
   * Main entry: Smart regeneration that only processes new/missing images
   * Never modifies the input HTML - returns JSONB data only
   */
  async smartRegenerate(
    currentHtml: string,
    existingData: ImageAltTextData | null,
    articleUrl: string,
    context?: { articleTitle?: string; articleAuthor?: string }
  ): Promise<ImageAltTextData> {
    console.log('[ImageAltText] Starting smart regeneration...');

    // Extract current images from HTML
    const currentImages = this.extractImageUrls(currentHtml);
    console.log(`[ImageAltText] Found ${currentImages.length} images in HTML`);

    if (currentImages.length === 0) {
      return {
        descriptions: {},
        total_images: 0,
        decorative_images: 0,
        cost_usd: 0,
        model: 'gemini-3-flash-preview',
        processed_at: new Date().toISOString()
      };
    }

    // Get existing descriptions (if any)
    const existingDescriptions: ImageDescriptions = existingData?.descriptions || {};
    const currentImageUrls = new Set(currentImages.map(img => this.normalizeUrl(img.url)));

    // Identify new images that need processing
    const newImages = currentImages.filter(img => {
      const normalized = this.normalizeUrl(img.url);
      return !existingDescriptions[normalized];
    });

    console.log(`[ImageAltText] ${newImages.length} new images need processing`);

    // Filter decorative images before sending to Gemini
    const informativeImages = this.filterDecorativeImages(newImages, currentHtml);
    console.log(`[ImageAltText] ${informativeImages.length} informative images after filtering`);

    let newDescriptions: ImageDescriptions = {};
    let costUsd = 0;

    if (informativeImages.length > 0) {
      // Process each image individually (one API call per image)
      for (let i = 0; i < informativeImages.length; i++) {
        const img = informativeImages[i];
        console.log(`[ImageAltText] Processing image ${i + 1}/${informativeImages.length}: ${img.url}`);

        try {
          const analysis = await this.analyzeImageWithRetry(
            img.url,
            { title: context?.articleTitle || '', url: articleUrl }
          );

          if (!analysis.isDecorative && analysis.description) {
            const normalized = this.normalizeUrl(analysis.url);
            newDescriptions[normalized] = analysis.description;
          }

          // Estimate cost per image
          costUsd += this.estimateCost(1);
        } catch (error) {
          console.error(`[ImageAltText] Failed to process image ${img.url}:`, error);
          // Continue with next image - don't fail entire article
        }
      }
    }

    // Merge: keep old descriptions for images still in HTML, add new ones
    const mergedDescriptions: ImageDescriptions = {};

    // Keep existing descriptions if image still exists
    Object.keys(existingDescriptions).forEach(url => {
      if (currentImageUrls.has(url)) {
        mergedDescriptions[url] = existingDescriptions[url];
      }
    });

    // Add new descriptions
    Object.assign(mergedDescriptions, newDescriptions);

    const decorativeCount = currentImages.length - informativeImages.length;

    return {
      descriptions: mergedDescriptions,
      total_images: currentImages.length,
      decorative_images: decorativeCount,
      cost_usd: (existingData?.cost_usd || 0) + costUsd,
      model: 'gemini-3-flash-preview',
      processed_at: new Date().toISOString()
    };
  }

  /**
   * Apply descriptions to HTML in memory (for TTS processing)
   * This modifies the HTML to add alt attributes with Gemini descriptions
   */
  applyDescriptionsToHtml(html: string, descriptions: ImageDescriptions): string {
    try {
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      const images = Array.from(doc.querySelectorAll('img'));

      images.forEach(img => {
        const src = img.getAttribute('src');
        if (!src) return;

        const normalized = this.normalizeUrl(src);

        // Check if we have a Gemini description for this image
        if (descriptions[normalized]) {
          // REPLACE existing alt attribute with Gemini's description
          img.setAttribute('alt', descriptions[normalized]);
        }
      });

      return doc.body.innerHTML;
    } catch (e) {
      console.error('[ImageAltText] Failed to apply descriptions to HTML:', e);
      return html;
    }
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
  private filterDecorativeImages(images: ImageElement[], html: string): ImageElement[] {
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

    // 2. Filename patterns
    const url = img.url.toLowerCase();
    const decorativePatterns = [
      /icon/i, /logo/i, /avatar/i, /profile/i, /badge/i,
      /button/i, /separator/i, /divider/i, /banner/i,
      /header/i, /footer/i, /share/i, /social/i,
      /spacer/i, /transparent\.png/i, /1x1/i, /pixel/i
    ];
    if (decorativePatterns.some(pattern => pattern.test(url))) return true;

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
    articleContext: { title: string; url: string },
    attempt: number = 1
  ): Promise<ImageAnalysisResult> {
    try {
      return await this.analyzeImage(imageUrl, articleContext);
    } catch (error: any) {
      const isRetryable = error?.status === 503 || error?.message?.includes('503') ||
                          error?.message?.includes('overloaded') ||
                          error?.message?.includes('RESOURCE_EXHAUSTED');

      if (!isRetryable || attempt >= PROCESSING_CONFIG.retry.maxAttempts) {
        console.error(`[ImageAltText] Failed after ${attempt} attempt(s):`, error);
        throw error;
      }

      // Exponential backoff
      const delay = Math.min(
        PROCESSING_CONFIG.retry.baseDelayMs * Math.pow(2, attempt - 1),
        PROCESSING_CONFIG.retry.maxDelayMs
      );

      console.log(`[ImageAltText] Retry attempt ${attempt + 1}/${PROCESSING_CONFIG.retry.maxAttempts} after ${delay}ms (API overloaded)`);
      await new Promise(resolve => setTimeout(resolve, delay));

      return this.analyzeImageWithRetry(imageUrl, articleContext, attempt + 1);
    }
  }

  /**
   * Call Gemini to analyze a single image and generate description
   * Uses Gemini's native urlContext tool to fetch the image automatically
   */
  private async analyzeImage(
    imageUrl: string,
    articleContext: { title: string; url: string }
  ): Promise<ImageAnalysisResult> {
    const ai = await this.getGeminiClient();

    // Simplified prompt for single image
    const prompt = `Describe this image for audio narration of a blog post. Be concise and informative.

Article context:
- Title: ${articleContext.title}
- URL: ${articleContext.url}

Image URL: ${imageUrl}

Guidelines:
- **If it's a photo or visual:** Describe the scene, identifying key subjects, text (if any), and overall mood.
- **If it's a chart/diagram:** Summarize the primary trend or insight. Describe what the visual shows.
- **If it's a social media thread (Reddit/Twitter):** Read it out like a script. Mention who is replying to whom.

Just output the description, nothing else.`;

    try {
      console.log(`[ImageAltText] Sending image URL to Gemini: ${imageUrl}`);

      // Use Gemini's urlContext tool to fetch image automatically
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          tools: [{ urlContext: {} }], // Enable URL fetching
          temperature: 0.3,
          maxOutputTokens: 500, // Single image needs less tokens
        },
      });

      if (!response.candidates || response.candidates.length === 0) {
        throw new Error('No response candidates from Gemini');
      }

      const candidate = response.candidates[0];
      if (!candidate || !candidate.content || !candidate.content.parts) {
        throw new Error('Invalid response structure from Gemini');
      }

      // Entire response text is the description
      const description = candidate.content.parts
        .map((part: any) => part.text)
        .join('')
        .trim();

      console.log(`[ImageAltText] Generated description (${description.length} chars): ${description.substring(0, 100)}...`);

      return {
        url: imageUrl,
        description,
        isDecorative: !description, // No description = decorative
        confidence: description ? 0.95 : 0
      };
    } catch (error) {
      console.error('[ImageAltText] Gemini API call failed:', error);
      throw error;
    }
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
    const tokensPerRequest = 500; // Prompt + article context
    const totalInputTokens = (imageCount * tokensPerImage) + tokensPerRequest;

    const inputCost = (totalInputTokens / 1_000_000) * 0.50;

    // Output tokens (alt-text descriptions): ~100 tokens per image
    const outputTokens = imageCount * 100;
    const outputCost = (outputTokens / 1_000_000) * 3.00;

    return inputCost + outputCost;
  }
}
