/**
 * Cuts for text that goes to an AI service, on whole letters.
 *
 * JavaScript stores a letter outside the basic plane (an emoji, or a "bold" math letter such
 * as 𝐥 from a quoted tweet) as two halves, and slice() counts halves. A cut between them
 * keeps one half, JSON.stringify writes it as an escape such as \ud835, and OpenAI refuses the
 * whole request as unreadable: 400 "failed to parse JSON value" (item 2803 on 2026-11-23, its
 * comment summary cut the article at 50,000 in the middle of a bold tweet). These cuts move
 * one place back or forward instead, so both halves stay or go together.
 */

const isFirstHalf = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isSecondHalf = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `end` for a slice(start, end), one place earlier when it falls between the two halves of a letter. */
export function wholeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  return isFirstHalf(text.charCodeAt(end - 1)) && isSecondHalf(text.charCodeAt(end)) ? end - 1 : end;
}

/** The first `max` units of `text`, without half a letter at the end. */
export function cutText(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : text.slice(0, wholeEnd(text, max));
}

/** The last `max` units of `text`, without half a letter at the start. */
export function tailText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const start = text.length - max;
  return text.slice(isSecondHalf(text.charCodeAt(start)) && isFirstHalf(text.charCodeAt(start - 1)) ? start + 1 : start);
}
