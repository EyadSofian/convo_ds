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
  it('rejects oversized, unsupported, empty and over-wide CSV files', async () => {
    const wide = `${headers.join(',')}\n${['Mona', '01012345678', 'PMP', 'PMP', '', 'October', 'extra'].join(',')}`;
    expect(await parseLeadSheet({ ...file('leads.csv', strToU8(wide)), size: 2_000_001 })).toMatchObject({ ok: false, message: 'Use a file smaller than 2 MB.' });
    expect(await parseLeadSheet(file('leads.xls', strToU8(wide)))).toMatchObject({ ok: false, message: 'Choose an .xlsx or .csv file.' });
    expect(await parseLeadSheet(file('leads.csv', strToU8(`${headers.join(',')}\n`)))).toMatchObject({ ok: false, message: 'Import between 1 and 500 leads per file.' });
    expect(await parseLeadSheet(file('leads.csv', strToU8('')))).toMatchObject({ ok: false, message: expect.stringContaining('Expected columns') });
    expect(await parseLeadSheet(file('leads.csv', strToU8(wide)))).toMatchObject({ ok: false, message: 'A row has more than six columns.' });
    expect(await parseLeadSheet(file('leads.csv', strToU8(`${headers.join(',')}\n${'Mona,01012345678,PMP,PMP,,October\n'.repeat(501)}`)))).toMatchObject({ ok: false, message: 'Import between 1 and 500 leads per file.' });
  });

  it('handles incomplete rows, embedded newlines and malformed quoting', async () => {
    const source = `${headers.join(',')}\n"Mona\nAli",01012345678\nAhmed\r\n`;
    expect(await parseLeadSheet(file('leads.CSV', strToU8(source)))).toMatchObject({ ok: true, rows: [
      { leadName: 'Mona\nAli', mobile: '01012345678', courseName: '', label: '', assignTo: '', campaignName: '' },
      { leadName: 'Ahmed', mobile: '' },
    ] });
    for (const bad of [`${headers.join(',')}\nMo"na,01012345678`, `${headers.join(',')}\n"Mona,01012345678`]) {
      expect(await parseLeadSheet(file('leads.csv', strToU8(bad)))).toMatchObject({ ok: false, message: expect.stringContaining('could not be read') });
    }
  });

  it('checks zip size, worksheet paths and missing or malformed XML', async () => {
    const sheet = '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Lead Name</t></is></c></row></sheetData></worksheet>';
    const parse = (entries: Record<string, Uint8Array>) => parseLeadSheet(file('leads.xlsx', zipSync(entries)));
    expect(await parse({})).toMatchObject({ ok: false });
    expect(await parse({ 'xl/worksheets/sheet1.xml': strToU8('<parsererror/>') })).toMatchObject({ ok: false });
    expect(await parse({ 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/workbook.xml': strToU8('<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="../evil.xml"/></Relationships>') })).toMatchObject({ ok: false });
    expect(await parse({ 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/workbook.xml': strToU8('<workbook><sheets><sheet/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships/>') })).toMatchObject({ ok: false });
    expect(await parse({ 'xl/worksheets/sheet1.xml': strToU8('x'.repeat(3_000_001)) })).toMatchObject({ ok: false });
  });

  it('reads shared strings and a workbook relationship, ignoring unsupported cells', async () => {
    const shared = `<sst>${headers.map((header) => `<si><t>${header}</t></si>`).join('')}<si><t>Mona</t></si><si><t>PMP</t></si></sst>`;
    const header = headers.map((_, index) => `<c r="${String.fromCharCode(65 + index)}1" t="s"><v>${index}</v></c>`).join('');
    const sheet = `<worksheet><sheetData><row>${header}</row><row><c r="A2" t="s"><v>6</v></c><c r="B2"><v>01012345678</v></c><c r="C2" t="s"><v>7</v></c><c r="D2" t="s"><v>99</v></c><c r="E2"></c><c r="G2"><v>ignored</v></c><c><v>ignored</v></c><c r="F2" t="inlineStr"><is><t>October</t></is></c></row></sheetData></worksheet>`;
    const workbookXml = '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet r:id="rId1"/></sheets></workbook>';
    const relationships = '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet2.xml"/></Relationships>';
    const bytes = zipSync({ 'xl/workbook.xml': strToU8(workbookXml), 'xl/_rels/workbook.xml.rels': strToU8(relationships),
      'xl/sharedStrings.xml': strToU8(shared), 'xl/worksheets/sheet2.xml': strToU8(sheet) });
    const parsed = await parseLeadSheet(file('leads.xlsx', bytes));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed).toMatchObject({ ok: true, rows: [{ leadName: 'Mona', mobile: '01012345678', courseName: 'PMP', label: '', campaignName: 'October' }] });
  });

  it('caps Excel worksheet rows before parsing the audience', async () => {
    const sheet = `<worksheet><sheetData>${'<row/>'.repeat(502)}</sheetData></worksheet>`;
    expect(await parseLeadSheet(file('leads.xlsx', zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) })))).toMatchObject({ ok: false });
  });

  it('supports escaped quotes and CR-only CSV rows', async () => {
    const source = `${headers.join(',')}\r"Mo""na",01012345678,PMP,PMP,,October\r`;
    expect(await parseLeadSheet(file('leads.csv', strToU8(source)))).toMatchObject({ ok: true, rows: [{ leadName: 'Mo"na' }] });
  });
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
