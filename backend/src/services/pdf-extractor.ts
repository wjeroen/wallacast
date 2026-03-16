import { extractText, extractImages, getDocumentProxy } from 'unpdf';
import { GoogleGenAI } from '@google/genai';
import { getUserSetting } from './ai-providers.js';
import sharp from 'sharp';

interface PdfExtractionResult {
  text: string;
  html: string;
  totalPages: number;
  imageCount: number;
}

/**
 * Extract text content from a PDF buffer (basic, text-only).
 * Kept as fallback when Gemini API key is not available.
 */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<{ text: string; totalPages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  const fullText = (text as string[])
    .map(pageText => pageText.trim())
    .filter(pageText => pageText.length > 0)
    .join('\n\n');

  console.log(`[PDF] Extracted ${fullText.length} chars from ${totalPages} pages`);
  return { text: fullText, totalPages };
}

/**
 * Plan 2: "Gemini reads, unpdf illustrates"
 *
 * 1. Send the PDF to Gemini in 10-page chunks → get structured HTML (headings, bold, tables)
 *    with <figure data-page="N" data-index="M"><figcaption>Description</figcaption></figure> placeholders
 * 2. For each placeholder, call unpdf's extractImages() to get the actual image from that page
 * 3. Convert raw pixels → PNG via sharp, replace placeholders with real <img> tags + keep <figcaption>
 *
 * Result: properly structured HTML with real images AND Gemini's descriptions.
 * The existing TTS pipeline (image narration injection → scriptwriter → TTS) works on this HTML.
 */
export async function extractPdfWithGemini(
  pdfBuffer: Buffer,
  userId: number
): Promise<PdfExtractionResult> {
  // Check for Gemini API key
  const geminiApiKey = await getUserSetting(userId, 'gemini_api_key');
  if (!geminiApiKey) {
    console.log('[PDF] No Gemini API key — falling back to text-only extraction');
    const { text, totalPages } = await extractTextFromPdf(pdfBuffer);
    const html = text
      .split(/\n\n+/)
      .filter(para => para.trim().length > 0)
      .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
      .join('\n');
    return { text, html, totalPages, imageCount: 0 };
  }

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const pdfData = new Uint8Array(pdfBuffer);

  // Get total page count from unpdf
  const pdf = await getDocumentProxy(pdfData);
  const totalPages = pdf.numPages;
  console.log(`[PDF] Starting Gemini PDF conversion: ${totalPages} pages`);

  // Step 1: Send PDF to Gemini in 10-page chunks for structured HTML
  const CHUNK_SIZE = 10;
  const htmlChunks: string[] = [];

  for (let chunkStart = 1; chunkStart <= totalPages; chunkStart += CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, totalPages);
    console.log(`[PDF] Gemini processing pages ${chunkStart}-${chunkEnd}...`);

    const prompt = buildGeminiPrompt(chunkStart, chunkEnd, totalPages);

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: Buffer.from(pdfBuffer).toString('base64')
                }
              },
              { text: prompt }
            ]
          }
        ],
        config: {
          temperature: 0.2,
          maxOutputTokens: 65536,
          thinkingConfig: { includeThoughts: false }
        }
      });

      const candidate = response.candidates?.[0];
      let chunkHtml = candidate?.content?.parts
        ?.map((part: any) => part.text)
        .join('')
        .trim() || '';

      // Strip markdown code fences if Gemini wraps output in ```html ... ```
      chunkHtml = stripCodeFences(chunkHtml);

      console.log(`[PDF] Gemini returned ${chunkHtml.length} chars for pages ${chunkStart}-${chunkEnd}`);
      htmlChunks.push(chunkHtml);
    } catch (error) {
      console.error(`[PDF] Gemini failed for pages ${chunkStart}-${chunkEnd}:`, error);
      // Fallback: use unpdf text extraction for this chunk
      const { text: pageTexts } = await extractText(await getDocumentProxy(pdfData), { mergePages: false });
      const pages = pageTexts as string[];
      const fallbackHtml = pages
        .slice(chunkStart - 1, chunkEnd)
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => p.split(/\n\n+/).map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`).join('\n'))
        .join('\n');
      htmlChunks.push(fallbackHtml);
    }
  }

  // Combine all chunks
  let combinedHtml = htmlChunks.join('\n');

  // Step 2: Find all <figure> placeholders and extract real images from unpdf
  const figureRegex = /<figure\s+data-page="(\d+)"\s+data-index="(\d+)">([\s\S]*?)<\/figure>/g;
  const placeholders: Array<{ fullMatch: string; page: number; index: number; figcaption: string }> = [];

  let match;
  while ((match = figureRegex.exec(combinedHtml)) !== null) {
    const figcaptionMatch = match[3].match(/<figcaption>([\s\S]*?)<\/figcaption>/);
    placeholders.push({
      fullMatch: match[0],
      page: parseInt(match[1]),
      index: parseInt(match[2]),
      figcaption: figcaptionMatch ? figcaptionMatch[1].trim() : ''
    });
  }

  console.log(`[PDF] Found ${placeholders.length} image placeholders to fill`);

  // Step 3: Extract actual images from unpdf for each referenced page
  const imagePdf = await getDocumentProxy(pdfData);
  const imageCache: Map<string, string> = new Map(); // "page-index" → data URI
  const pagesNeeded = new Set(placeholders.map(p => p.page));
  let imageCount = 0;

  for (const pageNum of pagesNeeded) {
    try {
      const pageImages = await extractImages(imagePdf, pageNum);
      console.log(`[PDF] Page ${pageNum}: unpdf found ${pageImages.length} images`);

      for (let i = 0; i < pageImages.length; i++) {
        const img = pageImages[i];

        // Skip tiny images (decorative: bullets, icons, spacers)
        if (img.width < 50 || img.height < 50) {
          console.log(`[PDF] Skipping tiny image on page ${pageNum}: ${img.width}x${img.height}`);
          continue;
        }

        try {
          const pngBuffer = await sharp(img.data, {
            raw: {
              width: img.width,
              height: img.height,
              channels: img.channels as 1 | 2 | 3 | 4
            }
          }).png().toBuffer();

          const dataUri = `data:image/png;base64,${pngBuffer.toString('base64')}`;
          imageCache.set(`${pageNum}-${i}`, dataUri);
          console.log(`[PDF] Converted image page ${pageNum} index ${i}: ${img.width}x${img.height} (${(pngBuffer.length / 1024).toFixed(0)}KB)`);
        } catch (sharpError) {
          console.warn(`[PDF] Failed to convert image page ${pageNum} index ${i}:`, sharpError);
        }
      }
    } catch (pageError) {
      console.warn(`[PDF] Failed to extract images from page ${pageNum}:`, pageError);
    }
  }

  // Step 4: Replace <figure> placeholders with real <img> tags + figcaptions
  for (const placeholder of placeholders) {
    const key = `${placeholder.page}-${placeholder.index}`;
    const dataUri = imageCache.get(key);

    let replacement: string;
    if (dataUri) {
      // Real image found — include both the image and Gemini's description
      replacement = `<figure><img src="${dataUri}" alt="${escapeHtmlAttr(placeholder.figcaption)}"><figcaption>${placeholder.figcaption}</figcaption></figure>`;
      imageCount++;
    } else {
      // No matching image from unpdf — keep Gemini's description as text
      console.warn(`[PDF] No image found for page ${placeholder.page} index ${placeholder.index}, keeping description only`);
      replacement = `<figure><figcaption>${placeholder.figcaption}</figcaption></figure>`;
    }

    combinedHtml = combinedHtml.replace(placeholder.fullMatch, replacement);
  }

  // Extract plain text from the HTML for the content column
  const plainText = htmlToPlainText(combinedHtml);

  console.log(`[PDF] Final: ${plainText.length} chars text, ${imageCount} images matched, ${combinedHtml.length} chars HTML`);

  return {
    text: plainText,
    html: combinedHtml,
    totalPages,
    imageCount
  };
}

/**
 * Build the Gemini prompt for converting a range of PDF pages to structured HTML.
 */
function buildGeminiPrompt(startPage: number, endPage: number, totalPages: number): string {
  const pageRange = startPage === endPage
    ? `page ${startPage}`
    : `pages ${startPage} through ${endPage}`;

  return `Convert ${pageRange} of this PDF document (${totalPages} pages total) to clean, structured HTML.

RULES:
1. Use proper HTML elements: <h1>-<h6> for headings, <p> for paragraphs, <strong>/<em> for bold/italic, <ul>/<ol>/<li> for lists, <table>/<tr>/<td>/<th> for tables, <blockquote> for quotes.
2. Preserve ALL text content verbatim — do NOT summarize, skip, or paraphrase anything.
3. For EACH image, figure, chart, diagram, or visual element, output a placeholder like this:
   <figure data-page="PAGE_NUMBER" data-index="IMAGE_INDEX"><figcaption>Description of what the image shows</figcaption></figure>
   - PAGE_NUMBER = the PDF page number where the image appears
   - IMAGE_INDEX = the 0-based index of the image on that page (first image = 0, second = 1, etc.)
   - The figcaption should describe the image content concisely for audio narration
4. Do NOT wrap your output in markdown code fences. Output raw HTML only.
5. Do NOT include <html>, <head>, or <body> tags. Just the content elements.
6. If a page has no content (blank page), skip it.
7. Maintain the document's reading order.`;
}

/**
 * Strip markdown code fences that Gemini sometimes wraps around HTML output.
 */
function stripCodeFences(text: string): string {
  // Remove ```html ... ``` or ``` ... ```
  return text.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * Escape a string for use in an HTML attribute value.
 */
function escapeHtmlAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert HTML to plain text (for the content column).
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
