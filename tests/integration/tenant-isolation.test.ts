import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { runtimePool, seedTenant, type SeededTenant } from '../support/pools.js';
import { withTenant } from '../../packages/database/src/context.js';

/**
 * TEN-02, TEN-03, TEN-05, SEC-01. Two tenants exist for the whole suite,
 * because an isolation test with a single tenant proves nothing.
 */
describe('tenant isolation', () => {
  let pool: Pool;
  let alpha: SeededTenant;
  let beta: SeededTenant;

  beforeAll(async () => {
    pool = runtimePool(4);
    alpha = await seedTenant(pool, `alpha-${randomUUID().slice(0, 8)}`);
    beta = await seedTenant(pool, `beta-${randomUUID().slice(0, 8)}`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns no rows at all without a tenant context', async () => {
    // Deliberately not using withTenant: this is the "someone forgot" case.
    const tenants = await pool.query('SELECT id FROM tenants');
    const memberships = await pool.query('SELECT id FROM memberships');
    const roles = await pool.query('SELECT id FROM roles');

    expect(tenants.rowCount).toBe(0);
    expect(memberships.rowCount).toBe(0);
    expect(roles.rowCount).toBe(0);
  });

  it('shows a tenant only its own rows', async () => {
    const seen = await withTenant(pool, alpha.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM tenants');
      return rows.map((r) => r.id);
    });

    expect(seen).toEqual([alpha.tenantId]);
    expect(seen).not.toContain(beta.tenantId);
  });

  it('hides another tenant even when its exact id is known', async () => {
    const found = await withTenant(pool, alpha.tenantId, async (client) => {
      const byId = await client.query('SELECT id FROM tenants WHERE id = $1', [beta.tenantId]);
      const membership = await client.query('SELECT id FROM memberships WHERE id = $1', [
        beta.ownerMembershipId,
      ]);
      const role = await client.query('SELECT id FROM roles WHERE id = $1', [beta.ownerRoleId]);
      return {
        tenant: byId.rowCount,
        membership: membership.rowCount,
        role: role.rowCount,
      };
    });

    // Guessing an id must not widen scope: the row simply does not exist here.
    expect(found).toEqual({ tenant: 0, membership: 0, role: 0 });
  });

  it('refuses a write that would place a row in another tenant', async () => {
    await expect(
      withTenant(pool, alpha.tenantId, async (client) => {
        await client.query(
          `INSERT INTO teams (tenant_id, name) VALUES ($1, 'smuggled')`,
          [beta.tenantId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses an update that would move a row into another tenant', async () => {
    const teamId = await withTenant(pool, alpha.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO teams (tenant_id, name) VALUES ($1, 'support') RETURNING id`,
        [alpha.tenantId],
      );
      return rows[0]!.id;
    });

    await expect(
      withTenant(pool, alpha.tenantId, async (client) => {
        await client.query('UPDATE teams SET tenant_id = $1 WHERE id = $2', [beta.tenantId, teamId]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot delete another tenant rows even by id', async () => {
    const deleted = await withTenant(pool, alpha.tenantId, async (client) => {
      const result = await client.query('DELETE FROM memberships WHERE id = $1', [
        beta.ownerMembershipId,
      ]);
      return result.rowCount;
    });

    expect(deleted).toBe(0);

    const stillThere = await withTenant(pool, beta.tenantId, async (client) => {
      const { rowCount } = await client.query('SELECT id FROM memberships WHERE id = $1', [
        beta.ownerMembershipId,
      ]);
      return rowCount;
    });

    expect(stillThere).toBe(1);
  });

  it('does not leak tenant context across pooled checkouts', async () => {
    // One connection, reused. SET LOCAL must not survive the commit.
    const single = runtimePool(1);
    try {
      await withTenant(single, alpha.tenantId, async (client) => {
        const { rowCount } = await client.query('SELECT id FROM tenants');
        expect(rowCount).toBe(1);
      });

      const afterRelease = await single.query('SELECT app_current_tenant() AS tenant');
      expect(afterRelease.rows[0]?.tenant).toBeNull();

      const leaked = await single.query('SELECT id FROM tenants');
      expect(leaked.rowCount).toBe(0);
    } finally {
      await single.end();
    }
  });

  it('rejects a cross-tenant relationship at the composite foreign key', async () => {
    // Membership in alpha pointing at a role that belongs to beta. Even with
    // both tenant contexts satisfied for their own rows, the composite key
    // makes the relationship unrepresentable.
    const userId = randomUUID();
    await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `cross+${userId}@example.test`,
    ]);

    await expect(
      withTenant(pool, alpha.tenantId, async (client) => {
        await client.query(
          'INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3)',
          [alpha.tenantId, userId, beta.ownerRoleId],
        );
      }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it('allows one identity to hold memberships in two tenants', async () => {
    // The SaaS case: global identity, tenant-scoped everything else.
    const userId = randomUUID();
    await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `shared+${userId}@example.test`,
    ]);

    for (const tenant of [alpha, beta]) {
      await withTenant(pool, tenant.tenantId, async (client) => {
        await client.query(
          'INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3)',
          [tenant.tenantId, userId, tenant.ownerRoleId],
        );
      });
    }

    const alphaCount = await withTenant(pool, alpha.tenantId, async (client) => {
      const { rowCount } = await client.query('SELECT id FROM memberships WHERE user_id = $1', [
        userId,
      ]);
      return rowCount;
    });

    expect(alphaCount).toBe(1);
  });

  it('refuses to set a tenant context that is not a uuid', async () => {
    await expect(
      withTenant(pool, "' OR 1=1 --", async () => undefined),
    ).rejects.toThrow(/non-uuid tenant context/i);
  });
});
