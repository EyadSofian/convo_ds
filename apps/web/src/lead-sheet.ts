import type { unzipSync as UnzipSync } from 'fflate';

/** The six-column broadcast import. Parsing never changes contacts or sends. */
export interface LeadSheetRow {
  readonly leadName: string;
  readonly mobile: string;
  readonly courseName: string;
  readonly label: string;
  readonly assignTo: string;
  readonly campaignName: string;
}

export type LeadSheetResult =
  | { readonly ok: true; readonly rows: readonly LeadSheetRow[] }
  | { readonly ok: false; readonly message: string };

const HEADERS = ['lead name', 'mobile', 'course name', 'label', 'assign to', 'campaign name'] as const;
const LIMIT = 2_000_000;

export async function parseLeadSheet(file: Pick<File, 'name' | 'size' | 'text' | 'arrayBuffer'>): Promise<LeadSheetResult> {
  if (file.size > LIMIT) return { ok: false, message: 'Use a file smaller than 2 MB.' };
  let table: string[][];
  try {
    if (/\.csv$/i.test(file.name)) table = csvRows(await file.text());
    else if (/\.xlsx$/i.test(file.name)) {
      const { unzipSync } = await import('fflate');
      table = xlsxRows(new Uint8Array(await file.arrayBuffer()), unzipSync);
    }
    else return { ok: false, message: 'Choose an .xlsx or .csv file.' };
  } catch {
    return { ok: false, message: 'The spreadsheet could not be read. Save it as .xlsx or UTF-8 CSV and try again.' };
  }
  const header = table.shift()?.map((value) => value.replace(/^\uFEFF/, '').trim().toLowerCase()) ?? [];
  if (header.length !== HEADERS.length || HEADERS.some((value, index) => header[index] !== value)) {
    return { ok: false, message: `Expected columns, in order: ${HEADERS.join(', ')}.` };
  }
  const data = table.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (data.length === 0 || data.length > 500) return { ok: false, message: 'Import between 1 and 500 leads per file.' };
  if (data.some((row) => row.length > 6)) return { ok: false, message: 'A row has more than six columns.' };
  return { ok: true, rows: data.map((row) => ({
    leadName: row[0]!.trim(), mobile: row[1]?.trim() ?? '', courseName: row[2]?.trim() ?? '',
    label: row[3]?.trim() ?? '', assignTo: row[4]?.trim() ?? '', campaignName: row[5]?.trim() ?? '',
  })) };
}

function csvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quote = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === '"') {
      if (quote && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (quote || cell === '') quote = !quote;
      else throw new Error('Invalid CSV quote');
    } else if (char === ',' && !quote) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quote) {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quote) throw new Error('Unclosed CSV quote');
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function xml(source: Uint8Array): Document {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(source), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('Malformed XLSX XML');
  return doc;
}

function nodes(parent: Document | Element, name: string): Element[] {
  const plain = Array.from(parent.getElementsByTagName(name));
  return plain.length > 0 ? plain : Array.from(parent.getElementsByTagNameNS('*', name));
}

function xlsxRows(bytes: Uint8Array, unzipSync: typeof UnzipSync): string[][] {
  let oversized = false;
  let extracted = 0;
  const files = unzipSync(bytes, { filter: (entry) => {
    const relevant = /^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)$/.test(entry.name);
    if (!relevant) return false;
    extracted += entry.originalSize;
    if (entry.originalSize > 3_000_000 || extracted > 4_000_000) oversized = true;
    return !oversized;
  } });
  if (oversized) throw new Error('XLSX sheet is too large');
  let path = 'xl/worksheets/sheet1.xml';
  const workbook = files['xl/workbook.xml'];
  const relations = files['xl/_rels/workbook.xml.rels'];
  if (workbook !== undefined && relations !== undefined) {
    const firstSheet = nodes(xml(workbook), 'sheet')[0];
    const relationshipId = firstSheet?.getAttribute('r:id') ?? firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const relation = nodes(xml(relations), 'Relationship').find((entry) => entry.getAttribute('Id') === relationshipId);
    const target = relation?.getAttribute('Target');
    if (target !== null && target !== undefined) {
      const normalized = target.replace(/^\//, '').replace(/^\.\//, '');
      path = normalized.startsWith('xl/') ? normalized : `xl/${normalized}`;
    }
  }
  if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) throw new Error('Unsafe worksheet path');
  const sheet = files[path];
  if (sheet === undefined) throw new Error('First worksheet missing');
  const strings = files['xl/sharedStrings.xml'] === undefined ? [] : nodes(xml(files['xl/sharedStrings.xml']), 'si')
    .map((item) => nodes(item, 't').map((text) => text.textContent!).join(''));
  const result: string[][] = [];
  for (const row of nodes(xml(sheet), 'row')) {
    const cells: string[] = [];
    for (const cell of nodes(row, 'c')) {
      const reference = cell.getAttribute('r') ?? '';
      const letters = /^[A-Z]+/.exec(reference)?.[0] ?? '';
      let column = 0;
      for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
      if (column < 1 || column > 6) continue;
      if (nodes(cell, 'f').length > 0) throw new Error('Formula cells are not accepted');
      const type = cell.getAttribute('t');
      const valueNode = nodes(cell, 'v')[0];
      const value = type === 'inlineStr' ? nodes(cell, 't').map((node) => node.textContent!).join('')
        : valueNode === undefined ? '' : valueNode.textContent!;
      cells[column - 1] = type === 's' ? strings[Number(value)] ?? '' : value;
    }
    result.push(Array.from({ length: 6 }, (_, index) => cells[index] ?? ''));
    if (result.length > 501) throw new Error('Too many rows');
  }
  return result;
}
