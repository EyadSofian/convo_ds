import type { Attrs, Child } from '../dom';
import { append, bdi, h } from '../dom';
import type { IconName } from '../icons';
import { icon } from '../icons';

/** Shared presentational atoms. Every one is exercised by ui/parts.test.ts. */

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'unknown';

export interface ButtonOptions {
  readonly label?: string | undefined;
  readonly icon?: IconName | undefined;
  readonly act: string;
  readonly arg?: string | undefined;
  readonly variant?: 'default' | 'primary' | 'ghost' | 'danger' | undefined;
  readonly small?: boolean | undefined;
  readonly pressed?: boolean | undefined;
  readonly expanded?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  readonly extraClass?: string | undefined;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const iconOnly = options.label === undefined;
  const classes = ['btn'];
  if (options.variant !== undefined && options.variant !== 'default') {
    classes.push(`btn--${options.variant}`);
  }
  if (options.small === true) classes.push('btn--sm');
  if (iconOnly) classes.push('btn--icon');
  if (options.extraClass !== undefined) classes.push(options.extraClass);
  const attrs: Attrs = {
    type: 'button',
    class: classes.join(' '),
    'data-act': options.act,
    'data-arg': options.arg,
    disabled: options.disabled,
    title: options.title,
    'aria-label': iconOnly ? options.title : undefined,
    'aria-pressed': options.pressed === undefined ? undefined : String(options.pressed),
    'aria-expanded': options.expanded === undefined ? undefined : String(options.expanded),
  };
  return h('button', attrs, [
    options.icon === undefined ? null : icon(options.icon, options.small === true ? 13 : 15),
    options.label,
  ]);
}

export function pill(label: string, tone: Tone = 'neutral', name?: IconName): HTMLElement {
  return h('span', { class: `pill pill--${tone}` }, [
    name === undefined ? null : icon(name, 11),
    label,
  ]);
}

export function countBadge(value: number, accent = false): HTMLElement {
  return h('span', { class: accent ? 'count count--accent' : 'count' }, [String(value)]);
}

export interface AvatarOptions {
  readonly initials: string;
  readonly size?: 'sm' | 'md' | 'lg' | undefined;
  readonly channel?: IconName | undefined;
  readonly title?: string | undefined;
}

export function avatar(options: AvatarOptions): HTMLElement {
  const size = options.size ?? 'md';
  const classes = size === 'md' ? 'avatar' : `avatar avatar--${size}`;
  return h('span', { class: classes, title: options.title, 'aria-hidden': 'true' }, [
    options.initials,
    options.channel === undefined
      ? null
      : h('span', { class: 'avatar__channel' }, [icon(options.channel, 9)]),
  ]);
}

export interface SegmentItem {
  readonly value: string;
  readonly label: string;
  readonly count?: number;
}

export function segment(
  items: readonly SegmentItem[],
  current: string,
  act: string,
  ariaLabel: string,
): HTMLElement {
  return h(
    'div',
    { class: 'segment', role: 'group', 'aria-label': ariaLabel },
    items.map((item) =>
      h(
        'button',
        {
          type: 'button',
          class: 'segment__item',
          'data-act': act,
          'data-arg': item.value,
          'aria-pressed': String(item.value === current),
        },
        [
          item.label,
          item.count === undefined
            ? null
            : h('span', { class: 'segment__count' }, [String(item.count)]),
        ],
      ),
    ),
  );
}

export interface StateBoxOptions {
  readonly kind: 'empty' | 'denied' | 'offline' | 'info';
  readonly iconName: IconName;
  readonly title: string;
  readonly body: string;
  readonly actionLabel?: string | undefined;
  readonly act?: string | undefined;
  readonly arg?: string | undefined;
}

export function stateBox(options: StateBoxOptions): HTMLElement {
  return h('div', { class: `statebox statebox--${options.kind}`, role: 'status' }, [
    h('span', { class: 'statebox__icon' }, [icon(options.iconName, 20)]),
    h('p', { class: 'statebox__title' }, [options.title]),
    h('p', { class: 'statebox__body' }, [options.body]),
    options.actionLabel === undefined || options.act === undefined
      ? null
      : button({
          label: options.actionLabel,
          act: options.act,
          arg: options.arg,
          variant: 'default',
          small: true,
        }),
  ]);
}

export function banner(
  tone: 'info' | 'warning' | 'danger',
  iconName: IconName,
  text: string,
  action?: { readonly label: string; readonly act: string; readonly arg?: string },
): HTMLElement {
  return h('div', { class: `banner banner--${tone}`, role: 'status' }, [
    icon(iconName, 14),
    h('span', {}, [text]),
    h('span', { class: 'banner__spacer' }),
    action === undefined
      ? null
      : button({ label: action.label, act: action.act, arg: action.arg, variant: 'ghost', small: true }),
  ]);
}

export function notice(
  tone: 'plain' | 'info' | 'warning',
  iconName: IconName,
  ...children: readonly Child[]
): HTMLElement {
  const classes = tone === 'plain' ? 'notice' : `notice notice--${tone}`;
  return h('div', { class: classes }, [
    h('span', { class: 'notice__icon' }, [icon(iconName, 14)]),
    h('span', {}, children),
  ]);
}

export interface PopoverOption {
  readonly label: string;
  readonly value: string;
  readonly checked: boolean;
  readonly hint?: string | undefined;
}

export function popover(
  title: string,
  options: readonly PopoverOption[],
  act: string,
  footer?: Child,
  alignEnd = false,
): HTMLElement {
  return h('div', { class: alignEnd ? 'popover popover--end' : 'popover', role: 'group' }, [
    h('p', { class: 'popover__title' }, [title]),
    ...options.map((option) =>
      h(
        'button',
        {
          type: 'button',
          class: 'popover__option',
          role: 'checkbox',
          'aria-checked': String(option.checked),
          'data-act': act,
          'data-arg': option.value,
        },
        [
          h('span', { class: 'popover__check' }, [icon('check', 11)]),
          h('span', { class: 'popover__label' }, [option.label]),
          option.hint === undefined ? null : h('span', { class: 'viewitem__scope' }, [option.hint]),
        ],
      ),
    ),
    footer === undefined ? null : h('div', { class: 'popover__footer' }, [footer]),
  ]);
}

export function anchored(children: readonly Child[]): HTMLElement {
  return h('span', { class: 'anchor' }, children);
}

export function field(label: string, control: Child, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, [
    h('span', { class: 'field__label' }, [label]),
    control,
    hint === undefined ? null : h('span', { class: 'field__hint' }, [hint]),
  ]);
}

export function textInput(name: string, value: string, placeholder: string): HTMLInputElement {
  return h('input', {
    class: 'input',
    type: 'text',
    value,
    placeholder,
    'data-act': 'form',
    'data-form': name,
  });
}

export interface SelectOptions {
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** Action dispatched on change; defaults to the generic form collector. */
  readonly act?: string | undefined;
  /** Form key, only meaningful for `act: 'form'`. */
  readonly form?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly style?: string | undefined;
  /** Disabled while the change it would start is already in flight. */
  readonly disabled?: boolean | undefined;
}

/**
 * The single select builder. It assigns `.value` after the options exist rather
 * than relying on the `selected` attribute alone — that attribute does not
 * reliably drive `selectedIndex` once options are appended, which silently
 * shifts the shown value.
 */
export function selectControl(config: SelectOptions): HTMLSelectElement {
  const element = h(
    'select',
    {
      class: 'select',
      'data-act': config.act ?? 'form',
      'data-form': config.form,
      'aria-label': config.ariaLabel,
      style: config.style,
      disabled: config.disabled,
    },
    config.options.map((option) =>
      h('option', { value: option.value, selected: option.value === config.value }, [option.label]),
    ),
  );
  element.value = config.value;
  return element;
}

export function selectInput(
  name: string,
  value: string,
  options: readonly { readonly value: string; readonly label: string }[],
): HTMLSelectElement {
  return selectControl({ value, options, form: name });
}

export function switchControl(label: string, checked: boolean, act: string, arg: string): HTMLElement {
  return h('span', { class: 'switch' }, [
    h('button', {
      type: 'button',
      class: 'switch__track',
      role: 'switch',
      'aria-checked': String(checked),
      'aria-label': label,
      'data-act': act,
      'data-arg': arg,
    }),
    h('span', {}, [label]),
  ]);
}

/** Mixed-script safe: phones, IDs, emails and handles never reorder. */
export function isolated(value: string, mono = false): HTMLElement {
  return bdi(value, mono ? { class: 'mono' } : {});
}

export function skeletonList(rows: number): HTMLElement {
  const items: HTMLElement[] = [];
  for (let index = 0; index < rows; index += 1) {
    items.push(
      h('div', { class: 'skeletonrow' }, [
        h('span', { class: 'skeleton', style: 'width:32px;height:32px;border-radius:9999px' }),
        h('span', { class: 'skeletonrow__lines' }, [
          h('span', { class: 'skeleton', style: 'width:58%;height:10px' }),
          h('span', { class: 'skeleton', style: 'width:84%;height:9px' }),
          h('span', { class: 'skeleton', style: 'width:40%;height:9px' }),
        ]),
      ]),
    );
  }
  return append(h('div', { class: 'convlist', 'aria-busy': 'true', 'aria-live': 'polite' }), items);
}

export function dialogShell(
  title: string,
  body: readonly Child[],
  footer: readonly Child[],
): HTMLElement {
  return h('div', { class: 'scrim', 'data-act': 'close-dialog', 'data-scrim': 'true' }, [
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      [
        h('div', { class: 'dialog__header' }, [
          h('h2', { class: 'dialog__title' }, [title]),
          h('span', { class: 'card__spacer' }),
          button({ icon: 'close', act: 'close-dialog', variant: 'ghost', small: true, title }),
        ]),
        h('div', { class: 'dialog__body' }, body),
        h('div', { class: 'dialog__footer' }, footer),
      ],
    ),
  ]);
}

export function card(title: string, headerExtra: readonly Child[], body: readonly Child[]): HTMLElement {
  return h('section', { class: 'card' }, [
    h('div', { class: 'card__header' }, [
      h('h3', { class: 'card__title' }, [title]),
      h('span', { class: 'card__spacer' }),
      ...headerExtra,
    ]),
    h('div', { class: 'card__body' }, body),
  ]);
}

export function metric(label: string, value: string, foot: string): HTMLElement {
  return h('div', { class: 'metric' }, [
    h('span', { class: 'metric__label' }, [label]),
    h('span', { class: 'metric__value' }, [isolated(value)]),
    h('span', { class: 'metric__foot' }, [foot]),
  ]);
}

export function barRow(label: string, ratio: number, value: string, warm = false): HTMLElement {
  const width = `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`;
  return h('div', { class: 'bars__row' }, [
    h('span', {}, [label]),
    h('span', { class: 'bars__track' }, [
      h('span', { class: warm ? 'bars__fill bars__fill--warm' : 'bars__fill', style: `width:${width}` }),
    ]),
    h('span', { class: 'bars__value' }, [isolated(value)]),
  ]);
}

export function checkItem(label: string, done: boolean): HTMLElement {
  return h('li', {}, [
    h('span', { class: `checklist__mark checklist__mark--${done ? 'yes' : 'no'}` }, [
      icon(done ? 'check' : 'close', 10),
    ]),
    h('span', {}, [label]),
  ]);
}

export const CHANNEL_ICON: Readonly<Record<'whatsapp' | 'instagram' | 'messenger', IconName>> = {
  whatsapp: 'whatsapp',
  instagram: 'instagram',
  messenger: 'messenger',
};
