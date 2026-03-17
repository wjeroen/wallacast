import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { getUserSetting } from './ai-providers.js';

const execFileAsync = promisify(execFile);

interface PdfExtractionResult {
  text: string;
  html: string;
  totalPages: number;
  imageCount: number;
}

/**
 * Convert a PDF to structured HTML using marker-pdf.
 *
 * marker-pdf is a Python tool that uses deep learning models (surya for OCR/layout,
 * texify for math) to convert PDFs into clean HTML with proper headings, tables,
 * lists, equations, and extracted images.
 *
 * Flow:
 * 1. Save PDF buffer to a temp file
 * 2. Run `marker_single` CLI with --output_format html
 * 3. If user has Gemini API key → add --use_llm for higher accuracy (tables, math, forms)
 * 4. Read the output HTML, embed extracted images as data URIs
 * 5. The resulting HTML has real structure + real images for the TTS narration pipeline
 *
 * Images are NOT described here — the existing ImageAltTextService in the TTS
 * pipeline handles image descriptions with its own carefully tuned prompt.
 */
export async function extractPdfWithMarker(
  pdfBuffer: Buffer,
  userId: number
): Promise<PdfExtractionResult> {
  // Create temp directory for input and output
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'wallacast-pdf-'));
  const inputPath = path.join(tmpDir, 'input.pdf');
  const outputDir = path.join(tmpDir, 'output');

  try {
    // Write PDF to temp file
    await writeFile(inputPath, pdfBuffer);
    console.log(`[PDF] Saved ${pdfBuffer.length} bytes to ${inputPath}`);

    // Build marker_single command args
    // --pdftext_workers 1: limit to single worker process to avoid OOM on Railway
    // (default spawns one worker per CPU, which exhausts container memory)
    const args = [
      inputPath,
      '--output_format', 'html',
      '--output_dir', outputDir,
      '--pdftext_workers', '1',
    ];

    // Check if user has Gemini API key for LLM-enhanced accuracy
    const geminiApiKey = await getUserSetting(userId, 'gemini_api_key');
    if (geminiApiKey) {
      args.push('--use_llm', '--gemini_api_key', geminiApiKey);
      console.log('[PDF] Using marker with --use_llm (Gemini) for higher accuracy');
    } else {
      console.log('[PDF] Using marker without LLM (no Gemini API key)');
    }

    // Run marker_single
    console.log(`[PDF] Running: marker_single ${args.filter(a => a !== geminiApiKey).join(' ')}`);
    const { stdout, stderr } = await execFileAsync('marker_single', args, {
      timeout: 5 * 60 * 1000, // 5 minute timeout for large PDFs
      maxBuffer: 50 * 1024 * 1024, // 50MB output buffer
    });

    if (stdout) console.log(`[PDF] marker stdout: ${stdout.substring(0, 500)}`);
    if (stderr) console.log(`[PDF] marker stderr: ${stderr.substring(0, 500)}`);

    // Find the output HTML file — marker creates a subdirectory named after the input file
    // Output structure: outputDir/input/input.html + outputDir/input/images/...
    const outputSubdirs = await readdir(outputDir);
    if (outputSubdirs.length === 0) {
      throw new Error('marker produced no output');
    }

    const resultDir = path.join(outputDir, outputSubdirs[0]);
    const files = await readdir(resultDir);
    const htmlFile = files.find(f => f.endsWith('.html'));
    if (!htmlFile) {
      throw new Error(`marker output directory has no HTML file. Files: ${files.join(', ')}`);
    }

    let html = await readFile(path.join(resultDir, htmlFile), 'utf-8');
    console.log(`[PDF] marker produced ${html.length} chars of HTML`);

    // Embed extracted images as data URIs so they travel with the HTML
    // marker saves images to an "images" or similarly named subdirectory
    let imageCount = 0;
    const imgDir = files.includes('images') ? path.join(resultDir, 'images') : null;

    if (imgDir) {
      try {
        const imageFiles = await readdir(imgDir);
        console.log(`[PDF] Found ${imageFiles.length} extracted images`);

        for (const imgFile of imageFiles) {
          const imgPath = path.join(imgDir, imgFile);
          const imgData = await readFile(imgPath);
          const ext = path.extname(imgFile).toLowerCase().replace('.', '');
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'png' ? 'image/png'
            : ext === 'webp' ? 'image/webp'
            : ext === 'gif' ? 'image/gif'
            : ext === 'svg' ? 'image/svg+xml'
            : 'image/png';
          const dataUri = `data:${mimeType};base64,${imgData.toString('base64')}`;

          // Replace image references in HTML (marker uses relative paths like "images/foo.png")
          // Handle both images/foo.png and ./images/foo.png patterns
          const relativePath = `images/${imgFile}`;
          const relativePathDot = `./images/${imgFile}`;

          if (html.includes(relativePath) || html.includes(relativePathDot)) {
            html = html.split(relativePath).join(dataUri);
            html = html.split(relativePathDot).join(dataUri);
            imageCount++;
            console.log(`[PDF] Embedded image: ${imgFile} (${(imgData.length / 1024).toFixed(0)}KB)`);
          }
        }
      } catch (imgError) {
        console.warn('[PDF] Failed to read images directory:', imgError);
      }
    }

    // Also check for images directly in the result directory (some marker versions)
    for (const file of files) {
      if (/\.(png|jpg|jpeg|webp|gif|svg)$/i.test(file) && file !== htmlFile) {
        try {
          const imgData = await readFile(path.join(resultDir, file));
          const ext = path.extname(file).toLowerCase().replace('.', '');
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'png' ? 'image/png'
            : ext === 'webp' ? 'image/webp'
            : ext === 'gif' ? 'image/gif'
            : 'image/png';
          const dataUri = `data:${mimeType};base64,${imgData.toString('base64')}`;

          if (html.includes(file)) {
            html = html.split(file).join(dataUri);
            imageCount++;
            console.log(`[PDF] Embedded image: ${file} (${(imgData.length / 1024).toFixed(0)}KB)`);
          }
        } catch {
          // Skip files we can't read
        }
      }
    }

    // Extract plain text from HTML for the content column
    const text = htmlToPlainText(html);

    // Count pages from marker's output (look for page break markers or estimate from text)
    // marker doesn't directly output page count, so we estimate from the PDF size
    const totalPages = estimatePageCount(pdfBuffer.length);

    console.log(`[PDF] Final: ${text.length} chars text, ${imageCount} images, ${html.length} chars HTML`);

    return { text, html, totalPages, imageCount };
  } finally {
    // Clean up temp directory
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      console.warn(`[PDF] Failed to clean up temp dir: ${tmpDir}`);
    }
  }
}

/**
 * Estimate page count from PDF file size (rough heuristic).
 * Average PDF page is ~50-100KB for text-heavy docs.
 */
function estimatePageCount(fileSizeBytes: number): number {
  return Math.max(1, Math.round(fileSizeBytes / 75000));
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
    .replace(/<\/div>/gi, '\n')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
