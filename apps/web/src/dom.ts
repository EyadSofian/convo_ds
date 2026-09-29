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

/** Update a rendered tree in place so unchanged controls and animations keep their DOM identity. */
export function reconcile(parent: Element, next: Node): void {
  const children = next.nodeType === 11 ? Array.from(next.childNodes) : [next];
  for (let index = 0; index < children.length; index += 1) {
    const current = parent.childNodes[index];
    if (current === undefined) parent.appendChild(children[index]!);
    else patchNode(current, children[index]!);
  }
  while (parent.childNodes.length > children.length) parent.removeChild(parent.lastChild!);
}

const IDENTITY_ATTRS = ['id', 'data-act', 'data-arg', 'data-form', 'data-scroll', 'data-scroll-key', 'data-overlay', 'data-trap'];

function sameIdentity(current: Node, next: Node): boolean {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) return false;
  if (!(current instanceof Element) || !(next instanceof Element)) return true;
  if (current.namespaceURI !== next.namespaceURI) return false;
  if (current.classList.contains('page') && next.classList.contains('page') && current.className !== next.className) return false;
  return IDENTITY_ATTRS.every((name) => current.getAttribute(name) === next.getAttribute(name));
}

function patchNode(current: Node, next: Node): void {
  if (!sameIdentity(current, next)) {
    current.parentNode?.replaceChild(next, current);
    return;
  }
  // A route-driven selection change must not emit a spurious change event.
  // Keep the live control mounted when the operator chose its current value.
  if (current instanceof HTMLSelectElement && next instanceof HTMLSelectElement && current.value !== next.value) {
    current.parentNode?.replaceChild(next, current);
    return;
  }
  if (current.isEqualNode(next)) return;
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.textContent !== next.textContent) current.textContent = next.textContent;
    return;
  }
  if (!(current instanceof Element)) {
    if (current.textContent !== next.textContent) current.textContent = next.textContent;
    return;
  }
  // sameIdentity already established that both nodes have the same element kind.
  const nextElement = next as Element;
  for (const attr of Array.from(current.attributes)) {
    if (!nextElement.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  }
  for (const attr of Array.from(nextElement.attributes)) {
    if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  }
  const children = Array.from(nextElement.childNodes);
  for (let index = 0; index < children.length; index += 1) {
    const existing = current.childNodes[index];
    if (existing === undefined) current.appendChild(children[index]!);
    else patchNode(existing, children[index]!);
  }
  while (current.childNodes.length > children.length) current.removeChild(current.lastChild!);
  if (current instanceof HTMLInputElement && nextElement instanceof HTMLInputElement) {
    if (current.value !== nextElement.value) current.value = nextElement.value;
  } else if (current instanceof HTMLTextAreaElement && nextElement instanceof HTMLTextAreaElement) {
    if (current.value !== nextElement.value) current.value = nextElement.value;
  }
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
