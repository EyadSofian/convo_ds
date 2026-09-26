/**
 * Every infinite loop — a spinner, a skeleton's shimmer, a pulsing dot — is
 * started at the document timeline's origin.
 *
 * The screen is rebuilt on every render, so each spinner is a new element with
 * a new animation. Left alone, each would start from zero and the spinner would
 * stutter back every time anything changed. Anchored at time zero, a loop's
 * angle depends only on the time, so the rebuilt spinner carries on exactly
 * where the old one was — and every spinner on screen turns together.
 */
export function lockLoops(doc: Document): void {
  if (typeof doc.getAnimations !== 'function') return;
  for (const animation of doc.getAnimations()) {
    if (animation.startTime !== 0 && animation.effect?.getComputedTiming().iterations === Infinity) animation.startTime = 0;
  }
}
