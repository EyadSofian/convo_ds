import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { Pool } from 'pg';
import { API_POOL } from '../tokens.js';
import type { AuthenticatedSession } from '../auth/auth.service.js';

export interface MembershipSummary {
  readonly id: string;
  readonly tenant: { readonly id: string; readonly name: string; readonly slug: string };
  readonly role: { readonly id: string; readonly key: string; readonly name: string };
  /** Permission keys held by this role. Scope is still enforced by the server. */
  readonly permissions: readonly string[];
}

@Injectable()
export class MembershipService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async listActive(session: AuthenticatedSession): Promise<readonly MembershipSummary[]> {
    const index = await this.pool.query<{ tenant_id: string; membership_id: string }>(
      `SELECT tenant_id::text, membership_id::text
       FROM user_membership_index WHERE user_id = $1 ORDER BY tenant_id`,
      [session.userId],
    );
    const resolved = await Promise.all(
      index.rows.map((entry) =>
        withTenant(this.pool, entry.tenant_id, async (client) => {
          const row = await asExecutor(client).query<{
            membership_id: string;
            tenant_id: string;
            tenant_name: string;
            tenant_slug: string;
            role_id: string;
            role_key: string;
            role_name: string;
            permissions: string[];
          }>(
            `SELECT m.id::text AS membership_id, t.id::text AS tenant_id,
               t.name AS tenant_name, t.slug::text AS tenant_slug,
               r.id::text AS role_id, r.key AS role_key, r.name AS role_name,
               ARRAY(
                 SELECT rp.permission_key
                   FROM role_permissions rp
                  WHERE rp.tenant_id = m.tenant_id AND rp.role_id = m.role_id
                  ORDER BY rp.permission_key
               ) AS permissions
             FROM memberships m
             JOIN tenants t ON t.id = m.tenant_id
             JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
             WHERE m.id = $1 AND m.user_id = $2 AND m.status = 'active'
               AND t.status = 'active'`,
            [entry.membership_id, session.userId],
          );
          return row.rows[0] === undefined ? null : mapMembership(row.rows[0]);
        }),
      ),
    );
    return resolved.filter((item): item is MembershipSummary => item !== null);
  }
}

function mapMembership(row: {
  readonly membership_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly tenant_slug: string;
  readonly role_id: string;
  readonly role_key: string;
  readonly role_name: string;
  readonly permissions: readonly string[];
}): MembershipSummary {
  return {
    id: row.membership_id,
    tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.tenant_slug },
    role: { id: row.role_id, key: row.role_key, name: row.role_name },
    permissions: row.permissions,
  };
}
