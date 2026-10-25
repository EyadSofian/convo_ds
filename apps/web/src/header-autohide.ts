/**
 * Whether the workspace header should be tucked away while a page scrolls.
 *
 * Scrolling down past the first screenful gives the page the header's height;
 * any scroll back up, or reaching the top, brings it back. A couple of pixels
 * either way is ignored so a trackpad's jitter does not make it flicker.
 */
export const HEADER_HIDE_AFTER = 72;
export const HEADER_TOP_ZONE = 24;
/** At least the header's own height (`--header-height`, 56px), with margin. */
export const HEADER_ROOM = 80;
const JITTER = 2;

/**
 * `maxTop` is how far the page can scroll (`scrollHeight - clientHeight`).
 * Zero means the geometry is unknown, as in a test DOM with no layout; a real
 * page that cannot scroll fires no scroll events to ask about.
 */
export function nextHeaderHidden(hidden: boolean, previousTop: number, top: number, maxTop = 0): boolean {
  if (maxTop > 0) {
    // Closing the header grows the page by its height, so the browser pulls a
    // scroll that sat at the bottom back up. That is layout, not the reader:
    // answering it reopened the header, which closed again on the next scroll,
    // and the page shook.
    if (hidden && top < previousTop && top >= maxTop - JITTER) return true;
    // Never tuck the header away on a page too short to keep scrolling after
    // it has: the page would stop scrolling and the header could not return.
    if (!hidden && maxTop < HEADER_HIDE_AFTER + HEADER_ROOM) return top <= HEADER_TOP_ZONE ? false : hidden;
  }
  if (top <= HEADER_TOP_ZONE) return false;
  if (top > previousTop + JITTER && top > HEADER_HIDE_AFTER) return true;
  if (top < previousTop - JITTER) return false;
  return hidden;
}
