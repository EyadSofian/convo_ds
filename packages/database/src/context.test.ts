import { describe, expect, it } from 'vitest';
import { TenantContextError, withTenant } from './context.js';
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
