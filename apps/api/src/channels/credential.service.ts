import { Inject, Injectable } from '@nestjs/common';
import type { SqlExecutor } from '@convo/domain';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { API_CONFIG } from '../tokens.js';
import { setUpCipher } from './credential-cipher.js';
import type {
  CredentialBinding,
  CredentialCipher,
  SealedCredential,
} from './credential-cipher.js';

/**
 * Reading and writing channel credentials, and the only place a plaintext token
 * exists inside this process.
 *
 * Two rules the rest of the codebase relies on:
 *
 * 1. **Nothing here returns a token to a caller that could serialize it.**
 *    `open` hands the plaintext to a callback and the value never becomes part
 *    of a summary, a response, or an error message.
 * 2. **Rotation supersedes; it never overwrites.** A new version is inserted and
 *    the previous one is marked `superseded` in the same transaction, so a
 *    credential that was in flight during the rotation can still be identified
 *    afterwards and revoking a version is a fact with a time.
 */
@Injectable()
export class ChannelCredentialService {
  private readonly cipher: CredentialCipher | null;
  private readonly keyFailure: string | null;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    // Not a boot failure: an installation with no channel connections needs no
    // key, and refusing to start over an unused feature is worse than refusing
    // at the point of use with a message that names the variable.
    const setup = setUpCipher(config.secrets.credentialKeys, config.secrets.authHash);
    this.cipher = setup.ok ? setup.cipher : null;
    this.keyFailure = setup.ok ? null : setup.message;
  }

  /** True when this installation can hold provider credentials at all. */
  get available(): boolean {
    return this.cipher !== null;
  }

  private require(): CredentialCipher {
    if (this.cipher === null) {
      throw new ApiHttpError(
        503,
        'credential_storage_unavailable',
        // `keyFailure` is a string exactly when `cipher` is null, which is what
        // `setUpCipher` guarantees and what this branch has already checked.
        `Channel credentials cannot be stored: ${String(this.keyFailure)}`,
      );
    }
    return this.cipher;
  }

  /**
   * Stores a credential as the new active version for its purpose.
   *
   * Runs inside the caller's transaction so the credential and whatever it
   * belongs to commit together: a connection with no credential and a
   * credential with no connection are both states nothing should have to
   * handle.
   */
  async store(
    sql: SqlExecutor,
    binding: CredentialBinding,
    plaintext: string,
    expiresAt: Date | null,
  ): Promise<{ readonly version: number; readonly fingerprint: string }> {
    const cipher = this.require();
    const sealed = cipher.seal(plaintext, binding);

    // Supersede first: the partial unique index allows exactly one active
    // version per purpose, so the order is not a preference.
    await sql.query(
      `UPDATE channel_credentials SET status = 'superseded'
        WHERE connection_id = $1 AND purpose = $2 AND status = 'active'`,
      [binding.connectionId, binding.purpose],
    );

    const inserted = await sql.query<{ version: number }>(
      `INSERT INTO channel_credentials
         (tenant_id, connection_id, purpose, version, ciphertext, iv, auth_tag,
          key_version, fingerprint, expires_at)
       VALUES ($1, $2, $3,
               (SELECT coalesce(max(version), 0) + 1 FROM channel_credentials
                 WHERE connection_id = $2 AND purpose = $3),
               $4, $5, $6, $7, $8, $9)
       RETURNING version`,
      [
        binding.tenantId,
        binding.connectionId,
        binding.purpose,
        sealed.ciphertext,
        sealed.iv,
        sealed.authTag,
        sealed.keyVersion,
        sealed.fingerprint,
        expiresAt,
      ],
    );
    return {
      version: requireRow(inserted.rows, 'credential insert returned no version').version,
      fingerprint: sealed.fingerprint,
    };
  }

  /**
   * Opens the active credential and hands the plaintext to `use`.
   *
   * A callback rather than a return value on purpose: a returned secret is a
   * secret that ends up in a variable somebody logs. Returns `null` when there
   * is no active credential, which is a state the caller must handle rather
   * than an exception to swallow.
   */
  async withActive<T>(
    sql: SqlExecutor,
    binding: CredentialBinding,
    use: (plaintext: string) => Promise<T>,
  ): Promise<T | null> {
    const cipher = this.require();
    const rows = await sql.query<{
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
      key_version: string;
      fingerprint: string;
    }>(
      `SELECT ciphertext, iv, auth_tag, key_version, fingerprint
         FROM channel_credentials
        WHERE connection_id = $1 AND purpose = $2 AND status = 'active'`,
      [binding.connectionId, binding.purpose],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      return null;
    }
    const sealed: SealedCredential = {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
      fingerprint: row.fingerprint,
    };
    return use(cipher.open(sealed, binding));
  }

  /**
   * Revokes every credential for a connection.
   *
   * Used by disconnect and by a blast-radius containment: revoking one
   * connection's credentials must not touch another connection or another
   * tenant, which the `connection_id` predicate and RLS together guarantee
   * (CH-05).
   */
  async revokeAll(sql: SqlExecutor, connectionId: string): Promise<void> {
    await sql.query(
      `UPDATE channel_credentials
          SET status = 'revoked', revoked_at = now()
        WHERE connection_id = $1 AND status <> 'revoked'`,
      [connectionId],
    );
  }
}
