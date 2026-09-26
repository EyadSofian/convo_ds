import { describe, expect, it } from 'vitest';
import { columnName, crc32, csv, sheetNames, workbook, xmlText, zip } from './xlsx';

/**
 * The spreadsheet writer is checked the way a spreadsheet program reads it:
 * walk the archive's headers, confirm every checksum, and read the parts back.
 */

const AT = new Date('2026-09-26T12:34:56Z');
const decoder = new TextDecoder();

function entries(archive: Uint8Array): Map<string, string> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const found = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = decoder.decode(archive.subarray(at + 30, at + 30 + nameLength));
    const data = archive.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    expect(view.getUint32(at + 14, true)).toBe(crc32(data));
    found.set(name, decoder.decode(data));
    at += 30 + nameLength + size;
  }
  expect(view.getUint32(at, true)).toBe(0x02014b50);
  return found;
}

describe('the archive', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('stores every entry with a central directory that points back at it', () => {
    const archive = zip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'ب.txt', data: new Uint8Array([1, 2]) }], AT);
    expect([...entries(archive).keys()]).toEqual(['a.txt', 'ب.txt']);
    const view = new DataView(archive.buffer);
    const end = archive.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const directory = view.getUint32(end + 16, true);
    expect(view.getUint32(directory, true)).toBe(0x02014b50);
    expect(view.getUint32(directory + 42, true)).toBe(0);
  });
});

describe('the pieces of a sheet', () => {
  it('escapes XML and drops what XML cannot hold', () => {
    expect(xmlText('a & b < c > "d"\u0001')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;');
  });

  it('names columns the way a spreadsheet does', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
  });

  it('keeps sheet names legal, short and unique', () => {
    expect(sheetNames(['Agents', 'agents', 'A/B: [x]?', '   ', 'x'.repeat(40), 'x'.repeat(40)])).toEqual([
      'Agents', 'agents (2)', 'A B x', 'Sheet', 'x'.repeat(31), `${'x'.repeat(27)} (2)`,
    ]);
  });
});

describe('a workbook', () => {
  it('holds one sheet per table with a frozen, bold header and sized columns', () => {
    const parts = entries(workbook([
      { name: 'Summary', rows: [['Measure', 'Value'], ['Sent', 502], ['Delivery rate', { ratio: 0.649 }], ['Note', null], ['<Mona & co>', 'x']] },
      { name: 'Empty', rows: [] },
    ], { rightToLeft: false, at: AT }));
    expect([...parts.keys()]).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
    ]);
    expect(parts.get('[Content_Types].xml')).toContain('/xl/worksheets/sheet2.xml');
    expect(parts.get('xl/workbook.xml')).toContain('<sheet name="Summary" sheetId="1" r:id="rId1"/>');
    expect(parts.get('xl/worksheets/sheet1.xml')).not.toContain('rightToLeft');
    expect(parts.get('xl/_rels/workbook.xml.rels')).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"');
    const sheet = parts.get('xl/worksheets/sheet1.xml') as string;
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Measure</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>502</v></c>');
    expect(sheet).toContain('<c r="B3" s="2"><v>0.649</v></c>');
    expect(sheet).toContain('<row r="4"><c r="A4" t="inlineStr"><is><t xml:space="preserve">Note</t></is></c></row>');
    expect(sheet).toContain('&lt;Mona &amp; co&gt;');
    expect(sheet).toContain('<col min="1" max="1" width="15" customWidth="1"/>');
    expect(parts.get('xl/worksheets/sheet2.xml')).toContain('<sheetData></sheetData>');
    expect(parts.get('xl/worksheets/sheet2.xml')).not.toContain('<cols>');
  });

  it('reads right to left for Arabic, with a numeric header kept bold', () => {
    const parts = entries(workbook([{ name: 'ملخص', rows: [[2026, 'العدد']] }], { rightToLeft: true, at: AT }));
    expect(parts.get('xl/worksheets/sheet1.xml')).toContain('<sheetView workbookViewId="0" rightToLeft="1">');
    expect(parts.get('xl/worksheets/sheet1.xml')).toContain('<c r="A1" s="1"><v>2026</v></c>');
  });
});

describe('the CSV', () => {
  it('writes every table under its name, quoted where needed and never as a formula', () => {
    const text = csv([
      { name: 'Summary', rows: [['Measure', 'Value'], ['Delivery rate', { ratio: 0.8125 }], ['Quote "x", y', null], ['=HYPERLINK("x")', -3]] },
      { name: 'Days', rows: [['Day'], ['2026-09-05']] },
    ]);
    expect(text.startsWith('\ufeffSummary\r\nMeasure,Value\r\n')).toBe(true);
    expect(text).toContain('Delivery rate,81.3%');
    expect(text).toContain('"Quote ""x"", y",');
    expect(text).toContain('"\'=HYPERLINK(""x"")",-3');
    expect(text.endsWith('\r\n\r\nDays\r\nDay\r\n2026-09-05\r\n')).toBe(true);
  });
});
