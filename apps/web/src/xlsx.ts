/**
 * Spreadsheets written in the browser, with no library.
 *
 * An .xlsx is a ZIP of a handful of Office Open XML parts. Every entry is
 * stored rather than compressed, which every spreadsheet program reads and
 * which keeps this file small enough to check by eye. Each sheet is one table:
 * a bold, tinted header row that stays in view while scrolling, columns sized
 * to what they hold, and right-to-left sheets when the workspace reads Arabic.
 * The same tables can be written as one CSV instead.
 */

/** A share, stored as a number and shown as a percentage. */
export interface Ratio {
  readonly ratio: number;
}

export type Cell = string | number | null | Ratio;

export interface Sheet {
  readonly name: string;
  readonly rows: readonly (readonly Cell[])[];
}

const encoder = new TextEncoder();

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A ZIP archive with every entry stored as it is, names in UTF-8. */
export function zip(entries: readonly { readonly name: string; readonly data: Uint8Array }[], at: Date): Uint8Array {
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const day = ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const local = new Uint8Array(30 + name.length);
    const head = new DataView(local.buffer);
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);
    head.setUint16(10, time, true);
    head.setUint16(12, day, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, size, true);
    head.setUint32(22, size, true);
    head.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(12, time, true);
    record.setUint16(14, day, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + size;
  }
  const directory = concat(centrals);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, entries.length, true);
  tail.setUint16(10, entries.length, true);
  tail.setUint32(12, directory.length, true);
  tail.setUint32(16, offset, true);
  return concat([...locals, directory, end]);
}

/** Text as XML character data: escaped, with characters XML cannot hold dropped. */
export function xmlText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- these are exactly the characters XML 1.0 forbids
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A1-style column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * Sheet names as Excel accepts them: none of `[]:*?/\`, at most 31
 * characters, never blank, and unique within the workbook.
 */
export function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 31 - String(n).length - 3)} (${String(n)})`;
    used.add(name.toLowerCase());
    return name;
  });
}

function isRatio(cell: Cell): cell is Ratio {
  return typeof cell === 'object' && cell !== null;
}

function cellXml(cell: Cell, ref: string, header: boolean): string {
  if (cell === null) return '';
  if (isRatio(cell)) return `<c r="${ref}" s="2"><v>${String(cell.ratio)}</v></c>`;
  if (typeof cell === 'number') return `<c r="${ref}"${header ? ' s="1"' : ''}><v>${String(cell)}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(cell)}</t></is></c>`;
}

function shown(cell: Cell): string {
  if (cell === null) return '';
  if (isRatio(cell)) return `${String(Math.round(cell.ratio * 1000) / 10)}%`;
  return String(cell);
}

function worksheet(sheet: Sheet, rightToLeft: boolean): string {
  const widths: number[] = [];
  for (const row of sheet.rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 8, Math.min(shown(cell).length + 2, 60));
    });
  }
  const cols = widths.length === 0 ? '' : `<cols>${widths.map((width, index) => `<col min="${String(index + 1)}" max="${String(index + 1)}" width="${String(width)}" customWidth="1"/>`).join('')}</cols>`;
  const rows = sheet.rows.map((row, r) => `<row r="${String(r + 1)}">${row.map((cell, c) => cellXml(cell, `${columnName(c)}${String(r + 1)}`, r === 0)).join('')}</row>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheetViews><sheetView workbookViewId="0"${rightToLeft ? ' rightToLeft="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF0A1630"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE1EBFF"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  + '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** An .xlsx workbook holding every sheet, in order. */
export function workbook(sheets: readonly Sheet[], options: { readonly rightToLeft: boolean; readonly at: Date }): Uint8Array {
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const count = sheets.length;
  const files: { name: string; data: Uint8Array }[] = [
    {
      name: '[Content_Types].xml',
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + names.map((_, index) => `<Override PartName="/xl/worksheets/sheet${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '</Types>'),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>'),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<bookViews><workbookView/></bookViews><sheets>'
        + names.map((name, index) => `<sheet name="${xmlText(name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`).join('')
        + '</sheets></workbook>'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + names.map((_, index) => `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`).join('')
        + `<Relationship Id="rId${String(count + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
        + '</Relationships>'),
    },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES) },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${String(index + 1)}.xml`, data: encoder.encode(worksheet(sheet, options.rightToLeft)) })),
  ];
  return zip(files, options.at);
}

function csvField(cell: Cell): string {
  let text = shown(cell);
  // A cell a spreadsheet would run as a formula is written as text instead.
  if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Every sheet as one CSV: each table under its own name, a blank line
 * between tables, and a byte-order mark so spreadsheet programs read UTF-8
 * (and so Arabic) correctly.
 */
export function csv(sheets: readonly Sheet[]): string {
  return `\ufeff${sheets.map((sheet) => [sheet.name, ...sheet.rows.map((row) => row.map(csvField).join(','))].join('\r\n')).join('\r\n\r\n')}\r\n`;
}
