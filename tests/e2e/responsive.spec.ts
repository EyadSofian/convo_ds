import { expect, test } from '@playwright/test';
import {
  fontsReady,
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
});
