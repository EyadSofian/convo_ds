import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

for (const width of [390, 430, 768, 1366, 1440]) {
  test(`${width}px presents the same task-derived progress without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /clear view/i })).toBeVisible();
    await expect(page.locator('#overall-percent')).toHaveText('44%');
    await expect(page.locator('#completed-stat')).toHaveText('16');
    await expect(page.locator('#remaining-stat')).toHaveText('20');
    await expect(page.locator('.day-card')).toHaveCount(12);
    await expect(page.locator('#day-detail')).toContainText('Conversation operations');
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(width);
  });
}

test('day cards are usable by keyboard and reveal client-safe detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const dayFour = page.getByRole('button', { name: /Day 4: WhatsApp connection/i });
  await dayFour.focus();
  await page.keyboard.press('Enter');
  await expect(dayFour).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#day-detail')).toContainText('Live message validation');
  await expect(page.locator('#day-detail')).toBeInViewport();
  await expect(page.locator('#client-action-list li')).toHaveCount(4);
  await expect(page.locator('body')).not.toContainText('Railway');
  await expect(page.locator('body')).not.toContainText('migration');
});

for (const width of [390, 1366]) {
  test(`${width}px has no detected WCAG 2.1 AA violations`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Keep the shipped CSP strict; remove it only on this test response so
    // Playwright can inject the local axe bundle for an accessibility audit.
    await page.route('**/', async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['content-security-policy'];
      await route.fulfill({ response, headers });
    });
    await page.goto('/');
    await page.addScriptTag({ path: fileURLToPath(import.meta.resolve('axe-core/axe.min.js')) });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      return result.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }));
    });
    expect(violations).toEqual([]);
  });
}
