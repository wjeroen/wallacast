/**
 * Positions saved during this page session, by item. The library list loads once and position
 * saves do not update it, so an item that starts from the list's copy (App.tsx, a queue advance
 * or previous) takes its position from here: an item heard earlier in the session then resumes
 * where it was left, as it does when its full details are fetched first.
 */
type Saved = { playback_position?: number; summary_playback_position?: number };

const saved = new Map<number, Saved>();

export function rememberPosition(id: number, field: keyof Saved, seconds: number): void {
  saved.set(id, { ...saved.get(id), [field]: seconds });
}

export function withSessionPosition<T extends { id: number }>(item: T): T {
  const s = saved.get(item.id);
  return s ? { ...item, ...s } : item;
}
