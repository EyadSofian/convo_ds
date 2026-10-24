import { describe, expect, it } from 'vitest';
import { templateTimezone } from './automation.controller.js';

describe('the zone a template automation runs in', () => {
  it('keeps UTC for a client that sends none', () => {
    expect(templateTimezone(undefined)).toBe('UTC');
    expect(templateTimezone(null)).toBe('UTC');
  });

  it("takes the operator's zone when it is a real one", () => {
    expect(templateTimezone('Africa/Cairo')).toBe('Africa/Cairo');
  });

  it('refuses anything that is not a zone this server knows', () => {
    for (const value of [3, '', 'x'.repeat(101), 'Mars/Olympus']) {
      expect(() => templateTimezone(value)).toThrow();
    }
  });
});
