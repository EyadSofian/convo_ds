import { describe, expect, it } from 'vitest';
import { canonicalJson, requestHash } from './canonical-json.js';

const SECRET = 'canonical-json-test-secret-value-0001';

describe('canonicalJson', () => {
  it('stabilizes object key order recursively', () => {
    const first = { z: [true, null, 3], a: { y: 'two', x: 'one' } };
    const second = { a: { x: 'one', y: 'two' }, z: [true, null, 3] };
    expect(canonicalJson(first)).toBe('{"a":{"x":"one","y":"two"},"z":[true,null,3]}');
    expect(requestHash(first, SECRET)).toBe(requestHash(second, SECRET));
    expect(requestHash(first, SECRET)).not.toBe(
      requestHash(first, 'canonical-json-test-secret-value-0002'),
    );
  });

  it.each([
    ['string', '"string"'],
    [false, 'false'],
    [12, '12'],
    [null, 'null'],
  ] as const)('serializes scalar %j', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });
});
