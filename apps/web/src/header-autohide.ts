/**
 * Whether the workspace header should be tucked away while a page scrolls.
 *
 * Scrolling down past the first screenful gives the page the header's height;
 * any scroll back up, or reaching the top, brings it back. A couple of pixels
 * either way is ignored so a trackpad's jitter does not make it flicker.
 */
export const HEADER_HIDE_AFTER = 72;
export const HEADER_TOP_ZONE = 24;
const JITTER = 2;

export function nextHeaderHidden(hidden: boolean, previousTop: number, top: number): boolean {
  if (top <= HEADER_TOP_ZONE) return false;
  if (top > previousTop + JITTER && top > HEADER_HIDE_AFTER) return true;
  if (top < previousTop - JITTER) return false;
  return hidden;
}
