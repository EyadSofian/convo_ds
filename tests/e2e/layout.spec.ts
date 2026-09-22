import { expect, test } from '@playwright/test';
import { CONNECTION, installApi } from './support/api';
import {
  box,
  freezeClock,
  fullyVisibleCount,
  MATRIX,
  openAutomationBuilder,
  openInbox,
  openScreen,
  overflowsHorizontally,
  pageScrolls,
  READY,
  SCREENS,
  setDirection,
  setTheme,
} from './support/workspace';

/**
 * Layout acceptance, measured in a real engine.
 *
 * happy-dom computes no geometry, so the numbers the redesign promises — the
 * navigation widths, the header height, the queue column, eight rows on a
 * 900px screen, a thread that is never squeezed — are asserted here. These run
 * at 1440×900 and 1366×768 (the two projects in playwright.config.ts), in
 * Arabic RTL and English LTR, in light and dark.
 */

test.describe('the shell', () => {
  test('loads every screen and its dialogs without an uncaught browser error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await openInbox(page);
    await page.locator('[data-act="live-inbox-queue"][data-arg="mine"]').click();
    await expect(page.locator('.convrow--record').first()).toBeVisible();
    for (const screen of SCREENS) {
      await page.locator(`.nav__item[data-arg="${screen}"]`).click();
      await expect(page.locator(READY[screen] as string).first()).toBeVisible();
    }
    await page.locator('.nav__item[data-arg="channels"]').click();
    await page.locator('[data-arg="connect-channel:messenger"]').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.nav__item[data-arg="people"]').click();
    await page.locator('[data-arg="invite"]').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    expect(errors).toEqual([]);
  });

  for (const { direction, theme } of MATRIX) {
    test(`fills the viewport exactly, with a 64px rail and a 56px header — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);

      const viewport = page.viewportSize();
      if (viewport === null) throw new Error('no viewport');

      const app = await box(page.locator('.app'));
      expect(app.height).toBeCloseTo(viewport.height, 0);
      expect(await pageScrolls(page)).toBe(false);
      expect(await overflowsHorizontally(page)).toBe(false);

      const nav = await box(page.locator('.nav'));
      expect(nav.width).toBeGreaterThanOrEqual(64);
      expect(nav.width).toBeLessThanOrEqual(72);
      expect(nav.height).toBeCloseTo(viewport.height, 0);

      const header = await box(page.locator('.header'));
      expect(header.height).toBeGreaterThanOrEqual(56);
      expect(header.height).toBeLessThanOrEqual(60);
    });
  }

  test('expands the navigation to 224–248px, labels it, and remembers the choice', async ({ page }) => {
    await openInbox(page);
    const toggle = page.locator('.nav__toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Collapsed, each destination is still named for assistive technology.
    await expect(page.locator('.nav__item[data-arg="inbox"]')).toHaveAttribute('aria-label', /.+/);
    await expect(page.locator('.nav__label').first()).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const expanded = await box(page.locator('.nav'));
    expect(expanded.width).toBeGreaterThanOrEqual(224);
    expect(expanded.width).toBeLessThanOrEqual(248);
    await expect(page.locator('.nav__label').first()).toBeVisible();
    // The screen gives up exactly the width the navigation took, and no more.
    expect(await overflowsHorizontally(page)).toBe(false);

    // A view preference, kept in this browser — and nothing about the session.
    const stored = await page.evaluate(() => ({ ...window.localStorage }));
    expect(stored['convo.nav']).toBe('expanded');
    expect(JSON.stringify(stored)).not.toMatch(/hana@|password|session|token/i);

    await page.reload();
    await expect(page.locator('.app')).toHaveAttribute('data-nav', 'expanded');
  });

  test('mirrors the frame between Arabic and English without changing its widths', async ({ page }) => {
    await openInbox(page);
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport');
    await setDirection(page, 'rtl');
    const rtl = await box(page.locator('.nav'));
    expect(rtl.x + rtl.width).toBeCloseTo(viewport.width, 0);

    await setDirection(page, 'ltr');
    const ltr = await box(page.locator('.nav'));
    expect(ltr.x).toBeCloseTo(0, 0);
    expect(ltr.width).toBeCloseTo(rtl.width, 0);
  });

  test('names the company, never its internal slug', async ({ page }) => {
    await openInbox(page);
    await expect(page.locator('.header__tenant')).toHaveText('Digital School');
    await expect(page.locator('body')).not.toContainText('digital-school');
    await expect(page.locator('body')).not.toContainText('workspace.');
  });
});

test.describe('the navigation drawer below 960px', () => {
  test('opens over the screen, keeps focus inside, and closes with Escape or the backdrop', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.nav')).toBeHidden();
    const opener = page.locator('.header__menu');
    await expect(opener).toBeVisible();

    await opener.click();
    await expect(page.locator('.nav')).toBeVisible();
    await expect(opener).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => document.querySelector('.nav')?.contains(document.activeElement))).toBe(true);
    // Tab cycles within the drawer.
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('.nav')?.contains(document.activeElement))).toBe(true);
    }
    // Labels are shown in the drawer: it opened because somebody asked where to go.
    await expect(page.locator('.nav .nav__label').first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.nav')).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    // In Arabic the drawer opens from the right, so the backdrop is on the left.
    await page.locator('.nav-scrim').click({ position: { x: 20, y: 400 } });
    await expect(page.locator('.nav')).toBeHidden();

    await opener.click();
    await page.locator('.nav__item[data-arg="settings"]').click();
    await expect(page.locator('.page--settings')).toBeVisible();
    await expect(page.locator('.nav')).toBeHidden();
    expect(await overflowsHorizontally(page)).toBe(false);
  });
});

test.describe('the inbox filter drawer on a phone', () => {
  test('uses the viewport, traps focus, and closes with Escape', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.thread__listtoggle').click();
    const opener = page.locator('[data-act="menu"][data-arg="inbox-filters"]');
    await opener.click();
    const drawer = page.locator('.inbox-filter-popover');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-trap', 'mobile-inbox-filters');
    const box = await drawer.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(389);
    expect(box?.height).toBeGreaterThanOrEqual(843);
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('.inbox-filter-popover')?.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});

test.describe('the queue', () => {
  test('rows are compact, carry no message text, and mark the open one', async ({ page }) => {
    await openInbox(page);
    const row = page.locator('.convrow').first();
    const measured = await box(row);
    expect(measured.height).toBeGreaterThanOrEqual(56);
    expect(measured.height).toBeLessThanOrEqual(72);

    // An unclaimed conversation is projected on the server: the browser is
    // never sent a snippet, and the masked label is what identifies it.
    expect(await row.locator('.convrow__name').innerText()).toMatch(/^•{4}/);
    const queueText = await page.locator('.zone--list').innerText();
    for (const body of ['سجّلت ابني', 'رقم الطلب 4817']) expect(queueText).not.toContain(body);

    await page.locator('[data-act="live-inbox-queue"][data-arg="mine"]').click();
    await expect(page.locator('.convrow--record[aria-current="true"]')).toHaveCount(1);
  });

  for (const { direction, theme } of MATRIX) {
    test(`shows at least 8 rows without scrolling — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);
      const visible = await fullyVisibleCount(page, '.convrow', '.zone--list .zone__body');
      expect(visible).toBeGreaterThanOrEqual(8);
    });
  }

  test('starts at 336px and resizes within 300–400px from the keyboard', async ({ page }) => {
    await openInbox(page);
    expect((await box(page.locator('.zone--list'))).width).toBeCloseTo(336, 0);

    const resizer = page.locator('.list-resizer');
    await expect(resizer).toHaveAttribute('role', 'separator');
    await resizer.focus();
    // Arabic is the default direction, so ArrowLeft widens the column.
    for (let index = 0; index < 20; index += 1) await page.keyboard.press('ArrowLeft');
    expect((await box(page.locator('.zone--list'))).width).toBeCloseTo(400, 0);
    for (let index = 0; index < 30; index += 1) await page.keyboard.press('ArrowRight');
    expect((await box(page.locator('.zone--list'))).width).toBeCloseTo(300, 0);
  });
});

test.describe('the conversation', () => {
  test('is the widest column, with a compact header and composer', async ({ page }) => {
    await openInbox(page);
    const thread = await box(page.locator('.zone--thread'));
    const list = await box(page.locator('.zone--list'));
    const panel = await box(page.locator('.zone--panel'));
    expect(thread.width).toBeGreaterThan(list.width);
    expect(thread.width).toBeGreaterThan(panel.width);
    expect(thread.width).toBeGreaterThanOrEqual(560);

    expect((await box(page.locator('.thread__header'))).height).toBeLessThanOrEqual(60);
    expect((await box(page.locator('.composer'))).height).toBeLessThanOrEqual(120);

    // The timeline takes what the header and composer leave.
    const body = await box(page.locator('.thread__body'));
    expect(body.height).toBeGreaterThanOrEqual(thread.height - 60 - 136);
    const visible = await fullyVisibleCount(page, '.thread__body .msg', '.thread__body');
    expect(visible).toBeGreaterThanOrEqual((page.viewportSize()?.height ?? 0) >= 900 ? 7 : 5);
  });

  test('grows the reply box to a limit, and switches to a private note that looks different', async ({ page }) => {
    await openInbox(page);
    const input = page.locator('.composer__input');
    const resting = await box(input);
    expect(resting.height).toBeGreaterThanOrEqual(40);
    expect(resting.height).toBeLessThanOrEqual(48);

    await input.fill(Array.from({ length: 14 }, (_, index) => `سطر رقم ${String(index + 1)}`).join('\n'));
    const grown = await box(input);
    expect(grown.height).toBeGreaterThan(resting.height);
    expect(grown.height).toBeLessThanOrEqual(120);
    await expect(page.locator('[data-act="live-inbox-send"]')).toBeEnabled();

    await page.locator('[data-act="composer-tab"][data-arg="note"]').click();
    const note = page.locator('.composer__input--note');
    await expect(note).toBeVisible();
    const replyColour = await page.locator('.msg--out .msg__bubble').first().evaluate((element) => getComputedStyle(element).backgroundColor);
    const noteColour = await page.locator('.composer__box--note').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(noteColour).not.toBe(replyColour);
  });

  test('collapses the customer panel and gives its width to the thread', async ({ page }) => {
    await openInbox(page);
    const before = await box(page.locator('.zone--thread'));
    await page.locator('.thread__paneltoggle--inline').click();
    await expect(page.locator('.inbox')).toHaveAttribute('data-panel', 'closed');
    await expect(page.locator('.zone--panel')).toBeHidden();
    const after = await box(page.locator('.zone--thread'));
    expect(after.width).toBeGreaterThan(before.width + 250);
  });

  test('lets customer content choose its own paragraph direction', async ({ page }) => {
    await openInbox(page);
    await setDirection(page, 'ltr');
    // An Arabic message inside an English UI must still read right-to-left.
    const bubble = await page.locator('.msg__bubble').first().evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const node = element.firstChild;
      let centre = Number.NaN;
      if (node !== null && node.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        const rect = range.getBoundingClientRect();
        centre = rect.left + rect.width / 2;
      }
      return { bidi: getComputedStyle(element).unicodeBidi, rightHalf: centre > bounds.left + bounds.width / 2 };
    });
    expect(bubble.bidi).toBe('plaintext');
    expect(bubble.rightHalf).toBe(true);
  });
});

test.describe('narrow screens', () => {
  test('keeps the queue beside the thread on a tablet, and makes it a drawer below that', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('.zone--list')).toBeVisible();
    expect((await box(page.locator('.zone--thread'))).width).toBeGreaterThanOrEqual(540);
    expect(await overflowsHorizontally(page)).toBe(false);

    await page.setViewportSize({ width: 683, height: 384 });
    await expect(page.locator('.zone--list')).toBeHidden();
    const before = await box(page.locator('.zone--thread'));
    await page.locator('.thread__listtoggle').click();
    await expect(page.locator('.inbox')).toHaveAttribute('data-list', 'open');
    await expect(page.locator('.convrow').first()).toBeVisible();
    // The drawer overlays the thread rather than squeezing it.
    expect((await box(page.locator('.zone--thread'))).width).toBeCloseTo(before.width, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.inbox')).toHaveAttribute('data-list', 'closed');
  });

  test('is operable on a phone', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.composer__input')).toBeVisible();
    expect(await pageScrolls(page)).toBe(false);
    expect(await overflowsHorizontally(page)).toBe(false);
  });

  for (const direction of ['rtl', 'ltr'] as const) {
    test(`every screen fits at 200% zoom and on a phone — ${direction}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      for (const size of [{ width: 683, height: 384 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(size);
        expect(await overflowsHorizontally(page), `inbox at ${String(size.width)}px`).toBe(false);
        for (const screen of SCREENS) {
          await page.evaluate((target) => {
            window.location.hash = `#/${target}`;
          }, screen);
          await expect(page.locator(READY[screen] as string).first()).toBeAttached();
          expect(await overflowsHorizontally(page), `${screen} at ${String(size.width)}px`).toBe(false);
          expect(await pageScrolls(page), `${screen} scrolls the page at ${String(size.width)}px`).toBe(false);
        }
        await page.evaluate(() => {
          window.location.hash = '#/inbox';
        });
      }
    });
  }
});

test.describe('workspace screens at desktop size', () => {
  for (const screen of SCREENS) {
    test(`${screen} scrolls inside its own area, never the page`, async ({ page }) => {
      await openScreen(page, screen);
      expect(await pageScrolls(page)).toBe(false);
      expect(await overflowsHorizontally(page)).toBe(false);
    });
  }
});

test.describe('typography and digits', () => {
  test('renders the self-hosted Arabic-first family, not a fallback', async ({ page }) => {
    await openInbox(page);
    const loaded = await page.evaluate(() =>
      Array.from(document.fonts).filter((face) => face.status === 'loaded').map((face) => face.family),
    );
    expect(loaded).toContain('IBM Plex Sans Arabic');
    const family = await page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily);
    expect(family.startsWith('"IBM Plex Sans Arabic"')).toBe(true);
  });

  test('keeps conversation copy inside the readable band', async ({ page }) => {
    await openInbox(page);
    const bubble = await page.locator('.msg__bubble').first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { size: Number.parseFloat(style.fontSize), leading: Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize) };
    });
    expect(bubble.size).toBeGreaterThanOrEqual(14);
    expect(bubble.size).toBeLessThanOrEqual(15);
    expect(bubble.leading).toBeGreaterThanOrEqual(1.4);
    expect(bubble.leading).toBeLessThanOrEqual(1.75);
  });

  test('sets primary copy at 13px or more, and nothing below 12px', async ({ page }) => {
    await openInbox(page);
    const sizes = await page.evaluate(() => {
      const offenders: string[] = [];
      const primary: string[] = [];
      const primarySelector = '.nav__label, .header__title, .convrow__name, .msg__bubble, .btn__label, .thread__name, .field__label, .menu__label, .composer__input';
      for (const element of Array.from(document.querySelectorAll('*'))) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || element.closest('.visually-hidden') !== null) continue;
        const own = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0);
        if (!own) continue;
        const size = Number.parseFloat(style.fontSize);
        if (size < 11.9) offenders.push(`${String(element.className)}: ${String(size)}px`);
        if (element.matches(primarySelector) && size < 13) primary.push(`${String(element.className)}: ${String(size)}px`);
      }
      return { offenders, primary };
    });
    expect(sizes.offenders).toEqual([]);
    expect(sizes.primary).toEqual([]);
  });

  test('sets figures in tabular numerals where they are compared', async ({ page }) => {
    await openScreen(page, 'analytics');
    const variants = await page.locator('.kpi__value, td.num').evaluateAll((elements) =>
      elements.slice(0, 12).map((element) => getComputedStyle(element).fontVariantNumeric),
    );
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) expect(variant).toContain('tabular-nums');
  });

  for (const direction of ['rtl', 'ltr'] as const) {
    test(`uses Western digits 0-9 on every screen — ${direction}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      const offendersOn = async (): Promise<string[]> =>
        page.evaluate(() => {
          const bad = /[٠-٩۰-۹]/;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const found: string[] = [];
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const value = node.textContent ?? '';
            if (bad.test(value)) found.push(value.trim().slice(0, 60));
          }
          return found;
        });
      expect(await offendersOn()).toEqual([]);
      for (const screen of SCREENS) {
        await page.locator(`.nav__item[data-arg="${screen}"]`).click();
        await expect(page.locator(READY[screen] as string).first()).toBeVisible();
        expect(await offendersOn(), screen).toEqual([]);
      }
    });
  }
});

test.describe('the Channels catalogue', () => {
  test('lists six integrations with a truthful state and one next step each', async ({ page }) => {
    await openScreen(page, 'channels');
    const cards = page.locator('[data-channel-kind]');
    await expect(cards).toHaveCount(6);
    expect(await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-channel-kind')))).toEqual([
      'whatsapp', 'messenger', 'instagram', 'web_chat', 'telegram', 'custom',
    ]);

    // Healthy WhatsApp: connected, managed. Instagram is still authorizing:
    // connecting, complete setup. Messenger with nothing connected: connect.
    await expect(page.locator('.integration--connected[data-channel-kind="whatsapp"] [data-act="channel-manage"]')).toBeVisible();
    await expect(page.locator(`.integration--connecting[data-channel-kind="instagram"] [data-act="channel-manage"][data-arg="instagram:cn-instagram-01"]`)).toBeVisible();
    await expect(page.locator('.integration--not_connected[data-channel-kind="messenger"] [data-arg="connect-channel:messenger"]')).toBeVisible();

    // Telegram is not implemented, and says so rather than offering a form.
    const telegram = page.locator('[data-channel-kind="telegram"]');
    await expect(telegram).toHaveClass(/integration--unavailable/);
    await expect(telegram.locator('button')).toBeDisabled();
    await expect(telegram).toContainText('غير متاح حاليًا');

    // Cards line up in a grid without overflowing the page.
    expect(await overflowsHorizontally(page)).toBe(false);
  });

  test('asks a Meta channel for its app and asset, and Website Chat for neither', async ({ page }) => {
    await openScreen(page, 'channels');
    await page.locator('[data-arg="connect-channel:messenger"]').click();
    await expect(page.locator('#channel-app')).toBeVisible();
    await expect(page.locator('label[for="channel-asset"]')).toHaveText('Page ID');
    await expect(page.locator('#channel-token')).toHaveAttribute('type', 'password');
    await page.keyboard.press('Escape');

    await page.locator('[data-arg="connect-channel:web_chat"]').click();
    await expect(page.locator('#channel-app')).toHaveCount(0);
  });

  test('opens a connection’s readiness evidence from its card', async ({ page }) => {
    await openScreen(page, 'channels');
    await page.locator('[data-act="channel-manage"][data-arg="instagram:cn-instagram-01"]').click();
    const details = page.locator('[data-connection="cn-instagram-01"] .connection__details');
    await expect(details).toBeVisible();
    await expect(details.locator('.checklist__item--done')).toHaveCount(1);
    await expect(page.locator(`[data-connection="${CONNECTION}"] .connection__details`)).toHaveCount(0);
  });
});

test.describe('the Automation builder geometry', () => {
  test('aligns every node and connector on one measured workflow axis', async ({ page }) => {
    await openAutomationBuilder(page);

    const nodes = await page.locator('.workflow-block').evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, width: bounds.width, centre: bounds.x + bounds.width / 2 };
    }));
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    for (const node of nodes.slice(1)) {
      expect(node.x).toBeCloseTo(nodes[0]?.x ?? 0, 0);
      expect(node.width).toBeCloseTo(nodes[0]?.width ?? 0, 0);
      expect(node.centre).toBeCloseTo(nodes[0]?.centre ?? 0, 0);
    }

    const connectors = await page.locator('.workflow-connector').evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      const after = getComputedStyle(element, '::after');
      return {
        centre: bounds.x + bounds.width / 2,
        arrowContent: after.content,
        arrowWidth: Number.parseFloat(after.width),
        arrowHeight: Number.parseFloat(after.height),
      };
    }));
    expect(connectors).toHaveLength(nodes.length);
    for (const connector of connectors) {
      expect(connector.centre).toBeCloseTo(nodes[0]?.centre ?? 0, 0);
      expect(connector.arrowContent).not.toBe('none');
      expect(connector.arrowWidth).toBe(8);
      expect(connector.arrowHeight).toBe(6);
    }
  });

  test('keeps the editor aligned in RTL and LTR', async ({ page }) => {
    await openAutomationBuilder(page);
    const rtl = await box(page.locator('.workflow-block').first());
    const rtlCanvas = await box(page.locator('.automation-canvas'));
    await setDirection(page, 'ltr');
    const ltr = await box(page.locator('.workflow-block').first());
    const ltrCanvas = await box(page.locator('.automation-canvas'));
    expect(ltr.width).toBeCloseTo(rtl.width, 0);
    expect(rtl.x + rtl.width / 2).toBeCloseTo(rtlCanvas.x + rtlCanvas.width / 2, 0);
    expect(ltr.x + ltr.width / 2).toBeCloseTo(ltrCanvas.x + ltrCanvas.width / 2, 0);
  });
});

test.describe('Analytics', () => {
  test('draws the funnel against its denominator, and the trend as a chart with a table', async ({ page }) => {
    await openScreen(page, 'analytics');
    await expect(page.locator('.kpi')).toHaveCount(7);
    const funnel = page.locator('.funnel');
    await expect(funnel).toContainText('618');
    await expect(funnel).toContainText('%');
    // The drawing is decorative for assistive technology; the same numbers are
    // a real table beside it, one row per launch day.
    await expect(page.locator('.chart-figure svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.chart-figure figcaption')).not.toBeEmpty();
    await expect(page.locator('.visually-hidden-table tbody tr')).toHaveCount(5);
  });

  test('follows an export from queued to a download, and says when the link has expired', async ({ page }) => {
    await freezeClock(page);
    await installApi(page);
    const job = { id: 'x-1', campaign_id: null, format: 'csv', row_count: null, error_code: null, requested_at: '2026-09-09T09:30:00.000Z', completed_at: null, expires_at: null, download_url: null };
    let state = 'queued';
    await page.route('**/reports/campaigns/exports', (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ data: { ...job, state: 'queued' }, request_id: 'e2e' }) }),
    );
    await page.route('**/reports/campaigns/exports/x-1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: state === 'completed'
            ? { ...job, state, row_count: 42, completed_at: '2026-09-09T09:31:00.000Z', expires_at: '2026-09-10T09:31:00.000Z', download_url: '/api/v1/tenants/t/reports/campaigns/exports/x-1/download' }
            : state === 'expired'
              ? { ...job, state: 'completed', row_count: 42, completed_at: '2026-09-08T09:00:00.000Z', expires_at: '2026-09-09T09:00:00.000Z', download_url: '/d' }
              : { ...job, state },
          request_id: 'e2e',
        }),
      }),
    );
    await page.goto('/#/analytics');
    await expect(page.locator('[data-report-ready]')).toBeVisible();

    await page.locator('[data-act="live-report-export"]').click();
    await expect(page.locator('[data-export]')).toHaveAttribute('data-export', 'queued');
    state = 'running';
    await page.clock.runFor(3_000);
    await expect(page.locator('[data-export]')).toHaveAttribute('data-export', 'running');
    state = 'completed';
    await page.clock.runFor(3_000);
    await expect(page.locator('[data-export]')).toHaveAttribute('data-export', 'completed');
    await expect(page.locator('[data-export-ready]')).toBeVisible();

    state = 'expired';
    await page.locator('[data-act="live-report-export"]').click();
    await page.clock.runFor(3_000);
    await expect(page.locator('[data-export]')).toHaveAttribute('data-export', 'expired');
    await expect(page.locator('[data-export-ready]')).toHaveCount(0);
  });

  test('opens the paginated Assignments report, loads its next page, and fits on a phone', async ({ page }) => {
    await openScreen(page, 'analytics');
    await page.route('**/reports/operations*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ data: { agentOptions: [], agents: [] }, request_id: 'e2e' }),
    }));
    await page.route('**/reports/assignments*', (route) => {
      const secondPage = new URL(route.request().url()).searchParams.has('cursor');
      const item = secondPage
        ? { id: 'audit-2', timestamp: '2026-09-08T09:00:00.000Z', conversationId: 'conversation-1', customer: 'Mona Khalil', action: 'assign', previousAssignee: null, assignedTo: { membershipId: 'member-1', displayName: 'Ahmed Fouad' }, actor: null }
        : { id: 'audit-1', timestamp: '2026-09-09T09:00:00.000Z', conversationId: 'conversation-1', customer: 'Mona Khalil', action: 'claim', previousAssignee: null, assignedTo: { membershipId: 'member-1', displayName: 'Ahmed Fouad' }, actor: { membershipId: 'member-1', displayName: 'Ahmed Fouad' } };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [item], page: { next_cursor: secondPage ? null : 'e2e-cursor-page-2', has_more: !secondPage }, request_id: 'e2e' }) });
    });
    await page.locator('[data-act="analytics-view"][data-arg="assignments"]').click();
    await expect(page.locator('[data-assignment-id="audit-1"]')).toBeVisible();
    await expect(page.locator('thead')).toContainText('المحادثة / العميل');
    await page.locator('[data-act="live-assignments-more"]').click();
    await expect(page.locator('[data-assignment-id="audit-2"]')).toBeVisible();
    await expect(page.locator('[data-assignment-id]')).toHaveCount(2);
    await page.setViewportSize({ width: 430, height: 900 });
    expect(await overflowsHorizontally(page)).toBe(false);
    await setDirection(page, 'rtl');
    expect(await overflowsHorizontally(page)).toBe(false);
  });
});
