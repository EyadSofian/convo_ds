import { expect, test } from '@playwright/test';
import { PASSWORD } from './support/api';
import { openScreen } from './support/workspace';

test.describe('focused product UX repairs', () => {
  test('using an automation template opens the newly-created draft editor', async ({ page }) => {
    await openScreen(page, 'automations');
    const card = page.locator('.automation-template-card').first();
    await card.locator('[data-act="live-automation-use"]').click();
    await expect(page).toHaveURL(/view=mine.*edit=automation-from-template|edit=automation-from-template.*view=mine/);
    await expect(page.locator('[data-automation-builder]')).toBeVisible();
    await expect(page.locator('[name="automationName"]')).toBeFocused();
    await expect(page.locator('.toast')).toContainText(/Draft created|أُنشئت المسودة/);
  });

  test('settings exposes a real password-change flow with honest success feedback', async ({ page }) => {
    await openScreen(page, 'settings');
    await page.locator('[data-act="dialog"][data-arg="change-password"]').click();
    await page.locator('#currentPassword').fill(PASSWORD);
    await page.locator('#newPassword').fill('new controlled password 2026');
    await page.locator('#confirmPassword').fill('new controlled password 2026');
    await page.locator('[data-act="live-change-password"]').click();
    await expect(page.locator('.dialog')).toBeHidden();
    await expect(page.locator('.toast')).toContainText(/Other sessions have been signed out|سُجّلت الجلسات الأخرى/);
  });

  test('template categories own full-width local grids with aligned compact cards', async ({ page }) => {
    await openScreen(page, 'automations');
    const catalogue = await page.locator('.automation-catalogue').boundingBox();
    const category = await page.locator('.automation-category').first().boundingBox();
    expect(catalogue).not.toBeNull();
    expect(category).not.toBeNull();
    expect(category?.width).toBeCloseTo(catalogue?.width ?? 0, 0);
    await expect(page.locator('.automation-template-card').first()).toBeVisible();
  });

  test('People and Settings keep flat full-width hierarchy without control overflow', async ({ page }) => {
    await openScreen(page, 'people');
    const pageWidth = await page.locator('.page__inner').boundingBox();
    const summaryWidth = await page.locator('.people-summary').boundingBox();
    expect(summaryWidth?.width).toBeCloseTo(pageWidth?.width ?? 0, 0);
    await expect(page.locator('.panel[aria-label="الأعضاء"], .panel[aria-label="Members"]')).toBeVisible();

    await page.locator('.nav__item[data-arg="settings"]').click();
    await expect(page.locator('.settings-section')).toHaveCount(4);
    const settingsWidth = await page.locator('.settings-section').first().boundingBox();
    expect(settingsWidth?.width).toBeCloseTo(pageWidth?.width ?? 0, 0);
  });

  test('native selects reserve a stable mirrored chevron area in RTL and LTR', async ({ page }) => {
    await openScreen(page, 'people');
    const select = page.locator('.table .select').first();
    const rtl = await select.evaluate((element) => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, image: style.backgroundImage, position: style.backgroundPosition };
    });
    await page.locator('.lang-toggle').first().click();
    const ltr = await select.evaluate((element) => getComputedStyle(element).backgroundPosition);
    expect(rtl.height).toBe(36);
    expect(rtl.image).toContain('svg');
    expect(rtl.position).not.toBe(ltr);
  });
});
