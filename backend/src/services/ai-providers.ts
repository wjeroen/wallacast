import OpenAI from 'openai';
import { query } from '../database/db.js';
import { decrypt } from './encryption.js';

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

// Get user setting from database (decrypts encrypted values transparently)
export async function getUserSetting(userId: number, key: string): Promise<string | null> {
  const result = await query(
    'SELECT setting_value FROM user_settings WHERE user_id = $1 AND setting_key = $2',
    [userId, key]
  );
  const value = result.rows[0]?.setting_value;
  if (!value) return null;
  return decrypt(value);
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
    // Always default to gpt-5-nano — don't read openai_model from DB which may
    // contain stale values like 'gpt-4o-mini' from before migration
    const model = options?.model || 'gpt-5-nano';

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
    // Explicit per-user choice (Settings → Transcription): provider 'deepinfra' | 'openai' + model.
    const provider = await getUserSetting(userId, 'transcription_provider');
    const chosenModel = await getUserSetting(userId, 'transcription_model');

    if (provider === 'openai') {
        const k = await getUserSetting(userId, 'openai_api_key');
        if (k) return { client: new OpenAI({ apiKey: k }), model: chosenModel || 'whisper-1' };
    }
    if (provider === 'deepinfra') {
        const k = await getUserSetting(userId, 'deepinfra_api_key');
        if (k) return { client: new OpenAI({ apiKey: k, baseURL: 'https://api.deepinfra.com/v1/openai' }), model: chosenModel || 'openai/whisper-large-v3-turbo' };
    }

    // Fallback (unset, or chosen provider has no key): legacy auto-routing — prefer DeepInfra (cheaper).
    const deepInfraKey = await getUserSetting(userId, 'deepinfra_api_key');
    if (deepInfraKey) {
        return { client: new OpenAI({ apiKey: deepInfraKey, baseURL: 'https://api.deepinfra.com/v1/openai' }), model: 'openai/whisper-large-v3-turbo' };
    }
    const openAIKey = await getUserSetting(userId, 'openai_api_key');
    if (openAIKey) {
        return { client: new OpenAI({ apiKey: openAIKey }), model: 'whisper-1' };
    }
    return null;
}

// Legacy helper (renamed for clarity, but kept signature)
export async function getOpenAIClientForUser(userId: number): Promise<OpenAI | null> {
  const apiKey = await getUserSetting(userId, 'openai_api_key');
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

// ===========================================================================
// CHAT LLM PROVIDER REGISTRY + PER-JOB ROUTING
//
// Every supported provider speaks the OpenAI Chat Completions format — we use
// the OpenAI SDK as a universal client and just swap baseURL + key. Each "chat
// job" (narration prep, read-along alignment, summaries) has its own
// provider+model+reasoning_effort, configured in Settings. Read-along and
// summaries can defer to the narration config ("use same model as narration").
// ===========================================================================

export type ChatJob = 'narration' | 'alignment' | 'summary';

interface ChatProviderDef {
  baseURL?: string; // undefined = OpenAI default endpoint
  keySetting: string;
  // Build the extra create() params for a non-empty reasoning effort (provider-specific shape).
  reasoningParams: (effort: string) => Record<string, any>;
}

export const CHAT_PROVIDERS: Record<string, ChatProviderDef> = {
  openai: { keySetting: 'openai_api_key', reasoningParams: (e) => ({ reasoning_effort: e }) },
  deepinfra: { baseURL: 'https://api.deepinfra.com/v1/openai', keySetting: 'deepinfra_api_key', reasoningParams: () => ({}) },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', keySetting: 'openrouter_api_key', reasoningParams: (e) => ({ reasoning: { effort: e } }) },
  anthropic: { baseURL: 'https://api.anthropic.com/v1/', keySetting: 'anthropic_api_key', reasoningParams: (e) => ({ reasoning_effort: e }) },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keySetting: 'gemini_api_key', reasoningParams: (e) => ({ reasoning_effort: e }) },
};

export interface ChatClientConfig {
  client: OpenAI;
  model: string;
  extraParams: Record<string, any>; // reasoning params (empty unless a reasoning effort is set)
}

// Legacy `narration_llm` routing → concrete {provider, model}. Used as a read-time fallback
// so existing users keep working (and the Settings fields pre-fill correctly) before they save
// the new per-job config.
async function legacyNarrationConfig(userId: number): Promise<{ provider: string; model: string }> {
  const llm = (await getUserSetting(userId, 'narration_llm')) || 'auto';
  if (llm === 'openai-mini') return { provider: 'openai', model: 'gpt-5-mini' };
  if (llm === 'openai') return { provider: 'openai', model: 'gpt-5-nano' };
  if (llm === 'deepseek') return { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V3.2' };
  // 'auto': prefer DeepInfra (cheaper) if its key is set, else OpenAI.
  if (await getUserSetting(userId, 'deepinfra_api_key')) return { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V3.2' };
  return { provider: 'openai', model: 'gpt-5-nano' };
}

// Resolve a job's effective {provider, model, effort}, honoring "use same model as narration".
async function resolveJobConfig(userId: number, job: ChatJob): Promise<{ provider: string; model: string; effort: string }> {
  if (job !== 'narration') {
    const same = await getUserSetting(userId, `${job}_same_as_narration`);
    const jobProvider = await getUserSetting(userId, `${job}_provider`);
    // Default to "same as narration" until the job is explicitly configured.
    if (same === 'true' || (same !== 'false' && !jobProvider)) {
      const base = await resolveJobConfig(userId, 'narration');
      const effort = (await getUserSetting(userId, `${job}_reasoning_effort`)) || base.effort;
      return { provider: base.provider, model: base.model, effort };
    }
  }
  const provider = await getUserSetting(userId, `${job}_provider`);
  const model = await getUserSetting(userId, `${job}_model`);
  const effort = (await getUserSetting(userId, `${job}_reasoning_effort`)) || '';
  if (provider && model) return { provider, model, effort };
  // Not configured yet → legacy narration mapping (covers all three chat jobs pre-migration).
  const legacy = await legacyNarrationConfig(userId);
  return { provider: legacy.provider, model: legacy.model, effort };
}

function buildChatClient(apiKey: string, def: ChatProviderDef): OpenAI {
  return new OpenAI(def.baseURL ? { apiKey, baseURL: def.baseURL } : { apiKey });
}

/**
 * Returns the chat client + model + reasoning params for a given job. Falls back to a
 * key-bearing provider if the configured one has no key (misconfiguration safety net).
 */
export async function getChatClientForJob(userId: number, job: ChatJob): Promise<ChatClientConfig | null> {
  const { provider, model, effort } = await resolveJobConfig(userId, job);
  const def = CHAT_PROVIDERS[provider];

  if (def) {
    const apiKey = await getUserSetting(userId, def.keySetting);
    if (apiKey) {
      return { client: buildChatClient(apiKey, def), model, extraParams: effort ? def.reasoningParams(effort) : {} };
    }
    console.warn(`[AI] ${job}: provider '${provider}' has no API key — falling back`);
  }

  // Fallback: legacy narration mapping (picks DeepInfra/OpenAI by whichever key exists).
  const legacy = await legacyNarrationConfig(userId);
  const legacyDef = CHAT_PROVIDERS[legacy.provider];
  const legacyKey = await getUserSetting(userId, legacyDef.keySetting);
  if (legacyKey) {
    return { client: buildChatClient(legacyKey, legacyDef), model: legacy.model, extraParams: effort ? legacyDef.reasoningParams(effort) : {} };
  }
  return null;
}

/**
 * Back-compat wrapper — narration job, without the reasoning extraParams.
 * Prefer getChatClientForJob() in new code so reasoning effort is honored.
 */
export async function getChatClientForUser(userId: number): Promise<{ client: OpenAI; model: string } | null> {
  const cfg = await getChatClientForJob(userId, 'narration');
  return cfg ? { client: cfg.client, model: cfg.model } : null;
}

export async function getTTSOptionsForUser(userId: number): Promise<{ voice: string; model: string }> {
  const voice = await getUserSetting(userId, 'openai_tts_voice') || 'coral';
  const model = await getUserSetting(userId, 'openai_tts_model') || 'gpt-4o-mini-tts';
  return { voice, model };
}

// A single selectable voice. `model` carries the provider (OpenAI vs Kokoro/DeepInfra) so a
// list of voices can span TTS models — the TTS client is routed per the picked model.
export interface TTSVoiceChoice { model: string; voice: string; }

// Parse the user's `tts_voices` setting (JSON array of { model, voice }). Returns [] on any
// problem, which makes callers fall back to the single openai_tts_voice/model.
export async function getSelectedTTSVoices(userId: number): Promise<TTSVoiceChoice[]> {
  const raw = await getUserSetting(userId, 'tts_voices');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((v: any) => v && typeof v.model === 'string' && typeof v.voice === 'string' && v.model && v.voice)
      .map((v: any) => ({ model: v.model, voice: v.voice }));
  } catch {
    return [];
  }
}

// Pick a random voice from the user's selected list, or null if none are usable.
// Random (not alternating) so there's no cross-generation state to persist. Voices whose
// provider key isn't configured are skipped so we never pick something we can't synthesize.
export async function pickRandomTTSVoice(userId: number): Promise<TTSVoiceChoice | null> {
  let voices = await getSelectedTTSVoices(userId);
  if (voices.length === 0) return null;

  const hasDeepInfra = !!(await getUserSetting(userId, 'deepinfra_api_key'));
  const hasOpenAI = !!(await getUserSetting(userId, 'openai_api_key'));
  voices = voices.filter(v => {
    const isKokoro = v.model.includes('Kokoro') || v.model.startsWith('hexgrad/');
    return isKokoro ? hasDeepInfra : hasOpenAI;
  });
  if (voices.length === 0) return null;

  return voices[Math.floor(Math.random() * voices.length)];
}

export async function hasUserConfiguredAPIKey(userId: number): Promise<boolean> {
    const openaiKey = await getUserSetting(userId, 'openai_api_key');
    const diKey = await getUserSetting(userId, 'deepinfra_api_key');
    return !!openaiKey || !!diKey;
}
