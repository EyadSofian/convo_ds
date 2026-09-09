import type { Pool, PoolClient } from 'pg';

export class TenantContextError extends Error {}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function assertTenantContextId(tenantId: string): void {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new TenantContextError(`Refusing to set a non-uuid tenant context: ${tenantId}`);
  }
}

/**
 * Runs `work` inside a transaction whose tenant context is set and verified.
 *
 * `SET LOCAL` scopes the setting to this transaction, so a pooled connection
 * cannot carry it into the next checkout. The read-back is not paranoia: it is
 * the assertion that turns "we set it" into "the database agrees" (TEN-05).
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertTenantContextId(tenantId);
  const client = await pool.connect();
  let result: T;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['convo.tenant_id', tenantId]);

    const check = await client.query<{ tenant: string | null }>(
      'SELECT app_current_tenant()::text AS tenant',
    );
    if (check.rows[0]?.tenant !== tenantId) {
      throw new TenantContextError('Tenant context did not take effect in this transaction');
    }

    result = await work(client);
    await client.query('COMMIT');
  } catch (error) {
    // A rollback on an already-broken connection throws too. The caller's
    // failure is the one worth reporting; the cleanup error would only hide it.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // Returning after the block rather than inside it keeps the success path
  // flowing through `finally` to a single exit, which is both easier to read
  // and the only shape in which coverage can observe every path out of here.
  return result;
}

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Runs `work` inside a transaction whose tenant context was resolved from a
 * **verified credential** rather than from a membership.
 *
 * Invariant I2 says the tenant may come from an authenticated membership, a
 * verified channel asset, or the installation config. An invitation token is
 * the same category: the caller demonstrably holds a credential this
 * installation issued, and the tenant is read from that credential, never from
 * anything the caller supplied alongside it.
 *
 * The carve-out is deliberately as narrow as it can be. `convo.credential_hash`
 * is transaction-local and is matched against ONE column, so the policy admits
 * exactly the row whose token the caller already has — not "all invitations
 * while a flag is set". The rest of the transaction then runs under the normal
 * tenant context, so every later read and write is isolated as usual.
 *
 * Returns `null` without opening a tenant context when nothing matches, so a
 * dead token cannot be told apart from an unknown one by observing behaviour.
 */
export interface ResolvedCredential<R> {
  readonly tenantId: string;
  /**
   * Whatever the resolver learned while finding the tenant — typically the row
   * it already had to read. Passing it through means the work does not look the
   * same row up twice, and does not have to defend against a "captured value is
   * somehow null" case that cannot happen.
   */
  readonly value: R;
}

export async function withCredentialResolvedTenant<R, T>(
  pool: Pool,
  credentialHash: string,
  resolveTenant: (client: PoolClient) => Promise<ResolvedCredential<R> | null>,
  work: (client: PoolClient, resolved: ResolvedCredential<R>) => Promise<T>,
): Promise<T | null> {
  if (!TOKEN_HASH_PATTERN.test(credentialHash)) {
    throw new TenantContextError('Refusing to set a non-fingerprint credential context');
  }
  const client = await pool.connect();
  let result: T | null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['convo.credential_hash', credentialHash]);
    const scope = await client.query<{ value: string | null }>(
      "SELECT nullif(current_setting('convo.credential_hash', true), '') AS value",
    );
    if (scope.rows[0]?.value !== credentialHash) {
      throw new TenantContextError('Credential context did not take effect in this transaction');
    }

    const resolved = await resolveTenant(client);
    if (resolved === null) {
      result = null;
    } else {
      assertTenantContextId(resolved.tenantId);
      await client.query('SELECT set_config($1, $2, true)', ['convo.tenant_id', resolved.tenantId]);
      const check = await client.query<{ tenant: string | null }>(
        'SELECT app_current_tenant()::text AS tenant',
      );
      if (check.rows[0]?.tenant !== resolved.tenantId) {
        throw new TenantContextError('Tenant context did not take effect in this transaction');
      }
      result = await work(client, resolved);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return result;
}
