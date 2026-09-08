/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import {
  append,
  applyAttrs,
  attrOf,
  bdi,
  closestWithAttr,
  frag,
  h,
  replace,
  setAttr,
  svgIcon,
} from './dom';

describe('attrOf', () => {
  it('returns the value, or an empty string when the attribute is absent', () => {
    const element = h('button', { 'data-act': 'theme' });
    expect(attrOf(element, 'data-act')).toBe('theme');
    expect(attrOf(element, 'data-arg')).toBe('');
  });
});

describe('setAttr', () => {
  it('skips nullish and false, and renders true as an empty attribute', () => {
    const element = document.createElement('div');
    setAttr(element, 'a', null);
    setAttr(element, 'b', undefined);
    setAttr(element, 'c', false);
    setAttr(element, 'd', true);
    setAttr(element, 'e', 7);
    setAttr(element, 'f', 'x');
    expect(element.hasAttribute('a')).toBe(false);
    expect(element.hasAttribute('b')).toBe(false);
    expect(element.hasAttribute('c')).toBe(false);
    expect(element.getAttribute('d')).toBe('');
    expect(element.getAttribute('e')).toBe('7');
    expect(element.getAttribute('f')).toBe('x');
  });
});

describe('applyAttrs and h', () => {
  it('builds an element with attributes and children', () => {
    const element = h('section', { class: 'x', 'data-n': 2 }, ['hello', h('b', {}, ['world'])]);
    expect(element.tagName).toBe('SECTION');
    expect(element.className).toBe('x');
    expect(element.textContent).toBe('helloworld');
  });

  it('drops nullish and false children', () => {
    const element = h('p', {}, [null, undefined, false, 'kept']);
    expect(element.childNodes).toHaveLength(1);
  });

  it('applies attributes to an existing element', () => {
    const element = document.createElement('div');
    applyAttrs(element, { id: 'z' });
    expect(element.id).toBe('z');
  });
});

describe('append, replace and frag', () => {
  it('replaces all children', () => {
    const parent = h('div', {}, ['old']);
    replace(parent, ['new']);
    expect(parent.textContent).toBe('new');
  });

  it('appends into a fragment', () => {
    const fragment = frag(['a', h('i', {}, ['b'])]);
    expect(fragment.childNodes).toHaveLength(2);
  });

  it('returns the parent it was given', () => {
    const parent = document.createElement('div');
    expect(append(parent, ['x'])).toBe(parent);
  });
});

describe('svgIcon', () => {
  it('creates a namespaced svg with the supplied markup and overridable attrs', () => {
    const element = svgIcon('<path d="M0 0"/>', 20, { 'aria-hidden': 'false' });
    expect(element.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(element.getAttribute('width')).toBe('20');
    expect(element.getAttribute('aria-hidden')).toBe('false');
    expect(element.innerHTML).toContain('path');
  });

  it('defaults to 16px', () => {
    expect(svgIcon('<path/>').getAttribute('height')).toBe('16');
  });
});

describe('bdi', () => {
  it('isolates a mixed-script value', () => {
    const element = bdi('+20 100 234 8190', { class: 'mono' });
    expect(element.tagName).toBe('BDI');
    expect(element.className).toBe('mono');
    expect(element.textContent).toBe('+20 100 234 8190');
  });

  it('works with no attributes', () => {
    expect(bdi('x').textContent).toBe('x');
  });
});

describe('closestWithAttr', () => {
  it('walks up to the nearest element carrying the attribute', () => {
    const outer = h('div', { 'data-act': 'open' }, [h('span', {}, [h('b', {}, ['t'])])]);
    const leaf = outer.querySelector('b');
    expect(closestWithAttr(leaf, 'data-act')).toBe(outer);
  });

  it('returns null for a non-element target and for a miss', () => {
    expect(closestWithAttr(null, 'data-act')).toBeNull();
    expect(closestWithAttr(h('div', {}, []), 'data-act')).toBeNull();
  });
});
