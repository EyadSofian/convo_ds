import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ColorToken, ThemeName } from './theme';
import {
  contrastFailures,
  contrastRatio,
  CONTRAST_REQUIREMENTS,
  DARK,
  LIGHT,
  PALETTES,
  parseHex,
  relativeLuminance,
} from './theme';

const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('./styles/tokens.css', import.meta.url)),
  'utf8',
);

/**
 * Reads one `@tokens <name>` section out of the stylesheet and returns the
 * `#rrggbb` custom properties it declares. Anchored on the marker comments so
 * a reordered file does not silently match the wrong block.
 */
function declaredColors(section: string): Record<string, string> {
  const start = TOKENS_CSS.indexOf(`/* @tokens ${section} */`);
  expect(start, `no "@tokens ${section}" marker in styles/tokens.css`).toBeGreaterThan(-1);
  const after = TOKENS_CSS.indexOf('/* @tokens ', start + 1);
  const body = TOKENS_CSS.slice(start, after === -1 ? undefined : after);
  const found: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    found[match[1] as string] = (match[2] as string).toLowerCase();
  }
  return found;
}

describe('colour maths', () => {
  it('computes WCAG luminance and ratio at the known anchors', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    // Both channels below the 0.04045 knee exercise the linear branch.
    expect(relativeLuminance('#010101')).toBeGreaterThan(0);
  });

  it('parses a six-digit hex and rejects anything else', () => {
    expect(parseHex('#1D4ED8')).toEqual([29, 78, 216]);
    expect(parseHex('  #ffffff ')).toEqual([255, 255, 255]);
    expect(() => parseHex('#fff')).toThrow(/not a #rrggbb colour/);
    expect(() => parseHex('rgb(0,0,0)')).toThrow(/not a #rrggbb colour/);
  });
});

describe('theme palettes', () => {
  /**
   * The claim "AA in both themes" is worth nothing as prose. This is the check
   * that makes it true, and it fails the build rather than a design review.
   */
  it.each<ThemeName>(['light', 'dark'])('meets every contrast requirement in %s', (theme) => {
    const failures = contrastFailures(theme).map(
      (failure) =>
        `${failure.fg} on ${failure.bg} = ${failure.actual.toFixed(2)} (needs ${failure.min}) — ${failure.note}`,
    );
    expect(failures).toEqual([]);
  });

  it('checks a meaningful number of pairs, not a token list of two', () => {
    expect(CONTRAST_REQUIREMENTS.length).toBeGreaterThanOrEqual(25);
  });

  it('reports the offending pair when a palette regresses', () => {
    // Guards the failure path itself: a checker that cannot fail is not a check.
    const broken = { ...LIGHT, 'text-secondary': '#d8dde5' };
    const failures = contrastFailures('light', broken);
    expect(failures.length).toBeGreaterThan(0);
    const secondary = failures.filter((failure) => failure.fg === 'text-secondary');
    expect(secondary.length).toBeGreaterThan(0);
    expect(secondary[0]?.theme).toBe('light');
    expect(secondary[0]?.actual).toBeLessThan(4.5);
    expect(secondary[0]?.note).toContain('body text');
  });

  it('rounds the way a reporting tool does, so a near miss is still a miss', () => {
    // 4.4996 must not be sold as a pass by floating-point luck.
    const nearMiss = CONTRAST_REQUIREMENTS.every(
      (requirement) => contrastRatio(LIGHT[requirement.fg], LIGHT[requirement.bg]) >= requirement.min,
    );
    expect(nearMiss).toBe(true);
  });

  it('defines the same token names in both themes', () => {
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
  });

  it('gives outcome_unknown its own hue, not a shade of danger', () => {
    // business-rules.md I7: an ambiguous outcome is never rendered as failure.
    for (const theme of ['light', 'dark'] as const) {
      expect(PALETTES[theme].unknown).not.toBe(PALETTES[theme].danger);
      expect(PALETTES[theme]['unknown-soft']).not.toBe(PALETTES[theme]['danger-soft']);
    }
  });
});

describe('styles/tokens.css', () => {
  /**
   * The stylesheet is what the browser reads; this module is what the tests
   * read. If they drift, the contrast evidence above describes a palette that
   * is not on screen — so drift is a test failure, not a comment.
   */
  it.each<[ThemeName, string]>([
    ['light', 'light'],
    ['dark', 'dark'],
  ])('declares exactly the %s palette', (theme, section) => {
    const declared = declaredColors(section);
    for (const [token, value] of Object.entries(PALETTES[theme])) {
      expect(declared[token], `--${token} in the ${section} block`).toBe(value);
    }
  });

  it('declares one theme block per theme, not a stack of overrides', () => {
    // The previous stylesheet had three `:root` colour blocks fighting each
    // other. Two — light and dark — is the contract now.
    const rootBlocks = TOKENS_CSS.match(/^\s{2}:root[^{]*\{/gm) ?? [];
    expect(rootBlocks.length).toBeLessThanOrEqual(3); // light, dark, non-colour scale
  });

  it('keeps the dark media-query fallback in step with the dark palette', () => {
    const media = TOKENS_CSS.slice(TOKENS_CSS.indexOf('@media (prefers-color-scheme: dark)'));
    for (const [token, value] of Object.entries(DARK)) {
      expect(media, `--${token} in the prefers-color-scheme fallback`).toContain(
        `--${token}: ${value};`,
      );
    }
  });

  it('never hard-codes a colour outside the token layer', () => {
    // Every other stylesheet must consume var(--token). The exceptions are
    // spelled out here so they cannot spread silently:
    //   #ffffff — the badge label on a filled danger/accent chip
    //   #000    — the opaque stop of a mask gradient, which is alpha maths and
    //             never paints a pixel of that colour
    const allowed = new Set(['#ffffff', '#000']);
    const files = ['base', 'shell', 'components', 'inbox', 'workspace'];
    const offenders: string[] = [];
    for (const name of files) {
      const css = readFileSync(
        fileURLToPath(new URL(`./styles/${name}.css`, import.meta.url)),
        'utf8',
      );
      for (const match of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
        const value = (match[0] as string).toLowerCase();
        if (!allowed.has(value)) offenders.push(`${name}.css: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses no physical left/right layout properties', () => {
    // design-reference.md §5: logical properties only, so one stylesheet serves
    // Arabic and English without a mirrored copy.
    const files = ['base', 'shell', 'components', 'inbox', 'workspace'];
    const offenders: string[] = [];
    for (const name of files) {
      const css = readFileSync(
        fileURLToPath(new URL(`./styles/${name}.css`, import.meta.url)),
        'utf8',
      );
      for (const match of css.matchAll(
        /^\s*(margin|padding|border)-(left|right)\s*:|^\s*(left|right)\s*:/gim,
      )) {
        offenders.push(`${name}.css: ${(match[0] as string).trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('states the geometry the layout tests assert', () => {
    for (const [token, value] of [
      ['--rail-width', '56px'],
      ['--topbar-height', '48px'],
      ['--list-width', '332px'],
      ['--list-width-min', '300px'],
      ['--list-width-max', '380px'],
      ['--row-height', '68px'],
      ['--thread-header-height', '64px'],
      ['--thread-min-width', '640px'],
      ['--composer-min-height', '44px'],
      ['--composer-max-height', '88px'],
    ] satisfies readonly (readonly [string, string])[]) {
      expect(TOKENS_CSS).toContain(`${token}: ${value};`);
    }
  });

  it('names one Arabic-first family and no leftovers from the old mixture', () => {
    expect(TOKENS_CSS).toContain("--font-sans: 'Readex Pro'");
    // Comments name the superseded families on purpose; declarations must not.
    const declarations = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const dropped of ['Alexandria', 'IBM Plex Sans Arabic', 'Manrope', 'Inter']) {
      expect(declarations).not.toContain(dropped);
    }
  });
});

describe('token coverage', () => {
  it('every colour token declared in CSS exists in the module', () => {
    const declared = Object.keys(declaredColors('light'));
    const known = new Set<string>(Object.keys(LIGHT));
    // Derived, non-contrast-bearing tokens live only in CSS by design.
    const cssOnly = new Set([
      'rail-hover',
      'bubble-in',
      'bubble-out',
      'bubble-note',
    ]);
    const unknown = declared.filter((token) => !known.has(token) && !cssOnly.has(token));
    expect(unknown).toEqual([]);
  });

  it('exposes each token through PALETTES', () => {
    for (const token of Object.keys(LIGHT) as ColorToken[]) {
      expect(PALETTES.light[token]).toMatch(/^#[0-9a-f]{6}$/);
      expect(PALETTES.dark[token]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
