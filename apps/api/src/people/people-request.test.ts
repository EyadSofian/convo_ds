import { describe, expect, it } from 'vitest';
import {
  isUuid,
  parseMembershipRef,
  parseUpdateMembership,
  parseWriteRole,
  parseWriteTeam,
} from './people-request.js';

const ID = '11111111-1111-4111-8111-111111111111';

function fields(result: { ok: boolean; details?: readonly { field: string }[] }): readonly string[] {
  if (result.ok) throw new Error('expected a rejection');
  return (result.details ?? []).map((detail) => detail.field);
}

describe('isUuid', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid(`${ID}x`)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe('parseUpdateMembership', () => {
  it('keeps only the fields that were sent', () => {
    const result = parseUpdateMembership({ status: 'suspended' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ status: 'suspended' });
    expect('roleId' in result.value).toBe(false);
  });

  it('accepts every scope shape, including a tenant-wide one', () => {
    const result = parseUpdateMembership({
      scopes: [
        { type: 'tenant', id: null },
        { type: 'team', id: ID },
      ],
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.scopes).toEqual([
      { type: 'tenant', id: null },
      { type: 'team', id: ID },
    ]);
  });

  it('accepts clearing every scope', () => {
    const result = parseUpdateMembership({ scopes: [] });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.scopes).toEqual([]);
  });

  it.each([
    ['a non-object body', ['nope'], ['body']],
    ['an empty patch', {}, ['body']],
    ['a non-uuid role', { roleId: 'nope' }, ['roleId']],
    ['an unknown status', { status: 'deleted' }, ['status']],
    ['non-array scopes', { scopes: 'all' }, ['scopes']],
    ['a team scope with no id', { scopes: [{ type: 'team', id: null }] }, ['scopes.0']],
    ['a tenant scope carrying an id', { scopes: [{ type: 'tenant', id: ID }] }, ['scopes.0']],
    ['an unknown scope type', { scopes: [{ type: 'everything', id: ID }] }, ['scopes.0']],
    ['a scope that is not an object', { scopes: ['inbox'] }, ['scopes.0']],
  ])('rejects %s', (_label, body, expected) => {
    expect(fields(parseUpdateMembership(body))).toEqual(expected);
  });

  it('rejects more scopes than anyone needs', () => {
    const scopes = Array.from({ length: 51 }, () => ({ type: 'inbox', id: ID }));
    expect(fields(parseUpdateMembership({ scopes }))).toEqual(['scopes']);
  });
});

describe('parseWriteRole', () => {
  it('accepts a named role with grants', () => {
    const result = parseWriteRole({
      name: '  Enrollment Lead  ',
      description: '  Handles enrollment.  ',
      grants: [{ permission: 'conversation.read', scope: 'scoped' }],
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.name).toBe('Enrollment Lead');
    expect(result.value.description).toBe('Handles enrollment.');
    expect(result.value.grants).toEqual([{ permission: 'conversation.read', scope: 'scoped' }]);
  });

  it('defaults a missing description to empty rather than rejecting', () => {
    const result = parseWriteRole({ name: 'Minimal', grants: [] });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.description).toBe('');
  });

  it.each([
    ['a non-object body', ['nope'], ['body']],
    ['a missing name', { grants: [] }, ['name']],
    ['a non-string name', { name: 42, grants: [] }, ['name']],
    ['an over-long name', { name: 'x'.repeat(81), grants: [] }, ['name']],
    ['an over-long description', { name: 'x', description: 'y'.repeat(281), grants: [] }, ['description']],
    ['non-array grants', { name: 'x', grants: 'all' }, ['grants']],
    ['an unknown permission', { name: 'x', grants: [{ permission: 'not.a.key', scope: 'tenant' }] }, ['grants.0']],
    ['a non-string permission', { name: 'x', grants: [{ permission: 7, scope: 'tenant' }] }, ['grants.0']],
    ['a grant that is not an object', { name: 'x', grants: ['nope'] }, ['grants.0']],
  ])('rejects %s', (_label, body, expected) => {
    expect(fields(parseWriteRole(body))).toEqual(expected);
  });

  it('rejects `none` as a scope, because a denial is the absence of a grant', () => {
    expect(fields(parseWriteRole({ name: 'x', grants: [{ permission: 'report.read', scope: 'none' }] }))).toEqual(
      ['grants.0'],
    );
  });

  it('rejects the same permission twice, naming the second one', () => {
    const result = parseWriteRole({
      name: 'x',
      grants: [
        { permission: 'report.read', scope: 'tenant' },
        { permission: 'report.read', scope: 'own' },
      ],
    });
    expect(fields(result)).toEqual(['grants.1']);
    if (result.ok) throw new Error('unreachable');
    expect(result.details[0]?.code).toBe('duplicate');
  });

  it('rejects more grants than the catalogue has', () => {
    const grants = Array.from({ length: 65 }, () => ({ permission: 'report.read', scope: 'tenant' }));
    expect(fields(parseWriteRole({ name: 'x', grants }))).toEqual(['grants']);
  });
});

describe('parseWriteTeam', () => {
  it('accepts a name, and treats a missing archived flag as false', () => {
    const result = parseWriteTeam({ name: '  Enrollment ' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ name: 'Enrollment', archived: false });
  });

  it('accepts an explicit archive flag', () => {
    const result = parseWriteTeam({ name: 'Seasonal', archived: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.archived).toBe(true);
  });

  it.each([
    ['a non-object body', ['nope'], ['body']],
    ['a missing name', {}, ['name']],
    ['an over-long name', { name: 'x'.repeat(81) }, ['name']],
    ['a non-boolean archived', { name: 'x', archived: 'yes' }, ['archived']],
  ])('rejects %s', (_label, body, expected) => {
    expect(fields(parseWriteTeam(body))).toEqual(expected);
  });
});

describe('parseMembershipRef', () => {
  it('accepts a uuid under the named field', () => {
    const result = parseMembershipRef({ membershipId: ID }, 'membershipId');
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.membershipId).toBe(ID);
  });

  it.each([
    ['a non-object body', ['nope'], ['body']],
    ['a missing field', {}, ['membershipId']],
    ['a non-uuid', { membershipId: 'nope' }, ['membershipId']],
  ])('rejects %s', (_label, body, expected) => {
    expect(fields(parseMembershipRef(body, 'membershipId'))).toEqual(expected);
  });
});
