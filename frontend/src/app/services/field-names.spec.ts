import { invalidFieldNames, isValidFieldName, missingFieldNames } from './field-names';
import { isAutoResolved, ImportIssue } from './import-issues';
import type { FormSection } from './form-state.service';

function sections(fieldName: string): FormSection[] {
  return [{
    id: 'S1', title: 'Angaben', sourceRef: 'S_A',
    components: [{ id: 'text-input', instanceId: 'c1', fieldName } as any],
  } as FormSection];
}

describe('field names', () => {
  it('allows letters (umlauts too), digits and _ only', () => {
    for (const ok of ['F_Lic', 'F_Erklärung2', '', '  ', undefined, ' F_Trim ']) {
      expect(isValidFieldName(ok)).withContext(String(ok)).toBeTrue();
    }
    for (const bad of ['Name (alt)', 'F-Lic', 'F Lic', 'F.Lic', 'F/Lic', "F'Lic", 'F$Lic']) {
      expect(isValidFieldName(bad)).withContext(bad).toBeFalse();
    }
  });

  it('lists the offending names on the canvas', () => {
    expect(invalidFieldNames(sections('F_Ok'))).toEqual([]);
    expect(invalidFieldNames(sections('Lizenz (Nr)'))).toEqual(['Lizenz (Nr)']);
  });

  it('lists fields still without a Fachdatenbezeichner, and clears that issue once all have one', () => {
    expect(missingFieldNames(sections(''))).toEqual(['text-input']);
    expect(missingFieldNames(sections('F_Ok'))).toEqual([]);
    const issue: ImportIssue = { code: 'field-names-missing', message: '' };
    expect(isAutoResolved(issue, sections(''))).toBeFalse();
    expect(isAutoResolved(issue, sections('F_Ok'))).toBeTrue();
  });

  it('clears the import issue once the name is fixed', () => {
    const issue: ImportIssue = { code: 'field-name-invalid', message: '', fieldName: 'Lizenz (Nr)' };
    expect(isAutoResolved(issue, sections('Lizenz (Nr)'))).toBeFalse();
    expect(isAutoResolved(issue, sections('LizenzNr'))).toBeTrue();
  });
});
