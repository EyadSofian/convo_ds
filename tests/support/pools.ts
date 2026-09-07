import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '../../packages/database/src/context.js';
import { NAMES } from './cluster.js';

function connection(): { host: string; port: number } {
  const host = process.env['CONVO_TEST_PG_HOST'];
  const port = process.env['CONVO_TEST_PG_PORT'];
  if (host === undefined || port === undefined) {
    throw new Error('Integration cluster env is missing; global setup did not run.');
  }
  return { host, port: Number(port) };
}

/** Connects as the runtime role: no ownership, no superuser, no BYPASSRLS. */
export function runtimePool(max = 2): Pool {
  const { host, port } = connection();
  return new Pool({
    host,
    port,
    database: NAMES.database,
    user: NAMES.runtimeRole,
    password: NAMES.runtimePassword,
    max,
  });
}

/** Connects as the migration role. Only for schema assertions, never runtime. */
export function migrationPool(max = 1): Pool {
  const { host, port } = connection();
  return new Pool({
    host,
    port,
    database: NAMES.database,
    user: NAMES.migrationRole,
    password: NAMES.migrationPassword,
    max,
  });
}

export interface SeededTenant {
  readonly tenantId: string;
  readonly ownerRoleId: string;
  readonly ownerMembershipId: string;
  readonly ownerUserId: string;
}

/**
 * Seeds one tenant through the runtime role and the RLS path.
 *
 * The tenant id is generated before the insert so the transaction can set its
 * own tenant context first. That is not a test trick: it is how provisioning
 * has to work when `tenants` itself is under RLS with a WITH CHECK clause, and
 * it keeps the seed honest -- nothing here bypasses a policy.
 */
export async function seedTenant(pool: Pool, slug: string): Promise<SeededTenant> {
  const tenantId = randomUUID();
  const userId = randomUUID();

  // `users` is global identity, outside tenant RLS.
  await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
    userId,
    `owner+${slug}@example.test`,
  ]);

  return withTenant(pool, tenantId, async (client) => {
    await client.query('INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, $4)', [
      tenantId,
      `Tenant ${slug}`,
      slug,
      'active',
    ]);

    const role = await client.query<{ id: string }>(
      `INSERT INTO roles (tenant_id, key, name, is_builtin)
       VALUES ($1, 'owner', 'Owner', true) RETURNING id`,
      [tenantId],
    );
    const ownerRoleId = role.rows[0]!.id;

    await client.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_key)
       SELECT $1, $2, key FROM permissions`,
      [tenantId, ownerRoleId],
    );

    const membership = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, userId, ownerRoleId],
    );

    return {
      tenantId,
      ownerRoleId,
      ownerMembershipId: membership.rows[0]!.id,
      ownerUserId: userId,
    };
  });
}
