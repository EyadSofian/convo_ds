import { describe, expect, it } from 'vitest';
import { lockLoops } from './loops';

function animation(iterations: number, startTime: number | null): Animation {
  return { startTime, effect: { getComputedTiming: () => ({ iterations }) } } as unknown as Animation;
}

describe('lockLoops', () => {
  it('starts every infinite loop at the timeline origin and leaves the rest alone', () => {
    const spinner = animation(Infinity, 1234);
    const entrance = animation(1, 1234);
    const settled = animation(Infinity, 0);
    const bare = { startTime: 50, effect: null } as unknown as Animation;
    lockLoops({ getAnimations: () => [spinner, entrance, settled, bare] } as unknown as Document);
    expect([spinner.startTime, entrance.startTime, settled.startTime, bare.startTime]).toEqual([0, 1234, 0, 50]);
  });

  it('does nothing where animations cannot be read', () => {
    expect(() => lockLoops({} as Document)).not.toThrow();
  });
});
