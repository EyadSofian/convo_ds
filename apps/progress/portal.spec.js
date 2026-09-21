import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

for (const width of [390, 430, 768, 1366, 1440]) {
  test(`${width}px presents three task-derived phases without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /clear path/i })).toBeVisible();
    await expect(page.locator('#overall-percent')).toHaveText('53%');
    await expect(page.locator('#current-phase')).toHaveText('Phase 1 of 3');
    await expect(page.locator('#completed-stat')).toHaveText('19');
    await expect(page.locator('#remaining-stat')).toHaveText('17');
    await expect(page.locator('.phase-card')).toHaveCount(3);
    await expect(page.locator('.phase-card__progress strong')).toHaveText(['75%', '58%', '25%']);
    await expect(page.locator('.phase-card__status')).toHaveText(['In Progress', 'In Progress', 'Waiting for Client']);
    await expect(page.locator('#requirements-list li')).toHaveCount(4);
    await expect(page.locator('#next-steps-list li')).toHaveCount(5);
    await expect(page.locator('body')).not.toContainText(/12.day|day (?:1|2|3|4|5|6|7|8|9|10|11|12)/i);
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(width);
  });
}

test('client access requirements remain pending and no live provider success is implied', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.requirement__state')).toHaveText(['Pending', 'Pending', 'Pending', 'Pending']);
  await expect(page.locator('.phase-card').nth(1)).toContainText('Live message validation');
  await expect(page.locator('.phase-card').nth(1)).toContainText('Waiting for Client');
  await expect(page.locator('body')).not.toContainText('passwords through this page');
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
