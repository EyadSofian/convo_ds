import { expect, test } from '@playwright/test';
import { PASSWORD } from './support/api';
import { openInbox, openScreen } from './support/workspace';

test.describe('focused product UX repairs', () => {
  test('WhatsApp template picker previews parameters and submits a catalog-backed send', async ({ page }) => {
    let payload: Record<string, unknown> | undefined;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/conversations\/[^/]+\/messages$/.test(request.url())) {
        payload = request.postDataJSON() as Record<string, unknown>;
      }
    });
    await openInbox(page);
    await page.locator('[data-act="live-whatsapp-template-open"]').click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-act="live-whatsapp-template-select"][data-arg="whatsapp-template-1"]').click();
    await dialog.locator('[data-form="whatsappTemplateParameter_body_1"]').fill('Ahmed');
    await expect(dialog.locator('.wa-template-preview')).toContainText('Hello Ahmed');
    await dialog.locator('[data-act="live-whatsapp-template-send"]').click();
    await expect.poll(() => payload).toMatchObject({
      messageType: 'template',
      template: { id: 'whatsapp-template-1', parameters: { 'body:1': 'Ahmed' } },
    });
    await expect(dialog).toBeHidden();
  });

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
    await page.locator('#currentPassword').fill('mistyped current password');
    await page.locator('#newPassword').fill('new controlled password 2026');
    await page.locator('#confirmPassword').fill('new controlled password 2026');
    await page.locator('[data-act="live-change-password"]').click();
    await expect(page.locator('.dialog')).toContainText('current password');
    await expect(page.locator('#currentPassword')).toHaveValue('');
    await expect(page.locator('#newPassword')).toHaveValue('new controlled password 2026');
    await expect(page.locator('#confirmPassword')).toHaveValue('new controlled password 2026');

    await page.locator('#currentPassword').evaluate((element, value) => { (element as HTMLInputElement).value = value; }, PASSWORD);
    await page.locator('[data-act="live-change-password"]').click();
    await expect(page.locator('.dialog')).toBeHidden();
    await expect(page.locator('.toast')).toContainText(/Other sessions have been signed out|سُجّلت الجلسات الأخرى/);
  });

  test('inbox refresh and supervisor actions are circular, clear, and fit a phone viewport', async ({ page }) => {
    await openInbox(page);
    for (const width of [1440, 430, 390]) {
      await page.setViewportSize({ width, height: 844 });
      if (width <= 599) {
        const listToggle = page.locator('.thread__listtoggle');
        if (await listToggle.getAttribute('aria-expanded') !== 'true') await listToggle.click();
      }
      const refresh = page.locator('.inbox-refresh-trigger');
      const supervisor = page.locator('.inbox-supervisor-trigger');
      await expect(refresh).toBeVisible();
      await expect(supervisor).toHaveAccessibleName(/Supervisor view for an agent|عرض إشرافي للوكيل/);
      const geometry = await refresh.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const icon = element.querySelector('svg')?.getBoundingClientRect();
        return {
          radius: getComputedStyle(element).borderRadius,
          contained: icon !== undefined && icon !== null && icon.left >= box.left && icon.right <= box.right && icon.top >= box.top && icon.bottom <= box.bottom,
        };
      });
      expect(geometry.radius).toBe('999px');
      expect(geometry.contained).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.route('**/api/v1/tenants/*/supervisor/agents', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], request_id: 'e2e' }),
    }));
    const eye = page.locator('.inbox-supervisor-trigger');
    await eye.click();
    await expect(eye).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#inbox-supervisor-picker')).toBeVisible();
    await expect(eye.locator('.spinner')).toHaveCount(0);
    await eye.click();
    await expect(eye).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#inbox-supervisor-picker')).toHaveCount(0);
  });

  test('selected supervisor workload keeps readable text in the narrow Inbox column', async ({ page }) => {
    await openInbox(page);
    const agentId = '99999999-9999-4999-8999-999999999999';
    await page.route('**/api/v1/tenants/*/supervisor/agents', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ membershipId: agentId, name: 'eyadsofian862', email: 'synthetic@example.test', teams: ['Support'] }] }),
    }));
    await page.route('**/api/v1/tenants/*/supervisor/workload?*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ data: { agent: { membershipId: agentId, name: 'eyadsofian862', email: 'synthetic@example.test', teams: ['Support'] }, current: { assigned: 0, open: 0, pending: 0, snoozed: 0, unreplied: 0 }, byStatus: [], byChannel: [] } }),
    }));
    await page.route('**/api/v1/tenants/*/supervisor/conversations?*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], page: { next_cursor: null } }),
    }));
    await page.setViewportSize({ width: 1440, height: 844 });
    await page.locator('.inbox-supervisor-trigger').click();
    await page.locator('[data-act="live-supervisor-agent"]').selectOption(agentId);
    const banner = page.locator('.inbox-supervisor-banner');
    await expect(banner).toContainText(/(?:Viewing|عرض حمل) eyadsofian862/);
    await expect(banner).toContainText(/(?:0 active conversations|0 محادثات نشطة)/);
    const widths = await banner.evaluate((element) => ({
      banner: element.getBoundingClientRect().width,
      identity: element.querySelector('.inbox-supervisor-banner__identity')?.getBoundingClientRect().width ?? 0,
    }));
    expect(widths.identity).toBeGreaterThan(250);
    expect(widths.identity).toBeLessThanOrEqual(widths.banner);
    await page.locator('.inbox-supervisor-trigger').click();
    await expect(banner).toHaveCount(0);
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

  test('Users and Settings keep flat full-width hierarchy without control overflow', async ({ page }) => {
    await openScreen(page, 'people');
    const pageWidth = await page.locator('.page__inner').boundingBox();
    const panelWidth = await page.locator('.admin-panel').boundingBox();
    expect(panelWidth?.width).toBeCloseTo(pageWidth?.width ?? 0, 0);
    await expect(page.locator('.admin-panel[role="tabpanel"]')).toBeVisible();

    await page.locator('.nav__item[data-arg="settings"]').click();
    await expect(page.locator('.settings-section')).toHaveCount(4);
    await expect(page.locator('.settings-section').first()).toBeVisible();
    // Route data and the notification count may both redraw the shell. Measure
    // the current section after those harmless refreshes, not a detached node.
    await expect.poll(async () => (await page.locator('.settings-section').first().boundingBox())?.width ?? 0)
      .toBeCloseTo(pageWidth?.width ?? 0, 0);
  });

  test('native selects reserve a stable mirrored chevron area in RTL and LTR', async ({ page }) => {
    await openScreen(page, 'teams', '?team=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const select = page.locator('.team-add .select').first();
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
