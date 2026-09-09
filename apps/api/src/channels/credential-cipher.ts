import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for tenant channel credentials.
 *
 * A Page token or a WhatsApp access token arrives from an OAuth grant, so it
 * cannot live in configuration the way an app secret does — it has to be
 * stored. Storing it in an ordinary column would mean a database backup, a
 * replica, or one over-broad `SELECT` hands out the ability to send messages as
 * the tenant.
 *
 * AES-256-GCM, standard construction, nothing invented:
 *
 * - a fresh 12-byte IV per record, never reused, so identical tokens do not
 *   produce identical ciphertext;
 * - the 16-byte authentication tag stored separately, so a tampered ciphertext
 *   fails to decrypt rather than decrypting to something else;
 * - additional authenticated data binding the record to its tenant, connection
 *   and purpose, so a ciphertext lifted from one row cannot be replayed into
 *   another;
 * - a named key version, so a key rotation is auditable and an undecryptable
 *   row is diagnosable rather than mysterious.
 *
 * The plaintext exists only as the return value of `decrypt`. It is never
 * logged, never put in an API response, and never stored in a second place.
 */

export class CredentialCipherError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CredentialCipherError';
    this.code = code;
  }
}

export interface SealedCredential {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly keyVersion: string;
  /** Identifies the secret without revealing it: HMAC, not a plain hash. */
  readonly fingerprint: string;
}

/** What a sealed record is bound to. Changing any of it breaks decryption. */
export interface CredentialBinding {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly purpose: string;
}

const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_VERSION_PATTERN = /^[a-z0-9_]{1,32}$/;

export interface CipherKey {
  readonly version: string;
  readonly key: Buffer;
}

/**
 * Parses a configured key.
 *
 * The format is `version:base64key`, so rotating means adding a key with a new
 * version rather than editing one in place — and a record encrypted under the
 * old version still says which key it needs.
 */
export function parseCipherKey(raw: string): CipherKey {
  const separator = raw.indexOf(':');
  const version = separator === -1 ? '' : raw.slice(0, separator);
  const material = separator === -1 ? '' : raw.slice(separator + 1);
  if (!KEY_VERSION_PATTERN.test(version)) {
    throw new CredentialCipherError(
      'credential_key_malformed',
      'A credential key is "<version>:<base64>" with a lowercase version.',
    );
  }
  const key = Buffer.from(material, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new CredentialCipherError(
      'credential_key_length',
      'A credential key must decode to exactly 32 bytes.',
    );
  }
  return { version, key };
}

export class CredentialCipher {
  /** Keys by version. The first is the one new records are written with. */
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly currentVersion: string;

  constructor(
    keys: readonly CipherKey[],
    private readonly fingerprintSecret: string,
  ) {
    const first = keys[0];
    if (first === undefined) {
      throw new CredentialCipherError(
        'credential_key_missing',
        'At least one credential encryption key must be configured.',
      );
    }
    this.keys = new Map(keys.map((entry) => [entry.version, entry.key]));
    this.currentVersion = first.version;
  }

  /**
   * A stable identifier for a secret that reveals nothing about it.
   *
   * HMAC under a server secret rather than a bare SHA-256: a plain hash of a
   * short-ish token is guessable from a candidate list, and the point of this
   * value is to be safe to compare and safe to store.
   */
  fingerprint(plaintext: string): string {
    return createHmac('sha256', this.fingerprintSecret)
      .update('channel-credential\0')
      .update(plaintext, 'utf8')
      .digest('hex');
  }

  seal(plaintext: string, binding: CredentialBinding): SealedCredential {
    const key = this.keys.get(this.currentVersion);
    /* c8 ignore next 3 -- the current version is taken from the key map itself */
    if (key === undefined) {
      throw new CredentialCipherError('credential_key_missing', 'The current key vanished.');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad(binding, this.currentVersion), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext,
      iv,
      authTag: cipher.getAuthTag(),
      keyVersion: this.currentVersion,
      fingerprint: this.fingerprint(plaintext),
    };
  }

  /**
   * Opens a sealed record, or refuses.
   *
   * Every failure is the same typed error rather than a distinction between
   * "wrong key", "tampered ciphertext" and "wrong row": from outside, telling
   * them apart is an oracle, and inside, the operator action is identical.
   */
  open(sealed: SealedCredential, binding: CredentialBinding): string {
    const key = this.keys.get(sealed.keyVersion);
    if (key === undefined) {
      throw new CredentialCipherError(
        'credential_key_unknown',
        `No configured key with version "${sealed.keyVersion}".`,
      );
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
      decipher.setAAD(Buffer.from(aad(binding, sealed.keyVersion), 'utf8'));
      decipher.setAuthTag(sealed.authTag);
      return decipher.update(sealed.ciphertext, undefined, 'utf8') + decipher.final('utf8');
    } catch {
      throw new CredentialCipherError(
        'credential_undecryptable',
        'The stored credential could not be opened.',
      );
    }
  }
}

/**
 * The additional authenticated data.
 *
 * Binding the record to its tenant, connection and purpose is what stops a
 * ciphertext being copied from one row to another: the bytes decrypt only under
 * the same binding they were sealed with, so moving a row between tenants
 * breaks it rather than transferring the credential.
 */
function aad(binding: CredentialBinding, keyVersion: string): string {
  return [keyVersion, binding.tenantId, binding.connectionId, binding.purpose].join('\0');
}

/**
 * Builds a cipher from configured keys, or explains why it cannot.
 *
 * A result rather than an exception because "this installation holds no channel
 * credentials" is a normal state, not a failure: an installation with no
 * channels needs no key, and refusing to boot over an unused feature would be
 * worse than refusing at the point of use.
 *
 * The cast in the catch is safe by construction: `parseCipherKey` and the
 * constructor are the only things that throw here, and both throw
 * `CredentialCipherError`.
 */
export type CipherSetup =
  | { readonly ok: true; readonly cipher: CredentialCipher }
  | { readonly ok: false; readonly message: string };

export function setUpCipher(keys: readonly string[], fingerprintSecret: string): CipherSetup {
  if (keys.length === 0) {
    return { ok: false, message: 'CONVO_CREDENTIAL_KEYS is not configured.' };
  }
  try {
    return { ok: true, cipher: new CredentialCipher(keys.map(parseCipherKey), fingerprintSecret) };
  } catch (error) {
    return { ok: false, message: (error as CredentialCipherError).message };
  }
}
