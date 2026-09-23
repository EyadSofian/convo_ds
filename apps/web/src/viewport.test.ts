/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { VisualViewportLike } from './viewport';
import { trackViewport } from './viewport';

class FakeViewport implements VisualViewportLike {
  height = 844;
  scale = 1;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: 'resize', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'resize', listener: () => void): void {
    this.listeners.delete(listener);
  }
  resize(height: number): void {
    this.height = height;
    for (const listener of this.listeners) listener();
  }
  get listening(): number {
    return this.listeners.size;
  }
}

describe('the visible-height tracker', () => {
  it('publishes the visual viewport height and follows the keyboard', () => {
    const root = document.createElement('html');
    const viewport = new FakeViewport();
    const stop = trackViewport(root, viewport);
    expect(root.style.getPropertyValue('--viewport-height')).toBe('844px');

    // The keyboard opens: the visible part shrinks, and so does the frame.
    viewport.resize(503.6);
    expect(root.style.getPropertyValue('--viewport-height')).toBe('504px');

    // Pinch zoom shrinks the visual viewport too; the frame keeps its size.
    viewport.scale = 2;
    viewport.resize(422);
    expect(root.style.getPropertyValue('--viewport-height')).toBe('');

    stop();
    expect(viewport.listening).toBe(0);
    expect(root.style.getPropertyValue('--viewport-height')).toBe('');
  });

  it('does nothing where the browser has no visual viewport', () => {
    const root = document.createElement('html');
    trackViewport(root, undefined)();
    trackViewport(root, null)();
    expect(root.style.getPropertyValue('--viewport-height')).toBe('');
  });
});
