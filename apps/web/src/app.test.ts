/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppHandle } from './app';
import { boot, browserEventSource, mount, renderApp } from './app';
import type { RouterHost } from './router';
import { createState } from './state';

const NOW = new Date('2026-09-08T12:00:00.000Z');

interface Host extends RouterHost {
  fire(): void;
  go(hash: string): void;
}

/** A router host that mirrors the browser: writing the hash fires the event. */
function createHost(hash = ''): Host {
  const listeners: (() => void)[] = [];
  let current = hash;
  const location = {
    get hash(): string {
      return current;
    },
    set hash(next: string) {
      if (next === current) return;
      current = next;
      listeners.forEach((listener) => listener());
    },
  };
  return {
    location,
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    fire: () => listeners.forEach((listener) => listener()),
    go: (next) => {
      location.hash = next;
    },
  };
}

let handle: AppHandle | null = null;

function start(hash = ''): { app: AppHandle; root: HTMLElement; host: Host } {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  const host = createHost(hash);
  const app = mount({ root, host, now: NOW });
  handle = app;
  return { app, root, host };
}

function press(root: HTMLElement, key: string, target?: Element | null): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (target ?? root).dispatchEvent(event);
}

function click(root: ParentNode, selector: string): void {
  const target = root.querySelector(selector);
  if (target === null) throw new Error(`no element for ${selector}`);
  target.dispatchEvent(new window.Event('click', { bubbles: true }));
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

afterEach(() => {
  handle?.destroy();
  handle = null;
});

describe('mount', () => {
  it('sets the document language and direction, and flips them', () => {
    const { root } = start();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    click(root, '[data-act="lang"]');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('boots by finding the existing mount node', () => {
    document.body.replaceChildren();
    const existing = document.createElement('div');
    existing.id = 'app';
    document.body.appendChild(existing);
    handle = boot(document, createHost());
    expect(existing.querySelector('.shell')).not.toBeNull();
  });

  it('boots by creating a mount node when the page has none', () => {
    document.body.replaceChildren();
    handle = boot(document, createHost());
    expect(document.getElementById('app')?.querySelector('.shell')).not.toBeNull();
  });
});

describe('navigation', () => {
  it('is deep-linkable and refresh-safe for every screen', () => {
    for (const screen of ['channels', 'people', 'broadcasts', 'analytics', 'settings']) {
      const { root, host } = start(`#/${screen}`);
      expect(host.location.hash).toBe(`#/${screen}`);
      expect(root.querySelector('.workspace')).not.toBeNull();
      handle?.destroy();
    }
  });

  it('navigates from the rail and writes the hash', () => {
    const { root, host } = start();
    click(root, '.rail__item[data-arg="analytics"]');
    expect(host.location.hash).toBe('#/analytics');
    expect(root.querySelector('.workspace')).not.toBeNull();
    click(root, '.rail__item[data-arg="inbox"]');
    expect(host.location.hash).toBe('#/inbox');
  });

  it('follows a hash change made outside the app, as the back button would', () => {
    const { root, host, app } = start();
    host.go('#/settings');
    expect(root.querySelector('.workspace')).not.toBeNull();
    host.go('#/inbox/cv-4816');
    expect(root.querySelector('.inbox')).not.toBeNull();
    // The id in the URL is what the inbox will ask the server for; with no
    // transport it stays unresolved rather than showing somebody's thread.
    expect(app.state.route.conversationId).toBe('cv-4816');
  });

  it('closes an open menu when clicking outside it', () => {
    const { root, app } = start('#/settings');
    app.dispatch('menu', 'anything');
    expect(app.state.openMenu).toBe('anything');
    root.querySelector('.workspace')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(app.state.openMenu).toBeNull();
  });

  it('closes a dialog from the scrim but not from inside it', () => {
    const { root, app } = start('#/settings');
    app.dispatch('dialog', 'invite');
    root.querySelector('.dialog__body')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(app.state.dialog).not.toBeNull();
    click(root, '.scrim');
    expect(app.state.dialog).toBeNull();
  });

  it('drives a workspace form control and its switches', () => {
    const { root, app } = start('#/settings');
    const company = root.querySelector('[data-form="company"]') as HTMLInputElement;
    typeInto(company, 'Noor Retail');
    expect(app.state.dialogForm.company).toBe('Noor Retail');
    const timezone = root.querySelector('[data-form="tz"]') as HTMLSelectElement;
    timezone.value = 'Asia/Dubai';
    timezone.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect((root.querySelector('[data-form="tz"]') as HTMLSelectElement).value).toBe('Asia/Dubai');
    click(root, '[role="switch"]');
    expect(root.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('ignores clicks with no action and stops listening after destroy', () => {
    const { root, app } = start('#/settings');
    root.querySelector('.workspace')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    root.dispatchEvent(new window.Event('input', { bubbles: true }));
    const field = root.querySelector('[data-form="company"]') as HTMLInputElement;
    field.removeAttribute('data-act');
    typeInto(field, 'x');
    app.destroy();
    handle = null;
    click(root, '.rail__item[data-arg="people"]');
    expect(app.state.route.screen).toBe('settings');
  });

  it('keeps focus on the control that was clicked across the re-render', () => {
    const { root } = start();
    const target = root.querySelector(
      '[data-act="live-inbox-queue"][data-arg="mine"]',
    ) as HTMLButtonElement;
    target.focus();
    target.dispatchEvent(new window.Event('click', { bubbles: true }));
    const after = root.querySelector('[data-act="live-inbox-queue"][data-arg="mine"]');
    // The element is replaced by the render; focus follows the control, not the
    // node, or every click would drop the keyboard user back to the top.
    expect(document.activeElement).toBe(after);
    expect(after?.getAttribute('aria-pressed')).toBe('true');
  });

  it('drops focus restoration when the focused control has no action', () => {
    const { root, app } = start();
    const zone = root.querySelector('.zone--list') as HTMLElement;
    zone.setAttribute('tabindex', '-1');
    zone.focus();
    app.render();
    expect(root.querySelector('.shell')).not.toBeNull();
  });

  it('switches the document theme and swaps the toggle affordance', () => {
    const { root, app } = start();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    const before = root.querySelector('.theme-toggle')?.getAttribute('title');
    click(root, '[data-act="theme"]');
    expect(app.state.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    const after = root.querySelector('.theme-toggle')?.getAttribute('title');
    expect(after).not.toBe(before);
    click(root, '[data-act="theme"]');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('exposes a direct dispatch for programmatic control', () => {
    const { app, root } = start();
    app.dispatch('nav', 'broadcasts');
    expect(root.querySelector('.workspace')).not.toBeNull();
    app.dispatch('unknown-action');
    app.render();
    expect(root.querySelector('.shell')).not.toBeNull();
  });
});

describe('focus restoration edge cases', () => {
  function mountFresh(): { app: AppHandle; root: HTMLElement } {
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
    const app = mount({ root, host: createHost(), now: NOW });
    handle = app;
    return { app, root };
  }

  it('ignores focus on a non-HTML element, such as an icon glyph', () => {
    // Icons are inline SVG, which is an Element but not an HTMLElement. Focus
    // landing there must not produce a focus key, and must not throw on
    // re-render.
    const { app, root } = mountFresh();
    const glyph = root.querySelector('svg');
    expect(glyph).not.toBeNull();
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => glyph,
    });
    app.render();
    expect(root.querySelector('.shell')).not.toBeNull();
    Reflect.deleteProperty(document, 'activeElement');
  });

  it('drops restoration when the focused control is gone after the render', () => {
    const { app, root } = mountFresh();
    // Focus a control that only exists while a dialog is open, then close the
    // dialog in the same dispatch: the keyed control disappears.
    app.dispatch('dialog', 'invite');
    const inside = root.querySelector('.dialog [data-act="close-dialog"]');
    expect(inside).not.toBeNull();
    (inside as HTMLElement).focus();
    app.dispatch('close-dialog');
    expect(root.querySelector('.dialog')).toBeNull();
    expect(root.querySelector('.shell')).not.toBeNull();
  });

  it('restores focus to a control that holds no caret', () => {
    const { app, root } = mountFresh();
    // A button has no selection range at all. Restoring focus to one must not
    // reach for `setSelectionRange`, which it does not have.
    const target = root.querySelector('[data-act="live-inbox-queue"]') as HTMLButtonElement;
    target.focus();
    app.render();
    expect(document.activeElement).toBe(root.querySelector('[data-act="live-inbox-queue"]'));
  });

  it('keeps the caret when a text control reports no selection range', () => {
    // `selectionStart` is `number | null` in the DOM: input types that do not
    // support selection report null. The guard is what stops that becoming NaN.
    const { app, root } = mountFresh();
    app.dispatch('nav', 'settings');
    const field = root.querySelector('[data-form="company"]');
    expect(field).toBeInstanceOf(HTMLInputElement);
    const input = field as HTMLInputElement;
    Object.defineProperty(input, 'selectionStart', { configurable: true, get: () => null });
    Object.defineProperty(input, 'selectionEnd', { configurable: true, get: () => null });
    input.focus();
    app.render();
    expect(root.querySelector('.shell')).not.toBeNull();
  });
});

describe('delegated click targets', () => {
  function mountFresh(): { app: AppHandle; root: HTMLElement } {
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
    const app = mount({ root, host: createHost(), now: NOW });
    handle = app;
    return { app, root };
  }

  it('ignores a click on a form control, which reports through input/change', () => {
    const { app, root } = mountFresh();
    const before = app.state.role;

    const select = root.querySelector('select[data-act="role"]');
    expect(select).toBeInstanceOf(HTMLSelectElement);
    (select as HTMLSelectElement).dispatchEvent(new window.Event('click', { bubbles: true }));
    // A click on a select is not a choice; the choice arrives as `change`.
    expect(app.state.role).toBe(before);
  });

  it('ignores a pointerdown on a separator that is not inside a list column', () => {
    const { app, root } = mountFresh();
    const stray = document.createElement('button');
    stray.className = 'list-resizer';
    root.appendChild(stray);
    const before = app.state.listWidth;
    stray.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 10 }));
    expect(app.state.listWidth).toBe(before);
  });
});

describe('the list drawer, Escape and the resizer', () => {
  function resizer(root: HTMLElement): HTMLElement {
    const element = root.querySelector('.list-resizer');
    if (element === null) throw new Error('no resizer');
    return element as HTMLElement;
  }

  function mountFresh(): { app: AppHandle; root: HTMLElement } {
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
    const app = mount({ root, host: createHost(), now: NOW });
    handle = app;
    return { app, root };
  }

  /**
   * Task §3: the saved-view sidebar and the customer panel are both closed on
   * arrival, so the timeline owns the width by default.
   */
  it('unwinds one layer at a time: dialog, then menu, then the drawer', () => {
    const { app, root } = mountFresh();
    app.dispatch('list');
    app.dispatch('dialog', 'invite');
    // The menu is opened last: opening a dialog closes any open menu, which is
    // its own rule and not the one under test here.
    app.dispatch('menu', 'anything');
    expect(app.state.dialog).not.toBeNull();

    press(root, 'Escape');
    // The dialog goes first: dismissing it must not also collapse what is
    // behind it.
    expect(app.state.dialog).toBeNull();
    expect(app.state.openMenu).toBe('anything');
    expect(app.state.listOpen).toBe(true);

    press(root, 'Escape');
    expect(app.state.openMenu).toBeNull();
    expect(app.state.listOpen).toBe(true);

    press(root, 'Escape');
    expect(app.state.listOpen).toBe(false);
  });

  it('ignores Escape when nothing is open, and ignores other keys', () => {
    const { app, root } = mountFresh();
    press(root, 'Escape');
    press(root, 'a');
    expect(app.state.listOpen).toBe(false);
    expect(app.state.dialog).toBeNull();
  });

  it('dismisses the list drawer by its scrim', () => {
    const { app, root } = mountFresh();
    click(root, '[data-act="list"]');
    expect(app.state.listOpen).toBe(true);
    click(root, '.zone-scrim--list');
    expect(app.state.listOpen).toBe(false);
  });

  it('publishes the width to CSS as an inline custom property', () => {
    const { app, root } = mountFresh();
    app.dispatch('resize-list', '355');
    const inbox = root.querySelector('.inbox');
    expect(inbox?.getAttribute('style')).toContain('--list-width:355px');
  });

  it('steps with the arrow keys, mirrored for RTL', () => {
    const { app, root } = mountFresh();
    const start = app.state.listWidth;
    // Arabic is the default, so ArrowLeft widens the column.
    press(root, 'ArrowLeft', resizer(root));
    expect(app.state.listWidth).toBe(start + 8);
    press(root, 'ArrowRight', resizer(root));
    expect(app.state.listWidth).toBe(start);

    app.dispatch('lang', 'en');
    press(root, 'ArrowRight', resizer(root));
    expect(app.state.listWidth).toBe(start + 8);
  });

  it('never leaves the 300-380px range however far it is pushed', () => {
    const { app, root } = mountFresh();
    for (let i = 0; i < 40; i += 1) press(root, 'ArrowLeft', resizer(root));
    expect(app.state.listWidth).toBe(380);
    for (let i = 0; i < 40; i += 1) press(root, 'ArrowRight', resizer(root));
    expect(app.state.listWidth).toBe(300);
  });

  it('ignores a resize that is not a number, and a no-op step', () => {
    const { app } = mountFresh();
    const start = app.state.listWidth;
    app.dispatch('resize-list', 'wide');
    expect(app.state.listWidth).toBe(start);
    app.dispatch('resize-list', String(start));
    expect(app.state.listWidth).toBe(start);
    app.dispatch('resize-list-step', '');
    expect(app.state.listWidth).toBe(start);
  });

  it('drags from the column edge, in both directions', () => {
    const { app, root } = mountFresh();
    // happy-dom lays nothing out, so the column box is pinned for the
    // arithmetic. Re-render replaces the element, so pin it on the prototype.
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function pinned(this: HTMLElement): DOMRect {
      if (!this.classList.contains('zone--list')) return original.call(this);
      return { left: 100, right: 432, top: 0, bottom: 0, width: 332, height: 0, x: 100, y: 0 } as DOMRect;
    };

    try {
      document.documentElement.setAttribute('dir', 'rtl');
      resizer(root).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 82 }));
      expect(app.state.listWidth).toBe(350);
      document.dispatchEvent(new PointerEvent('pointerup', {}));
      // Movement after the drag ends must not keep resizing.
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 40 }));
      expect(app.state.listWidth).toBe(350);

      document.documentElement.setAttribute('dir', 'ltr');
      resizer(root).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 410 }));
      expect(app.state.listWidth).toBe(310);
      document.dispatchEvent(new PointerEvent('pointercancel', {}));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 }));
      expect(app.state.listWidth).toBe(310);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it('ignores a pointerdown that did not land on the separator', () => {
    const { app, root } = mountFresh();
    const start = app.state.listWidth;
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 10 }));
    expect(app.state.listWidth).toBe(start);
  });
});

describe('the stream the browser actually opens', () => {
  it('carries credentials, because the session is a cookie', () => {
    // happy-dom has no `EventSource`, so the constructor is substituted to
    // record what it was asked for. What matters is the argument: an
    // `EventSource` without credentials is an unauthenticated request the API
    // refuses, and the failure would look like "realtime is broken".
    const calls: { url: string; init: unknown }[] = [];
    class FakeEventSource {
      constructor(url: string, init: unknown) {
        calls.push({ url, init });
      }
    }
    const globals = globalThis as unknown as { EventSource?: unknown };
    const original = globals.EventSource;
    globals.EventSource = FakeEventSource;
    try {
      browserEventSource('/api/v1/tenants/t1/realtime/stream');
    } finally {
      globals.EventSource = original;
    }
    expect(calls).toEqual([
      { url: '/api/v1/tenants/t1/realtime/stream', init: { withCredentials: true } },
    ]);
  });
});

describe('renderApp', () => {
  it('renders without a dialog or toast layer by default', () => {
    const fragment = renderApp(createState(NOW));
    expect(fragment.childNodes).toHaveLength(1);
  });

  it('adds the dialog and toast layers when the state has them', () => {
    const state = createState(NOW);
    state.dialog = { kind: 'snooze', arg: '' };
    state.toasts = [{ id: 't1', text: 'x', tone: 'danger' }];
    const fragment = renderApp(state);
    expect(fragment.childNodes).toHaveLength(3);
    const holder = document.createElement('div');
    holder.appendChild(fragment);
    expect(holder.querySelector('.toast--danger')).not.toBeNull();
  });
});
