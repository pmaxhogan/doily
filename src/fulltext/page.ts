/**
 * Offset paging for get_full_text. Pages are cut at a paragraph break when
 * one falls in the second half of the window, else at a sentence end, else at
 * whitespace, else hard at the limit. Concatenating every page in order
 * reproduces the input exactly: no gaps, no overlap.
 */

export const DEFAULT_PAGE_CHARS = 60_000;

export interface TextPage {
  text: string;
  total_chars: number;
  offset: number;
  next_offset?: number;
}

export function pageText(text: string, offset: number, limit = DEFAULT_PAGE_CHARS): TextPage {
  const total = text.length;
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const size = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_PAGE_CHARS;
  if (start >= total) return { text: "", total_chars: total, offset: start };

  const hardEnd = start + size;
  if (hardEnd >= total) return { text: text.slice(start), total_chars: total, offset: start };

  const end = findCut(text, start, hardEnd);
  return { text: text.slice(start, end), total_chars: total, offset: start, next_offset: end };
}

/** A cut point in (start, hardEnd], preferring natural boundaries. */
function findCut(text: string, start: number, hardEnd: number): number {
  const minCut = start + Math.max(1, Math.floor((hardEnd - start) / 2));
  const window = text.slice(start, hardEnd);

  const para = window.lastIndexOf("\n\n");
  if (para >= 0 && start + para + 2 >= minCut) return start + para + 2;

  let sentence = -1;
  const re = /[.!?]["')\]]*\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window))) sentence = m.index + m[0].length;
  if (sentence >= 0 && start + sentence >= minCut) return start + sentence;

  const ws = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
  if (ws >= 0 && start + ws + 1 >= minCut) return start + ws + 1;

  // Hard cut; never split a UTF-16 surrogate pair.
  const code = text.charCodeAt(hardEnd - 1);
  if (code >= 0xd800 && code <= 0xdbff && hardEnd - 1 > start) return hardEnd - 1;
  return hardEnd;
}
