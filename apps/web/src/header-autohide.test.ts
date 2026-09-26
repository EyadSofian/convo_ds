import { describe, expect, it } from 'vitest';
import { HEADER_HIDE_AFTER, HEADER_TOP_ZONE, nextHeaderHidden } from './header-autohide';

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
