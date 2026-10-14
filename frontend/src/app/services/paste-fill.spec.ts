import { parsePaste, distributePaste, LANGUAGE_ALIASES, DATA_FIELD_ALIASES } from './paste-fill';

const LANGUAGES = ['DE', 'FR', 'IT', 'EN'];
const DATA_FIELDS = ['fieldName', 'refID', 'compId'];

function fillLanguages(raw: string, focus = 'DE', requireExact = false) {
  const parsed = parsePaste(raw, LANGUAGE_ALIASES);
  return parsed ? distributePaste(parsed, LANGUAGES, focus, requireExact) : null;
}

function fillDataFields(raw: string, focus = 'fieldName', fields = DATA_FIELDS) {
  const parsed = parsePaste(raw, DATA_FIELD_ALIASES, { keepEmptyCells: true });
  return parsed ? distributePaste(parsed, fields, focus) : null;
}

describe('paste-fill: translations', () => {
  it('reads a column of four values pasted from a document', () => {
    expect(fillLanguages('Angaben zur antragstellenden Person\nDonnées du requérant\nDati del richiedente\nApplicant details')).toEqual({
      DE: 'Angaben zur antragstellenden Person',
      FR: 'Données du requérant',
      IT: 'Dati del richiedente',
      EN: 'Applicant details'
    });
  });

  it('reads a spreadsheet row of four cells', () => {
    expect(fillLanguages('Vorname\tPrénom\tNome\tFirst name')).toEqual({
      DE: 'Vorname', FR: 'Prénom', IT: 'Nome', EN: 'First name'
    });
  });

  it('handles CRLF line endings and blank separator lines', () => {
    expect(fillLanguages('Vorname\r\n\r\nPrénom\r\nNome\r\nFirst name')).toEqual({
      DE: 'Vorname', FR: 'Prénom', IT: 'Nome', EN: 'First name'
    });
  });

  it('unwraps quoted spreadsheet cells', () => {
    expect(fillLanguages('"Name, amtlich"\tNom\tNome\tName')).toEqual({
      DE: 'Name, amtlich', FR: 'Nom', IT: 'Nome', EN: 'Name'
    });
  });

  it('keeps a quoted cell that contains a line break in one piece', () => {
    // Excel quotes any cell holding a separator, so a multi-line description arrives as
    // one quoted cell. Splitting on newlines first would tear it in two and shift every
    // later value into the wrong language.
    expect(fillLanguages('"Name,\namtlich' + '"\tNom\tNome\tName')).toEqual({
      DE: 'Name,\namtlich', FR: 'Nom', IT: 'Nome', EN: 'Name'
    });
  });

  it('unwraps a doubled quote inside a quoted cell', () => {
    expect(fillLanguages('"Der ""Antrag"""\tLa demande\tLa domanda\tThe request')).toEqual({
      DE: 'Der "Antrag"', FR: 'La demande', IT: 'La domanda', EN: 'The request'
    });
  });

  it('maps by label when the glossary carries a language column', () => {
    expect(fillLanguages('EN\tApplicant details\nDE\tAngaben\nIT\tDati\nFR\tDonnées')).toEqual({
      DE: 'Angaben', FR: 'Données', IT: 'Dati', EN: 'Applicant details'
    });
  });

  it('maps by inline label regardless of order', () => {
    expect(fillLanguages('FR: Prénom\nDE: Vorname\nEN - First name\nIT: Nome')).toEqual({
      DE: 'Vorname', FR: 'Prénom', IT: 'Nome', EN: 'First name'
    });
  });

  it('maps a single row that alternates label and value', () => {
    expect(fillLanguages('DE\tVorname\tFR\tPrénom\tIT\tNome\tEN\tFirst name')).toEqual({
      DE: 'Vorname', FR: 'Prénom', IT: 'Nome', EN: 'First name'
    });
  });

  it('ignores labels for languages the group does not have', () => {
    const parsed = parsePaste('DE: Hinweis\nFR: Remarque\nIT: Nota\nEN: Note', LANGUAGE_ALIASES);
    expect(distributePaste(parsed!, ['DE', 'FR', 'IT'], 'DE')).toEqual({
      DE: 'Hinweis', FR: 'Remarque', IT: 'Nota'
    });
  });

  it('leaves an ordinary single-value paste alone', () => {
    expect(parsePaste('Angaben zur antragstellenden Person', LANGUAGE_ALIASES)).toBeNull();
    expect(parsePaste('', LANGUAGE_ALIASES)).toBeNull();
  });

  it('continues from the focused field for a partial paste', () => {
    expect(fillLanguages('Nome\tFirst name', 'IT')).toEqual({ IT: 'Nome', EN: 'First name' });
  });

  it('declines a partial paste that would overflow the remaining fields', () => {
    expect(fillLanguages('Nome\tFirst name\tExtra', 'IT')).toBeNull();
  });

  it('declines a block longer than the language list', () => {
    expect(fillLanguages('a\nb\nc\nd\ne')).toBeNull();
  });

  it('declines a partial paste in exact-count mode (text blocks)', () => {
    expect(fillLanguages('First line\nSecond line', 'DE', true)).toBeNull();
    expect(fillLanguages('a\nb\nc\nd', 'DE', true)).toEqual({ DE: 'a', FR: 'b', IT: 'c', EN: 'd' });
  });
});

describe('paste-fill: identifier trio', () => {
  it('reads the three adjacent PSPH cells from a spec row', () => {
    expect(fillDataFields('Antrag_Name\tRF-0815\tCOMP-4711')).toEqual({
      fieldName: 'Antrag_Name', refID: 'RF-0815', compId: 'COMP-4711'
    });
  });

  it('reads the trio pasted as three lines', () => {
    expect(fillDataFields('Antrag_Name\nRF-0815\nCOMP-4711')).toEqual({
      fieldName: 'Antrag_Name', refID: 'RF-0815', compId: 'COMP-4711'
    });
  });

  it('keeps a blank middle cell aligned instead of shifting the trio', () => {
    expect(fillDataFields('Antrag_Name\t\tCOMP-4711')).toEqual({
      fieldName: 'Antrag_Name', refID: '', compId: 'COMP-4711'
    });
    expect(fillDataFields('Antrag_Name\n\nCOMP-4711')).toEqual({
      fieldName: 'Antrag_Name', refID: '', compId: 'COMP-4711'
    });
  });

  it('drops the empty row a trailing newline leaves behind', () => {
    expect(fillDataFields('Antrag_Name\tRF-0815\tCOMP-4711\r\n')).toEqual({
      fieldName: 'Antrag_Name', refID: 'RF-0815', compId: 'COMP-4711'
    });
  });

  it('maps by workbook column header regardless of order', () => {
    expect(fillDataFields('Complimentary ID: COMP-4711\nFachdatenbezeichner: Antrag_Name\nRefID: RF-0815')).toEqual({
      fieldName: 'Antrag_Name', refID: 'RF-0815', compId: 'COMP-4711'
    });
  });

  it('maps a header column pasted beside its values', () => {
    expect(fillDataFields('Fachdatenbezeichner\tAntrag_Name\nRefID\tRF-0815\nComplimentary ID\tCOMP-4711')).toEqual({
      fieldName: 'Antrag_Name', refID: 'RF-0815', compId: 'COMP-4711'
    });
  });

  it('fills only the pair a group offers, ignoring the rest', () => {
    expect(fillDataFields('Antrag_Name\tRF-0815', 'fieldName', ['fieldName', 'refID'])).toEqual({
      fieldName: 'Antrag_Name', refID: 'RF-0815'
    });
    expect(fillDataFields('Antrag_Name\tRF-0815\tCOMP-4711', 'fieldName', ['fieldName', 'refID'])).toBeNull();
  });

  it('leaves a single identifier alone', () => {
    expect(parsePaste('Antrag_Name', DATA_FIELD_ALIASES, { keepEmptyCells: true })).toBeNull();
    expect(parsePaste('Antrag_Name\t', DATA_FIELD_ALIASES, { keepEmptyCells: true })).toBeNull();
  });
});
