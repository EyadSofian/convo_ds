import type { Pool, PoolClient } from 'pg';

export class TenantContextError extends Error {}

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
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantId)) {
    throw new TenantContextError(`Refusing to set a non-uuid tenant context: ${tenantId}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['convo.tenant_id', tenantId]);

    const check = await client.query<{ tenant: string | null }>(
      'SELECT app_current_tenant()::text AS tenant',
    );
    if (check.rows[0]?.tenant !== tenantId) {
      throw new TenantContextError('Tenant context did not take effect in this transaction');
    }

    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
