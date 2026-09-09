/**
 * The narrow crypto port the channel adapters are allowed to see.
 *
 * The domain stays runtime-independent — it imports no `node:crypto` — and the
 * three operations an adapter actually needs are small enough to name. The
 * comparison is a port method rather than a `===` at the call site precisely so
 * that "constant-time" is a property of one tested implementation instead of a
 * habit each adapter has to remember (EVT-01, CH-WA-02).
 */
export interface ChannelCrypto {
  /** Lowercase hex HMAC-SHA-256 of the exact bytes given. */
  hmacSha256Hex(secret: string, message: Uint8Array): string;
  /** Lowercase hex SHA-256 of a UTF-8 string. */
  sha256Hex(value: string): string;
  /**
   * Constant-time comparison of two hex digests.
   *
   * Returns false rather than throwing when the two differ in length, so a
   * malformed header is a refusal and not a 500.
   */
  timingSafeEqualHex(left: string, right: string): boolean;
}
