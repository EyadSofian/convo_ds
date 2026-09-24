import { expect, test, type Locator, type Page } from '@playwright/test';
import { CONVERSATION, installApi } from './support/api';
import { box, fontsReady, freezeClock, openScreen, overflowsHorizontally, setDirection, setTheme } from './support/workspace';

/**
 * Nothing moves when work starts or ends. Measured in a real engine, because
 * the regressions these guard were all a few pixels: a spinner a size larger
 * than the icon it replaced, a list blanked into placeholders by a refresh,
 * a header status word that pushed its neighbours along.
 */

/** The stand-in streams the page is given, reached without widening Window's type. */
type Streams = { __streams?: { fire(type: string): void }[] };

/** Holds every request to `pattern` until the returned function is called. */
async function hold(page: Page, pattern: string): Promise<() => void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await held;
    await route.fallback();
  });
  return release;
}

/** Every geometry that must not change, rounded to the device pixel. */
async function geometry(page: Page, control: Locator): Promise<Record<string, number[]>> {
  const rect = async (locator: Locator): Promise<number[]> => {
    const value = await box(locator);
    return [value.x, value.y, value.width, value.height].map((part) => Math.round(part * 2) / 2);
  };
  return {
    button: await rect(control),
    label: await rect(control.locator('.btn__label')),
    icon: await rect(control.locator('.btn__icon')),
    toolbar: await rect(page.locator('.pagebar')),
    header: await rect(page.locator('.header')),
  };
}

test.describe('a Refresh in flight', () => {
  for (const direction of ['ltr', 'rtl'] as const) {
    test(`keeps the button, its label, its icon and the toolbar exactly in place — ${direction}`, async ({ page }) => {
      await openScreen(page, 'people');
      await setDirection(page, direction);
      const control = page.locator('.pagebar [data-act="live-reload"]');
      const before = await geometry(page, control);
      const firstRow = await box(page.locator('[data-membership]').first());

      const release = await hold(page, '**/api/v1/tenants/*/people');
      await control.click();
      await expect(control).toHaveAttribute('aria-busy', 'true');
      // The arrows turn in their own slot; nothing is swapped for a larger mark.
      await expect(control.locator('.btn__icon--turning svg')).toBeVisible();
      expect(await geometry(page, control)).toEqual(before);
      // The rows stay: a refresh somebody asked for blanks nothing.
      await expect(page.locator('.skeleton')).toHaveCount(0);
      expect(await box(page.locator('[data-membership]').first())).toEqual(firstRow);
      await expect(page.locator('.spinner--lg')).toHaveCount(0);

      release();
      await expect(control).not.toHaveAttribute('aria-busy', 'true');
      expect(await geometry(page, control)).toEqual(before);
    });
  }

  test('a busy button with a label and no icon keeps its size and place', async ({ page }) => {
    await openScreen(page, 'people');
    await page.locator('.pagebar [data-arg="invite"]').click();
    await page.locator('#invite-email').fill('tarek@digital-school.example');
    await page.locator('#invite-role').selectOption({ index: 1 });
    const submit = page.locator('.dialog [data-act="live-invite"]');
    const before = await box(submit);
    const release = await hold(page, '**/api/v1/tenants/*/invitations');
    await submit.click();
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    // The label keeps the width; the spinner is drawn over it, not beside it.
    await expect(submit.locator('.btn__stack .spinner')).toBeVisible();
    expect(await box(submit)).toEqual(before);
    release();
  });
});

test.describe('the live status in the header', () => {
  test('Live, Reconnecting and Live again move nothing in the header or the content', async ({ page }) => {
    await page.addInitScript(() => {
      class StubSource {
        readyState = 0;
        private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
        constructor(readonly url: string) {
          ((window as unknown as Streams).__streams ??= []).push(this);
        }
        addEventListener(type: string, listener: (event: { data: string }) => void): void {
          this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }
        close(): void {
          this.readyState = 2;
        }
        fire(type: string): void {
          for (const listener of this.listeners.get(type) ?? []) listener({ data: '{}' });
        }
      }
      (window as unknown as { EventSource: unknown }).EventSource = StubSource;
    });
    await freezeClock(page);
    await installApi(page);
    await page.goto(`/#/inbox/${CONVERSATION}`);
    await expect(page.locator('.convrow').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as Streams).__streams?.length ?? 0)).toBe(1);
    await page.evaluate(() => (window as unknown as Streams).__streams?.[0]?.fire('open'));
    await expect(page.locator('.header [data-realtime="live"]')).toBeVisible();
    await fontsReady(page);

    const measure = async (): Promise<unknown[]> => [
      await box(page.locator('.header')),
      await box(page.locator('.header .status-slot')),
      await box(page.locator('.header .notification-bell')),
      await box(page.locator('.header .user-button')),
      await box(page.locator('.convrow').first()),
      await box(page.locator('.thread__body')),
    ];
    const live = await measure();

    await page.evaluate(() => (window as unknown as Streams).__streams?.[0]?.fire('error'));
    await expect(page.locator('.header [data-realtime="stale"]')).toBeVisible();
    expect(await measure()).toEqual(live);

    await page.evaluate(() => (window as unknown as Streams).__streams?.[0]?.fire('open'));
    await expect(page.locator('.header [data-realtime="live"]')).toBeVisible();
    expect(await measure()).toEqual(live);
  });
});

test.describe('channel identity', () => {
  test('draws WhatsApp, Messenger, Instagram and Telegram from the brand renderer, and nothing else as a logo', async ({ page }) => {
    await openScreen(page, 'channels');
    for (const kind of ['whatsapp', 'messenger', 'instagram', 'telegram']) {
      const mark = page.locator(`[data-channel-kind="${kind}"] .channel-tile .channel-mark`);
      await expect(mark).toHaveAttribute('data-mark', 'brand');
      await expect(mark).toHaveClass(new RegExp(`channel-mark--${kind}`));
    }
    for (const kind of ['web_chat', 'custom']) {
      await expect(page.locator(`[data-channel-kind="${kind}"] .channel-tile .channel-mark`)).toHaveAttribute('data-mark', 'product');
    }
    // Messenger's Page is shown as Facebook context; the channel stays Messenger.
    await expect(page.locator('[data-channel-kind="messenger"] .integration__context .channel-mark--facebook')).toBeVisible();

    // Every mark on the page draws something: no empty path, no zero box.
    const broken = await page.evaluate(() => Array.from(document.querySelectorAll('svg.channel-mark')).filter((svg) => {
      const rect = svg.getBoundingClientRect();
      const paths = Array.from(svg.querySelectorAll('path, rect, circle'));
      return rect.width === 0 || rect.height === 0 || paths.length === 0
        || paths.some((path) => path.tagName === 'path' && (path.getAttribute('d') ?? '') === '');
    }).length);
    expect(broken).toBe(0);
  });

  test('never mirrors a brand mark in Arabic, and keeps it legible in dark mode', async ({ page }) => {
    await openScreen(page, 'channels');
    await setDirection(page, 'rtl');
    await setTheme(page, 'dark');
    const transforms = await page.locator('.channel-mark--brand').evaluateAll((marks) => marks.map((mark) => getComputedStyle(mark).transform));
    expect(transforms.length).toBeGreaterThan(0);
    expect(transforms.every((transform) => transform === 'none')).toBe(true);
    // The tile stays light behind the logos in the dark theme.
    const tile = await page.locator('[data-channel-kind="whatsapp"] .channel-tile').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(tile).toBe('rgb(243, 246, 251)');
  });
});

test.describe('widths', () => {
  for (const width of [1440, 1280, 1024, 768, 430, 390] as const) {
    test(`nothing scrolls sideways and no toolbar is clipped at ${String(width)}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 });
      for (const screen of ['channels', 'people', 'roles', 'teams', 'analytics', 'contacts', 'broadcasts', 'automations', 'settings']) {
        await openScreen(page, screen);
        for (const direction of ['rtl', 'ltr'] as const) {
          await setDirection(page, direction);
          expect(await overflowsHorizontally(page), `${screen} ${direction}`).toBe(false);
          const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('.pagebar__actions .btn, .header__tools .btn')).filter((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && (rect.left < -0.5 || rect.right > window.innerWidth + 0.5);
          }).length);
          expect(clipped, `${screen} ${direction}`).toBe(0);
        }
      }
    });
  }
});
