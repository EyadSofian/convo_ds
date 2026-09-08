import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  IdempotencyService,
  type IdempotentCommand,
  type StoredHttpResponse,
} from './idempotency.service.js';

const TENANT = '44444444-4444-4444-8444-444444444444';
const COMMAND: IdempotentCommand = {
  tenantContextId: TENANT,
  tenantId: null,
  principalId: 'principal',
  operation: 'operation',
  key: 'key',
  requestHash: 'same-hash',
};
const RESPONSE: StoredHttpResponse = { statusCode: 201, body: { data: 'created' } };

interface Scenario {
  readonly inserted: boolean;
  readonly installationScope?: 'bootstrap' | 'wrong' | 'missing';
  readonly updateCount?: number;
  readonly stored?: {
    readonly request_hash: string;
    readonly state: 'pending' | 'completed';
    readonly response_status: number | null;
    readonly response_body: unknown;
  };
}

function poolFor(scenario: Scenario): Pool {
  const client = {
    query: (async (text: string): Promise<QueryResult> => {
      if (text.includes('app_current_tenant()')) {
        return result([{ tenant: TENANT }]);
      }
      if (text.includes('AS installation_scope')) {
        const scope = scenario.installationScope ?? 'bootstrap';
        return result(scope === 'missing' ? [] : [{ installation_scope: scope }]);
      }
      if (text.startsWith('INSERT INTO idempotency_records')) {
        return result(scenario.inserted ? [{ request_hash: 'same-hash' }] : []);
      }
      if (text.startsWith('UPDATE idempotency_records')) {
        return result([], scenario.updateCount ?? 1);
      }
      if (text.startsWith('SELECT request_hash')) {
        return result(scenario.stored === undefined ? [] : [scenario.stored]);
      }
      return result([]);
    }) as PoolClient['query'],
    release: vi.fn(),
  } as Pick<PoolClient, 'query' | 'release'>;
  return { connect: () => Promise.resolve(client as PoolClient) } as unknown as Pool;
}

function result(rows: readonly Record<string, unknown>[], rowCount = rows.length): QueryResult {
  return {
    rows: rows as QueryResult['rows'],
    rowCount,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

describe('IdempotencyService', () => {
  it('executes and stores the first command result', async () => {
    const work = vi.fn().mockResolvedValue(RESPONSE);
    const outcome = await new IdempotencyService(poolFor({ inserted: true })).execute(
      COMMAND,
      work,
    );
    expect(work).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ status: 'completed', replayed: false, response: RESPONSE });
  });

  it('refuses to commit if the claimed record disappeared', async () => {
    await expect(
      new IdempotencyService(poolFor({ inserted: true, updateCount: 0 })).execute(
        COMMAND,
        () => Promise.resolve(RESPONSE),
      ),
    ).rejects.toThrow('Idempotency record disappeared before completion');
  });

  it('fails closed when the installation idempotency scope is not verified', async () => {
    await expect(
      new IdempotencyService(
        poolFor({ inserted: true, installationScope: 'wrong' }),
      ).execute(COMMAND, () => Promise.resolve(RESPONSE)),
    ).rejects.toThrow('Installation context did not take effect in this transaction');
  });

  it('does not enable installation scope for a tenant-owned command', async () => {
    const command = { ...COMMAND, tenantId: TENANT };
    await expect(
      new IdempotencyService(
        poolFor({ inserted: true, installationScope: 'missing' }),
      ).execute(command, () => Promise.resolve(RESPONSE)),
    ).resolves.toMatchObject({ status: 'completed', replayed: false });
  });

  it('replays the completed stored response without executing work', async () => {
    const work = vi.fn().mockResolvedValue(RESPONSE);
    const stored = {
      request_hash: 'same-hash',
      state: 'completed' as const,
      response_status: 202,
      response_body: { data: 'stored' },
    };
    const outcome = await new IdempotencyService(poolFor({ inserted: false, stored })).execute(
      COMMAND,
      work,
    );
    expect(work).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'completed',
      replayed: true,
      response: { statusCode: 202, body: { data: 'stored' } },
    });
  });

  it('returns a conflict for the same key and another request hash', async () => {
    const stored = {
      request_hash: 'different-hash',
      state: 'completed' as const,
      response_status: 201,
      response_body: {},
    };
    await expect(
      new IdempotencyService(poolFor(stored === undefined ? { inserted: false } : { inserted: false, stored })).execute(
        COMMAND,
        () => Promise.resolve(RESPONSE),
      ),
    ).resolves.toEqual({ status: 'conflict' });
  });

  it.each([
    ['missing', undefined],
    [
      'pending',
      {
        request_hash: 'same-hash',
        state: 'pending' as const,
        response_status: null,
        response_body: null,
      },
    ],
    [
      'missing status',
      {
        request_hash: 'same-hash',
        state: 'completed' as const,
        response_status: null,
        response_body: {},
      },
    ],
  ])('fails closed for an incomplete %s record', async (_label, stored) => {
    await expect(
      new IdempotencyService(
        poolFor(stored === undefined ? { inserted: false } : { inserted: false, stored }),
      ).execute(
        COMMAND,
        () => Promise.resolve(RESPONSE),
      ),
    ).rejects.toThrow('Idempotency record is incomplete');
  });
});
