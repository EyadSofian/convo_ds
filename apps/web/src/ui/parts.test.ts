/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { ApiError } from '../api/client';
import { createState } from '../state';
import { brandLockup, channelTile, logomark } from './brand';
import { CHANNEL_NAMES, describeError, phrase, t } from './copy';
import {
  avatar,
  badge,
  button,
  channelIcon,
  countBadge,
  dialogShell,
  emptyState,
  errorState,
  field,
  inlineError,
  isolated,
  kpi,
  notice,
  page,
  panel,
  progress,
  requestIdLine,
  segmented,
  selectControl,
  skeleton,
  textInput,
  toolbar,
} from './parts';

const NOW = new Date('2026-09-09T09:30:00.000Z');

function error(status: number | null, overrides: Partial<ApiError> = {}): ApiError {
  return { code: status === null ? 'network' : 'refused', message: 'Server message.', requestId: 'req-9', status, details: [], ...overrides };
}

describe('button', () => {
  it('labels an icon-only button with its title and marks every state it is given', () => {
    const iconOnly = button({ icon: 'close', act: 'close-dialog', title: 'Close', small: true, variant: 'ghost', pressed: true, expanded: false, controls: 'x', haspopup: 'menu' });
    expect(iconOnly.className).toBe('btn btn--ghost btn--sm btn--icon');
    expect(iconOnly.getAttribute('aria-label')).toBe('Close');
    expect(iconOnly.getAttribute('aria-pressed')).toBe('true');
    expect(iconOnly.getAttribute('aria-expanded')).toBe('false');
    expect(iconOnly.getAttribute('aria-controls')).toBe('x');
    expect(iconOnly.getAttribute('aria-haspopup')).toBe('menu');
    expect(iconOnly.querySelector('svg')?.getAttribute('width')).toBe('14');
  });

  it('shows progress on a busy button and refuses a second press', () => {
    const busy = button({ label: 'Save', icon: 'check', act: 'save', busy: true, type: 'submit', extraClass: 'wide' });
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.querySelector('.spinner')).not.toBeNull();
    expect(busy.querySelector('svg')).toBeNull();
    expect(busy.type).toBe('submit');
    expect(busy.className).toContain('wide');
    expect(busy.getAttribute('aria-label')).toBeNull();
  });

  it('defaults to a plain button with no busy state', () => {
    const plain = button({ label: 'Go', act: 'go', variant: 'default', disabled: true });
    expect(plain.className).toBe('btn');
    expect(plain.disabled).toBe(true);
    expect(plain.getAttribute('aria-busy')).toBeNull();
    expect(plain.querySelector('svg')).toBeNull();
    expect(button({ label: 'Go', icon: 'plus', act: 'go' }).querySelector('svg')?.getAttribute('width')).toBe('16');
  });
});

describe('badges, avatars and counts', () => {
  it('draws a toned badge with an optional dot or icon', () => {
    expect(badge('Draft').className).toBe('badge badge--neutral');
    expect(badge('Live', 'success', { dot: true }).querySelector('.badge__dot')).not.toBeNull();
    expect(badge('Approved', 'success', { icon: 'check' }).querySelector('svg')).not.toBeNull();
    expect(countBadge(4, '4 unread').getAttribute('aria-label')).toBe('4 unread');
  });

  it('shows initials, or a person glyph for somebody the caller may not identify', () => {
    expect(avatar({ initials: 'مخ' }).className).toBe('avatar avatar--md');
    expect(avatar({ initials: 'مخ', size: 'lg' }).textContent).toBe('مخ');
    const masked = avatar({ initials: '', channel: 'whatsapp', size: 'sm' });
    expect(masked.querySelector('svg')).not.toBeNull();
    expect(masked.querySelector('.avatar__channel')?.className).toContain('channel-tile--whatsapp');
  });

  it('gives every known channel its glyph and an unknown one a neutral globe', () => {
    expect(channelIcon('whatsapp')).toBe('whatsapp');
    expect(channelIcon('web_chat')).toBe('chat');
    expect(channelIcon('telegram')).toBe('plane');
    expect(channelIcon('pigeon')).toBe('globe');
  });
});

describe('segmented control', () => {
  it('presses the current item and shows counts only where they are known', () => {
    const control = segmented(
      [{ value: 'a', label: 'A', count: 3 }, { value: 'b', label: 'B' }],
      'b',
      'pick',
      'Pick one',
    );
    const items = control.querySelectorAll('button');
    expect(items[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(items[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(control.querySelectorAll('.segmented__count')).toHaveLength(1);
    expect(control.getAttribute('aria-label')).toBe('Pick one');
  });
});

describe('empty and error states', () => {
  it('names the next step in a compact empty state', () => {
    const empty = emptyState({ icon: 'inbox', title: 'Nothing here', body: 'Connect a channel.', action: { label: 'Connect', act: 'dialog', arg: 'x', primary: true } });
    expect(empty.getAttribute('role')).toBe('status');
    expect(empty.className).toBe('empty empty--neutral');
    expect(empty.querySelector('.btn--primary')?.getAttribute('data-arg')).toBe('x');
    expect(emptyState({ icon: 'lock', title: 'No', body: 'No.', tone: 'denied', action: { label: 'Back', act: 'back' } }).querySelector('.btn--primary')).toBeNull();
    expect(emptyState({ icon: 'inbox', title: 'Nothing', body: '' }).querySelector('button')).toBeNull();
  });

  it('describes a failure by what to do next, quotes the request id and offers a retry', () => {
    const state = createState(NOW);
    state.lang = 'en';
    const failure = errorState(state, error(500), 'live-reload');
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.textContent).toContain('The server couldn’t complete this');
    expect(failure.textContent).toContain('req-9');
    expect(failure.querySelector('[data-act="live-reload"]')).not.toBeNull();
  });

  it('shows a denial quietly, without a retry that would only be refused again', () => {
    const state = createState(NOW);
    state.lang = 'en';
    const denied = errorState(state, error(403), 'live-reload');
    expect(denied.className).toContain('errorstate--denied');
    expect(denied.querySelector('button')).toBeNull();
    expect(errorState(state, error(null)).querySelector('.request-id')).toBeNull();
    expect(errorState(state, error(null)).textContent).toContain('Can’t reach the server');
  });

  it('keeps a refusal beside the form that caused it', () => {
    const state = createState(NOW);
    expect(inlineError(state, null)).toBeNull();
    const shown = inlineError(state, error(409));
    expect(shown?.getAttribute('role')).toBe('alert');
    expect(shown?.textContent).toContain('Server message.');
    expect(requestIdLine(state, null)).toBeNull();
    expect(requestIdLine(state, 'r-1')?.textContent).toContain('r-1');
  });
});

describe('copy', () => {
  it('describes each kind of failure differently', () => {
    const state = createState(NOW);
    state.lang = 'en';
    expect(describeError(state, error(401)).title).toBe('Your session has ended');
    expect(describeError(state, error(401)).requestId).toBeNull();
    expect(describeError(state, error(404)).title).toBe('Not found or not available to you');
    expect(describeError(state, error(409)).body).toBe('Server message.');
    expect(describeError(state, error(429)).title).toBe('Too many attempts');
    expect(describeError(state, error(400)).body).toBe('Server message.');
    expect(describeError(state, error(422, { details: [{ field: 'email', code: 'x', message: 'Email is required.' }, { field: 'x', code: 'y', message: '' }] })).body).toBe('Server message. · Email is required.');
    expect(describeError(state, error(422, { message: '', details: [{ field: 'email', code: 'x', message: 'Email is required.' }] })).body).toBe('Email is required.');
    // A refusal with its own reason keeps it; a bare one says who can help.
    expect(describeError(state, error(403)).body).toBe('Server message.');
    expect(describeError(state, error(403, { code: 'permission_denied' })).body).toBe('Ask a workspace administrator for access.');
    expect(describeError(state, error(403, { message: '' })).body).toBe('Ask a workspace administrator for access.');
    state.lang = 'ar';
    expect(describeError(state, error(403)).title).toBe('لا تملك صلاحية لهذا الإجراء');
  });

  it('names a known key in the operator’s language and shows an unknown one as itself', () => {
    const state = createState(NOW);
    expect(phrase(state, CHANNEL_NAMES, 'whatsapp')).toBe('واتساب');
    state.lang = 'en';
    expect(phrase(state, CHANNEL_NAMES, 'whatsapp')).toBe('WhatsApp');
    expect(phrase(state, CHANNEL_NAMES, 'pigeon')).toBe('pigeon');
    expect(t(state, 'نعم', 'Yes')).toBe('Yes');
  });
});

describe('form atoms', () => {
  it('builds a labelled field with an optional hint', () => {
    expect(field('Name', textInput('name', '', 'Your name')).querySelector('.field__hint')).toBeNull();
    const hinted = field('Name', null, 'As it appears');
    expect(hinted.querySelector('.field__hint')?.textContent).toBe('As it appears');
  });

  it('wires a text input to the form collector, or to its own action', () => {
    const plain = textInput('email', 'a@b.c', 'Email');
    expect(plain.getAttribute('data-act')).toBe('form');
    expect(plain.type).toBe('text');
    const custom = textInput('q', '', 'Search', { type: 'search', act: 'live-search', ariaLabel: 'Search', id: 'q', autocomplete: 'off', inputmode: 'search', required: true });
    expect(custom.getAttribute('data-act')).toBe('live-search');
    expect(custom.type).toBe('search');
    expect(custom.required).toBe(true);
  });

  it('selects the given value after its options exist', () => {
    const select = selectControl({ value: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], act: 'pick', form: 'x', ariaLabel: 'Pick', disabled: true, id: 's' });
    expect(select.value).toBe('b');
    expect(select.disabled).toBe(true);
    expect(selectControl({ value: 'a', options: [{ value: 'a', label: 'A' }] }).getAttribute('data-act')).toBe('form');
  });

  it('isolates mixed-script values, in the monospace face when asked', () => {
    expect(isolated('+20 100').tagName).toBe('BDI');
    expect(isolated('abc', true).className).toBe('mono');
  });
});

describe('layout atoms', () => {
  it('announces a loading list once', () => {
    const state = createState(NOW);
    const loading = skeleton(state);
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.querySelectorAll('.skeleton__row')).toHaveLength(3);
    expect(skeleton(state, 5).querySelectorAll('.skeleton__row')).toHaveLength(5);
  });

  it('makes a labelled modal dialog that keeps focus inside', () => {
    const state = createState(NOW);
    const shell = dialogShell(state, 'Connect', [h2('body')], [h2('footer')], { size: 'lg', description: 'Two steps.' });
    const dialog = shell.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('data-trap')).toBe('dialog');
    expect(dialog?.className).toContain('dialog--lg');
    expect(shell.querySelector('.dialog__description')?.textContent).toBe('Two steps.');
    expect(dialogShell(state, 'Plain', [], []).querySelector('.dialog__description')).toBeNull();
  });

  it('titles a panel with an h2 and draws its actions and description only when present', () => {
    const plain = panel('People', [h2('x')]);
    expect(plain.querySelector('h2.panel__title')?.textContent).toBe('People');
    expect(plain.querySelector('.panel__actions')).toBeNull();
    expect(panel('People', [], { actions: [] }).querySelector('.panel__actions')).toBeNull();
    const full = panel('People', [], { actions: [h2('a')], description: 'Everyone.', extraClass: 'wide', flush: true });
    expect(full.className).toBe('panel wide');
    expect(full.querySelector('.panel__body--flush')).not.toBeNull();
    expect(full.querySelector('.panel__description')?.textContent).toBe('Everyone.');
  });

  it('builds a page with or without a toolbar', () => {
    expect(page('x', null, [h2('a')]).querySelector('.pagebar')).toBeNull();
    const bar = toolbar('Lede', [h2('a')]);
    expect(page('x', bar, []).querySelector('.pagebar__lede')?.textContent).toBe('Lede');
    expect(toolbar(null, []).querySelector('.pagebar__lede')).toBeNull();
  });

  it('shows a figure with its foot, tone and unavailable state', () => {
    expect(kpi('Sent', '12').querySelector('.kpi__foot')).toBeNull();
    const toned = kpi('Failed', '3', { foot: '1%', tone: 'danger' });
    expect(toned.className).toBe('kpi kpi--danger');
    expect(kpi('Replies', 'Not measured', { unavailable: true }).className).toBe('kpi kpi--unavailable');
  });

  it('clamps a progress bar and names its value', () => {
    const bar = progress(1.7, '100% sent', 'success');
    expect(bar.getAttribute('style')).toBe('--progress:100%');
    expect(bar.getAttribute('aria-label')).toBe('100% sent');
    expect(progress(-1, 'none').getAttribute('style')).toBe('--progress:0%');
    expect(progress(0.1234, 'some').getAttribute('style')).toBe('--progress:12.3%');
  });

  it('wraps a notice around its content', () => {
    expect(notice('warning', 'alert', 'Careful').className).toBe('notice notice--warning');
  });
});

describe('brand', () => {
  it('draws the mark, the lockup and a channel tile, all decorative', () => {
    expect(logomark().className).toBe('logomark logomark--sm');
    expect(logomark('lg').getAttribute('src')).toBe('/brand/digital-school-by-berlitz.png');
    expect(logomark('lg').getAttribute('alt')).toBe('');
    expect(brandLockup().textContent).toBe('DIGITAL SCHOOL');
    const tile = channelTile('instagram', 'lg');
    expect(tile.className).toBe('channel-tile channel-tile--instagram channel-tile--lg');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(channelTile('custom').querySelector('svg')?.getAttribute('width')).toBe('16');
  });
});

function h2(text: string): HTMLElement {
  const element = document.createElement('h2');
  element.textContent = text;
  return element;
}
