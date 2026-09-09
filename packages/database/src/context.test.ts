import { describe, expect, it } from 'vitest';
import { TenantContextError, withCredentialResolvedTenant, withTenant } from './context.js';
import { fakePool } from './testing/fake-pool.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('withTenant', () => {
  it('opens a transaction, sets the context, verifies it, then commits', async () => {
    const fake = fakePool({ reportedTenant: TENANT });
    const result = await withTenant(fake.pool, TENANT, async () => await Promise.resolve('done'));

    expect(result).toBe('done');
    expect(fake.queries[0]).toBe('BEGIN');
    expect(fake.queries[1]).toContain('set_config');
    expect(fake.queries[2]).toContain('app_current_tenant()');
    expect(fake.queries.at(-1)).toBe('COMMIT');
    expect(fake.releaseCount()).toBe(1);
  });

  it.each([
    ["' OR 1=1 --", "' OR 1=1 --"],
    ['a bare word', 'tenant-one'],
    ['an empty string', ''],
    ['a uuid with a trailing character', `${TENANT}x`],
    ['a truncated uuid', TENANT.slice(0, 35)],
  ])('refuses %s before it reaches SQL', async (_label, value) => {
    const fake = fakePool();
    await expect(withTenant(fake.pool, value, async () => await Promise.resolve(1))).rejects.toThrow(
      TenantContextError,
    );
    // Nothing was even checked out of the pool.
    expect(fake.queries).toEqual([]);
    expect(fake.releaseCount()).toBe(0);
  });

  /**
   * The read-back is the assertion that turns "we sent a SET" into "the
   * database agrees" (TEN-05). If it ever stopped matching, running the caller's
   * work anyway would execute it with the wrong -- or no -- tenant context.
   */
  it('aborts without running the work when the database reports a different tenant', async () => {
    const fake = fakePool({ reportedTenant: '22222222-2222-4222-8222-222222222222' });
    let ran = false;
    await expect(
      withTenant(fake.pool, TENANT, async () => {
        ran = true;
        return await Promise.resolve(1);
      }),
    ).rejects.toThrow('Tenant context did not take effect in this transaction');

    expect(ran).toBe(false);
    expect(fake.queries).toContain('ROLLBACK');
    expect(fake.queries).not.toContain('COMMIT');
    expect(fake.releaseCount()).toBe(1);
  });

  it('aborts when the context query returns no row at all', async () => {
    const fake = fakePool();
    await expect(
      withTenant(fake.pool, TENANT, async () => await Promise.resolve(1)),
    ).rejects.toThrow(TenantContextError);
    expect(fake.queries).toContain('ROLLBACK');
  });

  it('rolls back and rethrows when the caller work fails', async () => {
    const fake = fakePool({ reportedTenant: TENANT });
    const failure = new Error('duplicate key value violates unique constraint');
    await expect(withTenant(fake.pool, TENANT, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(fake.queries).toContain('ROLLBACK');
    expect(fake.queries).not.toContain('COMMIT');
    expect(fake.releaseCount()).toBe(1);
  });

  /**
   * A dead connection makes ROLLBACK throw too. The original failure is the one
   * worth reporting; swallowing it in favour of the cleanup error would hide
   * the actual cause and still leak the connection.
   */
  it('reports the original failure even when the rollback itself fails', async () => {
    const fake = fakePool({
      reportedTenant: TENANT,
      failOn: { match: /ROLLBACK/, error: new Error('Connection terminated unexpectedly') },
    });
    const failure = new Error('the real problem');
    await expect(withTenant(fake.pool, TENANT, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(fake.releaseCount()).toBe(1);
  });

  it('releases the connection even when COMMIT fails', async () => {
    const fake = fakePool({
      reportedTenant: TENANT,
      failOn: { match: /^COMMIT$/, error: new Error('commit failed') },
    });
    await expect(
      withTenant(fake.pool, TENANT, async () => await Promise.resolve(1)),
    ).rejects.toThrow('commit failed');
    expect(fake.releaseCount()).toBe(1);
  });
});

describe('withCredentialResolvedTenant', () => {
  const HASH = 'a'.repeat(64);

  it('sets the credential scope, resolves the tenant, then enters it', async () => {
    const fake = fakePool({ reportedTenant: TENANT, reportedCredential: HASH });
    const result = await withCredentialResolvedTenant(
      fake.pool,
      HASH,
      async () => await Promise.resolve({ tenantId: TENANT, value: 'the row' }),
      async (_client, resolved) =>
        await Promise.resolve(`worked in ${resolved.tenantId} with ${resolved.value}`),
    );

    expect(result).toBe(`worked in ${TENANT} with the row`);
    expect(fake.queries[0]).toBe('BEGIN');
    // The setting name travels as a bound parameter, so only the read-back
    // query names it. Both happen before anything is resolved.
    expect(fake.queries[1]).toBe('SELECT set_config($1, $2, true)');
    expect(fake.queries[2]).toContain('convo.credential_hash');
    // The tenant context is entered afterwards, and verified in its turn.
    expect(fake.queries.some((text) => text.includes('app_current_tenant()'))).toBe(true);
    expect(fake.queries.at(-1)).toBe('COMMIT');
    expect(fake.releaseCount()).toBe(1);
  });

  it.each([
    ['an empty string', ''],
    ['a short hex string', 'abc'],
    ['uppercase hex', 'A'.repeat(64)],
    ['a uuid', TENANT],
    ['a 63-character hash', 'a'.repeat(63)],
  ])('refuses %s before it reaches SQL', async (_label, value) => {
    const fake = fakePool();
    await expect(
      withCredentialResolvedTenant(
        fake.pool,
        value,
        async () => await Promise.resolve({ tenantId: TENANT, value: null }),
        async () => await Promise.resolve(1),
      ),
    ).rejects.toThrow(TenantContextError);
    expect(fake.queries).toEqual([]);
    expect(fake.releaseCount()).toBe(0);
  });

  /**
   * The same argument as the tenant read-back: a scope that did not take effect
   * would leave the policy carve-out closed, and running the resolver anyway
   * would silently look at nothing.
   */
  it('aborts when the credential scope does not take effect', async () => {
    const fake = fakePool({ reportedTenant: TENANT });
    let resolved = false;
    await expect(
      withCredentialResolvedTenant(
        fake.pool,
        HASH,
        async () => {
          resolved = true;
          return await Promise.resolve({ tenantId: TENANT, value: null });
        },
        async () => await Promise.resolve(1),
      ),
    ).rejects.toThrow('Credential context did not take effect in this transaction');
    expect(resolved).toBe(false);
    expect(fake.queries).toContain('ROLLBACK');
    expect(fake.releaseCount()).toBe(1);
  });

  it('commits without entering any tenant when nothing resolves', async () => {
    const fake = fakePool({ reportedCredential: HASH });
    let ran = false;
    const result = await withCredentialResolvedTenant(
      fake.pool,
      HASH,
      async () => await Promise.resolve(null),
      async () => {
        ran = true;
        return await Promise.resolve(1);
      },
    );
    // Null, not an exception: an unknown credential must be indistinguishable
    // from a dead one, and neither opens a tenant context.
    expect(result).toBeNull();
    expect(ran).toBe(false);
    expect(fake.queries.some((text) => text.includes('app_current_tenant()'))).toBe(false);
    expect(fake.queries.at(-1)).toBe('COMMIT');
  });

  it('refuses a resolved tenant that is not a uuid', async () => {
    const fake = fakePool({ reportedCredential: HASH });
    await expect(
      withCredentialResolvedTenant(
        fake.pool,
        HASH,
        async () => await Promise.resolve({ tenantId: 'not-a-uuid', value: null }),
        async () => await Promise.resolve(1),
      ),
    ).rejects.toThrow(TenantContextError);
    expect(fake.queries).toContain('ROLLBACK');
  });

  it('aborts when the tenant context does not take effect', async () => {
    const fake = fakePool({
      reportedCredential: HASH,
      reportedTenant: '22222222-2222-4222-8222-222222222222',
    });
    let ran = false;
    await expect(
      withCredentialResolvedTenant(
        fake.pool,
        HASH,
        async () => await Promise.resolve({ tenantId: TENANT, value: null }),
        async () => {
          ran = true;
          return await Promise.resolve(1);
        },
      ),
    ).rejects.toThrow('Tenant context did not take effect in this transaction');
    expect(ran).toBe(false);
    expect(fake.queries).not.toContain('COMMIT');
  });

  it('reports the caller error, not a failing rollback', async () => {
    const fake = fakePool({
      reportedCredential: HASH,
      reportedTenant: TENANT,
      failOn: { match: /ROLLBACK/, error: new Error('connection already gone') },
    });
    await expect(
      withCredentialResolvedTenant(
        fake.pool,
        HASH,
        async () => await Promise.resolve({ tenantId: TENANT, value: null }),
        async () => {
          throw new Error('the work failed');
        },
      ),
    ).rejects.toThrow('the work failed');
    expect(fake.releaseCount()).toBe(1);
  });
});
