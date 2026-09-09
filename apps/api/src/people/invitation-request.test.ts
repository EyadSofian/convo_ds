import { describe, expect, it } from 'vitest';
import { parseAcceptInvitation, parseCreateInvitation } from './invitation-request.js';

const ROLE = '11111111-1111-4111-8111-111111111111';
const INBOX = '22222222-2222-4222-8222-222222222222';

function details(result: ReturnType<typeof parseCreateInvitation>): readonly string[] {
  if (result.ok) throw new Error('expected a rejection');
  return result.details.map((detail) => detail.field);
}

describe('parseCreateInvitation', () => {
  it('accepts a well-formed request and normalises the address', () => {
    const result = parseCreateInvitation({ email: '  Tarek@Example.Test ', roleId: ROLE });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ email: 'tarek@example.test', roleId: ROLE, scopes: [] });
  });

  it('accepts tenant, team and inbox scopes', () => {
    const result = parseCreateInvitation({
      email: 'a@b.test',
      roleId: ROLE,
      scopes: [
        { type: 'tenant', id: null },
        { type: 'inbox', id: INBOX },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.scopes).toEqual([
      { type: 'tenant', id: null },
      { type: 'inbox', id: INBOX },
    ]);
  });

  it('drops an id supplied alongside a tenant scope rather than storing it', () => {
    // The database CHECK pairs `tenant` with a null id. Normalising here means
    // a confused client gets a coherent record instead of a constraint error.
    const result = parseCreateInvitation({
      email: 'a@b.test',
      roleId: ROLE,
      scopes: [{ type: 'tenant', id: null }],
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.scopes[0]).toEqual({ type: 'tenant', id: null });
  });

  it.each([
    ['a non-object body', ['nope'], ['body']],
    ['a missing email', { roleId: ROLE }, ['email']],
    ['a non-string email', { email: 42, roleId: ROLE }, ['email']],
    ['a malformed email', { email: 'no-at-sign', roleId: ROLE }, ['email']],
    ['an over-long email', { email: `${'a'.repeat(250)}@x.test`, roleId: ROLE }, ['email']],
    ['a non-uuid role', { email: 'a@b.test', roleId: 'nope' }, ['roleId']],
    ['both at once', { email: 'nope', roleId: 'nope' }, ['email', 'roleId']],
    ['non-array scopes', { email: 'a@b.test', roleId: ROLE, scopes: 'all' }, ['scopes']],
  ])('rejects %s', (_label, body, fields) => {
    expect(details(parseCreateInvitation(body))).toEqual(fields);
  });

  it('rejects more scopes than anyone needs', () => {
    const scopes = Array.from({ length: 51 }, () => ({ type: 'inbox', id: INBOX }));
    expect(details(parseCreateInvitation({ email: 'a@b.test', roleId: ROLE, scopes }))).toEqual([
      'scopes',
    ]);
  });

  it.each([
    ['an unknown scope type', { type: 'everything', id: INBOX }],
    ['a team scope with no id', { type: 'team', id: null }],
    ['an inbox scope with a non-uuid id', { type: 'inbox', id: 'nope' }],
    ['a tenant scope carrying an id', { type: 'tenant', id: INBOX }],
    ['a scope that is not an object', 'inbox'],
  ])('rejects %s and names which entry', (_label, scope) => {
    expect(details(parseCreateInvitation({ email: 'a@b.test', roleId: ROLE, scopes: [scope] }))).toEqual(
      ['scopes.0'],
    );
  });
});

describe('parseAcceptInvitation', () => {
  it('accepts a long-enough password', () => {
    const result = parseAcceptInvitation({ password: 'a password long enough' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.password).toBe('a password long enough');
  });

  it.each([
    ['a non-object body', ['nope'], 'malformed'],
    ['a missing password', {}, 'too_short'],
    ['a non-string password', { password: 12345678901234 }, 'too_short'],
    ['a short password', { password: 'short' }, 'too_short'],
    ['an unbounded password', { password: 'x'.repeat(513) }, 'too_long'],
  ])('rejects %s', (_label, body, code) => {
    const result = parseAcceptInvitation(body);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.details[0]?.code).toBe(code);
  });
});
