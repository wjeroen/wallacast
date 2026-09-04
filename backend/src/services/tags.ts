/**
 * Tag rules shared by the content routes and the Wallabag sync.
 *
 * Storage model: `content_items.tags` is a Postgres TEXT[] holding ONLY the user's own
 * tags, already normalized. The three type tags (article / text / podcast) are never
 * stored, they are derived from `content_items.type` and added back on push. Labels are
 * normalized exactly the way Wallabag normalizes them (TagsAssigner.php: split on comma,
 * trim, lowercase), so a tag pushed to Wallabag comes back byte-identical on pull and
 * never causes update churn.
 */

/** Wallabag tag that marks the item's Wallacast type. Never user-editable. */
export const TYPE_TAGS = ['article', 'text', 'podcast'] as const;

/** Reserved names the tag picker refuses. nosync is managed in Wallabag only. */
export const RESERVED_TAGS = new Set<string>([...TYPE_TAGS, 'nosync', '#nosync']);

export const MAX_TAG_LENGTH = 100;

/** Normalize one label the way Wallabag does (trim + lowercase), plus no commas and
 *  collapsed inner whitespace. Returns '' for labels that normalize to nothing. */
export function normalizeTag(label: unknown): string {
  if (typeof label !== 'string') return '';
  return label
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

/** Normalize a list: drop empties and duplicates, keep first-seen order. Reserved names
 *  are dropped when `dropReserved` is true (the default), which is what every write path
 *  wants, since the type tag is derived and nosync is Wallabag-only. */
export function normalizeTagList(labels: unknown, dropReserved = true): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const raw of labels) {
    const t = normalizeTag(raw);
    if (!t) continue;
    if (dropReserved && RESERVED_TAGS.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** The reserved names present in a raw list, for a helpful 400 message. */
export function findReservedTags(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map(normalizeTag).filter((t) => t && RESERVED_TAGS.has(t));
}

/** Whether a stored tag array carries the nosync marker (items that must never push). */
export function hasNosyncTag(tags: readonly string[] | null | undefined): boolean {
  if (!tags) return false;
  return tags.some((t) => {
    const n = normalizeTag(t);
    return n === 'nosync' || n === '#nosync';
  });
}

/** The Wallabag type tag for a Wallacast content type. */
export function typeTagFor(type: string): (typeof TYPE_TAGS)[number] {
  switch (type) {
    case 'podcast_episode': return 'podcast';
    case 'text': return 'text';
    default: return 'article';
  }
}

/** The comma-separated string Wallabag expects on create/update: type tag first, then the
 *  user's tags. Wallabag's PATCH replaces the whole set, so this is always the full list. */
export function wallabagTagString(type: string, tags: readonly string[] | null | undefined): string {
  return [typeTagFor(type), ...normalizeTagList(tags ?? [])].join(',');
}

/** The user tags in a Wallabag entry's label list: type tags and nosync stripped. */
export function userTagsFromWallabagLabels(labels: readonly string[]): string[] {
  return normalizeTagList([...labels]);
}

/** Set equality for two tag lists (order-insensitive). */
export function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((t) => s.has(t));
}

/**
 * Three-way merge of an item's tags: `base` is the set both sides agreed on at the last
 * sync (`content_items.wallabag_synced_tags`), `local` what Wallacast has now, `remote`
 * what Wallabag has now. Changes made on either side since the base survive, and a tag
 * only disappears when one side deliberately removed it:
 *   - added in Wallabag   (remote - base) -> added locally
 *   - removed in Wallabag (base - remote) -> removed locally (unless re-added locally later)
 *   - added locally       (local - base)  -> kept (the push sends it)
 *   - removed locally     (base - local)  -> stays removed (NOT re-added from remote)
 * With no local edits (local == base) the result is exactly `remote`. Order: local first,
 * then remote additions.
 */
export function mergeTagSets(
  base: readonly string[] | null | undefined,
  local: readonly string[],
  remote: readonly string[]
): string[] {
  const b = new Set(base ?? local);
  const r = new Set(remote);
  const out: string[] = [];
  for (const t of local) {
    const removedRemotely = b.has(t) && !r.has(t);
    if (!removedRemotely && !out.includes(t)) out.push(t);
  }
  for (const t of remote) {
    const addedRemotely = !b.has(t);
    if (addedRemotely && !out.includes(t)) out.push(t);
  }
  return out;
}
