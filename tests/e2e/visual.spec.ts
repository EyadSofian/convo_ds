import { expect, test } from '@playwright/test';
import { MATRIX, openInbox, setDirection, setTheme } from './support/workspace';

/**
 * Visual regression — task §3, "Add visual-regression screenshots ... for the
 * dimensions and visible-row/message targets above."
 *
 * These are baselines, not judgements: they catch a token change or a layout
 * regression that the dimension assertions in layout.spec.ts would not notice,
 * such as a colour drifting or a control losing its border. The first run
 * writes baselines under tests/e2e/visual.spec.ts-snapshots/.
 *
 * Time is frozen through the app's own deterministic seed (every timestamp is
 * derived from `now` in src/data.ts), and animations are disabled by the config,
 * so a diff means the design changed.
 */

test.describe('inbox baselines', () => {
  for (const { direction, theme } of MATRIX) {
    test(`inbox — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);
      await expect(page).toHaveScreenshot(`inbox-${direction}-${theme}.png`, { fullPage: false });
    });
  }

  test('inbox with the views sidebar open', async ({ page }) => {
    await openInbox(page);
    await page.locator('.topbar [data-act="sidebar"]').click();
    await expect(page.locator('.zone--views')).toBeVisible();
    await expect(page).toHaveScreenshot('inbox-views-open.png');
  });

  test('inbox with the customer panel open', async ({ page }) => {
    await openInbox(page);
    await page.locator('.thread__header [data-act="panel"]').click();
    await expect(page.locator('.zone--panel')).toBeVisible();
    await expect(page).toHaveScreenshot('inbox-panel-open.png');
  });

  test('focus mode', async ({ page }) => {
    await openInbox(page);
    await page.locator('[data-act="focus"]').click();
    await expect(page.locator('.inbox')).toHaveAttribute('data-focus', 'on');
    await expect(page).toHaveScreenshot('inbox-focus-mode.png');
  });

  test('queue list rows in isolation', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('.zone--list')).toHaveScreenshot('queue-list.png');
  });

  test('composer in reply and note modes', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('.composer')).toHaveScreenshot('composer-reply.png');
    await page.locator('[data-act="composer-tab"][data-arg="note"]').click();
    await expect(page.locator('.composer')).toHaveScreenshot('composer-note.png');
  });
});

test.describe('state baselines', () => {
  for (const state of ['loading', 'empty', 'offline', 'denied'] as const) {
    test(`preview state — ${state}`, async ({ page }) => {
      await openInbox(page);
      await page.locator('select[data-act="preview"]').selectOption(state);
      await expect(page).toHaveScreenshot(`state-${state}.png`);
    });
  }

  test('projected unassigned queue for an agent', async ({ page }) => {
    // business-rules.md §4.1: no snippet, no PII, claim-first.
    await page.goto('/#/inbox?as=agent&queue=unassigned');
    await expect(page.locator('.convrow').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('queue-projection-agent.png');
  });
});

test.describe('workspace screen baselines', () => {
  for (const screen of ['channels', 'people', 'broadcasts', 'analytics', 'settings'] as const) {
    test(`screen — ${screen}`, async ({ page }) => {
      await page.goto(`/#/${screen}`);
      await expect(page.locator('.workspace')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`screen-${screen}.png`);
    });
  }
});
