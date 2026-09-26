import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { formatNumber, numberFormat } from '../format.js';
import type { IconName } from '../icons.js';
import { icon } from '../icons.js';
import type { AppState } from '../state.js';
import { isolated } from './parts.js';

/**
 * The charts analytics draws with: rings, donuts, bars and columns.
 *
 * Every chart is presentational for assistive technology and carries its own
 * numbers as text beside it — a legend with counts and shares, or a value on
 * each bar — so nothing is known only from a colour or a length. Colours come
 * from one palette of hues (`viz--<hue>` classes over theme tokens), so a
 * chart reads the same in light and dark, and a channel keeps its brand hue
 * wherever it is drawn.
 */

export type Hue =
  | 'blue' | 'violet' | 'teal' | 'orange' | 'pink' | 'green' | 'indigo' | 'cyan'
  | 'success' | 'warning' | 'danger' | 'unknown' | 'muted'
  | 'whatsapp' | 'messenger' | 'instagram' | 'telegram' | 'web' | 'custom';

const SERIES: readonly Hue[] = ['blue', 'violet', 'teal', 'orange', 'pink', 'green', 'indigo', 'cyan'];

/** The n-th hue of the categorical palette, repeating after eight. */
export function seriesHue(index: number): Hue {
  return SERIES[index % SERIES.length] as Hue;
}

const CHANNEL_HUES: Readonly<Record<string, Hue>> = {
  whatsapp: 'whatsapp',
  messenger: 'messenger',
  facebook: 'messenger',
  instagram: 'instagram',
  telegram: 'telegram',
  web_chat: 'web',
  website_chat: 'web',
  custom: 'custom',
  custom_api: 'custom',
};

/** A channel is always drawn in its own brand hue. */
export function channelHue(channel: string): Hue {
  return CHANNEL_HUES[channel] ?? 'muted';
}

/** A share as a percentage with one decimal, or a dash when there is nothing to share. */
export function share(state: AppState, value: number, total: number): string {
  return total <= 0
    ? '—'
    : numberFormat(state.lang, { style: 'percent', maximumFractionDigits: 1 }).format(value / total);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Readonly<Record<string, string>>): SVGElement {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  return element;
}

/** Radius whose circumference is 100, so dash lengths read as percentages. */
const R = '15.9155';

function ringSvg(arcs: readonly { readonly hue: Hue; readonly from: number; readonly length: number }[], extraClass: string): SVGElement {
  const root = svg('svg', { viewBox: '0 0 42 42', class: extraClass, 'aria-hidden': 'true', focusable: 'false' });
  root.append(svg('circle', { class: 'ring__track', cx: '21', cy: '21', r: R }));
  for (const arc of arcs) {
    root.append(svg('circle', {
      class: `ring__arc viz--${arc.hue}`,
      cx: '21', cy: '21', r: R,
      'stroke-dasharray': `${arc.length.toFixed(2)} ${(100 - arc.length).toFixed(2)}`,
      // A quarter turn back starts the first arc at twelve o'clock.
      'stroke-dashoffset': (25 - arc.from).toFixed(2),
    }));
  }
  return root;
}

export interface Slice {
  readonly label: string;
  readonly value: number;
  readonly hue: Hue;
}

export interface DonutOptions {
  readonly label: string;
  readonly slices: readonly Slice[];
  readonly centre: string;
  readonly centreLabel: string;
}

/**
 * A donut of parts of one whole, with its total in the middle and a legend
 * that names every part with its count and share. Empty parts are left out.
 */
export function donut(state: AppState, options: DonutOptions): HTMLElement {
  const slices = options.slices.filter((slice) => slice.value > 0);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  // A hairline gap between parts, and none when a single part is the whole.
  const gap = slices.length > 1 ? 0.8 : 0;
  let from = 0;
  const arcs = slices.map((slice) => {
    const length = (slice.value / total) * 100;
    const arc = { hue: slice.hue, from, length: Math.max(length - gap, 0.4) };
    from += length;
    return arc;
  });
  return h('figure', { class: 'donut', role: 'group', 'aria-label': options.label }, [
    h('div', { class: 'donut__ring' }, [
      ringSvg(arcs, 'donut__svg'),
      h('div', { class: 'donut__centre' }, [
        h('span', { class: 'donut__value' }, [isolated(options.centre)]),
        h('span', { class: 'donut__caption' }, [options.centreLabel]),
      ]),
    ]),
    h('ul', { class: 'legend' }, slices.map((slice) => h('li', { class: 'legend__item' }, [
      h('span', { class: `legend__swatch viz--${slice.hue}`, 'aria-hidden': 'true' }),
      h('span', { class: 'legend__label' }, [slice.label]),
      h('span', { class: 'legend__value' }, [isolated(formatNumber(slice.value, state.lang)), h('span', { class: 'legend__share' }, [share(state, slice.value, total)])]),
    ]))),
  ]);
}

export interface GaugeOptions {
  readonly label: string;
  /** 0–1, or null when the rate has no denominator yet. */
  readonly ratio: number | null;
  readonly hue: Hue;
  readonly detail?: string | undefined;
}

/** One rate as a ring filled to its share, the percentage in the middle. */
export function gauge(state: AppState, options: GaugeOptions): HTMLElement {
  const ratio = options.ratio === null ? null : Math.min(Math.max(options.ratio, 0), 1);
  const shown = ratio === null ? '—' : share(state, ratio, 1);
  return h('figure', { class: 'gauge', role: 'group', 'aria-label': `${options.label}: ${shown}` }, [
    h('div', { class: 'gauge__ring' }, [
      ringSvg(ratio === null || ratio === 0 ? [] : [{ hue: options.hue, from: 0, length: ratio * 100 }], 'gauge__svg'),
      h('span', { class: 'gauge__value' }, [isolated(shown)]),
    ]),
    h('figcaption', { class: 'gauge__text' }, [
      h('span', { class: 'gauge__label' }, [options.label]),
      options.detail === undefined ? null : h('span', { class: 'gauge__detail' }, [options.detail]),
    ]),
  ]);
}

export interface BarRow {
  readonly label: Child;
  readonly value: number;
  readonly hue: Hue;
  /** The value as written beside the bar; the count by default. */
  readonly display?: string | undefined;
  readonly note?: string | undefined;
}

/**
 * Horizontal bars against the largest row, or against `max` when the rows
 * are shares of one known whole. Compact bars put the label, the bar and the
 * value on one line, for groups of bars that belong together.
 */
export function bars(state: AppState, rows: readonly BarRow[], max?: number, compact = false): HTMLElement {
  const top = max ?? Math.max(...rows.map((row) => row.value), 0);
  return h('ul', { class: compact ? 'hbars hbars--compact' : 'hbars' }, rows.map((row) => h('li', { class: 'hbars__row' }, [
    h('div', { class: 'hbars__head' }, [
      h('span', { class: 'hbars__label' }, [row.label]),
      h('span', { class: 'hbars__value' }, [isolated(row.display ?? formatNumber(row.value, state.lang))]),
    ]),
    h('span', { class: 'hbars__track', 'aria-hidden': 'true' }, [
      h('span', { class: `hbars__fill viz--${row.hue}`, style: `--size:${width(row.value, top)}` }),
    ]),
    row.note === undefined ? null : h('span', { class: 'hbars__note' }, [row.note]),
  ])));
}

function width(value: number, top: number): string {
  return `${String(top <= 0 ? 0 : Math.round(Math.min(value / top, 1) * 1000) / 10)}%`;
}

export interface Column {
  readonly label: string;
  readonly value: number;
  readonly hue: Hue;
}

/** Vertical columns, each with its value above and its label below. */
export function columns(state: AppState, label: string, items: readonly Column[]): HTMLElement {
  const top = Math.max(...items.map((item) => item.value), 0);
  return h('ol', { class: 'vbars', 'aria-label': label }, items.map((item) => h('li', { class: 'vbars__col' }, [
    h('span', { class: 'vbars__value' }, [isolated(formatNumber(item.value, state.lang))]),
    h('span', { class: 'vbars__slot', 'aria-hidden': 'true' }, [
      h('span', { class: `vbars__bar viz--${item.hue}`, style: `--size:${width(item.value, top)}` }),
    ]),
    h('span', { class: 'vbars__label' }, [isolated(item.label)]),
  ])));
}

export interface Part {
  readonly label: string;
  readonly value: number;
  readonly hue: Hue;
}

/** One bar split into the parts of a whole, described in words for assistive technology. */
export function stack(state: AppState, parts: readonly Part[], total: number): HTMLElement {
  const present = parts.filter((part) => part.value > 0);
  return h('span', {
    class: 'stackbar',
    role: 'img',
    'aria-label': present.length === 0 ? '—' : present.map((part) => `${part.label} ${share(state, part.value, total)}`).join(' · '),
  }, present.map((part) => h('span', { class: `stackbar__part viz--${part.hue}`, style: `--size:${width(part.value, total)}` })));
}

/** A legend with no counts, for charts whose numbers are written elsewhere. */
export function key(items: readonly { readonly label: string; readonly hue: Hue }[]): HTMLElement {
  return h('ul', { class: 'chart-key', 'aria-hidden': 'true' }, items.map((item) => h('li', { class: 'chart-key__item' }, [
    h('span', { class: `legend__swatch viz--${item.hue}` }),
    item.label,
  ])));
}

export interface StatOptions {
  readonly label: string;
  readonly value: string;
  readonly icon: IconName;
  readonly hue: Hue;
  readonly foot?: string | undefined;
  readonly danger?: boolean | undefined;
  readonly unavailable?: boolean | undefined;
}

/** A headline figure on a card, with a tinted icon naming what it counts. */
export function stat(options: StatOptions): HTMLElement {
  const classes = ['kpi', 'kpi--stat', `viz--${options.hue}`];
  if (options.danger === true) classes.push('kpi--danger');
  if (options.unavailable === true) classes.push('kpi--unavailable');
  return h('div', { class: classes.join(' ') }, [
    h('span', { class: 'kpi__icon', 'aria-hidden': 'true' }, [icon(options.icon, 18)]),
    h('span', { class: 'kpi__label' }, [options.label]),
    h('span', { class: 'kpi__value' }, [isolated(options.value)]),
    options.foot === undefined ? null : h('span', { class: 'kpi__foot' }, [options.foot]),
  ]);
}
