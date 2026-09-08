import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { Pool } from 'pg';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { API_POOL } from '../tokens.js';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface PermissionDescriptor {
  readonly key: string;
  readonly description: string;
  readonly delegable: boolean;
}

@Injectable()
export class PermissionService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async listCatalogue(
    session: AuthenticatedSession,
    tenantId: string,
  ): Promise<readonly PermissionDescriptor[]> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw resourceNotFound();
    }
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const membership = await sql.query<{ role_id: string }>(
        `SELECT m.role_id::text
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'`,
        [session.userId],
      );
      const roleId = membership.rows[0]?.role_id;
      if (roleId === undefined) {
        throw resourceNotFound();
      }
      const allowed = await sql.query<{ allowed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM role_permissions
           WHERE role_id = $1 AND permission_key = 'role.manage'
         ) AS allowed`,
        [roleId],
      );
      if (allowed.rows[0]?.allowed !== true) {
        throw new ApiHttpError(
          403,
          'permission_denied',
          'You do not have permission to perform this action.',
        );
      }
      const permissions = await sql.query<PermissionDescriptor>(
        'SELECT key, description, delegable FROM permissions ORDER BY key',
      );
      return permissions.rows;
    });
  }
}

function resourceNotFound(): ApiHttpError {
  return new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
}
