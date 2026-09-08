import { Inject, Injectable } from '@nestjs/common';
import { enableInstallationContext, tenantTransaction } from '@convo/database';
import type { SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import { API_POOL } from '../tokens.js';

export interface StoredHttpResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

export type IdempotencyResult =
  | {
      readonly status: 'completed';
      readonly replayed: boolean;
      readonly response: StoredHttpResponse;
    }
  | { readonly status: 'conflict' };

export interface IdempotentCommand {
  readonly tenantContextId: string;
  readonly tenantId: string | null;
  readonly principalId: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
}

interface StoredRow {
  readonly request_hash: string;
  readonly state: 'pending' | 'completed';
  readonly response_status: number | null;
  readonly response_body: unknown;
}

@Injectable()
export class IdempotencyService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async execute(
    command: IdempotentCommand,
    work: (sql: SqlExecutor) => Promise<StoredHttpResponse>,
  ): Promise<IdempotencyResult> {
    return tenantTransaction(this.pool)(command.tenantContextId, async (sql) => {
      if (command.tenantId === null) {
        await enableInstallationContext(sql);
      }
      const inserted = await sql.query<{ request_hash: string }>(
        'INSERT INTO idempotency_records ' +
          '(tenant_id, principal_id, operation, idempotency_key, request_hash) ' +
          'VALUES ($1, $2, $3, $4, $5) ' +
          'ON CONFLICT (tenant_id, principal_id, operation, idempotency_key) ' +
          'DO NOTHING RETURNING request_hash',
        [
          command.tenantId,
          command.principalId,
          command.operation,
          command.key,
          command.requestHash,
        ],
      );

      if (inserted.rows.length > 0) {
        const response = await work(sql);
        const completed = await sql.query(
          'UPDATE idempotency_records ' +
            "SET state = 'completed', response_status = $5, response_body = $6::jsonb " +
            'WHERE tenant_id IS NOT DISTINCT FROM $1 AND principal_id = $2 ' +
            'AND operation = $3 AND idempotency_key = $4',
          [
            command.tenantId,
            command.principalId,
            command.operation,
            command.key,
            response.statusCode,
            JSON.stringify(response.body),
          ],
        );
        if (completed.rowCount !== 1) {
          throw new Error('Idempotency record disappeared before completion');
        }
        return { status: 'completed', replayed: false, response };
      }

      const selected = await sql.query<StoredRow>(
        'SELECT request_hash, state, response_status, response_body ' +
          'FROM idempotency_records ' +
          'WHERE tenant_id IS NOT DISTINCT FROM $1 AND principal_id = $2 ' +
          'AND operation = $3 AND idempotency_key = $4 FOR UPDATE',
        [command.tenantId, command.principalId, command.operation, command.key],
      );
      const row = selected.rows[0];
      if (row === undefined || row.state !== 'completed' || row.response_status === null) {
        throw new Error('Idempotency record is incomplete');
      }
      if (row.request_hash !== command.requestHash) {
        return { status: 'conflict' };
      }
      return {
        status: 'completed',
        replayed: true,
        response: { statusCode: row.response_status, body: row.response_body },
      };
    });
  }
}
