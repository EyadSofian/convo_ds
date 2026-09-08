import { describe, expect, it } from 'vitest';
import { parseBootstrapRequest, parseIdempotencyKey } from './bootstrap-request.js';

const VALID = {
  companyName: ' Acme ',
  companySlug: 'acme',
  ownerEmail: ' owner@acme.test ',
  ownerPassword: ' a password kept verbatim ',
};

describe('parseBootstrapRequest', () => {
  it.each([null, [], 'text'])('rejects a non-object body: %j', (body) => {
    expect(parseBootstrapRequest(body)).toEqual({
      status: 'invalid',
      details: [{ field: 'body', code: 'not_an_object', message: 'A JSON object is required.' }],
    });
  });

  it('accepts and normalizes public identity fields without trimming the password', () => {
    expect(parseBootstrapRequest(VALID)).toEqual({
      status: 'valid',
      value: {
        companyName: 'Acme',
        companySlug: 'acme',
        ownerEmail: 'owner@acme.test',
        ownerPassword: ' a password kept verbatim ',
      },
    });
  });

  it('reports unexpected, missing, and non-string fields together', () => {
    const result = parseBootstrapRequest({
      companyName: 4,
      companySlug: undefined,
      ownerEmail: '',
      ownerPassword: null,
      admin: true,
    });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.details.map((item) => [item.field, item.code])).toEqual([
        ['admin', 'unexpected'],
        ['companyName', 'not_a_string'],
        ['companySlug', 'required'],
        ['ownerEmail', 'required'],
        ['ownerPassword', 'not_a_string'],
      ]);
    }
  });

  it('enforces business-safe lengths and formats', () => {
    const result = parseBootstrapRequest({
      companyName: 'x'.repeat(81),
      companySlug: '-Bad-',
      ownerEmail: 'bad @address',
      ownerPassword: 'short',
    });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.details.map((item) => item.field)).toEqual([
        'companyName',
        'companySlug',
        'ownerEmail',
        'ownerPassword',
      ]);
    }
  });

  it.each([
    'x'.repeat(255) + '@example.test',
    'a b@example.test',
    'a@@example.test',
    '@example.test',
    'a@example',
  ])('rejects malformed owner email %s', (ownerEmail) => {
    expect(parseBootstrapRequest({ ...VALID, ownerEmail }).status).toBe('invalid');
  });

  it('rejects an overlong password', () => {
    expect(
      parseBootstrapRequest({ ...VALID, ownerPassword: 'x'.repeat(129) }).status,
    ).toBe('invalid');
  });
});

describe('parseIdempotencyKey', () => {
  it('accepts a printable bounded key', () => {
    expect(parseIdempotencyKey('bootstrap.retry-1')).toBe('bootstrap.retry-1');
  });

  it.each([undefined, [], '', 'x'.repeat(201), 'line\nbreak'])(
    'rejects invalid key %j',
    (value) => {
      expect(() => parseIdempotencyKey(value)).toThrow('invalid_idempotency_key');
    },
  );
});
