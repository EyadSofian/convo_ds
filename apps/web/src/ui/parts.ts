import type { ApiError } from '../api/client';
import type { Attrs, Child } from '../dom';
import { bdi, h } from '../dom';
import type { IconName } from '../icons';
import { icon } from '../icons';
import type { AppState } from '../state';
import { channelMark } from './channel-mark';
import { describeError, t } from './copy';
import { toneOf } from '../format';

/**
 * Shared presentational atoms. Every screen is built from these, so the product
 * has one button, one badge, one empty state and one error — and every one is
 * exercised by ui/parts.test.ts.
 */

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
  /** Shows progress on the control that started the work, and refuses a second press. */
  readonly busy?: boolean | undefined;
  readonly title?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly extraClass?: string | undefined;
  readonly type?: 'button' | 'submit' | undefined;
  readonly controls?: string | undefined;
  readonly haspopup?: string | undefined;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const iconOnly = options.label === undefined;
  const classes = ['btn'];
  if (options.variant !== undefined && options.variant !== 'default') {
    classes.push(`btn--${options.variant}`);
  }
  if (options.small === true) classes.push('btn--sm');
  if (iconOnly) classes.push('btn--icon');
  if (options.icon === 'refresh') classes.push('btn--refresh');
  if (options.extraClass !== undefined) classes.push(options.extraClass);
  const busy = options.busy === true;
  const attrs: Attrs = {
    type: options.type ?? 'button',
    class: classes.join(' '),
    'data-act': options.act,
    'data-arg': options.arg,
    disabled: options.disabled === true || busy,
    title: options.title,
    'aria-label': options.ariaLabel ?? (iconOnly ? options.title : undefined),
    'aria-pressed': options.pressed === undefined ? undefined : String(options.pressed),
    'aria-expanded': options.expanded === undefined ? undefined : String(options.expanded),
    'aria-controls': options.controls,
    'aria-haspopup': options.haspopup,
    'aria-busy': busy ? 'true' : undefined,
  };
  const size = options.small === true ? 14 : 16;
  return h('button', attrs, [
    options.icon === undefined ? null : iconSlot(options.icon, size, busy),
    options.label === undefined
      ? null
      : busy && options.icon === undefined
        ? h('span', { class: 'btn__stack' }, [h('span', { class: 'btn__label' }, [options.label]), spinner()])
        : h('span', { class: 'btn__label' }, [options.label]),
  ]);
}

/**
 * The one Refresh control. Initial and background list loads do not animate
 * its glyph; only the refresh the operator requested reports busy.
 */
export function refreshButton(
  state: AppState,
  act: string,
  loading: boolean,
  iconOnly = false,
  extraClass?: string,
): HTMLButtonElement {
  const label = t(state, 'تحديث', 'Refresh');
  return button({
    label: iconOnly ? undefined : label,
    title: iconOnly ? label : undefined,
    variant: iconOnly ? 'ghost' : undefined,
    icon: 'refresh',
    act,
    small: true,
    busy: state.live.refreshing === act,
    disabled: loading,
    extraClass,
  });
}

/** The one progress mark. Its size comes from the slot it is drawn in. */
export function spinner(): HTMLElement {
  return h('span', { class: 'spinner', 'aria-hidden': 'true' });
}

/**
 * The icon's own box, fixed at the icon's size, so progress takes the icon's
 * place without moving the label or resizing the button. Refresh keeps its
 * arrows steady; any other icon gives way to a spinner in the same box.
 * A label-only button keeps its label's width and draws the spinner over it.
 */
function iconSlot(name: IconName, size: number, busy: boolean): HTMLElement {
  const refreshing = busy && name === 'refresh';
  return h('span', { class: refreshing ? 'btn__icon btn__icon--refreshing' : 'btn__icon', 'aria-hidden': 'true' }, [
    busy && !refreshing ? spinner() : icon(name, size),
  ]);
}

export interface BadgeOptions {
  readonly icon?: IconName | undefined;
  /** A leading dot, for states that are ongoing rather than labels. */
  readonly dot?: boolean | undefined;
}

export function badge(label: string, tone: Tone = 'neutral', options: BadgeOptions = {}): HTMLElement {
  return h('span', { class: `badge badge--${tone}` }, [
    options.dot === true ? h('span', { class: 'badge__dot', 'aria-hidden': 'true' }) : null,
    options.icon === undefined ? null : icon(options.icon, 14),
    label,
  ]);
}

/** The colours a section's icon chip may wear. Each is a pair of tokens. */
export type SectionTone = 'blue' | 'cyan' | 'green' | 'violet' | 'amber' | 'pink';

/**
 * A card section's heading: a small colour-coded icon chip, then the title. The
 * chip lets an operator find "consent" or "assignment" in a long side panel by
 * colour before reading a word.
 */
export function sectionTitle(name: IconName, tone: SectionTone, title: string, id: string): HTMLElement {
  return h('h3', { class: 'panel-section__title', id }, [
    h('span', { class: `section-chip section-chip--${tone}`, 'aria-hidden': 'true' }, [icon(name, 14)]),
    h('span', { class: 'panel-section__text' }, [title]),
  ]);
}

export function countBadge(value: number, label: string): HTMLElement {
  return h('span', { class: 'count', 'aria-label': label }, [String(value)]);
}

export interface AvatarOptions {
  /** Empty for somebody the caller may not identify, such as a masked queue card. */
  readonly initials: string;
  readonly size?: 'sm' | 'md' | 'lg' | 'xl' | undefined;
  /** The channel kind, shown as a small provider-coloured mark. */
  readonly channel?: string | undefined;
  /**
   * What the colour is derived from — a name or an id. Without it the avatar
   * stays neutral, which is right for somebody the caller may not identify.
   */
  readonly seed?: string | undefined;
}

export function avatar(options: AvatarOptions): HTMLElement {
  const size = options.size ?? 'md';
  const tone = options.seed === undefined ? '' : ` avatar--tone-${String(toneOf(options.seed))}`;
  return h('span', { class: `avatar avatar--${size}${tone}`, 'aria-hidden': 'true' }, [
    options.initials === '' ? icon('user', size === 'xl' ? 28 : 16) : options.initials,
    options.channel === undefined
      ? null
      : h('span', { class: `avatar__channel channel-tile--${options.channel}` }, [channelMark(options.channel, 10)]),
  ]);
}

export interface SegmentItem {
  readonly value: string;
  readonly label: string;
  readonly count?: number | undefined;
}

export function segmented(
  items: readonly SegmentItem[],
  current: string,
  act: string,
  ariaLabel: string,
): HTMLElement {
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': ariaLabel },
    items.map((item) =>
      h(
        'button',
        {
          type: 'button',
          class: 'segmented__item',
          'data-act': act,
          'data-arg': item.value,
          'aria-pressed': String(item.value === current),
        },
        [
          item.label,
          item.count === undefined ? null : h('span', { class: 'segmented__count' }, [String(item.count)]),
        ],
      ),
    ),
  );
}

export interface EmptyStateOptions {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly action?: { readonly label: string; readonly act: string; readonly arg?: string; readonly primary?: boolean } | undefined;
  readonly tone?: 'neutral' | 'denied' | undefined;
}

/**
 * A compact "nothing here yet" that names the next valid step.
 *
 * Compact on purpose: an empty list is information, and a panel-sized
 * illustration around one sentence pushes everything useful off the screen.
 */
export function emptyState(options: EmptyStateOptions): HTMLElement {
  return h('div', { class: `empty empty--${options.tone ?? 'neutral'}`, role: 'status' }, [
    h('span', { class: 'empty__icon', 'aria-hidden': 'true' }, [icon(options.icon, 18)]),
    h('div', { class: 'empty__text' }, [
      h('p', { class: 'empty__title' }, [options.title]),
      h('p', { class: 'empty__body' }, [options.body]),
    ]),
    options.action === undefined
      ? null
      : button({
          label: options.action.label,
          act: options.action.act,
          arg: options.action.arg,
          small: true,
          variant: options.action.primary === true ? 'primary' : 'default',
        }),
  ]);
}

/** The request id, quoted so a support conversation can find the log line. */
export function requestIdLine(state: AppState, requestId: string | null): HTMLElement | null {
  if (requestId === null) return null;
  return h('p', { class: 'request-id' }, [t(state, 'رقم الطلب: ', 'Request ID: '), bdi(requestId, { class: 'mono' })]);
}

/**
 * A failed read, in the operator's terms, with the request id and a retry.
 *
 * Denials use the quieter tone: a missing permission is a fact about access,
 * not a fault to alarm anybody with.
 */
export function errorState(state: AppState, error: ApiError, retryAct?: string): HTMLElement {
  const copy = describeError(state, error);
  const denied = error.status === 403 || error.status === 404;
  return h('div', { class: `errorstate${denied ? ' errorstate--denied' : ''}`, role: 'alert' }, [
    h('span', { class: 'errorstate__icon', 'aria-hidden': 'true' }, [
      icon(error.code === 'network' ? 'wifiOff' : denied ? 'lock' : 'alert', 18),
    ]),
    h('div', { class: 'errorstate__text' }, [
      h('p', { class: 'errorstate__title' }, [copy.title]),
      h('p', { class: 'errorstate__body' }, [copy.body]),
      requestIdLine(state, copy.requestId),
    ]),
    retryAct === undefined || denied
      ? null
      : button({ label: t(state, 'إعادة المحاولة', 'Try again'), icon: 'refresh', act: retryAct, small: true }),
  ]);
}

/** The last mutation's refusal, beside the form that caused it. */
export function inlineError(state: AppState, error: ApiError | null): HTMLElement | null {
  if (error === null) return null;
  const copy = describeError(state, error);
  return h('div', { class: 'inline-error', role: 'alert' }, [
    icon('alert', 16),
    h('div', {}, [
      h('p', { class: 'inline-error__title' }, [copy.title]),
      h('p', { class: 'inline-error__body' }, [copy.body]),
      requestIdLine(state, copy.requestId),
    ]),
  ]);
}

export function notice(
  tone: 'plain' | 'info' | 'warning' | 'danger',
  iconName: IconName,
  ...children: readonly Child[]
): HTMLElement {
  return h('div', { class: `notice notice--${tone}` }, [
    h('span', { class: 'notice__icon', 'aria-hidden': 'true' }, [icon(iconName, 16)]),
    h('div', { class: 'notice__text' }, children),
  ]);
}

export function field(label: string, control: Child, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, [
    h('span', { class: 'field__label' }, [label]),
    control,
    hint === undefined ? null : h('span', { class: 'field__hint' }, [hint]),
  ]);
}

export interface InputOptions {
  readonly type?: string | undefined;
  readonly act?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly id?: string | undefined;
  readonly autocomplete?: string | undefined;
  readonly inputmode?: string | undefined;
  readonly required?: boolean | undefined;
}

/**
 * For credentials and addresses: typed exactly as keyed. A phone keyboard that
 * capitalises the first letter, auto-corrects a word or adds a space after a
 * suggestion changes a password without the person seeing it — it is most
 * likely while a password is shown as text — and the next sign-in elsewhere
 * then fails.
 */
export const LITERAL_INPUT = { autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' } as const;

export function textInput(
  name: string,
  value: string,
  placeholder: string,
  options: InputOptions = {},
): HTMLInputElement {
  return h('input', {
    class: 'input',
    type: options.type ?? 'text',
    id: options.id,
    value,
    placeholder,
    autocomplete: options.autocomplete,
    inputmode: options.inputmode,
    ...(options.type === 'email' ? LITERAL_INPUT : {}),
    required: options.required,
    'aria-label': options.ariaLabel,
    'data-act': options.act ?? 'form',
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
  /** Disabled while the change it would start is already in flight. */
  readonly disabled?: boolean | undefined;
  readonly id?: string | undefined;
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
      id: config.id,
      'data-act': config.act ?? 'form',
      'data-form': config.form,
      'aria-label': config.ariaLabel,
      disabled: config.disabled,
    },
    config.options.map((option) =>
      h('option', { value: option.value, selected: option.value === config.value }, [option.label]),
    ),
  );
  element.value = config.value;
  return element;
}

/** Mixed-script safe: phones, IDs, emails and handles never reorder. */
export function isolated(value: string, mono = false): HTMLElement {
  return bdi(value, mono ? { class: 'mono' } : {});
}

/** Placeholder rows while a list loads. Announced once, not per row. */
/**
 * A conversation that is still loading, drawn as the bubbles it will become:
 * alternating sides and lengths, so the thread does not change shape when the
 * messages land.
 */
export function messageSkeleton(state: AppState): HTMLElement {
  const bubbles = [['in', 62], ['out', 48], ['in', 38], ['out', 70], ['in', 54]] as const;
  return h('div', { class: 'skeleton skeleton--messages', 'aria-busy': 'true' }, [
    ...bubbles.map(([side, width]) =>
      h('span', { class: `skeleton__bubble skeleton__bubble--${side}`, style: `inline-size:${String(width)}%` })),
    h('span', { class: 'visually-hidden' }, [t(state, 'جارٍ تحميل الرسائل', 'Loading messages')]),
  ]);
}

export function skeleton(state: AppState, rows = 3): HTMLElement {
  const lines: HTMLElement[] = [];
  for (let index = 0; index < rows; index += 1) {
    lines.push(
      h('div', { class: 'skeleton__row' }, [
        h('span', { class: 'skeleton__block skeleton__block--round' }),
        h('span', { class: 'skeleton__lines' }, [
          h('span', { class: 'skeleton__block skeleton__block--wide' }),
          h('span', { class: 'skeleton__block' }),
        ]),
      ]),
    );
  }
  return h('div', { class: 'skeleton', 'aria-busy': 'true' }, [
    ...lines,
    h('span', { class: 'visually-hidden' }, [t(state, 'جارٍ التحميل', 'Loading')]),
  ]);
}

export interface DialogOptions {
  readonly size?: 'md' | 'lg' | undefined;
  readonly description?: string | undefined;
}

/**
 * A modal layer. `data-trap` is what the composition root keeps focus inside,
 * and Escape and the scrim both close it.
 */
export function dialogShell(
  state: AppState,
  title: string,
  body: readonly Child[],
  footer: readonly Child[],
  options: DialogOptions = {},
): HTMLElement {
  return h('div', { class: 'scrim', 'data-act': 'close-dialog', 'data-scrim': 'true' }, [
    h(
      'div',
      {
        class: `dialog dialog--${options.size ?? 'md'}`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dialog-title',
        'data-trap': 'dialog',
      },
      [
        h('header', { class: 'dialog__header' }, [
          h('div', { class: 'dialog__titles' }, [
            h('h2', { class: 'dialog__title', id: 'dialog-title' }, [title]),
            options.description === undefined ? null : h('p', { class: 'dialog__description' }, [options.description]),
          ]),
          button({ icon: 'close', act: 'close-dialog', variant: 'ghost', small: true, title: t(state, 'إغلاق', 'Close') }),
        ]),
        h('div', { class: 'dialog__body' }, body),
        h('footer', { class: 'dialog__footer' }, footer),
      ],
    ),
  ]);
}

export interface PanelOptions {
  readonly description?: string | undefined;
  readonly actions?: readonly Child[] | undefined;
  readonly extraClass?: string | undefined;
  readonly flush?: boolean | undefined;
}

/** A titled section of a page. The title is an h2: the page title is the header's h1. */
export function panel(title: string, body: readonly Child[], options: PanelOptions = {}): HTMLElement {
  return h('section', { class: `panel${options.extraClass === undefined ? '' : ` ${options.extraClass}`}`, 'aria-label': title }, [
    h('header', { class: 'panel__header' }, [
      h('div', { class: 'panel__titles' }, [
        h('h2', { class: 'panel__title' }, [title]),
        options.description === undefined ? null : h('p', { class: 'panel__description' }, [options.description]),
      ]),
      options.actions === undefined || options.actions.length === 0
        ? null
        : h('div', { class: 'panel__actions' }, options.actions),
    ]),
    h('div', { class: options.flush === true ? 'panel__body panel__body--flush' : 'panel__body' }, body),
  ]);
}

/** One page of a workspace screen: an optional toolbar row, then its sections. */
export function page(name: string, toolbar: HTMLElement | null, children: readonly Child[]): HTMLElement {
  return h('div', { class: `page page--${name}`, 'data-scroll': 'screen', tabindex: '-1' }, [
    h('div', { class: 'page__inner' }, [toolbar, ...children]),
  ]);
}

export function toolbar(lede: string | null, actions: readonly Child[]): HTMLElement {
  return h('div', { class: 'pagebar' }, [
    lede === null ? null : h('p', { class: 'pagebar__lede' }, [lede]),
    h('div', { class: 'pagebar__actions' }, actions),
  ]);
}

export interface KpiOptions {
  readonly foot?: string | undefined;
  readonly tone?: Tone | undefined;
  readonly unavailable?: boolean | undefined;
}

export function kpi(label: string, value: string, options: KpiOptions = {}): HTMLElement {
  return h('div', { class: `kpi${options.unavailable === true ? ' kpi--unavailable' : ''}${options.tone === undefined ? '' : ` kpi--${options.tone}`}` }, [
    h('span', { class: 'kpi__label' }, [label]),
    h('span', { class: 'kpi__value' }, [isolated(value)]),
    options.foot === undefined ? null : h('span', { class: 'kpi__foot' }, [options.foot]),
  ]);
}

/** A bar with its value in words for assistive technology. */
export function progress(ratio: number, label: string, tone: Tone = 'accent'): HTMLElement {
  const percent = Math.round(Math.min(Math.max(ratio, 0), 1) * 1000) / 10;
  return h('span', {
    class: `progress progress--${tone}`,
    role: 'img',
    'aria-label': label,
    style: `--progress:${String(percent)}%`,
  }, [h('span', { class: 'progress__fill' })]);
}
