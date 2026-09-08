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
