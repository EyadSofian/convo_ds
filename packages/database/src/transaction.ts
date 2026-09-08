import type { Pool, PoolClient } from 'pg';
import type { SqlExecutor, SqlResult, TenantTransaction } from '@convo/domain';
import { assertTenantContextId, TenantContextError, withTenant } from './context.js';

/**
 * Adapts the `pg` pool to the narrow port the domain declares.
 *
 * The wrapper is thin on purpose. It exists so the domain never imports the
 * driver, and so a domain test can substitute a recording fake without a
 * database -- not to add behaviour of its own.
 */
export function tenantTransaction(pool: Pool): TenantTransaction {
  return <T>(tenantId: string, work: (sql: SqlExecutor) => Promise<T>): Promise<T> =>
    withTenant(pool, tenantId, (client) => work(asExecutor(client)));
}

export function asExecutor(client: Pick<PoolClient, 'query'>): SqlExecutor {
  return {
    async query<R>(text: string, values?: readonly unknown[]): Promise<SqlResult<R>> {
      const result = await client.query(text, values as unknown[] | undefined);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
  };
}

/**
 * Changes the verified RLS tenant inside an already-open transaction.
 * Installation bootstrap needs this after claiming its global idempotency row
 * and before inserting the newly generated tenant.
 */
export async function setTenantContext(sql: SqlExecutor, tenantId: string): Promise<void> {
  assertTenantContextId(tenantId);
  await sql.query('SELECT set_config($1, $2, true)', ['convo.tenant_id', tenantId]);
  const check = await sql.query<{ tenant: string | null }>(
    'SELECT app_current_tenant()::text AS tenant',
  );
  if (check.rows[0]?.tenant !== tenantId) {
    throw new TenantContextError('Tenant context did not take effect in this transaction');
  }
}

/** Enables access to installation-scoped rows for this transaction only. */
export async function enableInstallationContext(sql: SqlExecutor): Promise<void> {
  const check = await sql.query<{ installation_scope: string }>(
    'SELECT set_config($1, $2, true) AS installation_scope',
    ['convo.installation_scope', 'bootstrap'],
  );
  if (check.rows[0]?.installation_scope !== 'bootstrap') {
    throw new TenantContextError('Installation context did not take effect in this transaction');
  }
}
