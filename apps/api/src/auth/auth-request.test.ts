import { describe, expect, it } from 'vitest';
import { parseLoginRequest } from './auth-request.js';

describe('parseLoginRequest', () => {
  it('normalizes a valid email without altering the password', () => {
    expect(
      parseLoginRequest({ email: ' Owner@Example.COM ', password: ' spaces stay ' }),
    ).toEqual({
      status: 'valid',
      value: { email: 'owner@example.com', password: ' spaces stay ' },
    });
  });

  it.each([null, [], 'text', 4])('rejects non-object input %j', (input) => {
    expect(parseLoginRequest(input)).toMatchObject({
      status: 'invalid',
      details: [{ field: 'body', code: 'not_an_object' }],
    });
  });

  it('aggregates missing, mistyped and unexpected fields', () => {
    const outcome = parseLoginRequest({ email: 3, extra: true });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.details.map(({ field, code }) => ({ field, code }))).toEqual([
        { field: 'extra', code: 'unexpected' },
        { field: 'email', code: 'not_a_string' },
        { field: 'password', code: 'required' },
      ]);
    }
  });

  it.each(['owner', '@example.com', 'a @example.com', 'a@localhost', 'a..b@example.com'])(
    'rejects malformed email %s',
    (email) => {
      const outcome = parseLoginRequest({ email, password: 'password' });
      expect(outcome.status).toBe('invalid');
      if (outcome.status === 'invalid') {
        expect(outcome.details.map(({ field, code }) => ({ field, code }))).toContainEqual({
          field: 'email',
          code: 'malformed',
        });
      }
    },
  );

  it('rejects blank or overlong credentials', () => {
    expect(parseLoginRequest({ email: ' ', password: '' })).toMatchObject({ status: 'invalid' });
    const outcome = parseLoginRequest({
      email: 'owner@example.com',
      password: 'x'.repeat(129),
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.details.map(({ field, code }) => ({ field, code }))).toContainEqual({
        field: 'password',
        code: 'too_long',
      });
    }
  });
});
