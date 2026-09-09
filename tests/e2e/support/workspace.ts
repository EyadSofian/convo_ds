import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
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
 * The seeded dataset derives every timestamp from `new Date()` at boot, so a
 * baseline captured at 01:47 and compared at 03:15 differs in every clock time
 * and every "4m ago" in the queue. Freezing the page clock before the bundle
 * runs makes the rendering a function of the code alone, which is the only way
 * a visual diff can mean "the design changed".
 */
export const FROZEN_NOW = new Date('2026-09-09T09:30:00.000Z');

/** Installs the fixed clock. Must run before the page script boots. */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.install({ time: FROZEN_NOW });
}

/**
 * Opens the inbox against the scripted API and waits for it to be populated.
 *
 * The Inbox reads everything from the server, so measuring it needs a server
 * to read from. `installApi` answers the handful of endpoints it calls with
 * fixed fixtures — see `support/api.ts` for what that is and is not.
 */
export async function openInbox(page: Page): Promise<void> {
  await freezeClock(page);
  await installApi(page);
  await page.goto(`/#/inbox/${CONVERSATION}`);
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('.zone--thread')).toBeVisible();
  // Wait for the server's answer rather than for a timer: a measurement taken
  // against a skeleton is a measurement of the skeleton.
  await expect(page.locator('.convrow').first()).toBeVisible();
  await expect(page.locator('.msg').first()).toBeVisible();
  // Self-hosted webfonts are part of the layout; measuring before they land
  // gives numbers for a fallback face nobody will ever see.
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Opens a screen, with the API scripted.
 *
 * `query` is passed through so a test can view the workspace as a role that
 * has the control it is about to click — the same "view as" the product
 * offers, rather than a test-only door into the state.
 */
export async function openScreen(page: Page, screen: string, query = ''): Promise<void> {
  await freezeClock(page);
  await installApi(page);
  await page.goto(`/#/${screen}${query}`);
  await expect(page.locator('.workspace, .inbox')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Switches the workspace to a direction using the language toggle. */
export async function setDirection(page: Page, direction: Direction): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.getAttribute('dir'));
  if (current === direction) return;
  await page.locator('[data-act="lang"]').click();
  await expect(page.locator('html')).toHaveAttribute('dir', direction);
  await page.evaluate(() => document.fonts.ready);
}

/** Switches the theme using the theme toggle. */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (current === theme) return;
  await page.locator('[data-act="theme"]').click();
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
  await expect(locator).toBeVisible();
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

/** True when the page itself scrolls vertically — always a layout bug here. */
export async function pageScrolls(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollHeight > root.clientHeight + 1 || document.body.scrollHeight > window.innerHeight + 1;
  });
}

/** Every combination the acceptance criteria must hold across. */
export const MATRIX: readonly { direction: Direction; theme: Theme }[] = [
  { direction: 'rtl', theme: 'light' },
  { direction: 'rtl', theme: 'dark' },
  { direction: 'ltr', theme: 'light' },
  { direction: 'ltr', theme: 'dark' },
];
