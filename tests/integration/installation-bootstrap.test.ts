import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapInstallation } from '../../packages/domain/src/installation/bootstrap.js';
import {
  applyInstallationConfig,
  readBootstrapState,
} from '../../packages/domain/src/installation/state.js';
import { asExecutor, tenantTransaction } from '../../packages/database/src/transaction.js';
import { withTenant } from '../../packages/database/src/context.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  createScratchDatabase,
  migrateScratch,
  scratchMigrationPool,
  scratchRuntimePool,
} from '../support/scratch.js';

const OWNER_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaGVkcGFzc3dvcmQ';

interface Installation {
  readonly names: DatabaseNames;
  readonly pool: Pool;
}

async function freshInstallation(prefix: string, max = 4): Promise<Installation> {
  const names = await createScratchDatabase(prefix);
  await migrateScratch(names);
  return { names, pool: scratchRuntimePool(names, max) };
}

function deps(pool: Pool): { transaction: ReturnType<typeof tenantTransaction>; newId: () => string } {
  return { transaction: tenantTransaction(pool), newId: () => randomUUID() };
}

describe('one-time installation bootstrap (MODE-03)', () => {
  let install: Installation;

  beforeAll(async () => {
    install = await freshInstallation('convo_selfhosted');
    const applied = await applyInstallationConfig(asExecutor(install.pool), 'self_hosted_single');
    expect(applied).toEqual({ status: 'created', deploymentMode: 'self_hosted_single' });
  }, 180_000);

  afterAll(async () => {
    await install.pool.end();
  });

  it('refuses to bootstrap before any configuration row exists', async () => {
    const unconfigured = await freshInstallation('convo_unconfigured', 2);
    try {
      const result = await bootstrapInstallation(deps(unconfigured.pool), {
        companyName: 'Nowhere',
        companySlug: 'nowhere',
        ownerEmail: 'owner@nowhere.example',
        ownerPasswordHash: OWNER_HASH,
      });
      expect(result).toMatchObject({ status: 'rejected', code: 'installation_not_configured' });
    } finally {
      await unconfigured.pool.end();
    }
  }, 180_000);

  it('creates exactly one company, one Owner, and the whole permission catalogue', async () => {
    const result = await bootstrapInstallation(deps(install.pool), {
      companyName: 'Acme Support',
      companySlug: 'acme',
      ownerEmail: 'owner@acme.example',
      ownerPasswordHash: OWNER_HASH,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') {
      throw new Error('unreachable');
    }

    const tenants = await install.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tenants',
    );
    // Read outside any tenant context: RLS returns nothing, which is the
    // default-deny behaviour, so counting happens inside the context below.
    expect(tenants.rows[0]?.count).toBe('0');

    await withTenant(install.pool, result.tenantId, async (client) => {
      const tenant = await client.query<{ name: string; slug: string; status: string }>(
        'SELECT name, slug, status FROM tenants',
      );
      expect(tenant.rows).toEqual([{ name: 'Acme Support', slug: 'acme', status: 'active' }]);

      const role = await client.query<{ key: string; is_builtin: boolean }>(
        'SELECT key, is_builtin FROM roles',
      );
      expect(role.rows).toEqual([{ key: 'owner', is_builtin: true }]);

      const granted = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM role_permissions WHERE role_id = $1',
        [result.ownerRoleId],
      );
      const catalogue = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM permissions',
      );
      expect(granted.rows[0]?.count).toBe(catalogue.rows[0]?.count);
      expect(Number(catalogue.rows[0]?.count)).toBeGreaterThan(0);

      const membership = await client.query<{ user_id: string; role_id: string; status: string }>(
        'SELECT user_id, role_id, status FROM memberships',
      );
      expect(membership.rows).toEqual([
        { user_id: result.ownerUserId, role_id: result.ownerRoleId, status: 'active' },
      ]);

      const scope = await client.query<{ scope_type: string; scope_id: string | null }>(
        'SELECT scope_type, scope_id FROM membership_scopes',
      );
      expect(scope.rows).toEqual([{ scope_type: 'tenant', scope_id: null }]);
    });

    const owner = await install.pool.query<{ email: string; password_hash: string }>(
      'SELECT email, password_hash FROM users WHERE id = $1',
      [result.ownerUserId],
    );
    expect(owner.rows[0]?.email).toBe('owner@acme.example');
    expect(owner.rows[0]?.password_hash).toBe(OWNER_HASH);
  }, 60_000);

  it('disables itself: the flag is consumed and the company is recorded', async () => {
    await expect(readBootstrapState(asExecutor(install.pool))).resolves.toBe('completed');

    const recorded = await install.pool.query<{ single_tenant_id: string | null }>(
      'SELECT single_tenant_id FROM installations WHERE singleton IS TRUE',
    );
    expect(recorded.rows[0]?.single_tenant_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('treats a second bootstrap as a harmless typed rejection, not a second company', async () => {
    const second = await bootstrapInstallation(deps(install.pool), {
      companyName: 'Acme Again',
      companySlug: 'acme-again',
      ownerEmail: 'other@acme.example',
      ownerPasswordHash: OWNER_HASH,
    });

    expect(second).toEqual({
      status: 'rejected',
      code: 'installation_already_bootstrapped',
      message: 'This installation has already been bootstrapped.',
      details: [],
    });

    const users = await install.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM users',
    );
    expect(users.rows[0]?.count).toBe('1');
  });

  /**
   * Two replicas booting at once, or an operator double-submitting the first-run
   * form. Exactly one may win, and the loser must not leave a half-built
   * company behind.
   */
  it('lets exactly one of two concurrent bootstraps win', async () => {
    const racing = await freshInstallation('convo_race');
    try {
      await applyInstallationConfig(asExecutor(racing.pool), 'self_hosted_single');

      const attempt = (slug: string): ReturnType<typeof bootstrapInstallation> =>
        bootstrapInstallation(deps(racing.pool), {
          companyName: `Company ${slug}`,
          companySlug: slug,
          ownerEmail: `owner-${slug}@example.test`,
          ownerPasswordHash: OWNER_HASH,
        });

      const results = await Promise.all([attempt('first'), attempt('second')]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual(['created', 'rejected']);

      const tenants = await racing.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM installations WHERE single_tenant_id IS NOT NULL',
      );
      expect(tenants.rows[0]?.count).toBe('1');

      const users = await racing.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM users',
      );
      expect(users.rows[0]?.count).toBe('1');
    } finally {
      await racing.pool.end();
    }
  }, 180_000);

  it('leaves the flag unclaimed when the write fails, so the operator can retry', async () => {
    const retry = await freshInstallation('convo_retry', 2);
    try {
      await applyInstallationConfig(asExecutor(retry.pool), 'self_hosted_single');
      // Someone already holds the address the operator typed.
      await retry.pool.query('INSERT INTO users (email) VALUES ($1)', ['taken@example.test']);

      await expect(
        bootstrapInstallation(deps(retry.pool), {
          companyName: 'Retry Co',
          companySlug: 'retry',
          ownerEmail: 'taken@example.test',
          ownerPasswordHash: OWNER_HASH,
        }),
      ).rejects.toThrow(/duplicate key value/);

      await expect(readBootstrapState(asExecutor(retry.pool))).resolves.toBe('pending');
      const tenants = await retry.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM installations WHERE single_tenant_id IS NOT NULL',
      );
      expect(tenants.rows[0]?.count).toBe('0');
    } finally {
      await retry.pool.end();
    }
  }, 180_000);
});

describe('single-company enforcement (MODE-04)', () => {
  let install: Installation;

  beforeAll(async () => {
    install = await freshInstallation('convo_single');
    await applyInstallationConfig(asExecutor(install.pool), 'self_hosted_single');
    const created = await bootstrapInstallation(deps(install.pool), {
      companyName: 'Only Company',
      companySlug: 'only',
      ownerEmail: 'owner@only.example',
      ownerPasswordHash: OWNER_HASH,
    });
    expect(created.status).toBe('created');
  }, 180_000);

  afterAll(async () => {
    await install.pool.end();
  });

  /**
   * "By any path" has to mean the database, not the service layer: a support
   * script, a replayed job or an endpoint written in a later phase all sit
   * above this constraint.
   */
  it('rejects a second company inserted directly by the runtime role', async () => {
    const second = randomUUID();
    await expect(
      withTenant(install.pool, second, async (client) => {
        await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
          second,
          'Sneaky',
          'sneaky',
        ]);
      }),
    ).rejects.toThrow(/single-company installation already holds company/);
  });

  it('rejects a second company inserted by the schema-owning migration role', async () => {
    const ownerPool = scratchMigrationPool(install.names);
    try {
      const second = randomUUID();
      await expect(
        withTenant(ownerPool, second, async (client) => {
          await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
            second,
            'Owner Path',
            'owner-path',
          ]);
        }),
      ).rejects.toThrow(/single-company installation already holds company/);
    } finally {
      await ownerPool.end();
    }
  });

  it('still holds exactly one company afterwards', async () => {
    const held = await install.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM installations WHERE single_tenant_id IS NOT NULL',
    );
    expect(held.rows[0]?.count).toBe('1');
  });

  it('refuses any company at all when no installation row has been applied', async () => {
    const bare = await freshInstallation('convo_bare', 2);
    try {
      const id = randomUUID();
      await expect(
        withTenant(bare.pool, id, async (client) => {
          await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
            id,
            'No Config',
            'no-config',
          ]);
        }),
      ).rejects.toThrow(/boot configuration has not been applied/);
    } finally {
      await bare.pool.end();
    }
  }, 180_000);
});

describe('SaaS mode keeps multiple companies legal', () => {
  let install: Installation;

  beforeAll(async () => {
    install = await freshInstallation('convo_saas');
    await applyInstallationConfig(asExecutor(install.pool), 'saas');
  }, 180_000);

  afterAll(async () => {
    await install.pool.end();
  });

  it('allows a second company and never claims a single tenant', async () => {
    const first = await bootstrapInstallation(deps(install.pool), {
      companyName: 'First Co',
      companySlug: 'first-co',
      ownerEmail: 'owner@first.example',
      ownerPasswordHash: OWNER_HASH,
    });
    expect(first.status).toBe('created');

    const second = randomUUID();
    await withTenant(install.pool, second, async (client) => {
      await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        second,
        'Second Co',
        'second-co',
      ]);
    });

    const claimed = await install.pool.query<{ single_tenant_id: string | null }>(
      'SELECT single_tenant_id FROM installations WHERE singleton IS TRUE',
    );
    expect(claimed.rows[0]?.single_tenant_id).toBeNull();
  }, 60_000);

  it('refuses to boot the same data as a different deployment mode', async () => {
    const result = await applyInstallationConfig(asExecutor(install.pool), 'self_hosted_single');
    expect(result).toMatchObject({
      status: 'mismatch',
      code: 'installation_mode_mismatch',
      configured: 'self_hosted_single',
      recorded: 'saas',
    });
  });

  it('is a no-op when the configured mode already matches', async () => {
    const result = await applyInstallationConfig(asExecutor(install.pool), 'saas');
    expect(result).toMatchObject({ status: 'unchanged', deploymentMode: 'saas' });
  });
});
