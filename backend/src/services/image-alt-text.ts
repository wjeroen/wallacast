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
   * @param forceRegenerate - If true, regenerate ALL images (not just new ones)
   */
  async smartRegenerate(
    currentHtml: string,
    existingData: ImageAltTextData | null,
    articleUrl: string,
    context?: { articleTitle?: string; articleAuthor?: string },
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
        model: 'gemini-3-flash-preview',
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
    const informativeImages = this.filterDecorativeImages(newImages, currentHtml);
    console.log(`[ImageAltText] ${informativeImages.length} informative images after filtering`);

    let newDescriptions: ImageDescriptions = {};
    let costUsd = 0;

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

    return {
      descriptions: mergedDescriptions,
      total_images: currentImages.length,
      decorative_images: decorativeCount,
      cost_usd: forceRegenerate ? costUsd : (existingData?.cost_usd || 0) + costUsd,
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

    // 2. Filename patterns (skip for data: URIs — base64 can randomly match patterns)
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
    articleContext: { title: string; url: string },
    attempt: number = 1
  ): Promise<ImageAnalysisResult> {
    try {
      return await this.analyzeImage(imageUrl);
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
   * Download image and convert to base64 for Gemini.
   * Handles data: URIs directly (from PDF image extraction) without network requests.
   */
  private async downloadImage(imageUrl: string): Promise<{ data: string; mimeType: string } | null> {
    // Handle data: URIs (from PDF extraction) - already base64, no download needed
    if (imageUrl.startsWith('data:')) {
      try {
        const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          console.warn(`[ImageAltText] Invalid data URI format`);
          return null;
        }
        const mimeType = match[1];
        const data = match[2];
        const sizeMB = (data.length * 0.75) / (1024 * 1024); // base64 → bytes estimate
        console.log(`[ImageAltText] ✅ Using inline data URI: ${sizeMB.toFixed(2)}MB, type: ${mimeType}`);
        return { data, mimeType };
      } catch (e) {
        console.warn(`[ImageAltText] Failed to parse data URI:`, e);
        return null;
      }
    }

    try {
      console.log(`[ImageAltText] Downloading image: ${imageUrl}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch(imageUrl, {
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
        console.warn(`[ImageAltText] Failed to download ${imageUrl}: ${response.status} ${response.statusText}`);
        return null;
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Check file size (max 100MB for Gemini as of Jan 2026)
      const sizeMB = buffer.length / (1024 * 1024);
      if (sizeMB > 100) {
        console.warn(`[ImageAltText] Image too large: ${sizeMB.toFixed(2)}MB (max 100MB)`);
        return null;
      }

      const base64 = buffer.toString('base64');
      console.log(`[ImageAltText] ✅ Downloaded ${sizeMB.toFixed(2)}MB, type: ${contentType}`);

      return {
        data: base64,
        mimeType: contentType
      };

    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn(`[ImageAltText] Download timeout for ${imageUrl}`);
      } else {
        console.warn(`[ImageAltText] Download failed for ${imageUrl}:`, error.message);
      }
      return null;
    }
  }

  /**
   * Call Gemini to analyze a single image and generate description
   * Downloads the image ourselves and sends inline data (no urlContext)
   */
  private async analyzeImage(
  imageUrl: string
): Promise<ImageAnalysisResult> {
  const ai = await this.getGeminiClient();

  // Download the image ourselves
  const imageData = await this.downloadImage(imageUrl);

  if (!imageData) {
    console.warn(`[ImageAltText] ❌ Could not download image: ${imageUrl}`);
    return {
      url: imageUrl,
      description: "",
      isDecorative: true,
      confidence: 0
    };
  }

  const prompt = `Describe this image for audio narration of a blog post. Be concise and informative.

Guidelines:
- **If it's a photo or visual:** Describe the scene, identifying key subjects, and overall mood.
- **If it's a chart/diagram:** Summarize the primary trend or insight.
- **If it's a social media thread:** Read it out like a script. Never summarize blocks of text that are displayed on an image, always read sentences exactly as they are written, VERBATIM.

Important Constraints:
- Just output the description, nothing else.
- **DO NOT GUESS** the content based on context or filenames.`;

  try {
    console.log(`[ImageAltText] Sending ${(imageData.data.length / 1024).toFixed(1)}KB image to Gemini`);

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: imageData.mimeType,
                data: imageData.data
              }
            }
          ]
        }
      ],
      config: {
        temperature: 0.3, // Lower temperature reduces creativity/hallucinations
        maxOutputTokens: 16384,
        thinkingConfig: {
          includeThoughts: false
        }
      },
    });

    // Validate response
    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error('No response candidates from Gemini');
    }

    const description = candidate.content.parts
      .map((part: any) => part.text)
      .join('')
      .trim();

    // Check for model-reported failure
    if (description.includes("FAILED") || !description || description.length < 10) {
       console.warn(`[ImageAltText] Invalid or empty description for: ${imageUrl}`);
       return {
         url: imageUrl,
         description: "",
         isDecorative: true,
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
