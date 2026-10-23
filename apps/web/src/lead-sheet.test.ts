// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseLeadSheet } from './lead-sheet';
import { workbook } from './xlsx';

const headers = ['Lead Name', 'Mobile', 'Course Name', 'Label', 'Assign To', 'Campaign Name'];

function file(name: string, bytes: Uint8Array): Pick<File, 'name' | 'size' | 'text' | 'arrayBuffer'> {
  return { name, size: bytes.length, text: () => Promise.resolve(new TextDecoder().decode(bytes)),
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) };
}

describe('broadcast lead sheet', () => {
  it('reads quoted UTF-8 CSV without losing Arabic names or commas', async () => {
    const source = `\uFEFF${headers.join(',')}\r\n"منى, أحمد",01012345678,PMP,CODE_ONE,,PMP October\r\n`;
    const parsed = await parseLeadSheet(file('leads.csv', strToU8(source)));
    expect(parsed).toMatchObject({ ok: true, rows: [{ leadName: 'منى, أحمد', mobile: '01012345678', campaignName: 'PMP October' }] });
  });

  it('reads compressed Excel workbooks and inline strings', async () => {
    const raw = workbook([{ name: 'Leads', rows: [headers, ['Mona', '01012345678', 'PMP', 'CODE_ONE', '', 'PMP October']] }],
      { rightToLeft: false, at: new Date('2026-10-23T00:00:00Z') });
    // Recompress the writer's stored ZIP to exercise Excel's ordinary deflate.
    const { unzipSync } = await import('fflate');
    const compressed = zipSync(unzipSync(raw));
    const parsed = await parseLeadSheet(file('leads.xlsx', compressed));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed).toMatchObject({ ok: true, rows: [{ leadName: 'Mona', courseName: 'PMP' }] });
  });

  it('rejects an unsafe header and formula cells', async () => {
    expect(await parseLeadSheet(file('leads.csv', strToU8('Name,Mobile\nMona,01012345678')))).toMatchObject({ ok: false });
    const zipped = zipSync({ 'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>') });
    expect(await parseLeadSheet(file('leads.xlsx', zipped))).toMatchObject({ ok: false });
  });
});
