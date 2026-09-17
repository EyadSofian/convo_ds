import type { ErrorDetail } from '@convo/contracts';
import { describe, expect, it } from 'vitest';
import { readTrustedProxyHops, trustProxyHops } from './client-address.js';

/**
 * Both failure directions matter here and they pull against each other:
 *
 * - Trust nothing behind the reverse proxy, and every user shares one
 *   rate-limit bucket — an anonymous lockout of the whole installation.
 * - Trust everything, and a client picks its own bucket by sending a header —
 *   an unlimited credential-guessing oracle.
 *
 * The tests are written as those two attacks.
 */

function hops(value: string | undefined) {
  const issues: ErrorDetail[] = [];
  return { value: readTrustedProxyHops({ CONVO_TRUSTED_PROXY_HOPS: value }, issues), issues };
}

describe('the configured hop count', () => {
  it('defaults to trusting nothing', () => {
    expect(hops(undefined).value).toBe(0);
    expect(hops('').value).toBe(0);
    expect(hops('   ').value).toBe(0);
  });

  it('raises no issue when it is absent', () => {
    expect(hops(undefined).issues).toHaveLength(0);
  });

  it('accepts a plausible deployment', () => {
    expect(hops('0').value).toBe(0);
    expect(hops('1').value).toBe(1);
    expect(hops('2').value).toBe(2);
    expect(hops('8').value).toBe(8);
  });

  it.each(['-1', '1.5', 'two', '9', '99', 'NaN'])(
    'refuses %s, and falls back to trusting nothing',
    (bad) => {
      const result = hops(bad);
      expect(result.value).toBe(0);
      expect(result.issues.map((issue) => issue.code)).toContain('out_of_range');
      expect(result.issues[0]?.field).toBe('CONVO_TRUSTED_PROXY_HOPS');
    },
  );

  it('names the bound in the message rather than leaving it to be guessed', () => {
    expect(hops('99').issues[0]?.message).toContain('0 to 8');
  });
});

describe('the predicate handed to Fastify', () => {
  it('trusts nothing at zero, so X-Forwarded-For is ignored entirely', () => {
    const trust = trustProxyHops(0);
    expect(trust('10.0.0.1', 0)).toBe(false);
    expect(trust('10.0.0.1', 1)).toBe(false);
  });

  it('trusts exactly one hop at one', () => {
    const trust = trustProxyHops(1);
    // Hop 0 is the proxy we run; anything beyond it is the client's own claim.
    expect(trust('10.0.0.1', 0)).toBe(true);
    expect(trust('203.0.113.9', 1)).toBe(false);
  });

  it('trusts two hops on the Railway topology and no more', () => {
    const trust = trustProxyHops(2);
    expect(trust('10.0.0.1', 0)).toBe(true);
    expect(trust('10.0.0.2', 1)).toBe(true);
    // A spoofed prefix, however long, is never reached.
    expect(trust('1.1.1.1', 2)).toBe(false);
    expect(trust('1.1.1.1', 7)).toBe(false);
  });
});
