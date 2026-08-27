// The user's "Copy content" preferences, read fresh on every copy (two small settings).
// Kept out of markdown.ts so that module stays free of API calls (it also runs in tests).
import { userSettingsAPI } from './api';
import type { CopyContentOptions } from './markdown';

export async function loadCopyContentOptions(): Promise<CopyContentOptions> {
  try {
    const res = await userSettingsAPI.getAll();
    const s = res.data.settings || {};
    return {
      includeSummary: s.copy_include_summary === 'true',
      summaryCodeLabel: (s.copy_summary_code_label || '').trim(),
    };
  } catch (err) {
    console.error('Failed to load copy settings, copying without summary:', err);
    return {};
  }
}
