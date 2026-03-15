import { extractText, getDocumentProxy } from 'unpdf';

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
