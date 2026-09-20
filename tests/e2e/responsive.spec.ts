import { expect, test } from '@playwright/test';
import {
  fontsReady,
  openAutomationBuilder,
  openInbox,
  openScreen,
  openSignedOut,
  overflowsHorizontally,
  SCREENS,
  setDirection,
} from './support/workspace';

const WIDTHS = [1440, 1366, 1280, 1024, 768, 430, 390] as const;

test.describe('required responsive matrix', () => {
  for (const width of WIDTHS) {
    test(`${String(width)}px keeps the auth and Inbox frames usable`, async ({ page }) => {
      const height = width <= 430 ? 844 : 900;
      const authPage = await page.context().newPage();
      await authPage.setViewportSize({ width, height });
      await openSignedOut(authPage);
      await expect(authPage.locator('.auth-card')).toBeVisible();
      expect(await overflowsHorizontally(authPage)).toBe(false);
      await authPage.close();

      await openInbox(page);
      await page.setViewportSize({ width, height });
      await setDirection(page, width % 2 === 0 ? 'rtl' : 'ltr');
      await expect(page.locator('.zone--thread')).toBeVisible();
      expect(await overflowsHorizontally(page)).toBe(false);

      if (width < 960) {
        await expect(page.locator('.nav')).toBeHidden();
        await expect(page.locator('.header__menu')).toBeVisible();
      }
      if (width <= 768) {
        await expect(page.locator('.zone--panel')).toBeHidden();
      }
      if (width === 1280) {
        await expect(page.locator('.zone--panel')).toBeHidden();
        const nameFits = await page.locator('.thread__name').evaluate((element) => element.scrollWidth <= element.clientWidth);
        expect(nameFits).toBe(true);
      }
      if (width <= 430) {
        await expect(page.locator('[data-act="live-inbox-send"]')).toBeVisible();
      }
    });

    test(`${String(width)}px keeps every workspace screen inside the viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 });
      for (const screen of SCREENS) {
        await openScreen(page, screen);
        await expect(page.locator('.page')).toBeVisible();
        expect(await overflowsHorizontally(page), `${screen} overflowed at ${String(width)}px`).toBe(false);
      }
      await fontsReady(page);
    });
  }

  test('the smallest viewport contains the channel dialog', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openScreen(page, 'channels');
    await page.locator('[data-arg="connect-channel:whatsapp"]').first().click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  });

  for (const width of [1024, 430] as const) {
    test(`${String(width)}px gives the seventh report KPI a complete row`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await openScreen(page, 'analytics');
      const figures = page.locator('.kpis--7 .kpi');
      const first = await figures.first().boundingBox();
      const last = await figures.last().boundingBox();
      expect(first).not.toBeNull();
      expect(last).not.toBeNull();
      expect(last?.width ?? 0).toBeGreaterThan((first?.width ?? 0) * 1.9);
    });
  }

  test('side chevrons mirror in RTL while down chevrons do not', async ({ page }) => {
    await openScreen(page, 'automations');
    const side = page.locator('.automation-flow-mini .icon--directional').first();
    await expect(side).toBeVisible();
    expect(await side.evaluate((element) => getComputedStyle(element).scale)).toBe('-1 1');
    const down = page.locator('.user-button svg').last();
    expect(await down.evaluate((element) => getComputedStyle(element).scale)).toBe('none');
    await setDirection(page, 'ltr');
    expect(await page.locator('.automation-flow-mini .icon--directional').first().evaluate((element) => getComputedStyle(element).scale)).toBe('none');
  });

  for (const width of [1024, 768, 430, 390] as const) {
    test(`${String(width)}px keeps the Automation editor and its nodes inside the viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 });
      await openAutomationBuilder(page);
      expect(await overflowsHorizontally(page)).toBe(false);
      const node = await page.locator('.workflow-block').first().boundingBox();
      expect(node).not.toBeNull();
      expect(node?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((node?.x ?? 0) + (node?.width ?? 0)).toBeLessThanOrEqual(width);
      await expect(page.locator('.automation-inspector')).toBeVisible();
    });
  }
});
