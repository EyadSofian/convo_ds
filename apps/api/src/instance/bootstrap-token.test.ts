import { describe, expect, it } from 'vitest';
import { bootstrapTokenMatches } from './bootstrap-token.js';

const TOKEN = 'bootstrap-token-test-value-00000001';

describe('bootstrapTokenMatches', () => {
  it('accepts only the exact configured token', () => {
    expect(bootstrapTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(bootstrapTokenMatches(TOKEN + '-wrong', TOKEN)).toBe(false);
  });

  it('rejects missing and repeated headers', () => {
    expect(bootstrapTokenMatches(undefined, TOKEN)).toBe(false);
    expect(bootstrapTokenMatches([TOKEN], TOKEN)).toBe(false);
  });
});
