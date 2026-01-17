import OpenAI from 'openai';
import { query } from '../database/db.js';

// AI Provider interface - extend this for new providers
export interface AIProvider {
  name: string;
  chatCompletion(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  textToSpeech?(text: string, options?: TTSOptions): Promise<Buffer>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface TTSOptions {
  model?: string;
  voice?: string;
  instructions?: string;
}

// Get user setting from database
async function getUserSetting(userId: number, key: string): Promise<string | null> {
  const result = await query(
    'SELECT setting_value FROM user_settings WHERE user_id = $1 AND setting_key = $2',
    [userId, key]
  );
  return result.rows[0]?.setting_value || null;
}

// OpenAI Provider implementation
class OpenAIProvider implements AIProvider {
  name = 'openai';
  private client: OpenAI;
  private userId: number;

  constructor(apiKey: string, userId: number) {
    this.client = new OpenAI({ apiKey });
    this.userId = userId;
  }

  async chatCompletion(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const model = options?.model || await getUserSetting(this.userId, 'openai_model') || 'gpt-4o-mini';

    const response = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 16384,
    });

    return response.choices[0]?.message?.content || '';
  }

  async textToSpeech(text: string, options?: TTSOptions): Promise<Buffer> {
    const model = options?.model || await getUserSetting(this.userId, 'openai_tts_model') || 'gpt-4o-mini-tts';
    const voice = options?.voice || await getUserSetting(this.userId, 'openai_tts_voice') || 'coral';

    const response = await this.client.audio.speech.create({
      model: model as any,
      voice: voice as any,
      input: text,
      instructions: options?.instructions,
    });

    return Buffer.from(await response.arrayBuffer());
  }
}

// Factory function to get AI provider for a user
export async function getAIProvider(userId: number): Promise<AIProvider | null> {
  // Get user's preferred provider (default to OpenAI)
  const providerName = await getUserSetting(userId, 'ai_provider') || 'openai';

  switch (providerName) {
    case 'openai': {
      // Try user's API key first, fall back to env
      const apiKey = await getUserSetting(userId, 'openai_api_key') || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return null;
      }
      return new OpenAIProvider(apiKey, userId);
    }
    // Add more providers here as they're implemented
    // case 'anthropic': { ... }
    // case 'google': { ... }
    default:
      console.warn(`Unknown AI provider: ${providerName}`);
      return null;
  }
}

// Get OpenAI client for a user (for backward compatibility with existing code)
export async function getOpenAIClientForUser(userId: number): Promise<OpenAI | null> {
  const apiKey = await getUserSetting(userId, 'openai_api_key') || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new OpenAI({ apiKey });
}

// Get TTS options for a user
export async function getTTSOptionsForUser(userId: number): Promise<{ voice: string; model: string }> {
  const voice = await getUserSetting(userId, 'openai_tts_voice') || 'coral';
  const model = await getUserSetting(userId, 'openai_tts_model') || 'gpt-4o-mini-tts';
  return { voice, model };
}

// Check if user has API key configured
export async function hasUserConfiguredAPIKey(userId: number): Promise<boolean> {
  const provider = await getUserSetting(userId, 'ai_provider') || 'openai';

  switch (provider) {
    case 'openai': {
      const userKey = await getUserSetting(userId, 'openai_api_key');
      return !!(userKey || process.env.OPENAI_API_KEY);
    }
    case 'anthropic': {
      const userKey = await getUserSetting(userId, 'anthropic_api_key');
      return !!(userKey || process.env.ANTHROPIC_API_KEY);
    }
    default:
      return false;
  }
}
