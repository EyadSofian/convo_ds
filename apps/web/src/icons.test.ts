/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { ICON_PATHS, icon } from './icons';
import type { IconName } from './icons';

describe('icon', () => {
  it('renders every icon in the set as inline SVG', () => {
    for (const name of Object.keys(ICON_PATHS) as IconName[]) {
      const element = icon(name);
      expect(element.tagName.toLowerCase()).toBe('svg');
      expect(element.innerHTML.length).toBeGreaterThan(0);
      expect(element.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('accepts a size and extra attributes', () => {
    const element = icon('check', 24, { class: 'x' });
    expect(element.getAttribute('width')).toBe('24');
    expect(element.getAttribute('class')).toBe('x');
  });

  it('marks only reading-direction chevrons for RTL mirroring', () => {
    expect(icon('chevronStart', 16, { class: 'x' }).getAttribute('class')).toBe('icon--directional x');
    expect(icon('chevronEnd').getAttribute('class')).toBe('icon--directional');
    expect(icon('chevronDown').getAttribute('class')).toBeNull();
    expect(icon('search').getAttribute('class')).toBeNull();
  });

  it('draws icons rather than using emoji or a font glyph', () => {
    for (const markup of Object.values(ICON_PATHS)) {
      expect(markup).toMatch(/^<(path|circle|rect)/);
    }
  });
});
