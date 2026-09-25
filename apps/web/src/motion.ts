import type { AppState } from './state';

/**
 * Entrance motion that survives re-renders.
 *
 * Every state change rebuilds the whole tree. An entrance keyed on "this
 * element is new" would therefore replay each time a realtime event arrived,
 * and one keyed on "this render opened it" would be cut dead by the next render
 * forty milliseconds later — typically the one that swaps a skeleton for data.
 *
 * Instead each motion channel remembers when its key last changed. A render
 * inside the window marks the channel `enter` on the root and publishes how far
 * into the entrance it is; the stylesheet starts every entrance that far in (a
 * negative `animation-delay`). A rebuilt element continues the same animation
 * from the same frame rather than restarting it, and once the window has passed
 * the channel is `settled` and nothing moves at all.
 */

/** Longer than the slowest staggered entrance in the stylesheet. */
export const MOTION_WINDOW_MS = 900;

export type MotionMemory = Map<string, { readonly key: string; readonly since: number }>;

/**
 * Milliseconds since `key` became current on `channel`, or `null` once the
 * entrance window has passed. A new key restarts the window at zero.
 */
export function motionElapsed(memory: MotionMemory, channel: string, key: string, now: number): number | null {
  const last = memory.get(channel);
  if (last === undefined || last.key !== key) {
    memory.set(channel, { key, since: now });
    return 0;
  }
  // A clock that stepped backwards is treated as "just started", never as a
  // negative offset that would push the entrance into the future.
  const elapsed = Math.max(0, now - last.since);
  return elapsed < MOTION_WINDOW_MS ? elapsed : null;
}

/** Stamps one channel's phase and offset on the render root. */
export function applyMotion(root: HTMLElement, memory: MotionMemory, channel: string, key: string, now: number): void {
  const elapsed = motionElapsed(memory, channel, key, now);
  root.setAttribute(`data-${channel}`, elapsed === null ? 'settled' : 'enter');
  root.style.setProperty(`--${channel}-elapsed`, `${String(elapsed ?? 0)}ms`);
}

export interface MotionKeys {
  /** The screen, and the tab inside it: changing either is a page transition. */
  readonly view: string;
  /** The one record in focus: a conversation, a contact, a role or a team. */
  readonly detail: string;
  /** An inline tool opened over a screen, such as adding or importing contacts. */
  readonly tool: string;
}

export function motionKeys(state: AppState): MotionKeys {
  const params = state.route.params;
  const record =
    state.route.screen === 'contacts'
      ? state.live.selectedContactId
      : state.route.conversationId ?? params['role'] ?? params['team'] ?? null;
  return {
    view: `${state.route.screen}|${params['tab'] ?? ''}`,
    detail: `${state.route.screen}|${record ?? ''}`,
    tool: `${state.route.screen}|${state.dialogForm['contactsTool'] ?? ''}`,
  };
}
