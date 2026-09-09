import type { ChannelCrypto } from './crypto.js';
import type { SignatureInput, SignatureVerdict } from './port.js';

/**
 * Meta's `X-Hub-Signature-256` verification, shared by the three Meta channels.
 *
 * This is the one thing WhatsApp, Messenger and Instagram genuinely do share:
 * they are deliveries from a single app registration, signed the same way. It
 * lives in its own module rather than in a base class so that sharing it is a
 * deliberate import and not an inheritance that quietly carries policy across
 * channels too (ADR-0009).
 *
 * Three properties, each of which has been a real vulnerability somewhere:
 *
 * 1. **The exact raw bytes.** Re-serializing the parsed body changes key order
 *    and whitespace, and a signature over the re-serialized form verifies a
 *    document the sender never signed.
 * 2. **Constant-time comparison.** A `===` on hex digests leaks the digest one
 *    byte at a time to anyone who can time the response.
 * 3. **A replay window.** A valid signature is valid forever; without a bound on
 *    the receipt timestamp, a captured delivery can be replayed indefinitely.
 */

const HEADER = 'x-hub-signature-256';
const PREFIX = 'sha256=';
const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** Deliveries older than this are refused even with a good signature. */
export const REPLAY_WINDOW_SECONDS = 300;

export function verifyMetaSignature(input: SignatureInput, crypto: ChannelCrypto): SignatureVerdict {
  const header = input.headers[HEADER];
  if (header === undefined || header === '') {
    return { valid: false, reason: 'missing_header' };
  }
  if (!header.startsWith(PREFIX)) {
    // A `sha1=` header is not "an older algorithm we can also accept": SHA-1
    // HMAC deliveries were deprecated, and quietly honouring one is how a
    // downgrade becomes possible.
    return { valid: false, reason: 'unsupported_algorithm' };
  }
  const provided = header.slice(PREFIX.length).toLowerCase();
  if (!HEX_DIGEST.test(provided)) {
    return { valid: false, reason: 'malformed_header' };
  }

  const expected = crypto.hmacSha256Hex(input.secret, input.rawBody);
  if (!crypto.timingSafeEqualHex(expected, provided)) {
    return { valid: false, reason: 'mismatch' };
  }

  // Only after the signature holds: an attacker must not be able to learn
  // anything from how we treat an unsigned old delivery versus an unsigned new
  // one.
  const stale = replayAge(input.headers, input.now);
  if (stale !== null && stale > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: 'stale' };
  }
  return { valid: true };
}

/**
 * Age of the delivery in seconds, or `null` when the sender did not date it.
 *
 * An absent timestamp is not treated as stale. Meta does not always send one,
 * and refusing every undated delivery would drop real inbound messages to close
 * a replay hole that the signature secret already bounds.
 */
function replayAge(
  headers: Readonly<Record<string, string | undefined>>,
  now: Date,
): number | null {
  const raw = headers['x-hub-timestamp'];
  if (raw === undefined) {
    return null;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  return Math.abs(now.getTime() / 1000 - seconds);
}

/**
 * The GET subscription handshake.
 *
 * Returns the challenge to echo, or `null` to refuse. The token is compared by
 * hash so the configured value never has to be held in memory beside it, and
 * the comparison is constant-time for the same reason the signature's is.
 */
export function answerMetaChallenge(
  query: Readonly<Record<string, string | undefined>>,
  expectedTokenHash: string,
  crypto: ChannelCrypto,
): string | null {
  if (query['hub.mode'] !== 'subscribe') {
    return null;
  }
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (token === undefined || challenge === undefined || challenge === '') {
    return null;
  }
  return crypto.timingSafeEqualHex(crypto.sha256Hex(token), expectedTokenHash) ? challenge : null;
}
