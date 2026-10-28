import { FormSection } from './form-state.service';
import { ImportIssue, annotateAmbiguity, outstandingIssues, resolutionFor } from './import-issues';

/**
 * The rules that let an import issue clear itself. The risk here is silence: an issue that
 * disappears without being dealt with is worse than one that lingers, so every case below
 * pins down which side of that line a situation falls on.
 */
describe('import issue resolution', () => {
  const tr = (s: string) => ({ DE: s, FR: s, IT: s, EN: s });

  const field = (fieldName: string, titleDe: string, extra: any = {}) => ({
    id: 'text-input', name: 'Text', icon: 'text_fields',
    instanceId: `i_${fieldName}`, label: 'Text', required: false,
    fieldName, title: titleDe, translations: { title: tr(titleDe) }, ...extra
  });

  const sections = (...components: any[]): FormSection[] =>
    [{ id: 'S1', title: 'Angaben', sourceRef: 'S_Ang', components }];

  const issue = (over: Partial<ImportIssue> = {}): ImportIssue => ({
    code: 'format-unknown', message: 'Kaputtes Feld — unknown format "Wurst"',
    row: 9, label: 'Kaputtes Feld', fieldName: 'F_Broken', ...over
  });

  it('keeps a skipped row outstanding while nothing of that name exists', () => {
    const open = outstandingIssues([issue()], sections(field('F_Other', 'Anderes Feld')));
    expect(open.length).toBe(1);
  });

  it('clears a skipped row once a field of that Fachdatenbezeichner is added', () => {
    const open = outstandingIssues([issue()], sections(field('F_Broken', 'Neu benannt')));
    expect(open.length).toBe(0);
  });

  it('clears a skipped row once a field of that German label is added', () => {
    const open = outstandingIssues([issue()], sections(field('', 'Kaputtes Feld')));
    expect(open.length).toBe(0);
  });

  it('matches an option label, not just a field label', () => {
    const orphan = issue({
      code: 'option-without-group', fieldName: '', label: 'Verwaiste Option'
    });
    const group = field('F_Group', 'Auswahl', {
      id: 'radio',
      options: [{ optionId: 'o1', fieldName: '', refID: '', translations: tr('Verwaiste Option') }]
    });
    expect(outstandingIssues([orphan], sections(group)).length).toBe(0);
  });

  it('never clears a row whose name was already taken at import time', () => {
    // The skipped row's label collides with a field that imported fine, so a name match
    // says nothing about whether the user did anything — it has to be ticked off by hand.
    const document = sections(field('F_Other', 'Kaputtes Feld'));
    const [annotated] = annotateAmbiguity([issue()], document);
    expect(annotated.ambiguous).toBe(true);
    expect(outstandingIssues([annotated], document).length).toBe(1);
  });

  it('clears a dropped condition once its field carries show/hide logic', () => {
    const dangling = issue({
      code: 'logic-dangling-ref', inputId: '99',
      label: 'Bedingtes Feld', fieldName: 'F_Cond',
      target: { kind: 'field', row: 8, label: 'Bedingtes Feld', fieldName: 'F_Cond' }
    });

    const withoutLogic = sections(field('F_Cond', 'Bedingtes Feld'));
    expect(outstandingIssues([dangling], withoutLogic).length).toBe(1);

    const withLogic = sections(field('F_Cond', 'Bedingtes Feld', { showLogic: ['opt_1'] }));
    expect(outstandingIssues([dangling], withLogic).length).toBe(0);
  });

  it('clears a section condition only when that section carries the logic', () => {
    const dropped = issue({
      code: 'logic-unreadable', label: 'Angaben', fieldName: 'S_Ang',
      target: { kind: 'section', row: 2, label: 'Angaben', fieldName: 'S_Ang' }
    });

    // Logic on a field inside the section is not the section's own condition.
    const fieldLogic = sections(field('F_A', 'Feld', { showLogic: ['opt_1'] }));
    expect(outstandingIssues([dropped], fieldLogic).length).toBe(1);

    const sectionLogic: FormSection[] = [
      { ...fieldLogic[0], showLogic: ['opt_1'] }
    ];
    expect(outstandingIssues([dropped], sectionLogic).length).toBe(0);
  });

  it('leaves structural findings to a human, even when a name matches', () => {
    const unclosed = issue({ code: 'aggregate-unclosed', label: 'Beteiligte', fieldName: 'F_Agg' });
    expect(resolutionFor(unclosed.code)).toBe('manual');

    const document = sections(field('F_Agg', 'Beteiligte'));
    expect(outstandingIssues([unclosed], document).length).toBe(1);

    const checked = { ...unclosed, fixedAt: Date.now() };
    expect(outstandingIssues([checked], document).length).toBe(0);
  });

  it('treats an unknown code as needing a human rather than clearing it', () => {
    expect(resolutionFor('something-new-from-the-backend')).toBe('manual');
  });
});
