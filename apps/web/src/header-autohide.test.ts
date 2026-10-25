import { describe, expect, it } from 'vitest';
import { HEADER_HIDE_AFTER, HEADER_ROOM, HEADER_TOP_ZONE, nextHeaderHidden } from './header-autohide';

describe('nextHeaderHidden', () => {
  it('hides on a scroll down past the first screenful and shows on any scroll up', () => {
    expect(nextHeaderHidden(false, 0, HEADER_HIDE_AFTER + 10)).toBe(true);
    expect(nextHeaderHidden(true, 400, 300)).toBe(false);
  });

  it('keeps its state inside the jitter band and just below the threshold', () => {
    expect(nextHeaderHidden(true, 300, 301)).toBe(true);
    expect(nextHeaderHidden(false, 300, 299)).toBe(false);
    expect(nextHeaderHidden(false, 40, HEADER_HIDE_AFTER - 1)).toBe(false);
  });

  it('always shows at the top of the page', () => {
    expect(nextHeaderHidden(true, 200, HEADER_TOP_ZONE)).toBe(false);
  });
});

describe('nextHeaderHidden with page geometry', () => {
  const MAX = 1000;

  it('ignores the pull-back at the bottom that closing the header causes', () => {
    // Hidden at the very bottom; the page grew, so the browser clamps 56px up.
    expect(nextHeaderHidden(true, MAX, MAX - 56, MAX - 56)).toBe(true);
    // A reader scrolling up from the bottom still brings it back.
    expect(nextHeaderHidden(true, MAX, MAX - 120, MAX)).toBe(false);
    // Scrolling down to the bottom keeps it hidden as before.
    expect(nextHeaderHidden(true, MAX - 10, MAX, MAX)).toBe(true);
  });

  it('never hides the header on a page too short to keep scrolling without it', () => {
    const short = HEADER_HIDE_AFTER + HEADER_ROOM - 1;
    expect(nextHeaderHidden(false, 0, short, short)).toBe(false);
    expect(nextHeaderHidden(false, 0, HEADER_TOP_ZONE, short)).toBe(false);
    expect(nextHeaderHidden(false, 0, HEADER_HIDE_AFTER + 10, HEADER_HIDE_AFTER + HEADER_ROOM)).toBe(true);
  });

  it('keeps the usual rules in the middle of a long page', () => {
    expect(nextHeaderHidden(false, 100, 300, MAX)).toBe(true);
    expect(nextHeaderHidden(true, 300, 200, MAX)).toBe(false);
    expect(nextHeaderHidden(true, 300, 10, MAX)).toBe(false);
  });
});
