import { expect, test, type Page } from '@playwright/test';
import { CONVERSATION, installApi } from './support/api';
import {
  box,
  fontsReady,
  freezeClock,
  motionSettled,
  openInbox,
  overflowsHorizontally,
  pageScrolls,
  setDirection,
  setTheme,
} from './support/workspace';

/**
 * Resume, reconnect and phone composition, measured in a real engine.
 *
 * The release blocker these guard: returning to the tab made the screen look
 * like it was loading again — the status line pushed the list down, every
 * re-render threw the list and the thread back to their tops, and a stream the
 * browser had given up on said "reconnecting" forever. The stream here is a
 * stand-in the test drives by hand, because the question is what the *screen*
 * does with each connection state; the stream itself is proved in
 * `apps/web/src/live/realtime.test.ts` and against the real server.
 */

interface StubStream {
  readonly url: string;
  readyState: number;
  closed: boolean;
  fire(type: string, data?: unknown): void;
}

declare global {
  interface Window {
    __streams: StubStream[];
  }
}

/** Replaces `EventSource` before the bundle runs, with streams the test controls. */
async function stubStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class StubSource {
      readyState = 0;
      closed = false;
      private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
      constructor(readonly url: string) {
        (window.__streams ??= []).push(this as unknown as StubStream);
      }
      addEventListener(type: string, listener: (event: { data: string }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      close(): void {
        this.readyState = 2;
        this.closed = true;
      }
      fire(type: string, data: unknown = {}): void {
        for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource = StubSource;
  });
}

const streams = (page: Page): Promise<number> => page.evaluate(() => (window.__streams as StubStream[] | undefined)?.length ?? 0);

async function openLive(page: Page, hash = `/#/inbox/${CONVERSATION}`): Promise<void> {
  await freezeClock(page);
  await stubStreams(page);
  await installApi(page);
  await page.goto(hash);
  await expect(page.locator('.convrow').first()).toBeVisible();
  await expect.poll(() => streams(page)).toBe(1);
  await page.evaluate(() => window.__streams[0]?.fire('open'));
  await expect(page.locator('.header [data-realtime="live"]')).toBeVisible();
  await fontsReady(page);
  await motionSettled(page);
}

const pill = (page: Page): Promise<string | null> =>
  page.locator('.header [data-realtime]').getAttribute('data-realtime');

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
    Object.defineProperty(document, 'hidden', { value: value === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test.describe('cold boot', () => {
  test('draws the shell and a content-shaped skeleton, never a page-wide spinner', async ({ page }) => {
    await freezeClock(page);
    await stubStreams(page);
    await installApi(page);
    let releaseLists: () => void = () => undefined;
    const lists = new Promise<void>((resolve) => { releaseLists = resolve; });
    await page.route('**/conversations/unassigned*', async (route) => {
      await lists;
      await route.fallback();
    });
    await page.goto('/#/inbox');
    await expect(page.locator('.app .nav')).toBeVisible();
    await expect(page.locator('.header')).toBeVisible();
    await expect(page.locator('.zone--list .skeleton')).toBeVisible();
    await expect(page.locator('.spinner--lg')).toHaveCount(0);
    releaseLists();
    await expect(page.locator('.convrow').first()).toBeVisible();
    expect(await pageScrolls(page)).toBe(false);
  });
});

test.describe('leaving the tab and coming back', () => {
  test('keeps the very same screen: no loader, no re-render, no session re-check', async ({ page }) => {
    const sessionChecks: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/auth/session')) sessionChecks.push(request.url());
    });
    await openLive(page);
    const before = sessionChecks.length;
    // A mark on the live DOM: any rebuild of the frame would drop it.
    await page.evaluate(() => document.querySelector('.app')?.setAttribute('data-probe', 'kept'));
    const list = page.locator('[data-scroll="list"]');
    await list.evaluate((element) => { element.scrollTop = 48; });

    await setVisibility(page, 'hidden');
    await page.clock.runFor(60_000);
    await setVisibility(page, 'visible');

    await expect(page.locator('.app[data-probe="kept"]')).toHaveCount(1);
    await expect(page.locator('.app--pending, .skeleton')).toHaveCount(0);
    expect(await list.evaluate((element) => element.scrollTop)).toBe(48);
    expect(sessionChecks.length).toBe(before);
    expect(await streams(page)).toBe(1);
    expect(await pill(page)).toBe('live');
  });

  test('a back/forward-cache restore reconnects behind the screen, keeping rows and scroll', async ({ page }) => {
    await openLive(page);
    const list = page.locator('[data-scroll="list"]');
    await list.evaluate((element) => { element.scrollTop = 40; });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));

    await expect.poll(() => streams(page)).toBe(2);
    expect(await page.evaluate(() => window.__streams[0]?.closed)).toBe(true);
    expect(await pill(page)).toBe('stale');
    await expect(page.locator('.convrow').first()).toBeVisible();
    await expect(page.locator('.skeleton')).toHaveCount(0);
    expect(await list.evaluate((element) => element.scrollTop)).toBe(40);

    await page.evaluate(() => window.__streams[1]?.fire('open'));
    await expect(page.locator('.header [data-realtime="live"]')).toBeVisible();
  });
});

test.describe('the live stream', () => {
  test('a reconnect changes one word in the header and moves nothing else', async ({ page }) => {
    await openLive(page);
    const rowBefore = await box(page.locator('.convrow').first());
    const threadBefore = await box(page.locator('.thread__body'));
    const pillBefore = await box(page.locator('.header .status-pill'));

    // The browser's own retry is still running: the screen says so, and waits.
    await page.evaluate(() => window.__streams[0]?.fire('error'));
    await expect(page.locator('.header [data-realtime="stale"]')).toContainText(/إعادة الاتصال|Reconnecting/);
    expect(await box(page.locator('.convrow').first())).toEqual(rowBefore);
    expect(await box(page.locator('.thread__body'))).toEqual(threadBefore);
    expect((await box(page.locator('.header .status-pill'))).y).toBeCloseTo(pillBefore.y, 0);
    expect((await box(page.locator('.header .status-pill'))).height).toBeCloseTo(pillBefore.height, 0);
    await expect(page.locator('.realtime')).toHaveCount(0);

    await page.evaluate(() => window.__streams[0]?.fire('open'));
    await expect(page.locator('.header [data-realtime="live"]')).toBeVisible();
  });

  test('a stream the browser gave up on is replaced, and live is claimed only once it opens', async ({ page }) => {
    await openLive(page);
    await page.evaluate(() => {
      const stream = window.__streams[0] as StubStream;
      stream.readyState = 2;
      stream.fire('error');
    });
    await expect(page.locator('.header [data-realtime="stale"]')).toBeVisible();
    await page.clock.runFor(3_100);
    await expect.poll(() => streams(page)).toBe(2);
    expect(await pill(page)).toBe('stale');
    await page.evaluate(() => window.__streams[1]?.fire('open'));
    await expect(page.locator('.header [data-realtime="live"]')).toBeVisible();
  });

  test('offline is a small notice, and online reconnects', async ({ page, context }) => {
    await openLive(page);
    await context.setOffline(true);
    await expect(page.locator('.header [data-realtime="offline"]')).toBeVisible();
    await expect(page.locator('.convrow').first()).toBeVisible();
    await expect(page.locator('.composer__input')).toBeVisible();
    expect(await pageScrolls(page)).toBe(false);
    await context.setOffline(false);
    await expect(page.locator('.header [data-realtime="live"]')).toBeVisible();
  });
});

test.describe('moving between screens', () => {
  test('keeps the frame and only loads the screen', async ({ page }) => {
    const sessionChecks: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/auth/session')) sessionChecks.push(request.url());
    });
    await openLive(page);
    const before = sessionChecks.length;
    await page.locator('.nav__item[data-arg="contacts"]').click();
    await expect(page.locator('.contactrow').first()).toBeVisible();
    await page.locator('.nav__item[data-arg="inbox"]').click();
    await expect(page.locator('.convrow').first()).toBeVisible();
    await expect(page.locator('.app--pending')).toHaveCount(0);
    expect(sessionChecks.length).toBe(before);
    expect(await streams(page)).toBe(1);
  });
});

test.describe('the phone', () => {
  test('Inbox is the list, a conversation takes the screen, and back returns to the list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await freezeClock(page);
    await installApi(page);
    await page.goto('/#/inbox');
    await expect(page.locator('.zone--list')).toBeVisible();
    await expect(page.locator('.bottom-nav')).toBeVisible();
    expect(await overflowsHorizontally(page)).toBe(false);
    expect(await pageScrolls(page)).toBe(false);

    await page.locator('[data-act="live-inbox-queue"][data-arg="mine"]').click();
    await page.locator('.convrow--record').first().click();
    await expect(page.locator('.msg').first()).toBeVisible();
    await expect(page.locator('.zone--list')).toBeHidden();
    await expect(page.locator('.bottom-nav')).toBeHidden();
    await motionSettled(page);
    const composer = await box(page.locator('.composer'));
    expect(composer.y + composer.height).toBeCloseTo(844, 0);

    await page.locator('.thread__listtoggle').click();
    await expect(page.locator('.zone--list')).toBeVisible();
    expect((await box(page.locator('.zone--list'))).width).toBeCloseTo(390, 0);
    expect(await overflowsHorizontally(page)).toBe(false);
  });

  test('the composer and its template sheet fit the phone in both directions', async ({ page }) => {
    await openInbox(page);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const direction of ['rtl', 'ltr'] as const) {
      await setDirection(page, direction);
      await expect(page.locator('[data-act="live-inbox-send"]')).toBeVisible();
      const templates = page.locator('[data-act="live-whatsapp-template-open"]');
      const button = await box(templates);
      expect(button.x).toBeGreaterThanOrEqual(0);
      expect(button.x + button.width).toBeLessThanOrEqual(390);
      await templates.click();
      const sheet = page.locator('.dialog');
      await expect(sheet).toBeVisible();
      await page.waitForTimeout(250);
      const measured = await box(sheet);
      expect(measured.width).toBeCloseTo(390, 0);
      expect(measured.y + measured.height).toBeCloseTo(844, 0);
      expect(await overflowsHorizontally(page)).toBe(false);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    }
  });

  test('notifications open as a bottom sheet from the bottom bar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await freezeClock(page);
    await installApi(page, { notifications: [{
      id: '99999999-9999-4999-8999-999999999999', kind: 'assignment', targetType: 'conversation', targetId: CONVERSATION,
      createdAt: '2026-09-09T09:29:00.000Z', readAt: null,
    }] });
    await page.goto('/#/contacts');
    await expect(page.locator('.contactrow').first()).toBeVisible();
    await page.locator('.bottom-nav [data-act="notification-toggle"]').click();
    const sheet = page.locator('.notification-menu');
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(250);
    const measured = await box(sheet);
    expect(measured.x).toBeCloseTo(0, 0);
    expect(measured.width).toBeCloseTo(390, 0);
    expect(measured.y + measured.height).toBeCloseTo(844, 0);
    await expect(page.locator('.notification-row')).toHaveCount(1);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`every primary surface stays inside the phone — ${theme}`, async ({ page }) => {
      await openInbox(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await setTheme(page, theme);
      for (const direction of ['rtl', 'ltr'] as const) {
        await setDirection(page, direction);
        expect(await overflowsHorizontally(page)).toBe(false);
        expect(await pageScrolls(page)).toBe(false);
      }
    });
  }
});
