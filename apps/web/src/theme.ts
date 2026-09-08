/**
 * Theme tokens — the single source of truth for colour.
 *
 * `styles/tokens.css` is the file the browser actually reads; this module holds
 * the same values as data so the palette can be *tested* rather than asserted.
 * `theme.test.ts` parses the stylesheet and fails when the two drift, and
 * re-checks every contrast requirement below on both themes.
 *
 * Provenance (ADR-0016): these are `original` / `a11y-override` values. They are
 * not measured Figma nodes — see docs/design/design-reference.md §1. The earlier
 * palette in that document is superseded here because it had no dark theme and
 * its light greys failed AA on the grey application ground.
 */

export type ThemeName = 'light' | 'dark';

/**
 * Colour tokens, without the `--` prefix. Non-colour tokens (space, radius,
 * type) stay in CSS only: they carry no contrast obligation and no test value.
 */
export type ColorToken =
  | 'surface-app'
  | 'surface-panel'
  | 'surface-sunken'
  | 'surface-hover'
  | 'surface-active'
  | 'border-subtle'
  | 'border-strong'
  | 'text-primary'
  | 'text-secondary'
  | 'text-muted'
  | 'text-disabled'
  | 'accent'
  | 'accent-strong'
  | 'accent-soft'
  | 'on-accent'
  | 'success'
  | 'success-soft'
  | 'warning'
  | 'warning-soft'
  | 'danger'
  | 'danger-soft'
  | 'unknown'
  | 'unknown-soft'
  | 'focus-ring'
  | 'rail-surface'
  | 'rail-text'
  | 'rail-active';

export type Palette = Readonly<Record<ColorToken, string>>;

/** Light: neutral grey ground, white reading surfaces, dark navy text. */
export const LIGHT: Palette = {
  'surface-app': '#eef1f5',
  'surface-panel': '#ffffff',
  'surface-sunken': '#f4f6f9',
  'surface-hover': '#f1f4f8',
  'surface-active': '#e6edfb',
  'border-subtle': '#dfe4ec',
  'border-strong': '#7d879a',
  'text-primary': '#101828',
  'text-secondary': '#4a5567',
  'text-muted': '#5e6980',
  'text-disabled': '#98a1b2',
  accent: '#1d4ed8',
  'accent-strong': '#1a43ba',
  'accent-soft': '#e6edfb',
  'on-accent': '#ffffff',
  success: '#04693e',
  'success-soft': '#e2f4ea',
  warning: '#8a5100',
  'warning-soft': '#fbf0dd',
  danger: '#b3261e',
  'danger-soft': '#fceceb',
  unknown: '#5b45c9',
  'unknown-soft': '#eeeaff',
  'focus-ring': '#1d4ed8',
  'rail-surface': '#101828',
  'rail-text': '#a8b3c7',
  'rail-active': '#ffffff',
};

/** Dark: deep neutral navy, minimal glow, body text that is not washed out. */
export const DARK: Palette = {
  'surface-app': '#0a0f1a',
  'surface-panel': '#141c2b',
  'surface-sunken': '#0f1624',
  'surface-hover': '#1c2536',
  'surface-active': '#1e2c4a',
  'border-subtle': '#263144',
  'border-strong': '#5f6e8f',
  'text-primary': '#e9eef7',
  'text-secondary': '#b6c2d6',
  'text-muted': '#93a0b6',
  'text-disabled': '#6d7a8f',
  accent: '#7aa5ff',
  'accent-strong': '#9bbaff',
  'accent-soft': '#1e2c4a',
  'on-accent': '#08111f',
  success: '#5cd0a0',
  'success-soft': '#102a22',
  warning: '#e8b35c',
  'warning-soft': '#2c2317',
  danger: '#ff8f85',
  'danger-soft': '#33191a',
  unknown: '#b3a2ff',
  'unknown-soft': '#221e3d',
  'focus-ring': '#8fb4ff',
  'rail-surface': '#0f1624',
  'rail-text': '#9aa7bd',
  'rail-active': '#ffffff',
};

export const PALETTES: Readonly<Record<ThemeName, Palette>> = { light: LIGHT, dark: DARK };

/* ------------------------------------------------------------- contrast -- */

/** `#rrggbb` to its three 0–255 channels. Throws on anything else. */
export function parseHex(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) throw new Error(`not a #rrggbb colour: ${value}`);
  const digits = match[1] as string;
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(value: string): number {
  const linear = parseHex(value).map((channel) => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as unknown as readonly [number, number, number];
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 2.1 contrast ratio, 1–21. Order of the arguments does not matter. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ContrastRequirement {
  readonly fg: ColorToken;
  readonly bg: ColorToken;
  /** 4.5 for body text (1.4.3), 3 for UI component boundaries (1.4.11). */
  readonly min: number;
  readonly note: string;
}

/**
 * Every pair the interface actually paints. `text-disabled` is absent on
 * purpose: WCAG 1.4.3 exempts inactive controls, and the design rule in
 * design-reference.md §4.1 is that a disabled tone never carries meaning alone.
 */
export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  ...(['surface-app', 'surface-panel', 'surface-sunken', 'surface-hover', 'surface-active'] as const)
    .flatMap((bg) =>
      (['text-primary', 'text-secondary', 'text-muted'] as const).map((fg) => ({
        fg,
        bg,
        min: 4.5,
        note: 'body text on a reading surface',
      })),
    ),
  ...(['accent', 'success', 'warning', 'danger', 'unknown'] as const).flatMap((fg) => [
    { fg, bg: `${fg}-soft` as ColorToken, min: 4.5, note: 'status text on its own soft chip' },
    { fg, bg: 'surface-panel' as ColorToken, min: 4.5, note: 'status text on a panel' },
    { fg, bg: 'surface-app' as ColorToken, min: 4.5, note: 'status text on the application ground' },
  ]),
  { fg: 'on-accent', bg: 'accent', min: 4.5, note: 'label inside a filled primary control' },
  { fg: 'rail-text', bg: 'rail-surface', min: 4.5, note: 'idle rail glyph' },
  { fg: 'rail-active', bg: 'rail-surface', min: 4.5, note: 'current rail glyph' },
  { fg: 'border-strong', bg: 'surface-panel', min: 3, note: 'input boundary (1.4.11)' },
  { fg: 'border-strong', bg: 'surface-app', min: 3, note: 'input boundary on the ground (1.4.11)' },
  { fg: 'focus-ring', bg: 'surface-panel', min: 3, note: 'focus indicator (1.4.11)' },
  { fg: 'focus-ring', bg: 'surface-app', min: 3, note: 'focus indicator on the ground (1.4.11)' },
  { fg: 'focus-ring', bg: 'surface-active', min: 3, note: 'focus indicator on a selected row' },
];

export interface ContrastFailure extends ContrastRequirement {
  readonly theme: ThemeName;
  readonly actual: number;
}

/**
 * Returns every requirement the given palette fails. Empty means it passes.
 *
 * `palette` is injectable so the same checker can validate a candidate palette
 * — a tenant brand colour, or a proposed token change — before it ships, and so
 * the failure path itself is exercised by a test rather than assumed.
 */
export function contrastFailures(
  theme: ThemeName,
  palette: Palette = PALETTES[theme],
): readonly ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const requirement of CONTRAST_REQUIREMENTS) {
    const actual = contrastRatio(palette[requirement.fg], palette[requirement.bg]);
    // Round the way a reporting tool does, so a 4.4996 is not sold as a pass.
    if (Math.round(actual * 100) / 100 < requirement.min) {
      failures.push({ ...requirement, theme, actual });
    }
  }
  return failures;
}
