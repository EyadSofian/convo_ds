import { expect, test, type Page } from '@playwright/test';
import { installApi } from './support/api';
import {
  fontsReady,
  freezeClock,
  MATRIX,
  openAutomationBuilder,
  openInbox,
  openScreen,
  openSignedOut,
  SCREENS,
  setDirection,
  setTheme,
} from './support/workspace';

/**
 * Visual regression for the redesigned operator UI.
 *
 * These are baselines, not judgements: they catch a token change or a layout
 * regression that the dimension assertions in layout.spec.ts would not notice,
 * such as a colour drifting or a control losing its border.
 *
 * Time is frozen with Playwright's clock before the bundle boots, and
 * animations are disabled by the config, so a diff means the design changed,
 * not that the day moved on.
 *
 * **Pixels are only half of it.** A screenshot comparison cannot tell a screen
 * being replaced from Arabic glyphs rasterising a subpixel differently: both
 * land around 2% of the image. Every screen baseline is therefore paired with a
 * **structural** snapshot — a DOM skeleton of tags, classes and the actions
 * each control dispatches, with all text removed. Rasterisation cannot move it,
 * and swapping a screen cannot help but change it.
 */

async function structureOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((root) => {
    const lines: string[] = [];
    const walk = (element: Element, depth: number): void => {
      const classes = element.getAttribute('class');
      const act = element.getAttribute('data-act');
      lines.push(
        `${'  '.repeat(depth)}${element.tagName.toLowerCase()}` +
          `${classes === null ? '' : `.${classes.trim().split(/\s+/).join('.')}`}` +
          `${act === null ? '' : ` [${act}]`}`,
      );
      for (const child of element.children) {
        walk(child, depth + 1);
      }
    };
    walk(root, 0);
    return lines.join('\n');
  });
}

test.describe('sign-in baselines', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`sign-in — ${theme}`, async ({ page }) => {
      await openSignedOut(page);
      await setTheme(page, theme);
      await expect(page).toHaveScreenshot(`signin-${theme}.png`);
    });
  }

  test('sign-in, refused', async ({ page }) => {
    await openSignedOut(page);
    await page.locator('#signin-email').fill('hana@digital-school.example');
    await page.locator('#signin-password').fill('not the password');
    await page.locator('.auth-form__submit').click();
    await expect(page.locator('.auth-card [role="alert"]')).toBeVisible();
    await expect(page).toHaveScreenshot('signin-refused.png');
    expect(await structureOf(page, '.gate')).toMatchSnapshot('signin-structure.txt');
  });

  test('recover access', async ({ page }) => {
    await freezeClock(page);
    await installApi(page, { signedIn: false });
    await page.goto('/#/reset-password');
    await expect(page.locator('#recovery-email')).toBeVisible();
    await fontsReady(page);
    await expect(page).toHaveScreenshot('recover-access.png');
  });

  test('invitation with an invalid link', async ({ page }) => {
    await freezeClock(page);
    await installApi(page, { signedIn: false });
    await page.goto('/#/accept-invitation?token=invalid');
    await expect(page.locator('.auth-card [role="alert"]')).toBeVisible();
    await fontsReady(page);
    await expect(page).toHaveScreenshot('invitation-invalid.png');
  });
});

test.describe('inbox baselines', () => {
  for (const { direction, theme } of MATRIX) {
    test(`inbox — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);
      await expect(page).toHaveScreenshot(`inbox-${direction}-${theme}.png`);
    });
  }

  test('inbox with the navigation expanded', async ({ page }) => {
    await openInbox(page);
    await page.locator('.nav__toggle').click();
    await expect(page.locator('.app')).toHaveAttribute('data-nav', 'expanded');
    await expect(page).toHaveScreenshot('inbox-nav-expanded.png');
  });

  test('inbox showing this agent’s own conversations', async ({ page }) => {
    await openInbox(page);
    await page.locator('[data-act="live-inbox-queue"][data-arg="mine"]').click();
    await expect(page.locator('.convrow--record').first()).toBeVisible();
    await expect(page).toHaveScreenshot('inbox-mine.png');
  });

  test('inbox writing a private note', async ({ page }) => {
    await openInbox(page);
    await page.locator('[data-act="composer-tab"][data-arg="note"]').click();
    await expect(page.locator('.composer__input--note')).toBeVisible();
    await expect(page.locator('.composer')).toHaveScreenshot('composer-note.png');
  });

  test('inbox at 200% zoom with the queue drawer open', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 683, height: 384 });
    await page.locator('.thread__listtoggle').click();
    await expect(page.locator('.inbox')).toHaveAttribute('data-list', 'open');
    await expect(page).toHaveScreenshot('inbox-zoom-list-open.png');
  });

  test('the navigation drawer on a phone', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.header__menu').click();
    await expect(page.locator('.nav')).toBeVisible();
    await fontsReady(page);
    await expect(page).toHaveScreenshot('phone-nav-open.png');
  });

  test('the active conversation on a phone', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.zone--thread')).toBeVisible();
    await fontsReady(page);
    await expect(page).toHaveScreenshot('inbox-phone.png');
  });

  test('inbox structure, including what scrolls out of view', async ({ page }) => {
    await openInbox(page);
    expect(await structureOf(page, '.inbox')).toMatchSnapshot('inbox-structure.txt');
  });

  test('the customer panel, with a suppression over a consent', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('.consent__suppressed')).toBeVisible();
    await expect(page.locator('.zone--panel')).toHaveScreenshot('contact-panel.png');
  });

  test('queue list rows in isolation', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('.zone--list')).toHaveScreenshot('queue-list.png');
  });

  test('composer, ready to reply', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('.composer')).toHaveScreenshot('composer-reply.png');
  });
});

test.describe('state baselines', () => {
  for (const [name, reply] of [
    ['empty', { status: 200, body: { data: [] } }],
    ['denied', { status: 403, body: { error: { code: 'permission_denied', message: 'No.' } } }],
    ['offline', { status: 503, body: { error: { code: 'unavailable', message: 'Try later.', request_id: 'req-503' } } }],
  ] as const) {
    test(`queue state — ${name}`, async ({ page }) => {
      // Produced by the server's answer: the only way the shipped screen can reach them.
      await freezeClock(page);
      await installApi(page);
      await page.route('**/conversations/unassigned', (route) =>
        route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) }),
      );
      await page.goto('/#/inbox');
      await expect(page.locator('.zone--list .empty, .zone--list .errorstate').first()).toBeVisible();
      await fontsReady(page);
      await expect(page.locator('.zone--list')).toHaveScreenshot(`state-${name}.png`);
    });
  }
});

test.describe('workspace screen baselines', () => {
  for (const screen of SCREENS) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screen — ${screen} — ${theme}`, async ({ page }) => {
        await openScreen(page, screen);
        await setTheme(page, theme);
        await expect(page).toHaveScreenshot(`screen-${screen}-${theme}.png`);
        if (theme === 'light') {
          // The half the pixels cannot do: this fails the moment a screen is
          // replaced by a different one, however similar the two look.
          expect(await structureOf(page, '.app__screen')).toMatchSnapshot(`screen-${screen}-structure.txt`);
        }
      });
    }
  }

  test('screen — channels, a connection opened', async ({ page }) => {
    await openScreen(page, 'channels');
    await page.locator('[data-act="channel-manage"][data-arg="instagram:cn-instagram-01"]').click();
    await expect(page.locator('[data-connection="cn-instagram-01"] .connection__details')).toBeVisible();
    await expect(page.locator('.connections')).toHaveScreenshot('channels-connection-open.png');
  });

  test('dialog — connect WhatsApp Business', async ({ page }) => {
    await openScreen(page, 'channels');
    await page.locator('[data-arg="connect-channel:whatsapp"]').first().click();
    await expect(page.locator('.dialog')).toBeVisible();
    await expect(page.locator('[role="dialog"]')).toHaveScreenshot('dialog-connect-whatsapp.png');
  });
});

test.describe('automation builder baselines', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`automation builder — ${theme}`, async ({ page }) => {
      await openAutomationBuilder(page);
      await setTheme(page, theme);
      await expect(page.locator('.automation-builder')).toHaveScreenshot(`automation-builder-${theme}.png`);
    });
  }

  test('automation builder — phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAutomationBuilder(page);
    await expect(page).toHaveScreenshot('automation-builder-phone.png');
  });
});
