import { describe, expect, it } from 'vitest';
import { previewContactCsv } from './contacts.js';

describe('previewContactCsv', () => {
  it('parses quoted commas, escaped quotes, and CRLF', () => {
    expect(previewContactCsv('\uFEFFdisplay_name,external_id\r\n"Sara, A.","201000000000"\r\n"The ""School""",wa-2\r\n')).toEqual({
      ok: true,
      rows: [
        { displayName: 'Sara, A.', externalId: '201000000000' },
        { displayName: 'The "School"', externalId: 'wa-2' },
      ],
    });
  });

  it('rejects malformed rows, repeated identities, wrong headers, and oversized batches', () => {
    expect(previewContactCsv('name,external_id\nSara,201')).toMatchObject({ ok: false });
    expect(previewContactCsv('display_name,external_id\nSara,201\nMona,201')).toMatchObject({ ok: false, message: expect.stringContaining('repeats') });
    expect(previewContactCsv('display_name,external_id\n"unterminated,201')).toMatchObject({ ok: false });
    expect(previewContactCsv('display_name,external_id\nSa"ra,201')).toMatchObject({ ok: false });
    expect(previewContactCsv('display_name,external_id\n"Sara"x,201')).toMatchObject({ ok: false });
    expect(previewContactCsv(`display_name,external_id\n${Array.from({ length: 501 }, (_, index) => `N${index},id-${index}`).join('\n')}`)).toMatchObject({ ok: false, message: expect.stringContaining('500') });
    expect(previewContactCsv('x'.repeat(1_000_001))).toMatchObject({ ok: false, message: expect.stringContaining('1 MB') });
  });

  it('rejects incomplete and overlong identity fields', () => {
    expect(previewContactCsv('display_name,external_id\nSara')).toMatchObject({ ok: false, message: expect.stringContaining('Row 2') });
    expect(previewContactCsv(`display_name,external_id\n${'N'.repeat(201)},id`)).toMatchObject({ ok: false, message: expect.stringContaining('Row 2') });
    expect(previewContactCsv(`display_name,external_id\nSara,${'x'.repeat(257)}`)).toMatchObject({ ok: false, message: expect.stringContaining('Row 2') });
  });
});
