import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { ApiOptions } from './api';
import { CONVERSATION, installApi } from './api';

/**
 * Shared driving helpers for the layout, accessibility and visual specs.
 *
 * Everything here goes through the product's own controls — the same buttons an
 * operator clicks — rather than reaching into application state. A layout test
 * that sets internal flags directly proves nothing about the shipped screen.
 */

export type Direction = 'rtl' | 'ltr';
export type Theme = 'light' | 'dark';

/**
 * A fixed instant for every screenshot.
 *
 * Relative times ("4m ago") and day separators are computed from the clock, so
 * a baseline captured at 01:47 and compared at 03:15 would differ everywhere.
 * Freezing the page clock before the bundle runs makes the rendering a function
 * of the code alone, which is the only way a visual diff can mean "the design
 * changed".
 */
export const FROZEN_NOW = new Date('2026-09-09T09:30:00.000Z');

/** Installs the fixed clock. Must run before the page script boots. */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.install({ time: FROZEN_NOW });
}

/** Fonts are part of layout: measuring before they land measures a fallback. */
export async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Opens the inbox on a conversation against the scripted API and waits for
 * the server's answers to be drawn.
 */
export async function openInbox(page: Page): Promise<void> {
  await freezeClock(page);
  await installApi(page);
  await page.goto(`/#/inbox/${CONVERSATION}`);
  await expect(page.locator('.app')).toBeVisible();
  await expect(page.locator('.zone--thread')).toBeVisible();
  // Wait for the server's answer rather than for a timer: a measurement taken
  // against a skeleton is a measurement of the skeleton.
  await expect(page.locator('.convrow').first()).toBeVisible();
  await expect(page.locator('.msg').first()).toBeVisible();
  await fontsReady(page);
}

/** What proves each screen has its server data on it, not just its frame. */
export const READY: Readonly<Record<string, string>> = {
  contacts: '.contactrow',
  channels: '[data-connection]',
  people: '[data-membership]',
  broadcasts: '[data-campaign]',
  analytics: '[data-report-ready]',
  settings: '[data-session]',
  automations: '.automation-template-card',
};

/** Opens a workspace screen with the API scripted and waits for its data. */
export async function openScreen(page: Page, screen: string, query = ''): Promise<void> {
  await freezeClock(page);
  await installApi(page);
  await page.goto(`/#/${screen}${query}`);
  await expect(page.locator(`.page--${screen === 'broadcasts' ? 'campaigns' : screen}`)).toBeVisible();
  const selector = READY[screen];
  if (selector !== undefined) await expect(page.locator(selector).first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await fontsReady(page);
}

/** Opens the real automation editor through the same links an operator uses. */
export async function openAutomationBuilder(page: Page): Promise<void> {
  await openScreen(page, 'automations');
  await page.locator('.automation-tabs__item').filter({ hasText: /أتمتتي|My Automations/ }).click();
  await expect(page.locator('.automation-row').first()).toBeVisible();
  await page.locator('.automation-row__actions a').first().click();
  await expect(page.locator('.automation-builder')).toBeVisible();
  await expect(page.locator('.workflow-block').first()).toBeVisible();
  await fontsReady(page);
}

/** Opens the app with no session: the sign-in page and nothing else. */
export async function openSignedOut(page: Page, hash = '#/inbox', options: ApiOptions = {}): Promise<void> {
  await freezeClock(page);
  await installApi(page, { ...options, signedIn: false });
  await page.goto(`/${hash}`);
  await expect(page.locator('#signin-email')).toBeVisible();
  await fontsReady(page);
}

/** Switches direction with the language control, wherever it is on screen. */
export async function setDirection(page: Page, direction: Direction): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.getAttribute('dir'));
  if (current === direction) return;
  await page.locator('.lang-toggle').first().click();
  await expect(page.locator('html')).toHaveAttribute('dir', direction);
  await fontsReady(page);
}

/** Switches the theme with the theme control. */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (current === theme) return;
  await page.locator('.theme-toggle').first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

export interface Box {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

/** Laid-out box of the first match, failing loudly when it is not rendered. */
export async function box(locator: Locator): Promise<Box> {
  await expect(locator.first()).toBeVisible();
  const value = await locator.first().boundingBox();
  if (value === null) throw new Error('element has no box');
  return value;
}

/**
 * How many rows of a list are fully inside their scroll container — the honest
 * reading of "at least 8 conversation rows are visible", as opposed to counting
 * rows that exist in the DOM below the fold.
 */
export async function fullyVisibleCount(page: Page, selector: string, containerSelector: string): Promise<number> {
  return page.evaluate(
    ({ item, container }) => {
      const scroller = document.querySelector(container);
      if (scroller === null) return 0;
      const bounds = scroller.getBoundingClientRect();
      return Array.from(document.querySelectorAll(item)).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= bounds.top - 0.5 && rect.bottom <= bounds.bottom + 0.5;
      }).length;
    },
    { item: selector, container: containerSelector },
  );
}

/** True when the document itself scrolls vertically — always a layout bug here. */
export async function pageScrolls(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollHeight > root.clientHeight + 1 || document.body.scrollHeight > window.innerHeight + 1;
  });
}

/** True when the document scrolls sideways. */
export async function overflowsHorizontally(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

/** Every combination the acceptance criteria must hold across. */
export const MATRIX: readonly { direction: Direction; theme: Theme }[] = [
  { direction: 'rtl', theme: 'light' },
  { direction: 'rtl', theme: 'dark' },
  { direction: 'ltr', theme: 'light' },
  { direction: 'ltr', theme: 'dark' },
];

/** The screens behind the navigation, besides the inbox. */
export const SCREENS = ['contacts', 'channels', 'people', 'broadcasts', 'automations', 'analytics', 'settings'] as const;
