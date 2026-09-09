import { describe, expect, it } from 'vitest';
import { requireRow } from './require-row.js';

describe('requireRow', () => {
  it('returns the first row when there is one', () => {
    expect(requireRow([{ id: 'a' }, { id: 'b' }], 'unused')).toEqual({ id: 'a' });
  });

  it('names the write that went wrong when a guaranteed row is missing', () => {
    // The value of the guard is the message: without it this surfaces as a
    // TypeError about reading a property of undefined, several frames away.
    expect(() => requireRow([], 'invitation insert returned no id')).toThrow(
      'convo: invitation insert returned no id',
    );
  });
});
