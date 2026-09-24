import { describe, expect, it, vi } from 'vitest';
import { canonicalHasher, canonicalPassword } from './password-canonical.js';

describe('the canonical password', () => {
  it('is the same whichever keyboard typed it', () => {
    expect(canonicalPassword('Digital١٢٣school')).toBe('Digital123school');
    expect(canonicalPassword('Digital۱۲۳school')).toBe('Digital123school');
    expect(canonicalPassword('  kept inner space  ')).toBe('kept inner space');
    // Decomposed é and precomposed é are one character.
    expect(canonicalPassword('café password')).toBe(canonicalPassword('café password'));
    // Case is never folded: that would halve the password space.
    expect(canonicalPassword('Password')).not.toBe(canonicalPassword('password'));
  });
});

describe('the canonical hasher', () => {
  /** A stand-in hasher whose "hash" is the plaintext it was given. */
  function fake() {
    return {
      hash: vi.fn(async (plaintext: string) => `h:${plaintext}`),
      verify: vi.fn(async (hash: string, plaintext: string) => hash === `h:${plaintext}`),
    };
  }

  it('hashes the canonical form, so a phone and a laptop agree', async () => {
    const inner = fake();
    const hasher = canonicalHasher(inner);
    const stored = await hasher.hash('secret١٢٣٤٥٦ ');
    expect(stored).toBe('h:secret123456');
    expect(await hasher.verify(stored, 'secret123456')).toBe(true);
    expect(await hasher.verify(stored, 'secret١٢٣٤٥٦')).toBe(true);
    expect(await hasher.verify(stored, 'secret123457')).toBe(false);
  });

  it('still accepts a password stored exactly as typed before canonicalisation', async () => {
    const inner = fake();
    const hasher = canonicalHasher(inner);
    expect(await hasher.verify('h:legacy١٢٣ ', 'legacy١٢٣ ')).toBe(true);
    // An already-canonical password needs one check, not two.
    inner.verify.mockClear();
    expect(await hasher.verify('h:other', 'plain-password')).toBe(false);
    expect(inner.verify).toHaveBeenCalledTimes(1);
  });
});
