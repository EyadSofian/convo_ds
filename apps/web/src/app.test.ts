/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppHandle } from './app';
import { boot, mount, renderApp } from './app';
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
  it('renders the shell, the rail and the inbox, and selects a conversation', () => {
    const { root, host } = start();
    expect(root.querySelector('.shell')).not.toBeNull();
    expect(root.querySelectorAll('.rail__item')).toHaveLength(6);
    expect(root.querySelector('.inbox')).not.toBeNull();
    expect(host.location.hash).toBe('#/inbox/cv-4821');
  });

  it('sets the document language and direction, and flips them', () => {
    const { root } = start();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    click(root, '[data-act="lang"]');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('shows an unread badge on the inbox rail item', () => {
    const { root } = start();
    expect(root.querySelector('.rail__badge')?.textContent).toBe('7');
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

  it('restores a deep-linked conversation, filter and preview state', () => {
    const { root, app } = start('#/inbox/cv-4820?queue=unread&sort=sla&as=agent&lang=en&state=offline');
    expect(app.state.route.conversationId).toBe('cv-4820');
    expect(app.state.filter.queue).toBe('unread');
    expect(app.state.role).toBe('agent');
    expect(root.querySelector('.banner--warning')).not.toBeNull();
  });

  it('navigates from the rail and writes the hash', () => {
    const { root, host } = start();
    click(root, '.rail__item[data-arg="analytics"]');
    expect(host.location.hash).toBe('#/analytics');
    expect(root.querySelector('.workspace')).not.toBeNull();
    click(root, '.rail__item[data-arg="inbox"]');
    expect(host.location.hash).toBe('#/inbox/cv-4821');
  });

  it('follows a hash change made outside the app, as the back button would', () => {
    const { root, host } = start();
    host.go('#/settings');
    expect(root.querySelector('.workspace')).not.toBeNull();
    host.go('#/inbox/cv-4816');
    expect(root.querySelector('.thread__name')?.textContent).toBe('سلمى حسن');
  });

  it('keeps the inbox usable when no conversation can be selected', () => {
    const { root, host } = start('#/inbox?state=empty');
    expect(host.location.hash).toBe('#/inbox?state=empty');
    expect(root.textContent).toContain('لم تُختر محادثة');
  });
});

describe('delegated interaction', () => {
  it('switches conversation from the list and marks it read', () => {
    const { root, app, host } = start();
    expect(app.state.conversations.find((c) => c.id === 'cv-4817')?.unreadCount).toBe(4);
    click(root, '.convrow[data-arg="cv-4817"]');
    expect(host.location.hash).toBe('#/inbox/cv-4817');
    expect(app.state.conversations.find((c) => c.id === 'cv-4817')?.unreadCount).toBe(0);
    expect(root.querySelector('.thread__name')?.textContent).toBe('أحمد بدر الدين');
  });

  it('filters through the queue segment and updates counts and the URL', () => {
    const { root, host } = start();
    const before = root.querySelectorAll('.convrow').length;
    click(root, '.segment__item[data-arg="unread"]');
    expect(host.location.hash).toContain('queue=unread');
    expect(root.querySelectorAll('.convrow').length).toBeLessThan(before);
    expect(root.querySelectorAll('.convrow--unread').length).toBe(
      root.querySelectorAll('.convrow').length,
    );
  });

  it('opens a filter popover, toggles a value, then clears it from the chip bar', () => {
    const { root } = start();
    click(root, '[data-arg="f-channel"]');
    expect(root.querySelector('.popover')).not.toBeNull();
    click(root, '.popover__option[data-arg="channels:instagram"]');
    expect(root.querySelector('.chip')).not.toBeNull();
    expect(
      Array.from(root.querySelectorAll('.convrow')).every((row) =>
        (row.textContent ?? '').length > 0,
      ),
    ).toBe(true);
    click(root, '.chip__remove');
    expect(root.querySelector('.chip')).toBeNull();
  });

  it('closes an open menu when clicking outside it', () => {
    const { root, app } = start();
    click(root, '[data-arg="f-status"]');
    expect(app.state.openMenu).toBe('f-status');
    root.querySelector('.listmeta')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(app.state.openMenu).toBeNull();
  });

  it('searches from the search box and keeps the caret in place', () => {
    const { root, app } = start();
    const search = root.querySelector('input[type="search"]') as HTMLInputElement;
    search.focus();
    typeInto(search, 'كريم');
    expect(app.state.filter.query).toBe('كريم');
    expect(root.querySelectorAll('.convrow')).toHaveLength(1);
    const after = root.querySelector('input[type="search"]') as HTMLInputElement;
    expect(document.activeElement).toBe(after);
    expect(after.value).toBe('كريم');
  });

  it('writes into the composer and sends a reply', () => {
    const { root, app } = start();
    const composer = root.querySelector('.composer__input') as HTMLTextAreaElement;
    composer.focus();
    typeInto(composer, 'تم فتح بلاغ مع شركة الشحن');
    click(root, '[data-act="send"]');
    expect(root.textContent).toContain('تم فتح بلاغ مع شركة الشحن');
    expect(root.querySelector('.toast')).not.toBeNull();
    expect(app.state.timelines['cv-4821']?.at(-1)?.kind).toBe('message');
    click(root, '.toast [data-act="toast"]');
    expect(root.querySelector('.toast')).toBeNull();
  });

  it('adds a private note through the note tab', () => {
    const { root, app } = start();
    click(root, '[data-act="composer-tab"][data-arg="note"]');
    const composer = root.querySelector('.composer__input') as HTMLTextAreaElement;
    typeInto(composer, 'تنبيه داخلي للفريق');
    click(root, '[data-act="send"]');
    expect(app.state.timelines['cv-4821']?.at(-1)?.kind).toBe('note');
    const notes = Array.from(root.querySelectorAll('.msg--note'));
    expect(notes.at(-1)?.textContent).toContain('تنبيه داخلي للفريق');
  });

  it('assigns a conversation from the thread header', () => {
    const { root, app } = start();
    click(root, '[data-arg="th-assign"]');
    click(root, '.popover__option[data-arg="m-mariam"]');
    expect(app.state.conversations.find((c) => c.id === 'cv-4821')?.assigneeId).toBe('m-mariam');
    expect(root.querySelector('[data-arg="th-assign"]')?.textContent).toContain('مريم السيد');
  });

  it('requires a disposition before resolving', () => {
    const { root, app } = start();
    click(root, '[data-act="status"][data-arg="resolved"]');
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(app.state.conversations.find((c) => c.id === 'cv-4821')?.status).toBe('open');
    click(root, '.dialog__body [data-act="resolve"]');
    expect(app.state.conversations.find((c) => c.id === 'cv-4821')?.status).toBe('resolved');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('snoozes through its dialog', () => {
    const { root, app } = start();
    click(root, '[data-act="dialog"][data-arg="snooze"]');
    click(root, '.dialog__body [data-act="snooze"]');
    expect(app.state.conversations.find((c) => c.id === 'cv-4821')?.status).toBe('snoozed');
  });

  it('saves a custom view from the current filters', () => {
    const { root, app } = start();
    click(root, '[data-act="sidebar"]');
    click(root, '[data-arg="f-channel"]');
    click(root, '.popover__option[data-arg="channels:messenger"]');
    click(root, '[data-act="dialog"][data-arg="save-view"]');
    const name = root.querySelector('[data-form="name"]') as HTMLInputElement;
    typeInto(name, 'ماسنجر فقط');
    click(root, '[data-act="save-view"]');
    expect(app.state.views.at(-1)?.name).toBe('ماسنجر فقط');
    expect(root.textContent).toContain('ماسنجر فقط');
  });

  it('closes a dialog from the scrim but not from inside it', () => {
    const { root, app } = start();
    click(root, '[data-act="dialog"][data-arg="snooze"]');
    root.querySelector('.dialog__body')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(app.state.dialog).not.toBeNull();
    click(root, '.scrim');
    expect(app.state.dialog).toBeNull();
  });

  it('opens the advanced filter dialog and toggles an attribute', () => {
    const { root, app } = start();
    click(root, '[data-act="dialog"][data-arg="filters"]');
    click(root, '[data-act="toggle-filter"][data-arg="priorities:urgent"]');
    expect(app.state.filter.priorities).toEqual(['urgent']);
    click(root, '[data-act="close-dialog"]');
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('collapses a views group and toggles the customer panel', () => {
    const { root, app } = start();
    click(root, '[data-act="sidebar"]');
    click(root, '.viewgroup__header[data-arg="g-teams"]');
    expect(app.state.collapsedGroups).toEqual(['g-teams']);
    expect(root.querySelector('.zone--panel')).toBeNull();
    click(root, '[data-act="panel"]');
    expect(root.querySelector('.zone--panel')).not.toBeNull();
    click(root, '[data-act="panel"]');
    expect(root.querySelector('.zone--panel')).toBeNull();
  });

  it('applies and deletes a saved view', () => {
    const { root, app, host } = start();
    click(root, '[data-act="sidebar"]');
    click(root, '.viewitem[data-arg="v-sla"]');
    expect(host.location.hash).toContain('view=v-sla');
    expect(app.state.filter.slas).toEqual(['breached', 'due']);
    click(root, '[data-act="delete-view"][data-arg="v-sla"]');
    expect(app.state.views.some((view) => view.id === 'v-sla')).toBe(false);
  });

  it('claims a queue card as an agent and unlocks the timeline', () => {
    const { root, app } = start('#/inbox?as=agent&queue=unassigned');
    expect(root.textContent).toContain('المحتوى محجوب حتى الاستلام');
    click(root, '.convrow [data-act="claim"]');
    expect(app.state.conversations.find((c) => c.id === app.state.route.conversationId)?.assigneeId).toBe(
      'm-hana',
    );
    expect(root.querySelector('.composer')).not.toBeNull();
  });

  it('drives the preview-state switcher and the view-as switcher', () => {
    const { root, app, host } = start();
    const preview = root.querySelector('[data-act="preview"]') as HTMLSelectElement;
    preview.value = 'loading';
    preview.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.location.hash).toContain('state=loading');
    const role = root.querySelector('[data-act="role"]') as HTMLSelectElement;
    role.value = 'campaign_manager';
    role.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(app.state.role).toBe('campaign_manager');
    expect(root.textContent).toContain('صندوق الوارد غير متاح لدورك');
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
    const { root, app } = start();
    root.querySelector('.thread__body')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    root.dispatchEvent(new window.Event('input', { bubbles: true }));
    const composer = root.querySelector('.composer__input') as HTMLTextAreaElement;
    composer.removeAttribute('data-act');
    typeInto(composer, 'x');
    app.destroy();
    handle = null;
    click(root, '.rail__item[data-arg="people"]');
    expect(app.state.route.screen).toBe('inbox');
  });

  it('keeps focus on the same control when two share an action', () => {
    const { root } = start();
    click(root, '[data-act="sidebar"]');
    // `queue|mine` exists twice: the views-column row and the segment tab.
    const tabs = root.querySelectorAll('[data-act="queue"][data-arg="mine"]');
    expect(tabs).toHaveLength(2);
    const target = tabs[1] as HTMLButtonElement;
    target.focus();
    target.dispatchEvent(new window.Event('click', { bubbles: true }));
    const after = root.querySelectorAll('[data-act="queue"][data-arg="mine"]');
    expect(document.activeElement).toBe(after[1]);
    expect(after[1]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('drops focus restoration when the focused control has no action', () => {
    const { root, app } = start();
    const log = root.querySelector('.thread__body') as HTMLElement;
    log.setAttribute('tabindex', '-1');
    log.focus();
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

  it('opens and closes the sidebar, swapping its label', () => {
    const { root, app } = start();
    expect(app.state.viewsOpen).toBe(false);
    const closed = root.querySelector('.sidebar-toggle')?.getAttribute('title');
    click(root, '[data-act="sidebar"]');
    expect(app.state.viewsOpen).toBe(true);
    const open = root.querySelector('.sidebar-toggle')?.getAttribute('title');
    expect(open).not.toBe(closed);
    click(root, '[data-act="sidebar"]');
    expect(app.state.viewsOpen).toBe(false);
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
    // Focus a control that only exists while the views sidebar is open, then
    // close the sidebar in the same dispatch: the keyed control disappears.
    app.dispatch('sidebar');
    const inside = root.querySelector('.zone--views [data-act="group"]');
    expect(inside).not.toBeNull();
    (inside as HTMLElement).focus();
    app.dispatch('sidebar');
    expect(root.querySelector('.zone--views')).toBeNull();
    expect(root.querySelector('.shell')).not.toBeNull();
  });

  it('keeps the caret when a text control reports no selection range', () => {
    // `selectionStart` is `number | null` in the DOM: input types that do not
    // support selection report null. The guard is what stops that becoming NaN.
    const { app, root } = mountFresh();
    const search = root.querySelector('[data-act="search"]');
    expect(search).toBeInstanceOf(HTMLInputElement);
    const input = search as HTMLInputElement;
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
    const before = app.state.preview;

    const select = root.querySelector('select[data-act="preview"]');
    expect(select).toBeInstanceOf(HTMLSelectElement);
    (select as HTMLSelectElement).dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(app.state.preview).toBe(before);

    const textarea = root.querySelector('textarea[data-act="composer-input"]');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    (textarea as HTMLTextAreaElement).dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(root.querySelector('.composer')).not.toBeNull();
  });

  it('navigates to a named conversation as well as to a bare screen', () => {
    const { app, root } = mountFresh();
    const second = app.state.conversations[1]?.id;
    expect(second).toBeDefined();
    click(root, `.convrow[data-arg="${second as string}"]`);
    expect(app.state.route.conversationId).toBe(second);

    app.dispatch('nav', 'channels');
    expect(app.state.route.conversationId).toBeNull();
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

describe('side zones, focus mode and Escape', () => {
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
  it('opens with both optional side zones closed', () => {
    const { app, root } = mountFresh();
    expect(app.state.viewsOpen).toBe(false);
    expect(app.state.panelOpen).toBe(false);
    expect(root.querySelector('.zone--views')).toBeNull();
    expect(root.querySelector('.zone--panel')).toBeNull();
    expect(root.querySelector('.inbox')?.getAttribute('data-focus')).toBe('off');
  });

  it('opens the views sidebar from the one Views control and closes it again', () => {
    const { app, root } = mountFresh();
    click(root, '[data-act="sidebar"]');
    expect(app.state.viewsOpen).toBe(true);
    expect(root.querySelector('.zone--views')).not.toBeNull();
    // A scrim exists so a drawer-mode sidebar is dismissible by pointer too.
    expect(root.querySelector('.zone-scrim--views')).not.toBeNull();
    click(root, '.zone--views [data-act="sidebar"]');
    expect(app.state.viewsOpen).toBe(false);
  });

  it('closes an open side zone with Escape', () => {
    const { app, root } = mountFresh();
    click(root, '[data-act="sidebar"]');
    click(root, '[data-act="panel"]');
    expect(app.state.viewsOpen).toBe(true);
    expect(app.state.panelOpen).toBe(true);
    press(root, 'Escape');
    expect(app.state.viewsOpen).toBe(false);
    expect(app.state.panelOpen).toBe(false);
  });

  it('unwinds one layer at a time: dialog, then menu, then side zones', () => {
    const { app, root } = mountFresh();
    click(root, '[data-act="sidebar"]');
    app.dispatch('dialog', 'snooze');
    press(root, 'Escape');
    expect(app.state.dialog).toBeNull();
    // The sidebar behind the dialog survives that first Escape.
    expect(app.state.viewsOpen).toBe(true);

    app.dispatch('menu', 'th-assign');
    press(root, 'Escape');
    expect(app.state.openMenu).toBeNull();
    expect(app.state.viewsOpen).toBe(true);

    press(root, 'Escape');
    expect(app.state.viewsOpen).toBe(false);
  });

  it('ignores Escape when nothing is open, and ignores other keys', () => {
    const { app, root } = mountFresh();
    press(root, 'Escape');
    press(root, 'a');
    expect(app.state.viewsOpen).toBe(false);
    expect(app.state.dialog).toBeNull();
  });

  it('dismisses a drawer by its scrim', () => {
    const { app, root } = mountFresh();
    click(root, '[data-act="panel"]');
    expect(app.state.panelOpen).toBe(true);
    click(root, '.zone-scrim--panel');
    expect(app.state.panelOpen).toBe(false);
  });

  it('focus mode closes both side zones and reports itself on the shell', () => {
    const { app, root } = mountFresh();
    click(root, '[data-act="sidebar"]');
    click(root, '[data-act="panel"]');
    click(root, '[data-act="focus"]');
    expect(app.state.focusMode).toBe(true);
    expect(app.state.viewsOpen).toBe(false);
    expect(app.state.panelOpen).toBe(false);
    expect(root.querySelector('.inbox')?.getAttribute('data-focus')).toBe('on');
    click(root, '[data-act="focus"]');
    expect(app.state.focusMode).toBe(false);
  });

  it('leaves focus mode when a side zone is opened again', () => {
    const { app, root } = mountFresh();
    click(root, '[data-act="focus"]');
    expect(app.state.focusMode).toBe(true);
    click(root, '[data-act="sidebar"]');
    expect(app.state.focusMode).toBe(false);

    click(root, '[data-act="focus"]');
    click(root, '[data-act="panel"]');
    expect(app.state.focusMode).toBe(false);
  });
});

describe('queue-list resize', () => {
  function mountFresh(): { app: AppHandle; root: HTMLElement } {
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
    const app = mount({ root, host: createHost(), now: NOW });
    handle = app;
    return { app, root };
  }

  function resizer(root: HTMLElement): HTMLElement {
    const element = root.querySelector('.list-resizer');
    if (!(element instanceof HTMLElement)) throw new Error('no resizer');
    return element;
  }

  it('exposes the separator with its range and current value', () => {
    const { app, root } = mountFresh();
    const handleElement = resizer(root);
    expect(handleElement.getAttribute('role')).toBe('separator');
    expect(handleElement.getAttribute('aria-valuemin')).toBe('300');
    expect(handleElement.getAttribute('aria-valuemax')).toBe('380');
    expect(handleElement.getAttribute('aria-valuenow')).toBe(String(app.state.listWidth));
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
