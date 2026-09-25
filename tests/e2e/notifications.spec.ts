import { expect, test } from '@playwright/test';
import { CONVERSATION, installApi } from './support/api';
import { freezeClock, overflowsHorizontally, setDirection } from './support/workspace';

const NOTIFICATION = '99999999-9999-4999-8999-999999999999';

test('a durable notification opens its exact authorized conversation and stays read after reload', async ({ page }) => {
  await freezeClock(page);
  await installApi(page, { notifications: [{
    id: NOTIFICATION, kind: 'new_message', targetType: 'conversation', targetId: CONVERSATION,
    createdAt: '2026-09-09T09:29:00.000Z', readAt: null,
  }] });
  await page.goto('/#/channels');
  await expect(page.locator('[data-connection]').first()).toBeVisible();
  await expect(page.locator('.notification-bell__badge')).toHaveText('1');

  await page.locator('.notification-bell').click();
  const row = page.locator('[data-act="notification-open"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('رسالة عميل جديدة');
  await expect(page.locator('[data-act="notification-enable-push"]')).toBeDisabled();
  await expect(page.locator('.notification-menu__hint')).toContainText('لم تُضبط بعد');
  await row.click();

  await expect(page).toHaveURL(new RegExp(`/#/inbox/${CONVERSATION}$`));
  await expect(page.locator('.zone--thread')).toBeVisible();
  await expect(page.locator('.notification-bell__badge')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.zone--thread')).toBeVisible();
  await expect(page.locator('.notification-bell__badge')).toHaveCount(0);
  await page.locator('.notification-bell').click();
  await expect(page.locator('.notification-row--unread')).toHaveCount(0);
});

test('the notification drawer fits a phone in Arabic and English', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freezeClock(page);
  await installApi(page, { notifications: [{
    id: NOTIFICATION, kind: 'assignment', targetType: 'conversation', targetId: CONVERSATION,
    createdAt: '2026-09-09T09:29:00.000Z', readAt: null,
  }] });
  await page.goto('/#/channels');
  await expect(page.locator('[data-connection]').first()).toBeVisible();
  for (const direction of ['rtl', 'ltr'] as const) {
    await setDirection(page, direction);
    await page.locator('.notification-bell').click();
    await expect(page.locator('.notification-menu')).toBeVisible();
    let box = await page.locator('.notification-menu').boundingBox();
    // The drawer is animated from a clipped popover; wait for layout to settle
    // before asserting its final mobile geometry.
    await expect.poll(async () => {
      box = await page.locator('.notification-menu').boundingBox();
      return box;
    }).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await overflowsHorizontally(page)).toBe(false);
    await page.locator('.notification-bell').click();
  }
});

test('a phone notification shows its authorized sender and preview, then opens the exact thread', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freezeClock(page);
  await installApi(page, { notifications: [{
    id: NOTIFICATION, kind: 'new_message', targetType: 'conversation', targetId: CONVERSATION,
    createdAt: '2026-09-09T09:29:00.000Z', readAt: null,
    senderName: 'Eyad Test', messagePreview: 'Controlled test message',
  }] });
  await page.goto('/#/channels');
  await expect(page.locator('[data-connection]').first()).toBeVisible();
  await page.locator('.notification-bell').click();
  const row = page.locator('[data-act="notification-open"]');
  await expect(row).toContainText('Eyad Test');
  await expect(row).toContainText('Controlled test message');
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/#/inbox/${CONVERSATION}$`));
  await expect(page.locator('.thread__header')).toBeVisible();
  await expect(page.locator('.zone--thread')).toBeVisible();
  await expect(page.locator('.notification-bell__badge')).toHaveCount(0);
});

test('claiming a conversation on a phone moves it to Mine and opens its thread', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freezeClock(page);
  await installApi(page);
  await page.goto('/#/inbox?queue=unassigned');
  await expect(page.locator('[data-act="live-inbox-claim"]').first()).toBeVisible();
  await page.locator('[data-act="live-inbox-claim"]').first().click();
  await expect(page).toHaveURL(new RegExp(`/#/inbox/${CONVERSATION}`));
  await expect(page.locator('.zone--thread')).toBeVisible();
  await expect(page.locator('.thread__header')).toBeVisible();
  await expect(page.locator('.segmented__item[data-arg="mine"]')).toHaveAttribute('aria-pressed', 'true');
});
