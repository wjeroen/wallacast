import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { query } from '../database/db.js';

async function getOpenAIClient(): Promise<OpenAI | null> {
  // First try environment variable
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  // Then try settings table
  try {
    const result = await query('SELECT value FROM settings WHERE key = $1', ['OPENAI_API_KEY']);
    if (result.rows.length > 0 && result.rows[0].value) {
      return new OpenAI({
        apiKey: result.rows[0].value,
      });
    }
  } catch (error) {
    console.error('Error fetching API key from settings:', error);
  }

  return null;
}

export async function extractArticleContent(htmlContent: string): Promise<string> {
  try {
    const openai = await getOpenAIClient();
    if (!openai) {
      console.warn('OpenAI API key not set, returning raw HTML content');
      return htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Use GPT-4o-mini to extract clean article content
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a content extraction assistant. Extract only the main article text from HTML content, removing navigation, ads, footers, headers, and other non-content elements. Return only the clean article text.',
        },
        {
          role: 'user',
          content: `Extract the main article content from this HTML:\n\n${htmlContent.slice(0, 50000)}`,
        },
      ],
      temperature: 0.3,
    });

    const cleanContent = response.choices[0]?.message?.content || '';
    return cleanContent;
  } catch (error) {
    console.error('Error extracting article content:', error);
    // Fallback: strip HTML tags
    return htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

export async function generateArticleAudio(
  articleText: string,
  options: {
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'coral';
    instructions?: string;
  } = {}
): Promise<Buffer> {
  try {
    const openai = await getOpenAIClient();
    if (!openai) {
      throw new Error('OpenAI API key not set. Please set your OpenAI API key in Settings.');
    }

    const voice = options.voice || 'alloy';
    const instructions =
      options.instructions ||
      'Read this article clearly and naturally. Focus on the main content. Use appropriate pacing and emphasis for readability.';

    console.log('Generating TTS audio with gpt-4o-mini-tts...');

    const response = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: voice,
      input: articleText.slice(0, 4096), // OpenAI has a character limit
      instructions: instructions,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
  } catch (error) {
    console.error('Error generating audio:', error);
    throw new Error('Failed to generate audio. Please check your OpenAI API key and try again.');
  }
}

export async function generateAudioForContent(contentId: number): Promise<string> {
  try {
    // Get content item
    const contentResult = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);

    if (contentResult.rows.length === 0) {
      throw new Error('Content not found');
    }

    const content = contentResult.rows[0];

    let textToConvert = '';

    if (content.type === 'article') {
      // Extract clean content from HTML
      const cleanContent = await extractArticleContent(content.html_content || content.content);
      textToConvert = cleanContent;
    } else {
      textToConvert = content.content || '';
    }

    if (!textToConvert) {
      throw new Error('No content to convert to audio');
    }

    // Generate audio
    const audioBuffer = await generateArticleAudio(textToConvert, {
      instructions:
        'Read this article clearly and naturally, focusing only on the main article text. Use appropriate pacing and emphasis.',
    });

    // Save audio file
    const audioDir = path.join(process.cwd(), 'public', 'audio');
    await fs.mkdir(audioDir, { recursive: true });

    const audioFilename = `article_${contentId}_${Date.now()}.mp3`;
    const audioPath = path.join(audioDir, audioFilename);
    await fs.writeFile(audioPath, audioBuffer);

    // Construct full URL for audio file
    const backendUrl = process.env.BACKEND_URL || process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'http://localhost:3001';
    const audioUrl = `${backendUrl}/audio/${audioFilename}`;

    // Update content item with audio URL
    await query('UPDATE content_items SET audio_url = $1 WHERE id = $2', [audioUrl, contentId]);

    return audioUrl;
  } catch (error) {
    console.error('Error generating audio for content:', error);
    throw error;
  }
}
