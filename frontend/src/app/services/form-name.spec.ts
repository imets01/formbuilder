import { outputBaseName } from './form-name';

/**
 * The generated artifacts are named from the Developer base name, not the form title —
 * The platform names a form by a short code, not by a sentence.
 *
 * Mirrors backend/json_builder.py's `output_base_name`; its cases are asserted in
 * backend/test_spreadsheet_exporter.py, so keep the two sets in step.
 */
describe('outputBaseName', () => {
  it('falls back to the form title', () => {
    expect(outputBaseName('', 'EU Fahrtenheft für den Gelegenheitsverkehr beantragen'))
      .toBe('EU_Fahrtenheft_fuer_den_Gelegenheitsverkehr_beantragen');
  });

  it('overrides the title when set', () => {
    expect(outputBaseName('AbcQz356', 'EU Fahrtenheft beantragen')).toBe('AbcQz356');
  });

  /** The pipeline writes query<base>_de.sql, so typing the file name as it should appear
   *  on disk must not double the prefix. */
  it('drops a leading query the pipeline adds itself', () => {
    expect(outputBaseName('queryAbcQz356', 'Any title')).toBe('AbcQz356');
    expect(outputBaseName('query_AbcQz356', 'Any title')).toBe('AbcQz356');
    expect(outputBaseName('QueryAbcQz356', 'Any title')).toBe('AbcQz356');
  });

  it('keeps a base name that is nothing but the prefix, rather than emptying it', () => {
    expect(outputBaseName('query', 'Any title')).toBe('query');
  });

  it('sanitises what it is given', () => {
    expect(outputBaseName('BAV mz/356', 'Any title')).toBe('BAV_mz_356');
    expect(outputBaseName('   ', 'My form')).toBe('My_form');
  });
});
