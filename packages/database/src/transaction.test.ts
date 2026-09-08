import { describe, expect, it } from 'vitest';
import type { PoolClient, QueryResult } from 'pg';
import { fakeSql } from '../../domain/src/testing/fake-sql.js';
import {
  asExecutor,
  enableInstallationContext,
  setTenantContext,
  tenantTransaction,
} from './transaction.js';
import { fakePool } from './testing/fake-pool.js';

const TENANT = '33333333-3333-4333-8333-333333333333';

function recordingClient(rows: Record<string, unknown>[]): {
  client: Pick<PoolClient, 'query'>;
  calls: Array<{ text: string; values: unknown }>;
} {
  const calls: Array<{ text: string; values: unknown }> = [];
  return {
    calls,
    client: {
      query: ((text: string, values?: unknown) => {
        calls.push({ text, values });
        return Promise.resolve({
          rows,
          rowCount: rows.length,
          command: 'SELECT',
          oid: 0,
          fields: [],
        } as QueryResult);
      }) as PoolClient['query'],
    },
  };
}

describe('asExecutor', () => {
  it('maps a driver result onto the narrow domain port', async () => {
    const { client, calls } = recordingClient([{ id: 'a' }]);
    const executor = asExecutor(client);

    const result = await executor.query<{ id: string }>('SELECT id FROM t WHERE k = $1', ['k']);

    expect(result).toEqual({ rows: [{ id: 'a' }], rowCount: 1 });
    expect(calls).toEqual([{ text: 'SELECT id FROM t WHERE k = $1', values: ['k'] }]);
  });

  it('passes no parameter array through when the caller supplied none', async () => {
    const { client, calls } = recordingClient([]);
    const result = await asExecutor(client).query('SELECT 1');

    expect(result).toEqual({ rows: [], rowCount: 0 });
    expect(calls[0]?.values).toBeUndefined();
  });
});

describe('tenantTransaction', () => {
  it('runs the domain work inside a verified tenant transaction', async () => {
    const fake = fakePool({ reportedTenant: TENANT });
    const run = tenantTransaction(fake.pool);

    const seen: string[] = [];
    const value = await run(TENANT, async (sql) => {
      await sql.query('SELECT 1');
      seen.push('work ran');
      return 'ok';
    });

    expect(value).toBe('ok');
    expect(seen).toEqual(['work ran']);
    expect(fake.queries[0]).toBe('BEGIN');
    expect(fake.queries).toContain('SELECT 1');
    expect(fake.queries.at(-1)).toBe('COMMIT');
  });

  it('propagates the tenant-context guard to domain callers', async () => {
    const fake = fakePool();
    await expect(tenantTransaction(fake.pool)('not-a-uuid', async () => await Promise.resolve(1))).rejects.toThrow(
      'Refusing to set a non-uuid tenant context',
    );
  });
});

describe('setTenantContext', () => {
  it('sets and verifies another tenant inside the current transaction', async () => {
    const sql = fakeSql([{ match: /app_current_tenant/, rows: [{ tenant: TENANT }] }]);
    await setTenantContext(sql, TENANT);
    expect(sql.calls.map((call) => call.text)).toEqual([
      'SELECT set_config($1, $2, true)',
      'SELECT app_current_tenant()::text AS tenant',
    ]);
  });

  it('fails closed when the switched context cannot be verified', async () => {
    await expect(setTenantContext(fakeSql(), TENANT)).rejects.toThrow(
      'Tenant context did not take effect in this transaction',
    );
  });
});

describe('enableInstallationContext', () => {
  it('enables and verifies the transaction-local installation scope', async () => {
    const sql = fakeSql([
      { match: /AS installation_scope/, rows: [{ installation_scope: 'bootstrap' }] },
    ]);
    await enableInstallationContext(sql);
    expect(sql.calls[0]?.values).toEqual(['convo.installation_scope', 'bootstrap']);
  });

  it('fails closed when the installation scope cannot be verified', async () => {
    await expect(enableInstallationContext(fakeSql())).rejects.toThrow(
      'Installation context did not take effect in this transaction',
    );
  });
});
