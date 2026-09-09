import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelCrypto } from '@convo/domain';

/**
 * The one implementation of the channel crypto port.
 *
 * It exists so that "constant-time" is a property of a single tested function
 * rather than something each adapter has to remember. `timingSafeEqual` throws
 * on a length mismatch, which is exactly the case a malformed header produces,
 * so the length is checked first and answered as a refusal rather than a 500.
 */
export const nodeChannelCrypto: ChannelCrypto = {
  hmacSha256Hex(secret: string, message: Uint8Array): string {
    return createHmac('sha256', secret).update(message).digest('hex');
  },

  sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  },

  timingSafeEqualHex(left: string, right: string): boolean {
    if (left.length !== right.length) {
      return false;
    }
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    // A non-hex string decodes to a shorter buffer, so this also catches
    // "same length, not actually hex" without a second parse.
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  },
};

/** SHA-256 of raw bytes, for the receipt's content address. */
export function sha256BytesHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The installation-wide fingerprint of a provider asset (CH-03, DEL-02). */
export function assetFingerprint(provider: string, kind: string, externalAssetId: string): string {
  return nodeChannelCrypto.sha256Hex(`${provider}:${kind}:${externalAssetId}`);
}
