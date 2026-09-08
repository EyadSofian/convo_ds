import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OpaqueCursorCodec, pageEnvelope } from './pagination.js';

const SECRET = 'a 32-byte minimum cursor signing secret';
const BINDING = { tenantId: 'tenant-a', filterHash: 'filter-a', sort: '-created_at,id' };
const NOW = 1_800_000_000_000;

function codec() {
  return new OpaqueCursorCodec(SECRET, () => NOW);
}

function signed(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return encoded + '.' + signature;
}

describe('OpaqueCursorCodec', () => {
  it('round-trips a cursor without exposing its fields', () => {
    const cursor = codec().encode(BINDING, { value: '2026-09-08T00:00:00Z', id: 'row-1' }, 60);
    expect(cursor).not.toContain('tenant-a');
    expect(codec().decode(cursor, BINDING)).toEqual({
      status: 'valid',
      after: { value: '2026-09-08T00:00:00Z', id: 'row-1' },
    });
  });

  it.each([
    '',
    'a'.repeat(4097),
    'one.two.three',
    'e30.short',
  ])('rejects malformed cursor %s', (cursor) => {
    expect(codec().decode(cursor, BINDING)).toMatchObject({
      status: 'rejected',
      code: 'cursor_invalid',
    });
  });

  it('rejects a same-length signature modification', () => {
    const cursor = codec().encode(BINDING, { value: 'v', id: 'id' }, 60);
    const last = cursor.endsWith('a') ? 'b' : 'a';
    expect(codec().decode(cursor.slice(0, -1) + last, BINDING)).toMatchObject({
      code: 'cursor_invalid',
    });
  });

  it('rejects signed but malformed or wrongly shaped payloads', () => {
    expect(codec().decode(signed('not an object'), BINDING)).toMatchObject({
      code: 'cursor_invalid',
    });
    const invalidJson = Buffer.from('{', 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(invalidJson).digest('base64url');
    expect(codec().decode(invalidJson + '.' + signature, BINDING)).toMatchObject({
      code: 'cursor_invalid',
    });
    expect(codec().decode(signed({}), BINDING)).toMatchObject({ code: 'cursor_invalid' });
  });

  it.each([
    [{ ...BINDING, tenantId: 'tenant-b' }],
    [{ ...BINDING, filterHash: 'filter-b' }],
    [{ ...BINDING, sort: 'created_at,id' }],
  ])('binds the cursor to tenant, filter and sort', (binding) => {
    const cursor = codec().encode(BINDING, { value: 'v', id: 'id' }, 60);
    expect(codec().decode(cursor, binding)).toMatchObject({ code: 'cursor_invalid' });
  });

  it('returns a typed expiry with a safe refresh path', () => {
    const cursor = codec().encode(BINDING, { value: 'v', id: 'id' }, 1);
    const later = new OpaqueCursorCodec(SECRET, () => NOW + 1000);
    expect(later.decode(cursor, BINDING)).toEqual({
      status: 'rejected',
      code: 'cursor_expired',
      message: 'This page cursor expired. Refresh the list from the beginning.',
    });
  });

  it('refuses weak signing secrets and invalid TTLs', () => {
    expect(() => new OpaqueCursorCodec('short')).toThrow('at least 32 bytes');
    expect(() => codec().encode(BINDING, { value: 'v', id: 'id' }, 0)).toThrow(
      'positive integer',
    );
    expect(() => codec().encode(BINDING, { value: 'v', id: 'id' }, 1.5)).toThrow(
      'positive integer',
    );
  });
});

describe('pageEnvelope', () => {
  it('emits the canonical snake-case page contract', () => {
    expect(pageEnvelope([{ id: 'one' }], 'next', 'request-1')).toEqual({
      data: [{ id: 'one' }],
      page: { next_cursor: 'next', has_more: true },
      request_id: 'request-1',
    });
    expect(pageEnvelope([], null, 'request-2').page.has_more).toBe(false);
  });
});
