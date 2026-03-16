import { extractText, extractImages, getDocumentProxy } from 'unpdf';
import sharp from 'sharp';

interface PdfImage {
  pageNumber: number;
  orderInPage: number;
  dataUri: string; // data:image/png;base64,...
  width: number;
  height: number;
}

interface PdfExtractionResult {
  text: string;
  html: string;
  totalPages: number;
  imageCount: number;
}

/**
 * Extract text content from a PDF buffer.
 * Returns the full text as a single string with page breaks preserved as double newlines.
 */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<{ text: string; totalPages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));

  // Extract text per page so we can join with clear page breaks
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  // Join pages with double newlines (preserves some structure)
  const fullText = (text as string[])
    .map(pageText => pageText.trim())
    .filter(pageText => pageText.length > 0)
    .join('\n\n');

  console.log(`[PDF] Extracted ${fullText.length} chars from ${totalPages} pages`);

  return { text: fullText, totalPages };
}

/**
 * Extract text AND images from a PDF buffer.
 * Returns HTML with embedded images as data URIs placed between the text paragraphs
 * of the page they came from. Images are processed in chunks of 10 pages for efficiency.
 *
 * The resulting HTML has <img> tags that the existing ImageAltTextService pipeline
 * (Gemini descriptions → TTS narration → read-along alignment) can pick up naturally.
 */
export async function extractTextAndImagesFromPdf(pdfBuffer: Buffer): Promise<PdfExtractionResult> {
  const pdfData = new Uint8Array(pdfBuffer);

  // Use separate document proxies for text and images to avoid known unpdf issue #17
  const textPdf = await getDocumentProxy(pdfData);
  const { totalPages, text: pageTexts } = await extractText(textPdf, { mergePages: false });

  console.log(`[PDF] Starting text+image extraction from ${totalPages} pages`);

  // Extract images in chunks of 10 pages
  const CHUNK_SIZE = 10;
  const allImages: PdfImage[] = [];

  const imagePdf = await getDocumentProxy(pdfData);

  for (let chunkStart = 1; chunkStart <= totalPages; chunkStart += CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, totalPages);
    console.log(`[PDF] Extracting images from pages ${chunkStart}-${chunkEnd}...`);

    for (let page = chunkStart; page <= chunkEnd; page++) {
      try {
        const images = await extractImages(imagePdf, page);

        for (let i = 0; i < images.length; i++) {
          const img = images[i];

          // Skip tiny images (likely decorative: bullets, icons, spacers)
          if (img.width < 50 || img.height < 50) {
            console.log(`[PDF] Skipping tiny image on page ${page}: ${img.width}x${img.height}`);
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

            const base64 = pngBuffer.toString('base64');
            const dataUri = `data:image/png;base64,${base64}`;

            allImages.push({
              pageNumber: page,
              orderInPage: i,
              dataUri,
              width: img.width,
              height: img.height
            });

            console.log(`[PDF] Extracted image from page ${page}: ${img.width}x${img.height} (${(pngBuffer.length / 1024).toFixed(0)}KB)`);
          } catch (sharpError) {
            console.warn(`[PDF] Failed to convert image on page ${page}, index ${i}:`, sharpError);
          }
        }
      } catch (pageError) {
        console.warn(`[PDF] Failed to extract images from page ${page}:`, pageError);
      }
    }
  }

  console.log(`[PDF] Extracted ${allImages.length} images total`);

  // Build HTML: interleave text paragraphs and images per page
  const htmlParts: string[] = [];
  const textParts: string[] = [];
  const pages = pageTexts as string[];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageNumber = pageIdx + 1;
    const pageText = pages[pageIdx].trim();
    const pageImages = allImages.filter(img => img.pageNumber === pageNumber);

    if (!pageText && pageImages.length === 0) continue;

    // Add text paragraphs for this page
    if (pageText) {
      textParts.push(pageText);
      const paragraphs = pageText.split(/\n\n+/).filter(p => p.trim().length > 0);

      for (const para of paragraphs) {
        htmlParts.push(`<p>${para.replace(/\n/g, '<br>')}</p>`);
      }
    }

    // Add images from this page after the text
    for (const img of pageImages) {
      htmlParts.push(`<img src="${img.dataUri}" width="${img.width}" height="${img.height}" alt="PDF image from page ${pageNumber}">`);
    }
  }

  const fullText = textParts.join('\n\n');
  const html = htmlParts.join('\n');

  console.log(`[PDF] Final: ${fullText.length} chars text, ${allImages.length} images, ${html.length} chars HTML`);

  return {
    text: fullText,
    html,
    totalPages,
    imageCount: allImages.length
  };
}
