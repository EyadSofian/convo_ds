import type { Pool, PoolClient, QueryResult } from 'pg';

/**
 * A `pg`-shaped test double for the transaction-control paths of `withTenant`.
 *
 * Tenant isolation itself is never asserted here -- that needs real RLS and is
 * proven in `tests/integration/tenant-isolation.test.ts`. This double exists
 * for the failure paths a working database will not produce on demand: a
 * context that silently fails to take effect, and a ROLLBACK that throws while
 * another error is already in flight.
 */
export interface FakePoolOptions {
  /**
   * What `app_current_tenant()` reports. Omit it to make the function return no
   * row at all, which is what an unset context looks like.
   */
  readonly reportedTenant?: string;
  /** What the credential-scope setting reports after being set. */
  readonly reportedCredential?: string;
  readonly failOn?: { readonly match: RegExp; readonly error: Error };
}

export interface FakeQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface FakePool {
  readonly pool: Pool;
  readonly queries: readonly string[];
  /**
   * The same calls with their bound values. A setting name travels as a
   * parameter, so which context was opened is only visible here — and which
   * context was opened is the security-relevant fact.
   */
  readonly calls: readonly FakeQuery[];
  releaseCount(): number;
}

export function fakePool(options: FakePoolOptions = {}): FakePool {
  const queries: string[] = [];
  const calls: FakeQuery[] = [];
  let released = 0;
  const reported = options.reportedTenant;
  const reportedCredential = options.reportedCredential;
  const failOn = options.failOn;

  const client: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string, values?: readonly unknown[]): Promise<QueryResult> => {
      queries.push(text);
      calls.push({ text, values: values ?? [] });
      if (failOn !== undefined && failOn.match.test(text)) {
        return Promise.reject(failOn.error);
      }
      if (text.includes('app_current_tenant()')) {
        return Promise.resolve(result(reported === undefined ? [] : [{ tenant: reported }]));
      }
      // The credential-scope read-back, mirroring the tenant one above: omit
      // `reportedCredential` to make the setting look as if it never took. The
      // setting's name is a bound parameter now, so the shape of the query is
      // what identifies it rather than the name inside it.
      if (text.includes('current_setting(')) {
        return Promise.resolve(
          result(reportedCredential === undefined ? [] : [{ value: reportedCredential }]),
        );
      }
      return Promise.resolve(result([]));
    }) as PoolClient['query'],
    release: () => {
      released += 1;
    },
  };

  return {
    queries,
    calls,
    releaseCount: () => released,
    pool: {
      connect: () => Promise.resolve(client as PoolClient),
    } as unknown as Pool,
  };
}

function result(rows: readonly Record<string, unknown>[]): QueryResult {
  return {
    rows: rows as QueryResult['rows'],
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}
