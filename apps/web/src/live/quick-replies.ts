import { normalizeSearchText } from '@convo/domain';
import type { QuickReply, QuickReplyLocation } from '../api/metadata.js';

/** The open "/shortcut" being typed: where it sits in the draft and what it says so far. */
export interface SlashToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** How many suggestions the "/" list shows at once. */
export const SLASH_LIMIT = 6;

/**
 * The "/word" that ends at the caret, if the caret is in one.
 *
 * A slash only opens the list at the start of the draft or after whitespace,
 * so a link (`https://…`) or a date (`1/2`) never does.
 */
export function slashToken(value: string, caret: number): SlashToken | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const match = /(^|\s)\/([^\s/]*)$/u.exec(before);
  if (match === null) return null;
  const start = before.length - match[2]!.length - 1;
  return { start, end: before.length, query: match[2]! };
}

/**
 * Replies whose shortcut starts with what was typed come first, then those
 * whose shortcut or title merely contains it. Arabic and English compare the
 * way search does elsewhere: case, diacritics and letter forms aside.
 */
export function matchQuickReplies(replies: readonly QuickReply[], query: string, limit = SLASH_LIMIT): readonly QuickReply[] {
  const needle = normalizeSearchText(query);
  if (needle === '') return replies.slice(0, limit);
  const prefix: QuickReply[] = [];
  const contains: QuickReply[] = [];
  for (const reply of replies) {
    const shortcut = normalizeSearchText(reply.shortcut);
    if (shortcut.startsWith(needle)) prefix.push(reply);
    else if (shortcut.includes(needle) || normalizeSearchText(reply.title).includes(needle)) contains.push(reply);
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** A link that opens the place in any maps app the customer has. */
export function mapsUrl(location: QuickReplyLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
}

/**
 * What a quick reply puts in the composer.
 *
 * A location becomes ordinary text — the place, its address, a map link and
 * any note — so it goes out on every channel the conversation can use, inside
 * the same messaging window as any other reply.
 */
export function quickReplyText(reply: QuickReply): string {
  if (reply.kind !== 'location' || reply.location === null) return reply.body;
  const place = reply.location;
  return [`📍 ${place.name}`, place.address, mapsUrl(place), reply.body === '' ? null : reply.body]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Puts a reply's text over the "/shortcut" that asked for it, or at the caret without one. */
export function applyQuickReply(value: string, selection: { readonly start: number; readonly end: number }, text: string): { readonly value: string; readonly caret: number } {
  const next = `${value.slice(0, selection.start)}${text}${value.slice(selection.end)}`;
  return { value: next, caret: selection.start + text.length };
}
