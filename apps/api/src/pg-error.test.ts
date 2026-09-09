import { describe, expect, it } from 'vitest';
import { ApiHttpError } from './http-error.js';
import { unlessConstraint, violatedConstraint } from './pg-error.js';

const CONFLICT = new ApiHttpError(409, 'team_exists', 'A live team with that name already exists.');

/** What a `pg` unique violation looks like where it is caught. */
function pgViolation(constraint: unknown): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
}

describe('violatedConstraint', () => {
  it('names the constraint a PostgreSQL error carries', () => {
    expect(violatedConstraint(pgViolation('teams_tenant_name_live_uq'))).toBe(
      'teams_tenant_name_live_uq',
    );
  });

  it('reports nothing for anything that is not one', () => {
    // The catch clause is an untyped boundary: whatever was thrown arrives
    // here, so every one of these has to answer rather than throw again.
    expect(violatedConstraint(new Error('boom'))).toBeNull();
    expect(violatedConstraint(pgViolation(undefined))).toBeNull();
    expect(violatedConstraint('a string')).toBeNull();
    expect(violatedConstraint(null)).toBeNull();
  });
});

describe('unlessConstraint', () => {
  it('returns the value when nothing was violated', async () => {
    await expect(unlessConstraint('x', CONFLICT, () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('answers the named violation with the conflict it means', async () => {
    const failed = unlessConstraint('teams_tenant_name_live_uq', CONFLICT, () =>
      Promise.reject(pgViolation('teams_tenant_name_live_uq')),
    );
    await expect(failed).rejects.toBe(CONFLICT);
  });

  it('rethrows every other failure untouched', async () => {
    // Swallowing these would turn a future bug in the same query into a
    // plausible-looking 409 that nobody would think to investigate.
    const other = pgViolation('memberships_role_fk');
    await expect(unlessConstraint('teams_tenant_name_live_uq', CONFLICT, () => Promise.reject(other))).rejects.toBe(
      other,
    );
    const plain = new Error('connection terminated');
    await expect(unlessConstraint('teams_tenant_name_live_uq', CONFLICT, () => Promise.reject(plain))).rejects.toBe(
      plain,
    );
  });
});
