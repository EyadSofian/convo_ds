/**
 * Keeps the app exactly as tall as the part of the screen the operator can see.
 *
 * On a phone the on-screen keyboard covers the bottom of the layout without
 * resizing it on iOS, so a composer pinned to the bottom edge of a `100dvh`
 * frame ends up underneath the keyboard. The visual viewport is the one
 * measurement every mobile engine updates when the keyboard opens; publishing
 * its height as `--viewport-height` lets the frame shrink to it, and the
 * composer rides up with the keyboard instead of hiding behind it.
 *
 * Presentation only: nothing here reads or changes what is loaded.
 */

/** The slice of `VisualViewport` this module reads. */
export interface VisualViewportLike {
  readonly height: number;
  /** Pinch zoom. A zoomed viewport is smaller for a reason the frame must not follow. */
  readonly scale: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
}

/** Starts tracking; returns the function that stops it. */
export function trackViewport(root: HTMLElement, viewport: VisualViewportLike | null | undefined): () => void {
  if (viewport === null || viewport === undefined) return () => undefined;
  const publish = (): void => {
    if (viewport.scale > 1.01) root.style.removeProperty('--viewport-height');
    else root.style.setProperty('--viewport-height', `${String(Math.round(viewport.height))}px`);
  };
  publish();
  viewport.addEventListener('resize', publish);
  return () => {
    viewport.removeEventListener('resize', publish);
    root.style.removeProperty('--viewport-height');
  };
}
