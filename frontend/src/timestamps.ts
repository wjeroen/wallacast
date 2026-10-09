// Chapter times in a podcast description, like "(00:36:06) Topic", "12:34 Intro" or
// "1h02m03s", become buttons that move the episode to that moment (the Description tab in
// FullscreenPlayer.tsx). The times are the podcast's own show notes, read as written, and
// nothing is matched against the transcript. An episode with dynamically inserted ads can
// run longer or shorter than its show notes assume, so a tap can land a little early or late.

// H:MM:SS, MM:SS or M:SS (up to 999 minutes without an hours part), or 1h02m03s / 1h 2m /
// 12m30s. A time followed by am, pm, uur, u or h is a clock time ("20:00 uur"). "20h30" has
// no "m" and is not read either, because Belgian and French notes write clock times that way.
const TIME_PATTERN = new RegExp(
  '(?<![\\d:])(?:(\\d{1,2}):([0-5]\\d):([0-5]\\d)|(\\d{1,3}):([0-5]\\d))(?![\\d:])' +
    '(?!\\s?(?:am|pm|AM|PM|a\\.m\\.|p\\.m\\.|uur|u|h)(?![\\p{L}\\p{N}]))' +
    '|(?<![\\p{L}\\p{N}])(?:(\\d{1,2})h\\s?([0-5]?\\d)m(?:\\s?([0-5]?\\d)s)?|(\\d{1,3})m\\s?([0-5]?\\d)s)(?![\\p{L}\\p{N}])',
  'gu'
);

// Text inside these keeps its own meaning: a link or button already does something, and
// code is never a chapter list.
const SKIP_INSIDE = 'a, button, code, pre';

function toSeconds(m: RegExpMatchArray): number {
  const n = (i: number) => Number(m[i] || 0);
  if (m[1] !== undefined) return n(1) * 3600 + n(2) * 60 + n(3);
  if (m[4] !== undefined) return n(4) * 60 + n(5);
  if (m[6] !== undefined) return n(6) * 3600 + n(7) * 60 + n(8);
  return n(9) * 60 + n(10);
}

/**
 * Returns the (already sanitized) description HTML with every chapter time wrapped in
 * `<button class="description-timestamp" data-seconds="...">`. Times at or past
 * `maxSeconds` (the episode's length, 0 when unknown) are left as text, because a seek
 * past the end would finish the episode and start the next one. A description with fewer
 * than two distinct times comes back unchanged: a lone time is more often a clock time,
 * a score or a verse number than a chapter.
 */
export function linkDescriptionTimestamps(html: string, maxSeconds: number): string {
  if (!html || !/\d[:hm]/.test(html)) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const doc = template.content.ownerDocument;
  const fits = (seconds: number) => !(maxSeconds > 0) || seconds < maxSeconds;

  const found: { node: Text; times: { index: number; text: string; seconds: number }[] }[] = [];
  const distinct = new Set<number>();
  const walker = doc.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest(SKIP_INSIDE)) continue;
    const times = [];
    for (const m of node.data.matchAll(TIME_PATTERN)) {
      const seconds = toSeconds(m);
      if (!fits(seconds)) continue;
      times.push({ index: m.index!, text: m[0], seconds });
      distinct.add(seconds);
    }
    if (times.length > 0) found.push({ node, times });
  }
  if (distinct.size < 2) return html;

  for (const { node, times } of found) {
    const fragment = doc.createDocumentFragment();
    let last = 0;
    for (const { index, text, seconds } of times) {
      fragment.append(node.data.slice(last, index));
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'description-timestamp';
      button.dataset.seconds = String(seconds);
      button.textContent = text;
      fragment.append(button);
      last = index + text.length;
    }
    fragment.append(node.data.slice(last));
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}
