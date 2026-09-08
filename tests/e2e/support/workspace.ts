import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Shared driving helpers for the layout, accessibility and visual specs.
 *
 * Everything here goes through the product's own controls — the same buttons an
 * operator clicks — rather than reaching into application state. A layout test
 * that sets internal flags directly proves nothing about the shipped screen.
 */

export type Direction = 'rtl' | 'ltr';
export type Theme = 'light' | 'dark';

/** Opens the inbox and waits for the shell to have rendered. */
export async function openInbox(page: Page): Promise<void> {
  await page.goto('/#/inbox');
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('.zone--thread')).toBeVisible();
  // Self-hosted webfonts are part of the layout; measuring before they land
  // gives numbers for a fallback face nobody will ever see.
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
