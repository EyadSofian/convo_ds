import { expect, test, type Page } from '@playwright/test';
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
 * Visual regression — task §3, "Add visual-regression screenshots ... for the
 * dimensions and visible-row/message targets above."
 *
 * These are baselines, not judgements: they catch a token change or a layout
 * regression that the dimension assertions in layout.spec.ts would not notice,
 * such as a colour drifting or a control losing its border. The first run
 * writes baselines under tests/e2e/visual.spec.ts-snapshots/.
 *
 * Time is frozen with Playwright's clock before the bundle boots, because the
 * seeded dataset derives every timestamp from `new Date()` at startup — without
 * that, a baseline taken an hour earlier differs in every clock time and every
 * "4m ago". Animations are disabled by the config. A diff therefore means the
 * design changed, not that the day moved on.
 *
 * **Pixels are only half of it.** A screenshot comparison cannot tell a screen
 * being replaced from Arabic glyphs rasterising a subpixel differently: both
 * land around 2% of the image, and only glyph pixels ever differ enough to
 * count. This file therefore pairs every screen baseline with a **structural**
 * snapshot — a DOM skeleton of tags, classes and the actions each control
 * dispatches, with all text removed. Rasterisation cannot move it, and swapping
 * a screen cannot help but change it.
 */

/**
 * A rasterisation-independent fingerprint of what is on screen.
 *
 * Tag, class list and `data-act` per element, indented by depth. No text, so
 * copy edits and seeded timestamps do not churn it; every structural element,
 * so a replaced screen or a lost control is a diff.
 */
async function structureOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((root) => {
    const lines: string[] = [];
    const walk = (element: Element, depth: number): void => {
      const classes = element.getAttribute('class');
      const act = element.getAttribute('data-act');
      lines.push(
        `${'  '.repeat(depth)}${element.tagName.toLowerCase()}` +
          `${classes === null ? '' : `.${classes.trim().split(/\s+/).join('.')}`}` +
          `${act === null ? '' : ` [${act}]`}`,
      );
      for (const child of element.children) {
        walk(child, depth + 1);
      }
    };
    walk(root, 0);
    return lines.join('\n');
  });
}

test.describe('inbox baselines', () => {
  for (const { direction, theme } of MATRIX) {
    test(`inbox — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);
      await expect(page).toHaveScreenshot(`inbox-${direction}-${theme}.png`, { fullPage: false });
    });
  }

  test('inbox with the queue drawer open', async ({ page }) => {
    await openInbox(page);
    await page.locator('.topbar [data-act="list"]').click();
    await expect(page.locator('.inbox')).toHaveAttribute('data-list', 'open');
    await expect(page).toHaveScreenshot('inbox-list-open.png');
  });

  test('inbox showing this agent’s own conversations', async ({ page }) => {
    await openInbox(page);
    await page.locator('[data-act="live-inbox-queue"][data-arg="mine"]').click();
    await expect(page.locator('.convrow--record').first()).toBeVisible();
    await expect(page).toHaveScreenshot('inbox-mine.png');
  });

  test('queue list rows in isolation', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('.zone--list')).toHaveScreenshot('queue-list.png');
  });

  test('composer, ready to reply', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('.composer')).toHaveScreenshot('composer-reply.png');
  });
});

test.describe('state baselines', () => {
  for (const [name, reply] of [
    ['empty', { status: 200, body: { data: [] } }],
    ['denied', { status: 403, body: { error: { code: 'permission_denied', message: 'No.' } } }],
    ['offline', { status: 503, body: { error: { code: 'unavailable', message: 'Try later.' } } }],
  ] as const) {
    test(`queue state — ${name}`, async ({ page }) => {
      // Produced by the server's answer, not by a preview switch: these are the
      // only ways the shipped screen can reach them.
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
      await expect(page.locator('.zone--list .statebox')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`state-${name}.png`);
    });
  }

  test('projected unassigned queue for an agent', async ({ page }) => {
    // business-rules.md §4.1: no snippet, no PII, claim-first. What is drawn
    // here is exactly what the server sent, because the projection happens
    // there.
    await openInbox(page);
    await expect(page.locator('.convrow').first()).toBeVisible();
    await expect(page.locator('.zone--list')).toHaveScreenshot('queue-projection-agent.png');
  });
});

test.describe('workspace screen baselines', () => {
  for (const screen of ['channels', 'people', 'broadcasts', 'analytics', 'settings'] as const) {
    test(`screen — ${screen}`, async ({ page }) => {
      await openScreen(page, screen);
      await expect(page).toHaveScreenshot(`screen-${screen}.png`);
      // The half the pixels cannot do: this fails the moment a screen is
      // replaced by a different one, however similar the two look.
      expect(await structureOf(page, '.workspace')).toMatchSnapshot(
        `screen-${screen}-structure.txt`,
      );
    });
  }
});
