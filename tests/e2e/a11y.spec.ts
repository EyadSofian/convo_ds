import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { installApi } from './support/api';
import {
  freezeClock,
  MATRIX,
  openInbox,
  openScreen,
  setDirection,
  setTheme,
} from './support/workspace';

/**
 * Accessibility acceptance — task §3, "Run accessibility checks for keyboard,
 * focus order, landmarks, labels, dialogs, contrast, reduced motion, RTL/LTR
 * and 200% zoom."
 *
 * axe-core is injected from the installed package rather than a CDN, so the run
 * is reproducible offline and pinned to the version in the lockfile.
 */

const require_ = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8');

interface AxeNode {
  readonly html: string;
  readonly target: readonly string[];
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly AxeNode[];
}

/** Runs axe against the whole page and returns violations at AA. */
async function audit(page: Page, context?: string): Promise<readonly AxeViolation[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (selector) => {
    const runner = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const target = selector === undefined ? document : document.querySelector(selector);
    const results = await runner.run(target ?? document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return results.violations;
  }, context);
}

function describeViolations(violations: readonly AxeViolation[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help} — ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

test.describe('axe: no WCAG 2.1 AA violations', () => {
  for (const { direction, theme } of MATRIX) {
    test(`inbox — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);
      expect(describeViolations(await audit(page))).toEqual([]);
    });
  }

  test('inbox with the queue drawer open', async ({ page }) => {
    await openInbox(page);
    await page.locator('.topbar [data-act="list"]').click();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  test('inbox showing this agent’s own conversations', async ({ page }) => {
    await openInbox(page);
    await page.locator('[data-act="live-inbox-queue"][data-arg="mine"]').click();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  for (const screen of ['channels', 'people', 'broadcasts', 'analytics', 'settings'] as const) {
    test(`workspace screen — ${screen}`, async ({ page }) => {
      await openScreen(page, screen);
      expect(describeViolations(await audit(page))).toEqual([]);
    });
  }

  test('open dialog', async ({ page }) => {
    // Viewed as the role that may draft a campaign: the control is not offered
    // to a role without the grant, which is the point of the matrix.
    await openScreen(page, 'broadcasts', '?as=campaign_manager');
    await page.locator('[data-act="dialog"][data-arg="campaign"]').first().click();
    await expect(page.locator('.dialog')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  test('the states the server can put the inbox in', async ({ page }) => {
    // The empty and refused states are the server's answers now, not a preview
    // switch: they are produced by scripting the API, which is the only way
    // they can appear in the shipped product.
    for (const reply of [
      { status: 200, body: { data: [] } },
      { status: 403, body: { error: { code: 'permission_denied', message: 'No.' } } },
      { status: 500, body: { error: { code: 'internal', message: 'Try later.' } } },
    ]) {
      await freezeClock(page);
      await installApi(page);
      await page.route('**/conversations/unassigned', (route) =>
        route.fulfill({
          status: reply.status,
          contentType: 'application/json',
          body: JSON.stringify(reply.body),
        }),
      );
      await page.goto('/#/inbox');
      await expect(page.locator('.zone--list')).toBeVisible();
      await expect(page.locator('.zone--list .statebox, .convrow').first()).toBeVisible();
      expect(describeViolations(await audit(page)), `status=${String(reply.status)}`).toEqual([]);
      await page.unrouteAll();
    }
  });
});

test.describe('landmarks and structure', () => {
  test('names every landmark region exactly once', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('nav.rail')).toHaveAttribute('aria-label', /.+/);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('banner')).toHaveCount(1);
    // Each work zone is a labelled region so a screen-reader user can jump.
    for (const zone of ['.zone--list', '.zone--thread']) {
      await expect(page.locator(zone)).toHaveAttribute('aria-label', /.+/);
    }
  });

  test('has exactly one h1 and no skipped heading level', async ({ page }) => {
    await openInbox(page);
    const levels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((element) =>
        Number.parseInt(element.tagName.slice(1), 10),
      ),
    );
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    let previous = 0;
    for (const level of levels) {
      if (previous !== 0) expect(level - previous).toBeLessThanOrEqual(1);
      previous = level;
    }
  });

  test('gives every icon-only control an accessible name', async ({ page }) => {
    await openInbox(page);
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .filter((button) => {
          const text = (button.textContent ?? '').trim();
          const label = button.getAttribute('aria-label') ?? '';
          const title = button.getAttribute('title') ?? '';
          return text.length === 0 && label.length === 0 && title.length === 0;
        })
        .map((button) => button.className),
    );
    expect(unnamed).toEqual([]);
  });
});

test.describe('keyboard operation', () => {
  test('reaches the rail, the queue and the composer by Tab alone', async ({ page }) => {
    await openInbox(page);
    await page.locator('body').press('Tab');

    const seen = new Set<string>();
    for (let i = 0; i < 90; i += 1) {
      const where = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return '';
        const zone = active.closest('.rail,.topbar,.zone--list,.zone--thread,.zone--views,.zone--panel');
        return zone === null ? '' : (zone.className.split(' ')[0] ?? '');
      });
      if (where !== '') seen.add(where);
      await page.keyboard.press('Tab');
    }
    expect(seen.has('rail')).toBe(true);
    expect(seen.has('topbar')).toBe(true);
    expect(seen.has('zone')).toBe(true);
  });

  test('shows a visible focus ring on the focused control', async ({ page }) => {
    await openInbox(page);
    const target = page.locator('.convrow [data-act="live-inbox-claim"]').first();
    await target.focus();
    const outline = await target.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
    expect(outline.style).not.toBe('none');
  });

  test('a dialog can be dismissed with Escape and returns to the page', async ({ page }) => {
    await openScreen(page, 'broadcasts', '?as=campaign_manager');
    await page.locator('[data-act="dialog"][data-arg="campaign"]').first().click();
    await expect(page.locator('.dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).toHaveCount(0);
  });

  test('operates the queue-list separator from the keyboard', async ({ page }) => {
    await openInbox(page);
    const resizer = page.locator('.list-resizer');
    await resizer.focus();
    const before = await page.locator('.zone--list').evaluate((el) => el.getBoundingClientRect().width);
    await page.keyboard.press('ArrowLeft');
    const after = await page.locator('.zone--list').evaluate((el) => el.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before);
  });
});

test.describe('motion and zoom', () => {
  test('honours prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openInbox(page);
    const durations = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.convrow, .rail__item, .inbox')).map((element) => {
        const style = window.getComputedStyle(element);
        return `${style.transitionDuration}|${style.animationDuration}`;
      }),
    );
    for (const pair of durations) {
      for (const value of pair.split('|')) {
        // 0.01ms is the documented "effectively off" value in base.css.
        expect(Number.parseFloat(value)).toBeLessThan(0.02);
      }
    }
  });

  // One test per direction: a hash change does not reload the app, so looping
  // inside a single test carried drawer state from the first pass into the
  // second and made the failure look like a layout bug.
  for (const direction of ['rtl', 'ltr'] as const) {
    test(`stays usable at 200% zoom — ${direction}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      // 200% zoom halves the CSS viewport (WCAG 1.4.4 / 1.4.10).
      await page.setViewportSize({ width: 683, height: 384 });

      // Below 1028px the queue is a drawer, so the timeline and composer stay
      // operable and the list is reached from the top bar — not two columns
      // crushed together.
      await expect(page.locator('.composer__input')).toBeVisible();
      await page.locator('.topbar [data-act="list"]').click();
      await expect(page.locator('.convrow').first()).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflow, `horizontal overflow at 200% zoom in ${direction}`).toBe(false);
      expect(describeViolations(await audit(page))).toEqual([]);
    });
  }
});
