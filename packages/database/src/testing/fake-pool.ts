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
  readonly failOn?: { readonly match: RegExp; readonly error: Error };
}

export interface FakePool {
  readonly pool: Pool;
  readonly queries: readonly string[];
  releaseCount(): number;
}

export function fakePool(options: FakePoolOptions = {}): FakePool {
  const queries: string[] = [];
  let released = 0;
  const reported = options.reportedTenant;
  const failOn = options.failOn;

  const client: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string): Promise<QueryResult> => {
      queries.push(text);
      if (failOn !== undefined && failOn.match.test(text)) {
        return Promise.reject(failOn.error);
      }
      if (text.includes('app_current_tenant()')) {
        return Promise.resolve(result(reported === undefined ? [] : [{ tenant: reported }]));
      }
      return Promise.resolve(result([]));
    }) as PoolClient['query'],
    release: () => {
      released += 1;
    },
  };

  return {
    queries,
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
