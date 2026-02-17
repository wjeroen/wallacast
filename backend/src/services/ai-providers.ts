import OpenAI from 'openai';
import { query } from '../database/db.js';

// AI Provider interface
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
  maxTokens?: number;
}

export interface TTSOptions {
  model?: string;
  voice?: string;
  instructions?: string;
}

// Get user setting from database
export async function getUserSetting(userId: number, key: string): Promise<string | null> {
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
    // UPDATED: Default to 'gpt-5-nano' instead of 'gpt-4o-mini'
    const model = options?.model || await getUserSetting(this.userId, 'openai_model') || 'gpt-5-nano';

    const response = await this.client.chat.completions.create({
      model: model,
      messages: messages as any,
      // UPDATED: gpt-5-nano supports a larger output limit (128k), ensuring long tasks don't get cut off
      max_tokens: options?.maxTokens || 128000,
    });

    return response.choices[0]?.message?.content || '';
  }

  async textToSpeech(text: string, options?: TTSOptions): Promise<Buffer> {
    const model = options?.model || await getUserSetting(this.userId, 'openai_tts_model') || 'gpt-4o-mini-tts';
    const voice = options?.voice || await getUserSetting(this.userId, 'openai_tts_voice') || 'coral';

    // Route request to the correct client (DeepInfra vs OpenAI)
    const client = await getTTSClientForUser(this.userId, model);

    if (!client) {
        throw new Error("No API client configured for TTS");
    }

    const response = await client.audio.speech.create({
      model: model as any,
      voice: voice as any,
      input: text,
      // Instructions are only supported by some models/endpoints
      // OpenAI TTS API doesn't officially verify instructions param in some SDK versions but we pass it
    });

    return Buffer.from(await response.arrayBuffer());
  }
}

// Factory function to get AI provider for a user
export async function getAIProvider(userId: number): Promise<AIProvider | null> {
  const providerName = await getUserSetting(userId, 'ai_provider') || 'openai';

  switch (providerName) {
    case 'openai': {
      const apiKey = await getUserSetting(userId, 'openai_api_key');
      if (!apiKey) return null;
      return new OpenAIProvider(apiKey, userId);
    }
    default:
      console.warn(`Unknown AI provider: ${providerName}`);
      return null;
  }
}

/**
 * Returns a DeepInfra-configured OpenAI client
 */
export async function getDeepInfraClientForUser(userId: number): Promise<OpenAI | null> {
    const apiKey = await getUserSetting(userId, 'deepinfra_api_key');
    if (!apiKey) return null;

    return new OpenAI({
        apiKey: apiKey,
        baseURL: 'https://api.deepinfra.com/v1/openai',
    });
}

/**
 * INTELLIGENT ROUTER: Returns the correct client based on the Model ID.
 * If model is 'hexgrad/Kokoro-82M', it returns the DeepInfra client.
 * Otherwise, it returns the standard OpenAI client.
 */
export async function getTTSClientForUser(userId: number, modelId?: string): Promise<OpenAI | null> {
    const model = modelId || await getUserSetting(userId, 'openai_tts_model') || 'gpt-4o-mini-tts';

    // DeepInfra Routing
    if (model.includes('Kokoro') || model.startsWith('hexgrad/')) {
        return getDeepInfraClientForUser(userId);
    }

    // Default to OpenAI
    return getOpenAIClientForUser(userId);
}

/**
 * INTELLIGENT ROUTER FOR WHISPER
 * If the user has a DeepInfra key, we prefer DeepInfra for transcription (cheaper).
 * Unless they explicitly requested OpenAI (logic can be adjusted).
 */
export async function getTranscriptionClientForUser(userId: number): Promise<{ client: OpenAI, model: string } | null> {
    // Check if DeepInfra is configured (Preferred for cost)
    const deepInfraKey = await getUserSetting(userId, 'deepinfra_api_key');
    if (deepInfraKey) {
        return {
            client: new OpenAI({ apiKey: deepInfraKey, baseURL: 'https://api.deepinfra.com/v1/openai' }),
            model: 'openai/whisper-large-v3-turbo' // DeepInfra specific model ID
        };
    }

    // Fallback to OpenAI
    const openAIKey = await getUserSetting(userId, 'openai_api_key');
    if (openAIKey) {
        return {
            client: new OpenAI({ apiKey: openAIKey }),
            model: 'whisper-1'
        };
    }

    return null;
}

// Legacy helper (renamed for clarity, but kept signature)
export async function getOpenAIClientForUser(userId: number): Promise<OpenAI | null> {
  const apiKey = await getUserSetting(userId, 'openai_api_key');
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

/**
 * INTELLIGENT ROUTER FOR NARRATION PREP LLM
 * Returns the client + model for scriptwriting (preparing text for TTS).
 * Supports: OpenAI gpt-5-nano or gpt-5-mini, DeepSeek-V3.2 via DeepInfra.
 *
 * Routing logic:
 *   1. If user explicitly chose 'deepseek' or 'openai', use that
 *   2. If 'auto' (default): prefer DeepInfra/DeepSeek (cheaper), fallback to OpenAI
 */
export async function getChatClientForUser(userId: number): Promise<{ client: OpenAI; model: string } | null> {
  const narrationLlm = await getUserSetting(userId, 'narration_llm') || 'auto';

  if (narrationLlm === 'deepseek') {
    const client = await getDeepInfraClientForUser(userId);
    if (client) return { client, model: 'deepseek-ai/DeepSeek-V3.2' };
    console.warn('[AI] User chose DeepSeek but no DeepInfra key, falling back to OpenAI');
  }

  if (narrationLlm === 'openai' || narrationLlm === 'openai-mini') {
    const client = await getOpenAIClientForUser(userId);
    if (client) {
      const model = narrationLlm === 'openai-mini' ? 'gpt-5-mini' : 'gpt-5-nano';
      return { client, model };
    }
    console.warn('[AI] User chose OpenAI but no OpenAI key, falling back to DeepInfra');
  }

  // Auto-routing: prefer DeepInfra (cheaper)
  const deepInfraClient = await getDeepInfraClientForUser(userId);
  if (deepInfraClient) {
    console.log('[AI] Auto-routing narration LLM to DeepSeek-V3.2 via DeepInfra');
    return { client: deepInfraClient, model: 'deepseek-ai/DeepSeek-V3.2' };
  }

  // Fallback to OpenAI
  const openaiClient = await getOpenAIClientForUser(userId);
  if (openaiClient) {
    const model = await getUserSetting(userId, 'openai_model') || 'gpt-5-nano';
    console.log(`[AI] Auto-routing narration LLM to OpenAI ${model}`);
    return { client: openaiClient, model };
  }

  return null;
}

export async function getTTSOptionsForUser(userId: number): Promise<{ voice: string; model: string }> {
  const voice = await getUserSetting(userId, 'openai_tts_voice') || 'coral';
  const model = await getUserSetting(userId, 'openai_tts_model') || 'gpt-4o-mini-tts';
  return { voice, model };
}

export async function hasUserConfiguredAPIKey(userId: number): Promise<boolean> {
    const openaiKey = await getUserSetting(userId, 'openai_api_key');
    const diKey = await getUserSetting(userId, 'deepinfra_api_key');
    return !!openaiKey || !!diKey;
}
