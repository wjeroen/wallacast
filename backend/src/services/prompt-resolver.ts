import { getUserSetting } from './ai-providers.js';

/**
 * Central helper for user-customizable LLM prompts.
 *
 * Every editable prompt in the app keeps its built-in default as an exported const in its own
 * service file (so defaults stay byte-identical and behavior never changes unless the user sets
 * an override). At call time the service calls `resolveCustomPrompt()`, which substitutes a
 * per-user override from Settings when present, else uses the default. Placeholders written as
 * `{token}` are filled in either way.
 *
 * The metadata that drives the Settings UI (id, category, label, default text, placeholder list)
 * lives in `prompt-registry.ts`. This module is intentionally tiny and imports ONLY ai-providers,
 * so the services can depend on it without an import cycle.
 */

// Replace every `{token}` in `tpl` with the provided value. Tokens with no provided value are
// left as-is (harmless, e.g. a single-paragraph summary prompt simply never mentions {maxTweets}).
export function fillPrompt(tpl: string, vars: Record<string, string | number> = {}): string {
  let out = tpl;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  return out;
}

// Resolve a prompt: a non-empty per-user override (stored under `settingKey` in user_settings)
// wins over `defaultPrompt`; blank/whitespace override falls back to the default. Either way the
// `{placeholders}` are filled from `vars`.
export async function resolveCustomPrompt(
  userId: number,
  settingKey: string,
  defaultPrompt: string,
  vars: Record<string, string | number> = {}
): Promise<string> {
  const override = ((await getUserSetting(userId, settingKey)) || '').trim();
  return fillPrompt(override || defaultPrompt, vars);
}
