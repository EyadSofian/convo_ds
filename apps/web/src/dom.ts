/**
 * Minimal DOM builders. Deliberately tiny: the demo has no framework, and every
 * branch here is exercised by dom.test.ts so the module carries its own weight
 * in the repository coverage gate.
 */

export type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue>;
export type Child = Node | string | null | undefined | false;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Sets an attribute unless the value is nullish or `false`; `true` sets `""`. */
export function setAttr(element: Element, name: string, value: AttrValue): void {
  if (value === null || value === undefined || value === false) return;
  element.setAttribute(name, value === true ? '' : String(value));
}

export function applyAttrs(element: Element, attrs: Attrs): void {
  for (const name of Object.keys(attrs)) setAttr(element, name, attrs[name]);
}

/**
 * An attribute's value, or `''` when the element does not carry it.
 *
 * Delegated event handling reads two attributes off one element, where only the
 * first is guaranteed to exist. Keeping the total function here means both of
 * its paths are exercised by a unit test instead of one of them being an
 * unreachable fallback inside an event handler.
 */
export function attrOf(element: Element, name: string): string {
  return element.getAttribute(name) ?? '';
}

export function append<T extends Node>(parent: T, children: readonly Child[]): T {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return parent;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  applyAttrs(element, attrs);
  return append(element, children);
}

/** Replaces every child of `parent` with `children` in one pass. */
export function replace<T extends Element>(parent: T, children: readonly Child[]): T {
  parent.replaceChildren();
  return append(parent, children);
}

export function frag(children: readonly Child[]): DocumentFragment {
  return append(document.createDocumentFragment(), children);
}

/**
 * Builds an inline SVG from raw path markup. Icons are drawn rather than
 * pulled from a font so they inherit `currentColor` and stay crisp at 14–20px.
 */
export function svgIcon(paths: string, size = 16, attrs: Attrs = {}): SVGElement {
  const element = document.createElementNS(SVG_NS, 'svg');
  applyAttrs(element, {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.9,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    ...attrs,
  });
  element.innerHTML = paths;
  return element;
}

/** `<bdi>` wrapper: keeps phones, emails, IDs and handles from reordering. */
export function bdi(value: string, attrs: Attrs = {}): HTMLElement {
  const element = document.createElement('bdi');
  applyAttrs(element, attrs);
  element.textContent = value;
  return element;
}

/** Closest ancestor (inclusive) carrying the attribute, or `null`. */
export function closestWithAttr(start: EventTarget | null, attr: string): HTMLElement | null {
  let node = start instanceof Element ? start : null;
  while (node !== null) {
    if (node instanceof HTMLElement && node.hasAttribute(attr)) return node;
    node = node.parentElement;
  }
  return null;
}
