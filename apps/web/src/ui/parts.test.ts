/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { h } from '../dom';
import {
  anchored,
  avatar,
  banner,
  barRow,
  button,
  card,
  CHANNEL_ICON,
  checkItem,
  countBadge,
  dialogShell,
  field,
  isolated,
  metric,
  notice,
  pill,
  popover,
  segment,
  selectInput,
  skeletonList,
  stateBox,
  switchControl,
  textInput,
} from './parts';

describe('button', () => {
  it('renders a labelled default button', () => {
    const element = button({ label: 'إرسال', act: 'send' });
    expect(element.getAttribute('data-act')).toBe('send');
    expect(element.className).toBe('btn');
    expect(element.textContent).toBe('إرسال');
    expect(element.hasAttribute('aria-label')).toBe(false);
  });

  it('renders every variant and modifier', () => {
    expect(button({ label: 'a', act: 'x', variant: 'primary' }).className).toContain('btn--primary');
    expect(button({ label: 'a', act: 'x', variant: 'ghost' }).className).toContain('btn--ghost');
    expect(button({ label: 'a', act: 'x', variant: 'danger' }).className).toContain('btn--danger');
    expect(button({ label: 'a', act: 'x', variant: 'default' }).className).toBe('btn');
    expect(button({ label: 'a', act: 'x', small: true }).className).toContain('btn--sm');
    expect(button({ label: 'a', act: 'x', extraClass: 'zz' }).className).toContain('zz');
  });

  it('labels an icon-only button from its title', () => {
    const element = button({ icon: 'close', act: 'x', title: 'إغلاق', small: true });
    expect(element.className).toContain('btn--icon');
    expect(element.getAttribute('aria-label')).toBe('إغلاق');
    expect(element.querySelector('svg')).not.toBeNull();
  });

  it('carries pressed, expanded, disabled and arg state', () => {
    const element = button({
      label: 'x',
      act: 'menu',
      arg: 'f-status',
      pressed: true,
      expanded: false,
      disabled: true,
    });
    expect(element.getAttribute('aria-pressed')).toBe('true');
    expect(element.getAttribute('aria-expanded')).toBe('false');
    expect(element.disabled).toBe(true);
    expect(element.getAttribute('data-arg')).toBe('f-status');
  });
});

describe('pill, count and avatar', () => {
  it('tones a pill and optionally draws an icon', () => {
    expect(pill('x').className).toBe('pill pill--neutral');
    expect(pill('x', 'danger').className).toContain('pill--danger');
    expect(pill('x', 'accent', 'flag').querySelector('svg')).not.toBeNull();
  });

  it('renders a plain and an accented count', () => {
    expect(countBadge(3).className).toBe('count');
    expect(countBadge(3, true).className).toContain('count--accent');
  });

  it('renders each avatar size and an optional channel badge', () => {
    expect(avatar({ initials: 'مخ' }).className).toBe('avatar');
    expect(avatar({ initials: 'مخ', size: 'sm' }).className).toContain('avatar--sm');
    expect(avatar({ initials: 'مخ', size: 'lg', title: 'x' }).getAttribute('title')).toBe('x');
    const badged = avatar({ initials: 'مخ', channel: CHANNEL_ICON.whatsapp });
    expect(badged.querySelector('.avatar__channel')).not.toBeNull();
  });
});

describe('segment', () => {
  it('marks the current item and shows optional counts', () => {
    const element = segment(
      [
        { value: 'all', label: 'الكل', count: 9 },
        { value: 'mine', label: 'لديّ' },
      ],
      'all',
      'queue',
      'segments',
    );
    const buttons = element.querySelectorAll('button');
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false');
    expect(element.querySelectorAll('.segment__count')).toHaveLength(1);
  });
});

describe('state surfaces', () => {
  it('renders a state box with and without an action', () => {
    const plain = stateBox({ kind: 'empty', iconName: 'inboxEmpty', title: 't', body: 'b' });
    expect(plain.querySelector('button')).toBeNull();
    const acting = stateBox({
      kind: 'denied',
      iconName: 'lock',
      title: 't',
      body: 'b',
      actionLabel: 'go',
      act: 'nav',
      arg: 'inbox',
    });
    expect(acting.className).toContain('statebox--denied');
    expect(acting.querySelector('button')?.getAttribute('data-arg')).toBe('inbox');
    const halfSpecified = stateBox({
      kind: 'offline',
      iconName: 'wifiOff',
      title: 't',
      body: 'b',
      actionLabel: 'go',
    });
    expect(halfSpecified.querySelector('button')).toBeNull();
  });

  it('renders a banner with and without an action', () => {
    expect(banner('warning', 'alert', 'x').querySelector('button')).toBeNull();
    const acting = banner('info', 'info', 'x', { label: 'retry', act: 'preview', arg: 'ready' });
    expect(acting.querySelector('button')?.getAttribute('data-act')).toBe('preview');
  });

  it('renders notices in every tone', () => {
    expect(notice('plain', 'info', 'x').className).toBe('notice');
    expect(notice('info', 'info', 'x').className).toContain('notice--info');
    expect(notice('warning', 'alert', 'x').className).toContain('notice--warning');
  });

  it('renders a skeleton list', () => {
    const element = skeletonList(3);
    expect(element.getAttribute('aria-busy')).toBe('true');
    expect(element.querySelectorAll('.skeletonrow')).toHaveLength(3);
  });
});

describe('popover and anchors', () => {
  it('marks checked options and renders an optional hint and footer', () => {
    const element = popover(
      'title',
      [
        { label: 'a', value: 'a', checked: true, hint: '12' },
        { label: 'b', value: 'b', checked: false },
      ],
      'toggle-filter',
    );
    const options = element.querySelectorAll('.popover__option');
    expect(options[0]?.getAttribute('aria-checked')).toBe('true');
    expect(element.querySelectorAll('.viewitem__scope')).toHaveLength(1);
    expect(element.querySelector('.popover__footer')).toBeNull();
    const withFooter = popover('t', [], 'x', h('span', {}, ['f']), true);
    expect(withFooter.className).toContain('popover--end');
    expect(withFooter.querySelector('.popover__footer')).not.toBeNull();
  });

  it('wraps children in a positioning anchor', () => {
    expect(anchored([h('span', {}, [])]).className).toBe('anchor');
  });
});

describe('form controls', () => {
  it('renders a labelled field with an optional hint', () => {
    const withHint = field('label', textInput('name', 'v', 'p'), 'hint');
    expect(withHint.querySelectorAll('.field__hint')).toHaveLength(1);
    expect(field('label', textInput('name', '', 'p')).querySelectorAll('.field__hint')).toHaveLength(0);
  });

  it('renders a text input bound to a form key', () => {
    const element = textInput('name', 'x', 'p');
    expect(element.getAttribute('data-form')).toBe('name');
    expect(element.value).toBe('x');
  });

  it('renders a select with the current value applied', () => {
    const element = selectInput('scope', 'team', [
      { value: 'private', label: 'p' },
      { value: 'team', label: 't' },
    ]);
    expect(element.value).toBe('team');
    expect(element.querySelectorAll('option')).toHaveLength(2);
  });

  it('renders a switch in both positions', () => {
    const on = switchControl('x', true, 'form-toggle', 'a:off');
    expect(on.querySelector('.switch__track')?.getAttribute('aria-checked')).toBe('true');
    const off = switchControl('x', false, 'form-toggle', 'a:on');
    expect(off.querySelector('.switch__track')?.getAttribute('aria-checked')).toBe('false');
  });
});

describe('layout atoms', () => {
  it('isolates mixed-script values, optionally in mono', () => {
    expect(isolated('+20 100').tagName).toBe('BDI');
    expect(isolated('CV-1', true).className).toBe('mono');
  });

  it('renders a dialog shell with a header, body and footer', () => {
    const element = dialogShell('عنوان', [h('p', {}, ['b'])], [h('span', {}, ['f'])]);
    expect(element.className).toBe('scrim');
    expect(element.getAttribute('data-scrim')).toBe('true');
    expect(element.querySelector('.dialog__title')?.textContent).toBe('عنوان');
    expect(element.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
  });

  it('renders a card, a metric, a bar row and a checklist item', () => {
    expect(card('t', [pill('x')], [h('p', {}, [])]).querySelector('.card__title')?.textContent).toBe('t');
    expect(metric('l', '5', 'f').querySelector('.metric__value')?.textContent).toBe('5');
    const bar = barRow('l', 0.5, '5');
    expect(bar.querySelector('.bars__fill')?.getAttribute('style')).toContain('50%');
    expect(barRow('l', 2, '5', true).querySelector('.bars__fill')?.getAttribute('style')).toContain('100%');
    expect(barRow('l', -1, '0').querySelector('.bars__fill')?.getAttribute('style')).toContain('0%');
    expect(barRow('l', 0.2, '1', true).querySelector('.bars__fill')?.className).toContain('bars__fill--warm');
    expect(checkItem('x', true).querySelector('.checklist__mark--yes')).not.toBeNull();
    expect(checkItem('x', false).querySelector('.checklist__mark--no')).not.toBeNull();
  });
});
