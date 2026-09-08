import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { errorEnvelope, describeInstance, type ErrorDetail, type InstanceDescriptor } from '@convo/contracts';
import {
  bootstrapInstallation,
  readBootstrapState,
  type InstallationBootstrapResult,
} from '@convo/domain';
import { asExecutor, setTenantContext } from '@convo/database';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requestHash, type JsonValue } from '../idempotency/canonical-json.js';
import {
  IdempotencyService,
  type StoredHttpResponse,
} from '../idempotency/idempotency.service.js';
import { API_CONFIG, API_POOL, PASSWORD_HASHER, type PasswordHasher } from '../tokens.js';
import { bootstrapTokenMatches } from './bootstrap-token.js';
import { parseBootstrapRequest, parseIdempotencyKey } from './bootstrap-request.js';

const BOOTSTRAP_PRINCIPAL = 'preauth:installation';
const BOOTSTRAP_OPERATION = 'instance.bootstrap.v1';
export const INSTALLATION_IDEMPOTENCY_CONTEXT_ID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class InstanceService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async describe(): Promise<InstanceDescriptor> {
    const state = await readBootstrapState(asExecutor(this.pool));
    return describeInstance({
      ...this.config,
      bootstrapRequired: state === 'pending',
    });
  }

  async bootstrap(
    body: unknown,
    rawBootstrapToken: string | string[] | undefined,
    rawIdempotencyKey: string | string[] | undefined,
    requestId: string,
  ): Promise<StoredHttpResponse> {
    if (!bootstrapTokenMatches(rawBootstrapToken, this.config.secrets.bootstrapToken)) {
      throw new ApiHttpError(
        401,
        'bootstrap_authentication_failed',
        'Bootstrap credentials are not valid.',
      );
    }
    let key: string;
    try {
      key = parseIdempotencyKey(rawIdempotencyKey);
    } catch {
      throw new ApiHttpError(
        400,
        'invalid_idempotency_key',
        'A printable Idempotency-Key of 1-200 characters is required.',
      );
    }

    const parsed = parseBootstrapRequest(body);
    const tenantId = randomUUID();
    const ownerUserId = randomUUID();
    const outcome = await this.idempotency.execute(
      {
        tenantContextId: INSTALLATION_IDEMPOTENCY_CONTEXT_ID,
        tenantId: null,
        principalId: BOOTSTRAP_PRINCIPAL,
        operation: BOOTSTRAP_OPERATION,
        key,
        requestHash: requestHash(body as JsonValue, this.config.secrets.idempotencyHash),
      },
      async (sql) => {
        if (parsed.status === 'invalid') {
          return rejectionResponse(
            400,
            'invalid_input',
            'The installation bootstrap request is not valid.',
            requestId,
            parsed.details,
          );
        }
        const passwordHash = await this.passwordHasher.hash(parsed.value.ownerPassword);
        const ids = [tenantId, ownerUserId] as const;
        let idIndex = 0;
        const result = await bootstrapInstallation(
          {
            newId: () => ids[idIndex++] as string,
            transaction: async (requestedTenantId, work) => {
              await setTenantContext(sql, requestedTenantId);
              return work(sql);
            },
          },
          {
            companyName: parsed.value.companyName,
            companySlug: parsed.value.companySlug,
            ownerEmail: parsed.value.ownerEmail,
            ownerPasswordHash: passwordHash,
          },
        );
        return mapBootstrapResult(result, requestId);
      },
    );

    if (outcome.status === 'conflict') {
      return rejectionResponse(
        409,
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
        requestId,
        [],
      );
    }
    return outcome.response;
  }
}

function mapBootstrapResult(
  result: InstallationBootstrapResult,
  requestId: string,
): StoredHttpResponse {
  if (result.status === 'created') {
    return {
      statusCode: 201,
      body: {
        data: {
          tenantId: result.tenantId,
          ownerUserId: result.ownerUserId,
          ownerRoleId: result.ownerRoleId,
          membershipId: result.membershipId,
        },
        request_id: requestId,
      },
    };
  }
  const statusCode =
    result.code === 'invalid_input'
      ? 400
      : result.code === 'installation_already_bootstrapped'
        ? 409
        : 503;
  return rejectionResponse(statusCode, result.code, result.message, requestId, result.details);
}

function rejectionResponse(
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
  details: readonly ErrorDetail[],
): StoredHttpResponse {
  return {
    statusCode,
    body: { error: errorEnvelope(code, message, { requestId, details }) },
  };
}

export function responseRequestId(response: StoredHttpResponse): string {
  const body = response.body as {
    readonly request_id?: string;
    readonly error?: { readonly request_id?: string | null };
  };
  return body.request_id ?? body.error?.request_id ?? randomUUID();
}
