import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { CUSTOM_ROLE, installApi } from './support/api';
import {
  freezeClock,
  MATRIX,
  motionSettled,
  openInbox,
  openScreen,
  openSignedOut,
  overflowsHorizontally,
  SCREENS,
  setDirection,
  setTheme,
} from './support/workspace';

/**
 * Accessibility acceptance: keyboard, focus order, landmarks, labels, dialogs,
 * contrast, reduced motion, RTL/LTR and 200% zoom.
 *
 * axe-core is injected from the installed package rather than a CDN, so the run
 * is reproducible offline and pinned to the version in the lockfile.
 */

const require_ = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8');

interface AxeNode {
  readonly html: string;
  readonly target: readonly string[];
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly AxeNode[];
}

/** Runs axe against the whole page and returns violations at WCAG 2.1 AA. */
async function audit(page: Page): Promise<readonly AxeViolation[]> {
  // Contrast is judged on the settled screen, not on a frame mid-fade.
  await motionSettled(page);
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    const runner = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const results = await runner.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return results.violations;
  });
}

function describeViolations(violations: readonly AxeViolation[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help} — ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

test.describe('axe: no WCAG 2.1 AA violations', () => {
  test('notification drawer and explicit device-alert control', async ({ page }) => {
    await openScreen(page, 'channels');
    await page.locator('.notification-bell').click();
    await expect(page.locator('.notification-menu')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the sign-in page — ${theme}`, async ({ page }) => {
      await openSignedOut(page);
      await setTheme(page, theme);
      expect(describeViolations(await audit(page))).toEqual([]);
      // With the form's own errors showing, too.
      await page.locator('.auth-form__submit').click();
      await expect(page.locator('#signin-email-error')).toBeVisible();
      expect(describeViolations(await audit(page))).toEqual([]);
    });
  }

  for (const { direction, theme } of MATRIX) {
    test(`inbox — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);
      expect(describeViolations(await audit(page))).toEqual([]);
    });
  }

  test('inbox showing this agent’s own conversations, with the filters open', async ({ page }) => {
    await openInbox(page);
    await page.locator('[data-act="live-inbox-queue"][data-arg="mine"]').click();
    await page.locator('[data-act="menu"][data-arg="inbox-filters"]').click();
    await expect(page.locator('.popover')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  test('the private note composer', async ({ page }) => {
    await openInbox(page);
    await page.locator('[data-act="composer-tab"][data-arg="note"]').click();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const screen of SCREENS) {
      test(`workspace screen — ${screen} — ${theme}`, async ({ page }) => {
        await openScreen(page, screen);
        await setTheme(page, theme);
        expect(describeViolations(await audit(page))).toEqual([]);
      });
    }
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`user management in detail — a role, its holders and a team — ${theme}`, async ({ page }) => {
      await openScreen(page, 'roles', `?role=${CUSTOM_ROLE}`);
      await setTheme(page, theme);
      expect(describeViolations(await audit(page))).toEqual([]);
      // A draft brings up the save bar.
      await page.locator('[data-permission="contact.edit"] input').check();
      await expect(page.locator('.savebar')).toBeVisible();
      expect(describeViolations(await audit(page))).toEqual([]);
      await page.locator('[data-act="role-draft-discard"]').click();
      await page.locator('#tab-users').click();
      await expect(page.locator('[data-membership]').first()).toBeVisible();
      expect(describeViolations(await audit(page))).toEqual([]);
      await openScreen(page, 'teams', '?team=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      await setTheme(page, theme);
      expect(describeViolations(await audit(page))).toEqual([]);
    });
  }

  test('user-management dialogs and row menus', async ({ page }) => {
    await openScreen(page, 'people');
    await page.locator('[data-act="menu"][data-arg^="member:"]').first().click();
    await expect(page.locator('.row-menu')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
    await page.locator('.row-menu [data-arg^="member-role:"]').click();
    await expect(page.locator('.dialog')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
    await page.keyboard.press('Escape');

    await page.locator('.nav__item[data-arg="roles"]').click();
    await page.locator('.pagebar [data-arg="role-create"]').click();
    await expect(page.locator('.dialog')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
    await page.keyboard.press('Escape');

    await openScreen(page, 'roles', `?role=${CUSTOM_ROLE}&tab=users`);
    await page.locator('[data-arg^="role-assign:"]').first().click();
    await expect(page.locator('.dialog .pick-list')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  test('dialogs: connecting a channel, inviting a member, drafting a campaign', async ({ page }) => {
    await openScreen(page, 'channels');
    await page.locator('[data-arg="connect-channel:whatsapp"]').first().click();
    await expect(page.locator('.dialog')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
    await page.keyboard.press('Escape');

    await page.locator('.nav__item[data-arg="people"]').click();
    await page.locator('[data-arg="invite"]').click();
    await expect(page.locator('.dialog')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
    await page.keyboard.press('Escape');

    await page.locator('.nav__item[data-arg="broadcasts"]').click();
    await page.locator('[data-act="live-campaign-editor"]').first().click();
    await expect(page.locator('.dialog')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  test('the user menu and the navigation drawer', async ({ page }) => {
    await openInbox(page);
    await page.locator('.user-button').click();
    await expect(page.locator('#user-menu')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.header__menu').click();
    await expect(page.locator('.nav')).toBeVisible();
    expect(describeViolations(await audit(page))).toEqual([]);
  });

  test('the states the server can put the inbox in', async ({ page }) => {
    // Produced by scripting the API, which is the only way the shipped product
    // can reach them.
    for (const reply of [
      { status: 200, body: { data: [] } },
      { status: 403, body: { error: { code: 'permission_denied', message: 'No.' } } },
      { status: 500, body: { error: { code: 'internal', message: 'Try later.', request_id: 'req-500' } } },
    ]) {
      await freezeClock(page);
      await installApi(page);
      await page.route('**/conversations/unassigned', (route) =>
        route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) }),
      );
      await page.goto('/#/inbox');
      await expect(page.locator('.zone--list .empty, .zone--list .errorstate').first()).toBeVisible();
      expect(describeViolations(await audit(page)), `status=${String(reply.status)}`).toEqual([]);
      await page.unrouteAll();
    }
  });
});

test.describe('landmarks and structure', () => {
  test('names the navigation, and has exactly one main and one banner', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('nav.nav')).toHaveAttribute('aria-label', /.+/);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('banner')).toHaveCount(1);
    for (const zone of ['.zone--list', '.zone--thread']) {
      await expect(page.locator(zone)).toHaveAttribute('aria-label', /.+/);
    }
  });

  for (const screen of ['inbox', ...SCREENS] as const) {
    test(`has exactly one h1 and no skipped heading level — ${screen}`, async ({ page }) => {
      if (screen === 'inbox') await openInbox(page);
      else await openScreen(page, screen);
      const levels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((element) => Number.parseInt(element.tagName.slice(1), 10)),
      );
      expect(levels.filter((level) => level === 1)).toHaveLength(1);
      let previous = 0;
      for (const level of levels) {
        if (previous !== 0) expect(level - previous).toBeLessThanOrEqual(1);
        previous = level;
      }
    });
  }

  test('gives every control an accessible name, on every screen', async ({ page }) => {
    await openInbox(page);
    const unnamed = async (): Promise<string[]> =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a[href], [role="tab"]'))
          .filter((element) => {
            const text = (element.textContent ?? '').trim();
            return text.length === 0 && (element.getAttribute('aria-label') ?? '') === '' && (element.getAttribute('title') ?? '') === '';
          })
          .map((element) => element.className),
      );
    expect(await unnamed()).toEqual([]);
    for (const screen of SCREENS) {
      await page.locator(`.nav__item[data-arg="${screen}"]`).click();
      await expect(page.locator(`.page--${screen === 'broadcasts' ? 'campaigns' : screen}`)).toBeVisible();
      expect(await unnamed(), screen).toEqual([]);
    }
  });
});

test.describe('keyboard operation', () => {
  test('skips to the content, then reaches the navigation, header, queue and composer by Tab', async ({ page }) => {
    await openInbox(page);
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    await page.locator('body').click({ position: { x: 1, y: 1 } });
    const seen = new Set<string>();
    for (let index = 0; index < 120; index += 1) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const active = document.activeElement;
        const zone = active?.closest('.nav, .header, .zone--list, .composer, .zone--panel');
        return zone === null || zone === undefined ? '' : (zone.className.split(' ').find((name) => ['nav', 'header', 'zone--list', 'composer', 'zone--panel'].includes(name)) ?? '');
      });
      if (where !== '') seen.add(where);
    }
    for (const zone of ['nav', 'header', 'zone--list', 'composer']) expect(seen.has(zone), zone).toBe(true);
  });

  test('shows a visible focus ring on the focused control', async ({ page }) => {
    await openInbox(page);
    // The composer's ring is drawn on its box, which is what surrounds the text.
    for (const [selector, ringed] of [
      ['.convrow [data-act="live-inbox-claim"]', null],
      ['.nav__item', null],
      ['.composer__input', '.composer'],
    ] as const) {
      const target = page.locator(selector).first();
      await target.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const outline = await page.evaluate((ring) => {
        const element = ring === null ? (document.activeElement as Element) : (document.querySelector(ring) as Element);
        const style = getComputedStyle(element);
        return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle, shadow: style.boxShadow };
      }, ringed);
      expect((outline.width >= 2 && outline.style !== 'none') || outline.shadow !== 'none', selector).toBe(true);
    }
  });

  test('a dialog takes focus, keeps it, and gives it back on Escape', async ({ page }) => {
    await openScreen(page, 'people');
    const opener = page.locator('[data-arg="invite"]');
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.dialog')).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement))).toBe(true);
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('walks the user menu with the arrow keys', async ({ page }) => {
    await openInbox(page);
    await page.locator('.user-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#user-menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toMatch(/menuitem/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#user-menu')).toHaveCount(0);
    await expect(page.locator('.user-button')).toBeFocused();
  });

  test('operates the queue-list separator from the keyboard', async ({ page }) => {
    await openInbox(page);
    const resizer = page.locator('.list-resizer');
    await resizer.focus();
    const before = await page.locator('.zone--list').evaluate((element) => element.getBoundingClientRect().width);
    await page.keyboard.press('ArrowLeft');
    const after = await page.locator('.zone--list').evaluate((element) => element.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before);
    await expect(resizer).toHaveAttribute('aria-valuenow', String(Math.round(after)));
  });
});

test.describe('motion and zoom', () => {
  test('honours prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openInbox(page);
    const durations = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.convrow, .nav__item, .btn, .spinner, .skeleton__block')).map((element) => {
        const style = getComputedStyle(element);
        return [style.transitionDuration, style.animationDuration];
      }),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const pair of durations) {
      for (const value of pair) {
        for (const part of value.split(',')) expect(Number.parseFloat(part)).toBeLessThan(0.02);
      }
    }
  });

  for (const direction of ['rtl', 'ltr'] as const) {
    test(`stays usable at 200% zoom — ${direction}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      // 200% zoom halves the CSS viewport (WCAG 1.4.4 / 1.4.10).
      await page.setViewportSize({ width: 683, height: 384 });
      await expect(page.locator('.composer__input')).toBeVisible();
      await page.locator('.thread__listtoggle').click();
      await expect(page.locator('.convrow').first()).toBeVisible();
      expect(await overflowsHorizontally(page), `horizontal overflow at 200% zoom in ${direction}`).toBe(false);
      expect(describeViolations(await audit(page))).toEqual([]);
    });
  }
});
