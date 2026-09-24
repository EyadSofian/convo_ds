import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { CUSTOM_ROLE } from './support/api';
import { MATRIX, openScreen, overflowsHorizontally, setDirection, setTheme } from './support/workspace';

/**
 * Users, Roles and Teams as three destinations, driven in a real engine: the
 * navigation between them, the permission console's draft and save, the row
 * menus, and the layout across direction, theme and a phone.
 */

const ADMISSIONS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function capture(page: Page, pattern: RegExp, method: string, reply: unknown): Promise<() => unknown> {
  let body: unknown;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    body = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: reply, request_id: 'e2e' }) });
  });
  return () => body;
}

test.describe('user management', () => {
  test('Users, Roles and Teams are separate destinations under one heading', async ({ page }) => {
    await openScreen(page, 'people');
    await setDirection(page, 'ltr');
    await expect(page.locator('.nav__group-label')).toHaveText('User management');
    await expect(page.locator('.header__title')).toHaveText('Users');
    // A list page names itself once, in the header: no second title or breadcrumb.
    await expect(page.locator('.page--people .admin-head, .page--people .breadcrumb')).toHaveCount(0);
    await expect(page.locator('[data-membership]')).toHaveCount(4);

    await page.locator('.nav__item[data-arg="roles"]').click();
    await expect(page).toHaveURL(/#\/roles/);
    await expect(page.locator('[data-role="enrollment_lead"]')).toContainText('Custom');

    await page.locator('.nav__item[data-arg="teams"]').click();
    await expect(page).toHaveURL(/#\/teams/);
    await expect(page.locator(`[data-team="${ADMISSIONS}"]`)).toContainText('Admissions');

    await page.locator(`[data-team="${ADMISSIONS}"] a`).click();
    await expect(page.locator('[data-team-member]')).toHaveCount(2);
    await page.locator('.breadcrumb a').filter({ hasText: 'Teams' }).click();
    await expect(page.locator('[data-team]')).toHaveCount(2);
  });

  test('invitations have their own tab, and Back returns to it', async ({ page }) => {
    await openScreen(page, 'people');
    await setDirection(page, 'ltr');
    await page.locator('#tab-invitations').click();
    await expect(page.locator('[data-invitation]')).toContainText('nour@digital-school.example');
    await page.locator('#tab-users').click();
    await page.goBack();
    await expect(page.locator('#tab-invitations')).toHaveAttribute('aria-selected', 'true');
  });

  test('a row menu opens from the keyboard and closes on Escape', async ({ page }) => {
    await openScreen(page, 'people');
    await setDirection(page, 'ltr');
    const trigger = page.locator('[data-act="menu"][data-arg^="member:"]').first();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.row-menu[role="menu"]')).toBeVisible();
    await expect(page.locator('.row-menu [role="menuitem"]').first()).toContainText('Change role');
    await page.keyboard.press('Escape');
    await expect(page.locator('.row-menu')).toHaveCount(0);
  });

  test('the permission console drafts changes, warns about them, and saves the whole grant set', async ({ page }) => {
    await openScreen(page, 'roles', `?role=${CUSTOM_ROLE}`);
    await setDirection(page, 'ltr');
    const saved = await capture(page, new RegExp(`/roles/${CUSTOM_ROLE}$`), 'PATCH', {});

    // Friendly labels over the real key; locks explain themselves.
    await expect(page.locator('[data-permission="conversation.read"]')).toContainText('conversation.read');
    await expect(page.locator('[data-permission="tenant.delete"] input')).toBeDisabled();
    await expect(page.locator('[data-permission="tenant.delete"]')).toContainText('Not delegable');

    await page.locator('[data-permission="contact.edit"] input').check();
    await page.locator('[data-permission="contact.edit"] select').selectOption('own');
    await expect(page.locator('.savebar')).toBeVisible();

    await page.locator('[data-act="permission-search"]').fill('reply');
    await expect(page.locator('.permission-row')).toHaveCount(1);
    await page.locator('[data-act="permission-search"]').fill('');

    await page.locator('.savebar [data-act="live-save-role"]').click();
    await expect.poll(saved).toEqual({
      name: 'Enrollment lead',
      description: 'Handles enrolment conversations for the admissions team.',
      grants: [
        { permission: 'conversation.read', scope: 'scoped' },
        { permission: 'conversation.reply', scope: 'scoped' },
        { permission: 'contact.read', scope: 'scoped' },
        { permission: 'report.read', scope: 'tenant' },
        { permission: 'contact.edit', scope: 'own' },
      ],
    });
  });

  test('a built-in role shows its permissions read-only', async ({ page }) => {
    await openScreen(page, 'roles');
    await setDirection(page, 'ltr');
    await page.locator('[data-role="admin"] a').click();
    await expect(page.locator('[data-permission]').first()).toBeVisible();
    await expect(page.locator('.permission-row input:not([disabled])')).toHaveCount(0);
    await expect(page.locator('.savebar')).toHaveCount(0);
  });

  test('the assigned-users tab lists holders and offers to assign more', async ({ page }) => {
    await openScreen(page, 'roles', `?role=${CUSTOM_ROLE}`);
    await setDirection(page, 'ltr');
    await page.locator('#tab-users').click();
    await expect(page.locator('[data-membership]')).toHaveCount(1);
    await page.locator('[data-arg^="role-assign:"]').first().click();
    await expect(page.locator('.dialog .pick-list input')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).toHaveCount(0);
  });

  for (const { direction, theme } of MATRIX) {
    test(`role detail holds its layout — ${direction}/${theme}`, async ({ page }) => {
      await openScreen(page, 'roles', `?role=${CUSTOM_ROLE}`);
      await setDirection(page, direction);
      await setTheme(page, theme);
      expect(await overflowsHorizontally(page)).toBe(false);
      const cards = page.locator('.permission-card');
      const first = await cards.nth(0).boundingBox();
      const second = await cards.nth(1).boundingBox();
      // Two modules side by side on a desktop.
      expect(Math.abs((first?.y ?? 0) - (second?.y ?? 1))).toBeLessThan(2);
      // The breadcrumb follows the reading direction.
      const crumbs = await page.locator('.breadcrumb li').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().x));
      expect(direction === 'rtl' ? crumbs[0]! > crumbs[1]! : crumbs[0]! < crumbs[1]!).toBe(true);
    });
  }

  test('all three destinations fit a phone without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [screen, query] of [['people', ''], ['roles', ''], ['roles', `?role=${CUSTOM_ROLE}`], ['teams', ''], ['teams', `?team=${ADMISSIONS}`]] as const) {
      await openScreen(page, screen, query);
      for (const direction of ['rtl', 'ltr'] as const) {
        await setDirection(page, direction);
        expect(await overflowsHorizontally(page), `${screen}${query} ${direction}`).toBe(false);
      }
    }
  });
});
