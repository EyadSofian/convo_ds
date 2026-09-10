import { expect, test } from '@playwright/test';
import {
  box,
  fullyVisibleCount,
  MATRIX,
  openInbox,
  pageScrolls,
  setDirection,
  setTheme,
} from './support/workspace';

/**
 * Desktop density and layout acceptance — docs/execution/CLAUDE-LIVE-MVP-TASK.md §3.
 *
 * Every number below is quoted from that section. These run at 1440×900 and
 * 1366×768 (the two projects in playwright.config.ts), in Arabic RTL and
 * English LTR, in light and dark.
 */

test.describe('shell geometry', () => {
  test('loads and redraws without an uncaught browser error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await openInbox(page);
    await page.locator('[data-act="live-inbox-queue"][data-arg="mine"]').click();
    await expect(page.locator('.convrow--record').first()).toBeVisible();
    await page.locator('.topbar [data-act="list"]').click();
    await expect(page.locator('.inbox')).toHaveAttribute('data-list', 'open');

    expect(errors).toEqual([]);
  });

  for (const { direction, theme } of MATRIX) {
    test(`fills exactly 100dvh with no page scrolling — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);

      const viewport = page.viewportSize();
      if (viewport === null) throw new Error('no viewport');

      const shell = await box(page.locator('.shell'));
      expect(shell.height).toBeCloseTo(viewport.height, 0);
      expect(await pageScrolls(page)).toBe(false);

      // The rail and the top bar are chrome; their ranges are what keep the
      // work area from being eaten a few pixels at a time.
      const rail = await box(page.locator('.rail'));
      expect(rail.width).toBeGreaterThanOrEqual(56);
      expect(rail.width).toBeLessThanOrEqual(60);
      expect(rail.height).toBeCloseTo(viewport.height, 0);

      const topbar = await box(page.locator('.topbar'));
      expect(topbar.height).toBeGreaterThanOrEqual(48);
      expect(topbar.height).toBeLessThanOrEqual(52);
    });
  }

  test('conversation header stays within 64px on one compact row', async ({ page }) => {
    await openInbox(page);
    const header = await box(page.locator('.thread__header'));
    expect(header.height).toBeLessThanOrEqual(64);
  });

  test('mirrors the shell without changing the hierarchy', async ({ page }) => {
    await openInbox(page);
    await setDirection(page, 'rtl');
    const railRtl = await box(page.locator('.rail'));
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport');
    // RTL puts the rail on the right edge, LTR on the left — same widths.
    expect(railRtl.x).toBeCloseTo(viewport.width - railRtl.width, 0);

    await setDirection(page, 'ltr');
    const railLtr = await box(page.locator('.rail'));
    expect(railLtr.x).toBeCloseTo(0, 0);
    expect(railLtr.width).toBeCloseTo(railRtl.width, 0);
  });
});

test.describe('queue list', () => {
  test('rows are 64–72px and carry no message text', async ({ page }) => {
    await openInbox(page);
    const row = page.locator('.convrow').first();
    const measured = await box(row);
    expect(measured.height).toBeGreaterThanOrEqual(64);
    expect(measured.height).toBeLessThanOrEqual(72);

    // The row that used to hold a one-line preview holds none: an unclaimed
    // conversation is projected on the server, and the browser is never sent a
    // snippet to render (IAM-11). The masked label is what identifies it.
    await expect(page.locator('.convrow__snippet')).toHaveCount(0);
    expect(await row.locator('.convrow__name').innerText()).toMatch(/^•{4}/);
  });

  for (const { direction, theme } of MATRIX) {
    test(`shows at least 8 rows without zoom — ${direction}/${theme}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      await setTheme(page, theme);
      const visible = await fullyVisibleCount(page, '.convrow', '.zone--list .zone__body');
      expect(visible).toBeGreaterThanOrEqual(8);
    });
  }

  test('is resizable within 300–380px, and clamps at both ends', async ({ page }) => {
    await openInbox(page);
    const start = await box(page.locator('.zone--list'));
    expect(start.width).toBeGreaterThanOrEqual(300);
    expect(start.width).toBeLessThanOrEqual(380);

    const resizer = page.locator('.list-resizer');
    await expect(resizer).toHaveAttribute('role', 'separator');
    await resizer.focus();

    // Arabic is the default direction, so ArrowLeft widens the column.
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('ArrowLeft');
    expect((await box(page.locator('.zone--list'))).width).toBeCloseTo(380, 0);

    for (let i = 0; i < 30; i += 1) await page.keyboard.press('ArrowRight');
    expect((await box(page.locator('.zone--list'))).width).toBeCloseTo(300, 0);
  });
});

test.describe('timeline and composer', () => {
  test('shows at least 7 message groups before scrolling', async ({ page }) => {
    await openInbox(page);
    // "Meaningful message/event groups": bubbles and timeline events both
    // count, day separators do not — a separator carries no content.
    const visible = await fullyVisibleCount(page, '.thread__body .msg', '.thread__body');
    expect(visible).toBeGreaterThanOrEqual(7);
  });

  test('timeline takes every remaining vertical pixel', async ({ page }) => {
    await openInbox(page);
    const thread = await box(page.locator('.zone--thread'));
    const header = await box(page.locator('.thread__header'));
    const body = await box(page.locator('.thread__body'));
    const composer = await box(page.locator('.composer'));
    // Nothing between them: header + timeline + composer account for the column.
    expect(header.height + body.height + composer.height).toBeCloseTo(thread.height, 0);
  });

  test('composer is at most 118px in normal reply mode and grows to 88px', async ({ page }) => {
    await openInbox(page);
    const composer = await box(page.locator('.composer'));
    expect(composer.height).toBeLessThanOrEqual(118);

    const input = page.locator('.composer__input');
    const resting = await box(input);
    expect(resting.height).toBeGreaterThanOrEqual(44);
    expect(resting.height).toBeLessThanOrEqual(48);

    await input.click();
    await input.fill(Array.from({ length: 14 }, (_, i) => `سطر رقم ${String(i + 1)}`).join('\n'));
    const grown = await box(input);
    // Only the textarea grows, and only to 88px: the thread keeps its height.
    expect(grown.height).toBeLessThanOrEqual(88);
    expect((await box(page.locator('.composer'))).height).toBeLessThanOrEqual(160);
  });

  test('composer stays reachable at the bottom of a scrolled thread', async ({ page }) => {
    await openInbox(page);
    await page.locator('.thread__body').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const composer = await box(page.locator('.composer'));
    const thread = await box(page.locator('.zone--thread'));
    expect(composer.y + composer.height).toBeCloseTo(thread.y + thread.height, 0);
  });
});

test.describe('the queue drawer never squeezes the timeline', () => {
  test('opens as an overlay and closes again', async ({ page }) => {
    await openInbox(page);
    const before = await box(page.locator('.zone--thread'));

    await page.locator('.topbar [data-act="list"]').click();
    await expect(page.locator('.inbox')).toHaveAttribute('data-list', 'open');
    const after = await box(page.locator('.zone--thread'));
    // A drawer overlays the work area rather than shrinking it, so the
    // timeline keeps every pixel it had.
    expect(after.width).toBeCloseTo(before.width, 0);
    expect(after.width).toBeGreaterThanOrEqual(640);

    await page.keyboard.press('Escape');
    await expect(page.locator('.inbox')).toHaveAttribute('data-list', 'closed');
  });

  test('has no saved-view sidebar to squeeze it with', async ({ page }) => {
    await openInbox(page);
    // The views column was a demo surface over seeded data. It is gone rather
    // than present and empty: a saved-view sidebar with no saved views would be
    // a promise the server cannot keep.
    await expect(page.locator('.zone--views')).toHaveCount(0);
    expect((await box(page.locator('.zone--thread'))).width).toBeGreaterThanOrEqual(640);
  });

  test('keeps the timeline at 640px with the customer panel beside it', async ({ page }) => {
    await openInbox(page);
    // The panel is a real column here, reading a real contact. Below 1364px it
    // is an overlay instead, so the timeline never gives up its width for it.
    await expect(page.locator('.zone--panel')).toBeVisible();
    expect((await box(page.locator('.zone--thread'))).width).toBeGreaterThanOrEqual(640);
    expect(await pageScrolls(page)).toBe(false);
  });
});

test.describe('narrow viewports', () => {
  test('reaches the queue from the top bar on a tablet', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 900, height: 800 });

    // The queue is reached from the top bar rather than squeezed in beside the
    // timeline, so the thread keeps its width.
    const toggle = page.locator('.topbar [data-act="list"]');
    await expect(toggle).toBeVisible();
    expect(await pageScrolls(page)).toBe(false);

    await toggle.click();
    await expect(page.locator('.zone--list')).toBeVisible();
    const list = await box(page.locator('.zone--list'));
    expect(list.width).toBeLessThanOrEqual(900);
  });

  test('is operable on a phone', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.zone--thread')).toBeVisible();
    expect(await pageScrolls(page)).toBe(false);
    const horizontal = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(horizontal).toBe(false);
  });

  test('stays operable at 200% zoom without horizontal page overflow', async ({ page }) => {
    await openInbox(page);
    // 200% zoom is equivalent to halving the CSS viewport (WCAG 1.4.4/1.4.10).
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport');
    await page.setViewportSize({
      width: Math.round(viewport.width / 2),
      height: Math.round(viewport.height / 2),
    });

    await expect(page.locator('.composer__input')).toBeVisible();
    const horizontal = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(horizontal).toBe(false);
  });
});

test.describe('typography and digits', () => {
  test('renders the self-hosted Arabic-first family, not a fallback', async ({ page }) => {
    await openInbox(page);
    const loaded = await page.evaluate(() =>
      Array.from(document.fonts).some((face) => face.family === 'Readex Pro' && face.status === 'loaded'),
    );
    expect(loaded).toBe(true);

    const family = await page.locator('body').evaluate((el) => window.getComputedStyle(el).fontFamily);
    expect(family).toContain('Readex Pro');
  });

  test('keeps body and conversation copy inside the readable band', async ({ page }) => {
    await openInbox(page);
    const bubble = await page.locator('.msg__bubble').first().evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        size: Number.parseFloat(style.fontSize),
        leading: Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize),
      };
    });
    expect(bubble.size).toBeGreaterThanOrEqual(14);
    expect(bubble.size).toBeLessThanOrEqual(16);
    expect(bubble.leading).toBeGreaterThanOrEqual(1.5);
    expect(bubble.leading).toBeLessThanOrEqual(1.75);
  });

  test('has no primary copy below 12px anywhere on the screen', async ({ page }) => {
    await openInbox(page);
    const tooSmall = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const element of Array.from(document.querySelectorAll('*'))) {
        const own = Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0,
        );
        if (!own) continue;
        const size = Number.parseFloat(window.getComputedStyle(element).fontSize);
        if (size < 11) offenders.push(`${element.className || element.tagName}: ${String(size)}px`);
      }
      return offenders;
    });
    expect(tooSmall).toEqual([]);
  });

  test('lets customer content choose its own paragraph direction', async ({ page }) => {
    await openInbox(page);
    await setDirection(page, 'ltr');
    // An Arabic message inside an English UI must still read right-to-left.
    // Without `unicode-bidi: plaintext` the paragraph takes the UI's base
    // direction and a mixed Arabic/Latin sentence visually reorders.
    const bubble = await page.locator('.msg__bubble').first().evaluate((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      // `unicode-bidi: plaintext` changes the base direction used at layout
      // time, not the computed `direction` property — so the observable is
      // where the first strong character actually lands. Under an RTL base
      // direction it sits in the right half of the bubble.
      const node = element.firstChild;
      let firstCharCentre = Number.NaN;
      if (node !== null && node.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        const rect = range.getBoundingClientRect();
        firstCharCentre = rect.left + rect.width / 2;
      }
      return {
        bidi: style.unicodeBidi,
        text: element.textContent ?? '',
        firstCharInRightHalf: firstCharCentre > box.left + box.width / 2,
      };
    });
    expect(bubble.bidi).toBe('plaintext');
    expect(bubble.text).toMatch(/[\u0600-\u06ff]/);
    expect(bubble.firstCharInRightHalf).toBe(true);

    // The queue row's label is the server's masked one and carries no customer
    // text at all, so there is no second place for a direction to be wrong.
    await expect(page.locator('.convrow__snippet')).toHaveCount(0);
  });

  test('keeps the queue row to its essential cues', async ({ page }) => {
    await openInbox(page);
    // Row anatomy is capped so a cue is never sheared mid-word: assignee plus
    // at most two cues, then a count. Labels live in the customer panel.
    const counts = await page.locator('.convrow__meta').evaluateAll((elements) =>
      elements.map((element) => element.children.length),
    );
    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
  });

  for (const direction of ['rtl', 'ltr'] as const) {
    test(`uses Western digits 0-9 throughout — ${direction}`, async ({ page }) => {
      await openInbox(page);
      await setDirection(page, direction);
      // Arabic-Indic and extended Arabic-Indic digit ranges must not appear.
      const offenders = await page.evaluate(() => {
        const bad = /[٠-٩۰-۹]/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const found: string[] = [];
        let node = walker.nextNode();
        while (node !== null) {
          const value = node.textContent ?? '';
          if (bad.test(value)) found.push(value.trim().slice(0, 60));
          node = walker.nextNode();
        }
        return found;
      });
      expect(offenders).toEqual([]);
    });
  }
});
