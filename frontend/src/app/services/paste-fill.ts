/**
 * Parsing for clipboard blocks that hold one value per field of a group: a spreadsheet row
 * (tab-separated cells), a spreadsheet column (one value per line), or a labelled block
 * ("DE: ..." / "RefID: ..."). Pasting such a block fills the whole group at once instead of
 * landing in the single field that received the paste.
 */

/** Field-name aliases for the DE/FR/IT/EN translation fields. */
export const LANGUAGE_ALIASES: Record<string, string> = {
  de: 'DE', d: 'DE', deutsch: 'DE', german: 'DE', allemand: 'DE', tedesco: 'DE',
  fr: 'FR', f: 'FR', französisch: 'FR', franzoesisch: 'FR', français: 'FR', francais: 'FR', french: 'FR', francese: 'FR',
  it: 'IT', i: 'IT', italienisch: 'IT', italiano: 'IT', italien: 'IT', italian: 'IT',
  en: 'EN', e: 'EN', englisch: 'EN', english: 'EN', anglais: 'EN', inglese: 'EN'
};

/** Field-name aliases for the identifier trio, keyed to the PSPH workbook column headers. */
export const DATA_FIELD_ALIASES: Record<string, string> = {
  fachdatenbezeichner: 'fieldName', fieldname: 'fieldName', feldname: 'fieldName', fachdatenname: 'fieldName',
  refid: 'refID', referenzid: 'refID', ref: 'refID',
  complimentaryid: 'compId', complementaryid: 'compId', compid: 'compId',
  komplementärid: 'compId', komplementaerid: 'compId'
};

export interface ParsedPaste {
  /** Values keyed by field, when the pasted block carried field labels. */
  labelled?: Record<string, string>;
  /** Values in the order they appeared, when the block carried no labels. */
  ordered?: string[];
}

export interface ParsePasteOptions {
  /**
   * Keep blank cells so they stay aligned with their neighbours. Needed wherever a group's
   * fields are independent and one of them is legitimately empty ("Name<TAB><TAB>CompID");
   * translation groups leave it off so stray blank lines between entries are ignored.
   */
  keepEmptyCells?: boolean;
}

function normalizeLabel(token: string): string {
  return token.trim().toLowerCase().replace(/[\s._:\-–—/]/g, '');
}

function fieldFor(token: string, aliases: Record<string, string>): string | null {
  return aliases[normalizeLabel(token)] ?? null;
}

function splitLabelledEntry(entry: string, aliases: Record<string, string>): [string, string] | null {
  const match = entry.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]{0,23})\s*[:\-–—]\s*(.+)$/);
  if (!match) return null;
  const field = fieldFor(match[1], aliases);
  return field ? [field, match[2].trim()] : null;
}

function asAlternatingPairs(entries: string[], aliases: Record<string, string>): Record<string, string> | null {
  if (entries.length < 4 || entries.length % 2 !== 0) return null;
  const labelled: Record<string, string> = {};
  for (let i = 0; i < entries.length; i += 2) {
    const field = fieldFor(entries[i], aliases);
    if (!field || !entries[i + 1]) return null;
    labelled[field] = entries[i + 1];
  }
  return labelled;
}

function splitRows(raw: string): string[][] {
  const text = raw.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (char === '\t') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.map(cells => cells.map(c => c.trim()));
}

function toRows(raw: string, keepEmptyCells: boolean): string[][] {
  const rows = splitRows(raw);

  if (!keepEmptyCells) {
    return rows.map(cells => cells.filter(cell => cell !== '')).filter(cells => cells.length > 0);
  }
  // Interior blanks are real values and must keep their position; only the empty rows a
  // trailing newline or a leading blank produce are dropped.
  const isBlank = (cells: string[]) => cells.every(cell => cell === '');
  let start = 0;
  let end = rows.length;
  while (start < end && isBlank(rows[start])) start++;
  while (end > start && isBlank(rows[end - 1])) end--;
  return rows.slice(start, end);
}

export function parsePaste(
  raw: string,
  aliases: Record<string, string>,
  options: ParsePasteOptions = {}
): ParsedPaste | null {
  if (!raw) return null;

  const rows = toRows(raw, options.keepEmptyCells ?? false);
  if (rows.length === 0) return null;

  // A column copy that carries its labels alongside ("DE<TAB>Angaben...").
  if (rows.length > 1 && rows.every(cells => cells.length >= 2)) {
    const labelled: Record<string, string> = {};
    const allLabelled = rows.every(cells => {
      const field = fieldFor(cells[0], aliases);
      if (!field) return false;
      labelled[field] = cells.slice(1).join(' ').trim();
      return labelled[field] !== '';
    });
    if (allLabelled && Object.keys(labelled).length >= 2) return { labelled };
  }

  const entries = rows.flat();
  if (entries.filter(entry => entry !== '').length < 2) return null;

  const inlineLabelled: Record<string, string> = {};
  if (entries.every(entry => {
    const pair = splitLabelledEntry(entry, aliases);
    if (!pair) return false;
    inlineLabelled[pair[0]] = pair[1];
    return true;
  }) && Object.keys(inlineLabelled).length >= 2) {
    return { labelled: inlineLabelled };
  }

  // A row copy that alternates label and value ("DE<TAB>Angaben...<TAB>FR<TAB>Données...").
  const pairs = asAlternatingPairs(entries, aliases);
  if (pairs && Object.keys(pairs).length >= 2) return { labelled: pairs };

  return { ordered: entries };
}

/**
 * Map a parsed paste onto the fields of one group. Returns null when the paste does not line up
 * with the available fields, in which case the browser's own paste runs.
 *
 * `requireExactCount` is for multi-line fields (text blocks), where a partial-length paste is
 * far more likely to be real content than a glossary excerpt.
 */
export function distributePaste(
  parsed: ParsedPaste,
  fields: string[],
  focusField: string,
  requireExactCount = false
): Record<string, string> | null {
  if (parsed.labelled) {
    const assignment: Record<string, string> = {};
    for (const field of fields) {
      const value = parsed.labelled[field];
      if (value) assignment[field] = value;
    }
    return Object.keys(assignment).length >= 2 ? assignment : null;
  }

  const ordered = parsed.ordered ?? [];
  if (ordered.length < 2 || ordered.length > fields.length) return null;
  if (requireExactCount && ordered.length !== fields.length) return null;

  // A full-length paste always starts at the first field; a partial one continues from the
  // field the user pasted into, and is rejected outright when it would overflow.
  const focusIndex = fields.indexOf(focusField);
  const start = ordered.length === fields.length ? 0 : Math.max(focusIndex, 0);
  if (start + ordered.length > fields.length) return null;

  const assignment: Record<string, string> = {};
  ordered.forEach((value, i) => { assignment[fields[start + i]] = value; });
  return assignment;
}
