import type { SqlExecutor, SqlResult, TenantTransaction } from '../ports/sql.js';

/**
 * A scripted `SqlExecutor` for domain unit tests.
 *
 * It exists so the ordering and branching rules of a service can be asserted
 * without a database -- specifically that the one-time bootstrap flag is
 * claimed before anything is written. The real SQL behaviour (RLS, composite
 * keys, the single-company trigger) is proven against a real PostgreSQL in
 * `tests/integration`, never here.
 */
export interface FakeSqlRule {
  readonly match: RegExp;
  readonly rows: readonly unknown[];
}

export interface RecordedCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface FakeSql extends SqlExecutor {
  readonly calls: readonly RecordedCall[];
}

export function fakeSql(rules: readonly FakeSqlRule[] = []): FakeSql {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async query<R>(text: string, values?: readonly unknown[]): Promise<SqlResult<R>> {
      calls.push({ text, values: values ?? [] });
      const rule = rules.find((candidate) => candidate.match.test(text));
      const rows = (rule?.rows ?? []) as R[];
      return await Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

export interface FakeTransaction {
  readonly run: TenantTransaction;
  readonly sql: FakeSql;
  readonly tenantIds: readonly string[];
}

export function fakeTransaction(rules: readonly FakeSqlRule[] = []): FakeTransaction {
  const sql = fakeSql(rules);
  const tenantIds: string[] = [];
  return {
    sql,
    tenantIds,
    run: <T>(tenantId: string, work: (executor: SqlExecutor) => Promise<T>): Promise<T> => {
      tenantIds.push(tenantId);
      return work(sql);
    },
  };
}
