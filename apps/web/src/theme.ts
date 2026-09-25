/**
 * Colour contrast — the checks behind "AA in both themes".
 *
 * `styles/tokens.css` is the single source of truth for every colour. This
 * module holds no palette of its own: it reads the two theme blocks out of that
 * stylesheet and states which foreground/background pairs the interface
 * actually paints, so `theme.test.ts` can measure the stylesheet the browser
 * receives rather than a copy of it that might have drifted.
 */

export type ThemeName = 'light' | 'dark';

export type Palette = Readonly<Record<string, string>>;

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

/**
 * The `#rrggbb` custom properties declared in one `@tokens <section>` block of
 * the stylesheet, without their `--` prefix.
 *
 * Anchored on the marker comments so a reordered file cannot silently match the
 * wrong block. Non-hex values (hairlines, shadows) carry no contrast obligation
 * and are not returned.
 */
export function paletteFromCss(css: string, section: ThemeName): Palette {
  const start = css.indexOf(`/* @tokens ${section} */`);
  if (start === -1) throw new Error(`no "@tokens ${section}" marker`);
  const after = css.indexOf('/* @tokens ', start + 1);
  const body = css.slice(start, after === -1 ? undefined : after);
  const found: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    found[match[1] as string] = (match[2] as string).toLowerCase();
  }
  return found;
}

export interface ContrastRequirement {
  readonly fg: string;
  readonly bg: string;
  /** 4.5 for text (1.4.3), 3 for UI boundaries and focus indicators (1.4.11). */
  readonly min: number;
  readonly note: string;
}

const READING_SURFACES = ['canvas', 'surface-1', 'surface-2', 'surface-3', 'surface-hover', 'surface-selected'] as const;

/**
 * Every pair the interface paints. `text-disabled` is absent on purpose: WCAG
 * 1.4.3 exempts inactive controls, and a disabled tone never carries meaning
 * alone.
 */
export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  ...READING_SURFACES.flatMap((bg) =>
    (['text', 'text-secondary', 'text-muted', 'accent-text'] as const).map((fg) => ({
      fg,
      bg,
      min: 4.5,
      note: 'text on a reading surface',
    })),
  ),
  ...(['success', 'warning', 'danger', 'unknown', 'violet'] as const).flatMap((fg) => [
    { fg, bg: `${fg}-soft`, min: 4.5, note: 'status text on its own tint' },
    { fg, bg: 'surface-1', min: 4.5, note: 'status text on a panel' },
    { fg, bg: 'canvas', min: 4.5, note: 'status text on the ground' },
  ]),
  { fg: 'accent-text', bg: 'accent-soft', min: 4.5, note: 'accent text on the accent tint' },
  { fg: 'on-accent', bg: 'accent', min: 4.5, note: 'label inside a filled primary control' },
  { fg: 'on-accent', bg: 'accent-hover', min: 4.5, note: 'label inside a hovered primary control' },
  { fg: 'border-strong', bg: 'surface-1', min: 3, note: 'input boundary on a panel (1.4.11)' },
  { fg: 'border-strong', bg: 'canvas', min: 3, note: 'input boundary on the ground (1.4.11)' },
  { fg: 'focus-ring', bg: 'surface-1', min: 3, note: 'focus indicator on a panel (1.4.11)' },
  { fg: 'focus-ring', bg: 'canvas', min: 3, note: 'focus indicator on the ground (1.4.11)' },
  { fg: 'focus-ring', bg: 'surface-selected', min: 3, note: 'focus indicator on a selected row' },
  { fg: 'accent', bg: 'surface-1', min: 3, note: 'chart line and selected indicator (1.4.11)' },
  { fg: 'nav-text', bg: 'nav-bg', min: 4.5, note: 'navigation label on the rail' },
  { fg: 'nav-text', bg: 'nav-hover', min: 4.5, note: 'navigation label on a hovered item' },
  { fg: 'nav-text-strong', bg: 'accent', min: 4.5, note: 'current navigation item' },
  { fg: 'on-highlight', bg: 'brand-highlight', min: 4.5, note: 'label inside a lime control' },
];

export interface ContrastFailure extends ContrastRequirement {
  readonly theme: ThemeName;
  readonly actual: number;
}

/**
 * Returns every requirement the palette fails. Empty means it passes. A token a
 * requirement names but the palette lacks is a failure too, reported with a
 * ratio of 0 — a missing colour is not a passing one.
 */
export function contrastFailures(theme: ThemeName, palette: Palette): readonly ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const requirement of CONTRAST_REQUIREMENTS) {
    const fg = palette[requirement.fg];
    const bg = palette[requirement.bg];
    const actual = fg === undefined || bg === undefined ? 0 : contrastRatio(fg, bg);
    // Round the way a reporting tool does, so a 4.4996 is not sold as a pass.
    if (Math.round(actual * 100) / 100 < requirement.min) {
      failures.push({ ...requirement, theme, actual });
    }
  }
  return failures;
}
