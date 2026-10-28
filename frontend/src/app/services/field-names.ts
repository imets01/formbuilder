import type { FormComponentInstance, FormSection } from './form-state.service';

/** Mirrors backend/field_names.py — the generator refuses anything this rejects. */
const FIELD_NAME = /^[\p{L}0-9_]*$/u;

export const FIELD_NAME_RULE = 'Only letters, digits and _ are allowed.';

export function isValidFieldName(name: string | null | undefined): boolean {
  return FIELD_NAME.test((name ?? '').trim());
}

export function fieldNameError(name: string | null | undefined): string {
  return isValidFieldName(name) ? '' : FIELD_NAME_RULE;
}

export function invalidFieldNames(sections: FormSection[]): string[] {
  const invalid = new Set<string>();
  const check = (name: string | undefined) => {
    if (!isValidFieldName(name)) invalid.add(name!.trim());
  };
  for (const section of sections) {
    check(section.sourceRef);
    check(section.aggregateFachdatenbezeichner);
    for (const comp of section.components) {
      check(comp.fieldName);
      check(comp.splitConfig?.a.fieldName);
      check(comp.splitConfig?.b.fieldName);
      comp.options?.forEach(option => check(option.fieldName));
    }
  }
  return [...invalid];
}

/** Components whose Fachdatenbezeichner the generator does not need: display text, and the
 *  electronic consent, which the platform renders with fixed names of its own. */
const UNNAMED_ALLOWED = new Set(['text', 'electronic-consent']);

function labelOf(comp: FormComponentInstance): string {
  return comp.translations?.title?.['DE'] || comp.title || comp.label || comp.id;
}

export function missingFieldNames(sections: FormSection[]): string[] {
  const missing: string[] = [];
  for (const section of sections) {
    if (section.isMetadata) continue;
    for (const comp of section.components) {
      if (UNNAMED_ALLOWED.has(comp.id)) continue;
      if (comp.splitConfig) {
        for (const side of [comp.splitConfig.a, comp.splitConfig.b]) {
          if (!(side.fieldName ?? '').trim()) missing.push(side.titles?.['DE'] || labelOf(comp));
        }
      } else if (!(comp.fieldName ?? '').trim()) {
        missing.push(labelOf(comp));
      }
    }
  }
  return missing;
}
