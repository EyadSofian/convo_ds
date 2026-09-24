import type { PasswordHasher } from '../tokens.js';

/**
 * One spelling of a password, whatever keyboard typed it.
 *
 * The same person types the same password on a Mac and on a phone. An Arabic
 * phone keyboard types the digits as ١٢٣ (or ۱۲۳), a composed character can
 * arrive precomposed or decomposed, and a suggestion bar leaves a trailing
 * space. Each of those made a password set on one device refuse to sign in
 * on another. Both hashing and verifying see this form, so they agree:
 *
 * - Unicode NFKC, so compatibility and composed forms are one character;
 * - Arabic-Indic and Eastern Arabic-Indic digits become 0–9;
 * - leading and trailing whitespace is dropped (inner spaces stay).
 */
export function canonicalPassword(plaintext: string): string {
  return plaintext
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .trim();
}

/**
 * Hashes and verifies the canonical form. A hash stored before this existed
 * was made from the password exactly as typed, so a canonical miss is retried
 * with the original: nobody who could sign in yesterday is locked out today.
 */
export function canonicalHasher(inner: PasswordHasher): PasswordHasher {
  return {
    hash: (plaintext) => inner.hash(canonicalPassword(plaintext)),
    async verify(hash, plaintext) {
      const canonical = canonicalPassword(plaintext);
      if (await inner.verify(hash, canonical)) return true;
      return canonical !== plaintext && inner.verify(hash, plaintext);
    },
  };
}
