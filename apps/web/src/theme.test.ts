import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ThemeName } from './theme';
import {
  contrastFailures,
  contrastRatio,
  CONTRAST_REQUIREMENTS,
  paletteFromCss,
  parseHex,
  relativeLuminance,
} from './theme';

const STYLES = ['base', 'shell', 'components', 'inbox', 'screens'] as const;

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const TOKENS_CSS = read('./styles/tokens.css');

describe('colour maths', () => {
  it('computes WCAG luminance and ratio at the known anchors', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    // Channels below the 0.04045 knee exercise the linear branch.
    expect(relativeLuminance('#010101')).toBeGreaterThan(0);
  });

  it('parses a six-digit hex and rejects anything else', () => {
    expect(parseHex('#6558D9')).toEqual([101, 88, 217]);
    expect(parseHex('  #ffffff ')).toEqual([255, 255, 255]);
    expect(() => parseHex('#fff')).toThrow(/not a #rrggbb colour/);
    expect(() => parseHex('rgb(0,0,0)')).toThrow(/not a #rrggbb colour/);
  });
});

describe('palettes read from styles/tokens.css', () => {
  /**
   * The stylesheet is the only place a colour is written. These read it rather
   * than a copy, so the contrast evidence describes what the browser receives.
   */
  it.each<ThemeName>(['light', 'dark'])('meets every contrast requirement in %s', (theme) => {
    const failures = contrastFailures(theme, paletteFromCss(TOKENS_CSS, theme)).map(
      (failure) =>
        `${failure.fg} on ${failure.bg} = ${failure.actual.toFixed(2)} (needs ${failure.min}) — ${failure.note}`,
    );
    expect(failures).toEqual([]);
  });

  it('checks a meaningful number of pairs, not a token list of two', () => {
    expect(CONTRAST_REQUIREMENTS.length).toBeGreaterThanOrEqual(35);
  });

  it('declares the same colour tokens in both themes', () => {
    const light = Object.keys(paletteFromCss(TOKENS_CSS, 'light')).sort();
    const dark = Object.keys(paletteFromCss(TOKENS_CSS, 'dark')).sort();
    expect(light.length).toBeGreaterThan(30);
    expect(dark).toEqual(light);
  });

  it('uses the supplied Digital School blue, yellow, powder and charcoal-navy direction', () => {
    const light = paletteFromCss(TOKENS_CSS, 'light');
    const dark = paletteFromCss(TOKENS_CSS, 'dark');
    expect(light['surface-1']).toBe('#fcfcfc');
    expect(light['accent']).toBe('#004fef');
    expect(dark['surface-1']).toBe('#111a2a');
    expect(dark['accent']).toBe('#2563c7');
    expect(dark['canvas']).not.toBe('#000000');
  });

  it('gives outcome_unknown its own hue, not a shade of danger', () => {
    for (const theme of ['light', 'dark'] as const) {
      const palette = paletteFromCss(TOKENS_CSS, theme);
      expect(palette['unknown']).not.toBe(palette['danger']);
      expect(palette['unknown-soft']).not.toBe(palette['danger-soft']);
    }
  });

  it('reports the offending pair when a palette regresses', () => {
    // Guards the failure path itself: a checker that cannot fail is not a check.
    const light = paletteFromCss(TOKENS_CSS, 'light');
    const failures = contrastFailures('light', { ...light, 'text-muted': '#d8dde5' });
    const muted = failures.filter((failure) => failure.fg === 'text-muted');
    expect(muted.length).toBeGreaterThan(0);
    expect(muted[0]?.theme).toBe('light');
    expect(muted[0]?.actual).toBeLessThan(4.5);
  });

  it('counts a colour a requirement needs but the palette lacks as a failure', () => {
    const light = paletteFromCss(TOKENS_CSS, 'light');
    const withoutAccent = Object.fromEntries(Object.entries(light).filter(([token]) => token !== 'accent'));
    const failures = contrastFailures('light', withoutAccent);
    expect(failures.some((failure) => failure.bg === 'accent' && failure.actual === 0)).toBe(true);
  });

  it('refuses a stylesheet with no marker for the theme asked about', () => {
    expect(() => paletteFromCss(':root { --canvas: #ffffff; }', 'light')).toThrow(/no "@tokens light" marker/);
    // The last section runs to the end of the file.
    expect(paletteFromCss('/* @tokens dark */ :root { --canvas: #101010; }', 'dark')).toEqual({ canvas: '#101010' });
  });
});

describe('the token layer', () => {
  it('has one light block, one dark block and no media-query copy', () => {
    const blocks = TOKENS_CSS.match(/^\s{2}:root[^{]*\{/gm) ?? [];
    expect(blocks.map((block) => block.trim())).toEqual([':root {', ":root[data-theme='dark'] {"]);
    expect(TOKENS_CSS).not.toContain('prefers-color-scheme');
  });

  it('never hard-codes a colour outside the token layer', () => {
    // Every other stylesheet consumes var(--token). `#ffffff` is not allowed
    // either: a label on a filled control uses --on-accent or --on-brand.
    const offenders: string[] = [];
    for (const name of STYLES) {
      const css = read(`./styles/${name}.css`);
      for (const match of css.matchAll(/#[0-9a-f]{3,8}\b|rgba?\(/gi)) {
        offenders.push(`${name}.css: ${match[0] as string}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses no physical left/right layout properties', () => {
    // Logical properties only, so one stylesheet serves Arabic and English.
    const offenders: string[] = [];
    for (const name of STYLES) {
      const css = read(`./styles/${name}.css`);
      // A four-value `padding`/`margin` shorthand is physical too: its second
      // and fourth values are right and left.
      for (const match of css.matchAll(/^[ \t]*(margin|padding|border)-(left|right)[ \t]*:|^[ \t]*(left|right)[ \t]*:|^[ \t]*(padding|margin):[ \t]*[^\s;]+[ \t]+[^\s;]+[ \t]+[^\s;]+[ \t]+[^\s;]+[ \t]*;/gim)) {
        offenders.push(`${name}.css: ${(match[0] as string).trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no !important outside the reduced-motion override', () => {
    const offenders: string[] = [];
    for (const name of STYLES) {
      const css = read(`./styles/${name}.css`).replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n {2}\}/, '');
      if (css.includes('!important')) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('states the geometry the layout tests assert', () => {
    for (const [token, value] of [
      ['--nav-width-collapsed', '64px'],
      ['--nav-width-expanded', '232px'],
      ['--header-height', '56px'],
      ['--list-width', '352px'],
      ['--list-width-min', '300px'],
      ['--list-width-max', '400px'],
      ['--panel-width', '320px'],
      ['--thread-min-width', '540px'],
      ['--row-height', '68px'],
      ['--thread-header-height', '60px'],
      ['--control-height', '36px'],
      ['--control-height-sm', '32px'],
      ['--composer-min-height', '44px'],
      ['--composer-max-height', '120px'],
    ] satisfies readonly (readonly [string, string])[]) {
      expect(TOKENS_CSS).toContain(`${token}: ${value};`);
    }
  });

  it('builds spacing on a 4px scale and keeps primary copy at 13px or more', () => {
    for (const match of TOKENS_CSS.matchAll(/--space-(\d+):\s*(\d+)px;/g)) {
      expect(Number(match[2]) % 4).toBe(0);
      expect(Number(match[2])).toBe(Number(match[1]) * 4);
    }
    expect(TOKENS_CSS).toContain('--text-xs: 13px;');
    expect(TOKENS_CSS).toContain('--text-sm: 14px;');
  });

  it('names one self-hosted Arabic-first family', () => {
    expect(TOKENS_CSS).toContain("--font-sans: 'IBM Plex Sans Arabic'");
    const declarations = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const dropped of ['Readex Pro', 'Alexandria', 'Manrope', 'Inter']) {
      expect(declarations).not.toContain(dropped);
    }
    const base = read('./styles/base.css');
    expect(base).not.toMatch(/url\(['"]?https?:/);
    expect(base.match(/@font-face/g)?.length).toBe(9);
  });

  it('keeps the cascade-layer order in one place', () => {
    const entry = read('./styles.css');
    expect(entry).toContain('@layer tokens, base, components, shell, screens;');
    for (const name of STYLES) {
      expect(read(`./styles/${name}.css`)).toMatch(/@layer (base|components|shell|screens) \{/);
    }
  });
});
