import OpenAI from 'openai';
import { query } from '../database/db.js';
import { decrypt } from './encryption.js';
import { PROCESSING_CONFIG } from '../config/processing.js';

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
 * INTELLIGENT ROUTER: Returns the correct client + the model id to call with.
 * - Kokoro models → DeepInfra (default), OR via OpenRouter if the user picked
 *   'openrouter' as their Kokoro TTS provider (same voices; OpenRouter lists the
 *   model under the lowercase id 'hexgrad/kokoro-82m', so we rewrite it here).
 * - OpenAI-family models → always OpenAI directly. OpenRouter does not carry the
 *   OpenAI TTS models (verified live 2026-07-02), so there is no alternate route.
 */
// Key-aware TTS default: Kokoro's Puck voice whenever a Kokoro-capable key (DeepInfra or
// OpenRouter) is configured, else OpenAI's gpt-4o-mini-tts with coral.
async function defaultTTSChoice(userId: number): Promise<{ model: string; voice: string }> {
    const hasDeepInfra = !!(await getUserSetting(userId, 'deepinfra_api_key'));
    const hasOpenRouter = !!(await getUserSetting(userId, 'openrouter_api_key'));
    if (hasDeepInfra || hasOpenRouter) return { model: 'hexgrad/Kokoro-82M', voice: 'am_puck' };
    return { model: 'gpt-4o-mini-tts', voice: 'coral' };
}

export async function getTTSClientForUser(userId: number, modelId?: string): Promise<{ client: OpenAI; model: string } | null> {
    const model = modelId || await getUserSetting(userId, 'openai_tts_model') || (await defaultTTSChoice(userId)).model;

    // Kokoro: DeepInfra (default) or OpenRouter, per the kokoro_tts_provider setting. Falls
    // back to whichever of the two keys exists so Kokoro works for OpenRouter-only users.
    if (model.includes('Kokoro') || model.startsWith('hexgrad/')) {
        const kokoroProvider = (await getUserSetting(userId, 'kokoro_tts_provider')) || 'deepinfra';
        const orKey = await getUserSetting(userId, 'openrouter_api_key');
        // OpenRouter's /audio/speech endpoint is OpenAI-compatible but lists Kokoro under
        // the lowercase id.
        if (kokoroProvider === 'openrouter' && orKey) {
            return { client: new OpenAI({ apiKey: orKey, baseURL: 'https://openrouter.ai/api/v1' }), model: model.toLowerCase() };
        }
        const client = await getDeepInfraClientForUser(userId);
        if (client) return { client, model };
        if (orKey) {
            return { client: new OpenAI({ apiKey: orKey, baseURL: 'https://openrouter.ai/api/v1' }), model: model.toLowerCase() };
        }
        return null;
    }

    // OpenAI-family model: OpenAI only.
    const client = await getOpenAIClientForUser(userId);
    return client ? { client, model } : null;
}

/**
 * INTELLIGENT ROUTER FOR WHISPER
 * If the user has a DeepInfra key, we prefer DeepInfra for transcription (cheaper).
 * Unless they explicitly requested OpenAI (logic can be adjusted).
 */
// Transcription config is a discriminated union so the caller knows HOW to call the model:
//   - 'deepinfra': call DeepInfra's NATIVE inference endpoint (raw multipart POST). Only this
//     endpoint accepts Whisper's anti-hallucination params (condition_on_previous_text, vad, ...).
//   - 'openai': call via the OpenAI SDK (endpoint is OpenAI-shaped and does NOT accept those
//     extra params). OpenRouter is NOT a transcription provider: its endpoint takes a JSON
//     base64 body (not the SDK's multipart upload) and returns no word timestamps at all,
//     which read-along requires (verified live 2026-07-02).
export type TranscriptionConfig =
    | { kind: 'deepinfra'; apiKey: string; model: string }
    | { kind: 'openai'; client: OpenAI; model: string };

export async function getTranscriptionClientForUser(userId: number): Promise<TranscriptionConfig | null> {
    // Explicit per-user choice (Settings → Transcription): provider 'deepinfra' | 'openai' + model.
    const provider = await getUserSetting(userId, 'transcription_provider');
    const chosenModel = await getUserSetting(userId, 'transcription_model');

    if (provider === 'openai') {
        const k = await getUserSetting(userId, 'openai_api_key');
        if (k) return { kind: 'openai', client: new OpenAI({ apiKey: k }), model: chosenModel || 'whisper-1' };
    }
    if (provider === 'deepinfra') {
        const k = await getUserSetting(userId, 'deepinfra_api_key');
        if (k) return { kind: 'deepinfra', apiKey: k, model: chosenModel || 'openai/whisper-large-v3-turbo' };
    }
    // Fallback (unset, or chosen provider has no key): legacy auto-routing, preferring DeepInfra (cheaper).
    const deepInfraKey = await getUserSetting(userId, 'deepinfra_api_key');
    if (deepInfraKey) {
        return { kind: 'deepinfra', apiKey: deepInfraKey, model: 'openai/whisper-large-v3-turbo' };
    }
    const openAIKey = await getUserSetting(userId, 'openai_api_key');
    if (openAIKey) {
        return { kind: 'openai', client: new OpenAI({ apiKey: openAIKey }), model: 'whisper-1' };
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
// Every supported provider speaks the OpenAI Chat Completions format, so we use
// the OpenAI SDK as a universal client and just swap baseURL + key. Each "chat
// job" (narration prep, read-along alignment, summaries) has its own
// provider+model+reasoning_effort, configured in Settings. Read-along and
// summaries can defer to the narration config ("use same model as narration").
// ===========================================================================

export type ChatJob = 'narration' | 'alignment' | 'summary';

interface ChatProviderDef {
  baseURL?: string; // undefined = OpenAI default endpoint
  keySetting: string;
  // Build the extra create() params for a non-empty reasoning effort (provider-specific
  // shape). Gets the model id too, since some providers need model-aware mapping.
  reasoningParams: (effort: string, model: string) => Record<string, any>;
}

// Effort handling for Anthropic. The OpenAI-compat endpoint silently strips EVERY effort
// control (reasoning_effort AND the native output_config, both verified live 2026-07-06
// with identical token spend under low/max/unset, and invalid values accepted without
// error). Real graded effort only exists on the NATIVE /v1/messages API (verified live:
// output_config.effort 'low' answered a test puzzle in 3 output tokens, 'max' used
// 565-1058, and invalid values 400 with the valid list). So Anthropic chat goes through
// AnthropicNativeChatClient below, and this mapping produces NATIVE params:
//   - 'off' -> thinking disabled.
//   - Haiku 4.5 / Sonnet 4.5 and older: no output_config.effort support, effort tier maps
//     to a thinking budget instead.
//   - Everything newer (Sonnet 5, 4.6-era, Opus 4.x, Fable): output_config.effort, the
//     real thing (low | medium | high | xhigh | max).
const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = {
  low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576,
};
const ANTHROPIC_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];
function anthropicReasoningParams(effort: string, model: string): Record<string, any> {
  const e = effort.toLowerCase().trim();
  if (e === 'off' || e === 'none' || e === 'disabled') return { thinking: { type: 'disabled' } };
  if (/haiku|sonnet-4-5|claude-3/.test(model)) {
    const budget = ANTHROPIC_THINKING_BUDGETS[e];
    if (!budget) {
      console.warn(`[AI] anthropic: unknown effort '${effort}' for ${model} (valid: off, low, medium, high, xhigh, max), thinking left at model default`);
      return {};
    }
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  if (!ANTHROPIC_EFFORT_VALUES.includes(e)) {
    console.warn(`[AI] anthropic: unknown effort '${effort}' (valid: off, low, medium, high, xhigh, max), using model default`);
    return {};
  }
  return { output_config: { effort: e } };
}

// Speaks Anthropic's NATIVE /v1/messages API while exposing the same
// client.chat.completions.create() surface the rest of the app uses, so effort and
// thinking controls actually work (the OpenAI-compat endpoint drops them, see above).
export class AnthropicNativeChatClient {
  constructor(private apiKey: string) {}
  chat = {
    completions: {
      create: async (params: Record<string, any>): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
        const msgs = params.messages as Array<{ role: string; content: string }>;
        // Native supports a single system param, so hoist system messages (same rule the
        // compat endpoint applies).
        const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
        const body: Record<string, any> = {
          model: params.model,
          // Native requires max_tokens. Thinking counts toward it, so leave headroom.
          max_tokens: params.max_completion_tokens ?? params.max_tokens ?? 32000,
          messages: msgs.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content })),
        };
        if (system) body.system = system;
        if (params.thinking) body.thinking = params.thinking;
        if (params.output_config) body.output_config = params.output_config;
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // High-effort calls can think for a long time.
          signal: AbortSignal.timeout(600000),
        });
        if (!res.ok) {
          const errText = (await res.text()).slice(0, 500);
          const err: any = new Error(`Anthropic API ${res.status}: ${errText}`);
          // chatCreateWithRetry keys its retry decision off err.status (429/5xx retried).
          err.status = res.status;
          throw err;
        }
        const data: any = await res.json();
        const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        return {
          id: data.id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: data.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text, refusal: null },
            finish_reason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
            logprobs: null,
          }],
          usage: {
            prompt_tokens: data.usage?.input_tokens ?? 0,
            completion_tokens: data.usage?.output_tokens ?? 0,
            total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
          },
        } as OpenAI.Chat.Completions.ChatCompletion;
      },
    },
  };
}

export const CHAT_PROVIDERS: Record<string, ChatProviderDef> = {
  openai: { keySetting: 'openai_api_key', reasoningParams: (e) => ({ reasoning_effort: e }) },
  // DeepInfra accepts OpenAI-style reasoning_effort for reasoning models like gpt-oss
  // (validated live 2026-07-02); non-reasoning models simply ignore it.
  deepinfra: { baseURL: 'https://api.deepinfra.com/v1/openai', keySetting: 'deepinfra_api_key', reasoningParams: (e) => ({ reasoning_effort: e }) },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', keySetting: 'openrouter_api_key', reasoningParams: (e) => ({ reasoning: { effort: e } }) },
  anthropic: { baseURL: 'https://api.anthropic.com/v1/', keySetting: 'anthropic_api_key', reasoningParams: anthropicReasoningParams },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keySetting: 'gemini_api_key', reasoningParams: (e) => ({ reasoning_effort: e }) },
};

// Model-aware input character cap for scriptwriter/chat prompts. Baseline 400000 chars
// (~100k tokens) fits every supported model, larger caps for known big-context models so
// long articles are not needlessly truncated on models that can handle them.
// - /gpt-5/ -> 1200000 (400k-token context)
// - /gemini/ -> 1500000
// - /claude-(sonnet-5|sonnet-4-6|opus-4|fable)/ -> 1500000 (1M-token contexts)
// claude-haiku is deliberately NOT matched (200k context, baseline is right).
export function chatInputCharCap(model: string): number {
  const m = (model || '').toLowerCase();
  if (/gpt-5/.test(m)) return 1200000;
  if (/gemini/.test(m)) return 1500000;
  if (/claude-(sonnet-5|sonnet-4-6|opus-4|fable)/.test(m)) return 1500000;
  return 400000;
}

// The narrow chat surface every consumer uses. Both the OpenAI SDK client (all
// OpenAI-compatible providers) and AnthropicNativeChatClient satisfy it.
export interface ChatCompletionsClient {
  chat: { completions: { create: (params: any) => Promise<OpenAI.Chat.Completions.ChatCompletion> } };
}

export interface ChatClientConfig {
  client: ChatCompletionsClient;
  model: string;
  extraParams: Record<string, any>; // reasoning params (empty unless a reasoning effort is set)
}

// Legacy `narration_llm` routing → concrete {provider, model}. Doubles as the key-aware
// default for unconfigured accounts: 'auto' picks the first provider with a configured key
// in recommendation order, with GPT-5 Mini (OpenAI) first.
const CHAT_PROVIDER_PRIORITY = ['openai', 'deepinfra', 'anthropic', 'gemini', 'openrouter'];
async function legacyNarrationConfig(userId: number): Promise<{ provider: string; model: string }> {
  const llm = (await getUserSetting(userId, 'narration_llm')) || 'auto';
  if (llm === 'openai-mini' || llm === 'openai') return { provider: 'openai', model: CHAT_DEFAULT_MODELS.openai };
  // 'deepseek' was an explicit user choice, keep it literal (the deepinfra DEFAULT moved on).
  if (llm === 'deepseek') return { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V3.2' };
  for (const provider of CHAT_PROVIDER_PRIORITY) {
    if (await getUserSetting(userId, CHAT_PROVIDERS[provider].keySetting)) {
      return { provider, model: CHAT_DEFAULT_MODELS[provider] };
    }
  }
  return { provider: 'openai', model: CHAT_DEFAULT_MODELS.openai };
}

// Default chat model per provider, used when a job's provider is set but its model field
// is left blank. The Settings hints advertise these as "default = ..." (keep in sync with
// CHAT_PROVIDERS in SettingsPage.tsx).
export const CHAT_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-5-mini',
  // gpt-oss-120b over DeepSeek V3.2: DeepInfra serves DeepSeek at ~20 tok/s (measured
  // 2026-07-02), while gpt-oss runs ~46 tok/s, costs less, and supports reasoning effort.
  deepinfra: 'openai/gpt-oss-120b',
  openrouter: 'openai/gpt-5-mini',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-3-flash-preview',
};

// Default reasoning effort per provider when the user leaves the effort field blank.
// Haiku degrades badly without extended thinking, so Anthropic jobs think by default.
// NOTE: the earlier belief that the compat endpoint "accepts reasoning_effort" was wrong,
// it silently ignores it. Since 2026-07-06 this default is honored for real via the
// native `thinking` param mapping in anthropicReasoningParams().
export const CHAT_DEFAULT_EFFORT: Record<string, string> = {
  anthropic: 'high',
};

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
  // A set provider with a blank model uses that provider's default model.
  const effectiveModel = model || (provider ? CHAT_DEFAULT_MODELS[provider] : '');
  if (provider && effectiveModel) return { provider, model: effectiveModel, effort };
  // Not configured yet → legacy narration mapping (covers all three chat jobs pre-migration).
  const legacy = await legacyNarrationConfig(userId);
  return { provider: legacy.provider, model: legacy.model, effort };
}

function buildChatClient(apiKey: string, def: ChatProviderDef, provider: string): ChatCompletionsClient {
  // Anthropic chat goes through the native API so effort and thinking controls work
  // (the OpenAI-compat endpoint silently drops them, verified live 2026-07-06).
  if (provider === 'anthropic') return new AnthropicNativeChatClient(apiKey);
  return new OpenAI(def.baseURL ? { apiKey, baseURL: def.baseURL } : { apiKey }) as unknown as ChatCompletionsClient;
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
      const effectiveEffort = effort || CHAT_DEFAULT_EFFORT[provider] || '';
      const extraParams = effectiveEffort ? def.reasoningParams(effectiveEffort, model) : {};
      logChatConfig(job, provider, model, effectiveEffort, extraParams);
      return { client: buildChatClient(apiKey, def, provider), model, extraParams };
    }
    console.warn(`[AI] ${job}: provider '${provider}' has no API key, falling back`);
  }

  // Fallback: legacy narration mapping (picks the first key-bearing provider).
  const legacy = await legacyNarrationConfig(userId);
  const legacyDef = CHAT_PROVIDERS[legacy.provider];
  const legacyKey = await getUserSetting(userId, legacyDef.keySetting);
  if (legacyKey) {
    const effectiveEffort = effort || CHAT_DEFAULT_EFFORT[legacy.provider] || '';
    const extraParams = effectiveEffort ? legacyDef.reasoningParams(effectiveEffort, legacy.model) : {};
    logChatConfig(job, legacy.provider, legacy.model, effectiveEffort, extraParams);
    return { client: buildChatClient(legacyKey, legacyDef, legacy.provider), model: legacy.model, extraParams };
  }
  return null;
}

// One concise line per LLM call so the Railway logs show exactly which provider, model,
// and effort params were sent (the request side; the response side is logged in
// chatCreateWithRetry with the model the API actually served).
function logChatConfig(job: string, provider: string, model: string, effort: string, extraParams: Record<string, any>): void {
  const extras = Object.keys(extraParams).length ? ` sending=${JSON.stringify(extraParams)}` : '';
  console.log(`[AI] ${job}: provider=${provider} model=${model} effort=${effort || '(provider default)'}${extras}`);
}

/**
 * Back-compat wrapper for the narration job, without the reasoning extraParams.
 * Prefer getChatClientForJob() in new code so reasoning effort is honored.
 */
export async function getChatClientForUser(userId: number): Promise<{ client: ChatCompletionsClient; model: string } | null> {
  const cfg = await getChatClientForJob(userId, 'narration');
  return cfg ? { client: cfg.client, model: cfg.model } : null;
}

// Retry a chat-completion call with exponential backoff. Connection-level failures (e.g.
// "Premature close" / ECONNRESET on a reused keep-alive socket, see Node #63989) and
// 429/5xx are transient and almost always succeed on a fresh attempt. 4xx (bad request /
// auth) are NOT retried. Summaries previously had no retry, so these surfaced as failures
// while TTS/transcription (which already retry) silently recovered.
export async function chatCreateWithRetry(
  client: ChatCompletionsClient,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & Record<string, any>,
  label: string
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = PROCESSING_CONFIG.retry;
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.chat.completions.create(params);
      // The response `model` field is ground truth for which model actually served the
      // call (the request-side config is logged by getChatClientForJob).
      console.log(`${label} done: served_by=${response.model} tokens_in=${response.usage?.prompt_tokens ?? '?'} tokens_out=${response.usage?.completion_tokens ?? '?'}`);
      return response;
    } catch (err: any) {
      lastErr = err;
      const status: number | undefined = err?.status;
      // Retry connection errors (no status) and 429/5xx; give up on 4xx.
      const retryable = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      console.warn(`${label} attempt ${attempt}/${maxAttempts} failed (${status ?? 'conn'}): ${err?.message}. Retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function getTTSOptionsForUser(userId: number): Promise<{ voice: string; model: string }> {
  const savedVoice = await getUserSetting(userId, 'openai_tts_voice');
  const savedModel = await getUserSetting(userId, 'openai_tts_model');
  const fallback = await defaultTTSChoice(userId);
  const model = savedModel || fallback.model;
  // The voice default follows the model family, so a Kokoro model never gets an OpenAI
  // voice name (and vice versa).
  const isKokoro = model.includes('Kokoro') || model.startsWith('hexgrad/');
  const voice = savedVoice || (isKokoro ? 'am_puck' : 'coral');
  return { voice, model };
}

// A single selectable voice. `model` carries the provider (OpenAI vs Kokoro/DeepInfra) so a
// list of voices can span TTS models, so the TTS client is routed per the picked model.
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
  // Kokoro voices are usable with a DeepInfra key OR an OpenRouter key (same voices).
  // getTTSClientForUser serves Kokoro via OpenRouter as a fallback even when
  // kokoro_tts_provider is unset, so an OpenRouter-only user can still synthesize them.
  // OpenAI voices always need an OpenAI key.
  const hasOpenRouter = !!(await getUserSetting(userId, 'openrouter_api_key'));
  const canKokoroVoices = hasDeepInfra || hasOpenRouter;
  voices = voices.filter(v => {
    const isKokoro = v.model.includes('Kokoro') || v.model.startsWith('hexgrad/');
    return isKokoro ? canKokoroVoices : hasOpenAI;
  });
  if (voices.length === 0) return null;

  return voices[Math.floor(Math.random() * voices.length)];
}
