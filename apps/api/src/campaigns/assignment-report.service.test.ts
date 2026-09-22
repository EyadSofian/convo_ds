import { describe, expect, it } from 'vitest';
import { ApiHttpError } from '../http-error.js';
import { parseAssignmentReportQuery } from './assignment-report.service.js';

describe('assignment report query', () => {
  it('applies the bounded default and preserves shared filters', () => {
    expect(parseAssignmentReportQuery({ from: '2026-08-25', channel: 'messenger', limit: '' })).toMatchObject({
      cursor: null,
      limit: 50,
      filters: { fromAt: new Date('2026-08-25T00:00:00.000Z'), channel: 'messenger' },
    });
  });

  it('accepts supported opaque cursor and integer page-size forms', () => {
    expect(parseAssignmentReportQuery({ cursor: 'opaque', limit: 25 })).toMatchObject({ cursor: 'opaque', limit: 25 });
    expect(parseAssignmentReportQuery({ cursor: '', limit: '100' })).toMatchObject({ cursor: null, limit: 100 });
  });

  it.each([null, [], 'not-an-object', { unknown: 'value' }, { cursor: 7 }, { cursor: 'x'.repeat(4097) },
    { limit: 'nope' }, { limit: 1.2 }, { limit: 0 }, { limit: 101 }])(
    'rejects malformed assignment query %#', (query) => {
      expect(() => parseAssignmentReportQuery(query)).toThrow(ApiHttpError);
    },
  );
});
