/**
 * Central registry of every user-editable LLM prompt in the app.
 *
 * Each service owns its default prompt string (exported const) and resolves it at call time via
 * `resolveCustomPrompt()` (prompt-resolver.ts). This registry just collects those defaults plus the
 * metadata the Settings UI needs to render an editable box per prompt: id, category, label,
 * description, and the list of `{placeholder}` tokens that get substituted at generation time.
 *
 * Setting key convention: `prompt_<id>`. A blank/whitespace override means "use the built-in default".
 *
 * This module is imported ONLY by the users route (for the GET /api/users/prompts endpoint and the
 * settings-key whitelist). Services never import it, so there's no import cycle.
 */

import {
  ARTICLE_SUMMARY_MULTI_DEFAULT,
  ARTICLE_SUMMARY_SINGLE_DEFAULT,
  COMMENT_SUMMARY_MULTI_DEFAULT,
  COMMENT_SUMMARY_SINGLE_DEFAULT,
  PODCAST_SUMMARY_MULTI_DEFAULT,
  PODCAST_SUMMARY_SINGLE_DEFAULT,
} from './summarizer.js';
import { NARRATION_SCRIPT_DEFAULT, NARRATION_SCRIPT_RETRY_DEFAULT } from './openai-tts.js';
import { IMAGE_DESCRIPTION_DEFAULT } from './image-alt-text.js';
import { ALIGNMENT_RULES_DEFAULT } from './llm-alignment.js';

export interface PromptVar {
  token: string;       // e.g. 'maxTweets' (written as {maxTweets} in the prompt)
  desc: string;
}

export interface PromptDef {
  id: string;          // stable id; setting key is `prompt_<id>`
  category: string;    // group header in Settings
  label: string;
  description: string;
  vars: PromptVar[];
  default: string;
}

const V = {
  maxTweets: { token: 'maxTweets', desc: 'the maximum number of paragraphs, set by the length tiers' },
  maxWords: { token: 'maxWords', desc: 'the maximum words per paragraph, set by Words per paragraph' },
  inputImageCount: { token: 'inputImageCount', desc: 'how many image descriptions the first pass dropped' },
};

const CAT_SUMMARIES = 'Summaries';
const CAT_NARRATION = 'Narration (text to speech)';
const CAT_ALIGNMENT = 'Read-along alignment';
const CAT_IMAGE = 'Image descriptions';

export const PROMPT_REGISTRY: PromptDef[] = [
  // ----- Summaries (6: each kind has a multi-paragraph and a single-paragraph variant) -----
  {
    id: 'summary_article_multi', category: CAT_SUMMARIES,
    label: 'Article / text summary (multiple paragraphs)',
    description: 'Used for most articles and texts (anything that is not a podcast).',
    vars: [V.maxTweets, V.maxWords], default: ARTICLE_SUMMARY_MULTI_DEFAULT,
  },
  {
    id: 'summary_article_single', category: CAT_SUMMARIES,
    label: 'Article / text summary (single paragraph)',
    description: 'Used for short articles and texts that only get one paragraph.',
    vars: [V.maxWords], default: ARTICLE_SUMMARY_SINGLE_DEFAULT,
  },
  {
    id: 'summary_comment_multi', category: CAT_SUMMARIES,
    label: 'Comment summary (multiple paragraphs)',
    description: 'Summarizes the comment discussion when it gets more than one paragraph.',
    vars: [V.maxTweets, V.maxWords], default: COMMENT_SUMMARY_MULTI_DEFAULT,
  },
  {
    id: 'summary_comment_single', category: CAT_SUMMARIES,
    label: 'Comment summary (single paragraph)',
    description: 'Summarizes a short comment discussion in one paragraph.',
    vars: [V.maxWords], default: COMMENT_SUMMARY_SINGLE_DEFAULT,
  },
  {
    id: 'summary_podcast_multi', category: CAT_SUMMARIES,
    label: 'Podcast summary (multiple paragraphs)',
    description: 'Summarizes a podcast episode transcript across several paragraphs.',
    vars: [V.maxTweets, V.maxWords], default: PODCAST_SUMMARY_MULTI_DEFAULT,
  },
  {
    id: 'summary_podcast_single', category: CAT_SUMMARIES,
    label: 'Podcast summary (single paragraph)',
    description: 'Summarizes a short podcast episode in one paragraph.',
    vars: [V.maxWords], default: PODCAST_SUMMARY_SINGLE_DEFAULT,
  },

  // ----- Narration / TTS scriptwriter -----
  {
    id: 'narration_script', category: CAT_NARRATION,
    label: 'TTS scriptwriter (main)',
    description: 'Rewrites article HTML into the plain-text script the TTS voice reads.',
    vars: [], default: NARRATION_SCRIPT_DEFAULT,
  },
  {
    id: 'narration_script_retry', category: CAT_NARRATION,
    label: 'TTS scriptwriter (image-drop retry)',
    description: 'Appended to the main prompt and retried when the first pass drops image descriptions.',
    vars: [V.inputImageCount], default: NARRATION_SCRIPT_RETRY_DEFAULT,
  },

  // ----- Read-along alignment -----
  {
    id: 'alignment_rules', category: CAT_ALIGNMENT,
    label: 'Read-along alignment rules',
    description: 'The instruction + examples block that tells the LLM how to map each text element to an audio timestamp. The element list and transcript are added automatically around it.',
    vars: [], default: ALIGNMENT_RULES_DEFAULT,
  },

  // ----- Image descriptions -----
  {
    id: 'image_description', category: CAT_IMAGE,
    label: 'Image description',
    description: 'Asks the vision model to describe an article image for audio narration.',
    vars: [], default: IMAGE_DESCRIPTION_DEFAULT,
  },
];

// Setting key for a prompt id, and the full list (used to whitelist keys in the users route).
export const promptSettingKey = (id: string): string => `prompt_${id}`;
export const PROMPT_SETTING_KEYS: string[] = PROMPT_REGISTRY.map((p) => promptSettingKey(p.id));
