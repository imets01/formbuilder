import type { FormSection, FormComponentInstance, LogicCondition } from './form-state.service';
import { invalidFieldNames, missingFieldNames } from './field-names';

/**
 * A finding the spreadsheet importer couldn't reconstruct, kept with the form so it can
 * be reopened long after the import (see FormStateService.importIssues).
 *
 * `code` comes from backend/excel_importer.py's _issue calls and decides how the finding
 * can clear itself; the rest are anchors pointing back at the row it came from.
 */
export interface ImportIssue {
  code: string;
  message: string;
  /** 1-based row in the source sheet, as Excel numbers it. 0 when not attributable. */
  row?: number;
  sheet?: string;
  label?: string;
  fieldName?: string;
  inputId?: string;
  /** The field/section whose show-hide condition was dropped, for the logic codes. */
  target?: { kind: 'field' | 'section'; row?: number; label?: string; fieldName?: string };
  /** Set when the user marked the issue fixed by hand. */
  fixedAt?: number;
  /**
   * Set when the issue already looked resolved the moment it was imported — a skipped row
   * whose label another field happens to carry. Its name match proves nothing, so the
   * issue falls back to needing a human (see annotateAmbiguity).
   */
  ambiguous?: boolean;
}

/**
 * How an issue can stop counting:
 *  - `field-exists`  the row was dropped, so it clears once a field/option/section of that
 *                    name (or Fachdatenbezeichner) is on the canvas;
 *  - `logic-present` the row imported but its condition was dropped, so it clears once
 *                    that field or section carries any show/hide condition;
 *  - `name-gone`     the row imported under a name the generator refuses, so it clears
 *                    once nothing on the canvas carries that name any more;
 *  - `names-filled`  fields imported without a Fachdatenbezeichner; clears once every field
 *                    on the canvas has one;
 *  - `manual`        nothing in the document says whether it was dealt with — only the
 *                    user can say so.
 */
export type ResolutionKind = 'field-exists' | 'logic-present' | 'name-gone' | 'names-filled' | 'manual';

const RESOLUTION: Record<string, ResolutionKind> = {
  'format-unknown': 'field-exists',
  'format-missing': 'field-exists',
  'format-deferred': 'field-exists',
  'option-without-group': 'field-exists',
  'group-outside-aggregate': 'field-exists',
  'logic-unreadable': 'logic-present',
  'logic-dangling-ref': 'logic-present',
  'logic-hidden-unreachable': 'logic-present',
  'field-name-invalid': 'name-gone',
  // The condition was imported, just possibly misread — only a human can confirm it.
  'logic-unbalanced': 'manual',
  'logic-without-input-ids': 'manual',
  'aggregate-unclosed': 'manual',
  'developer-attrs-ignored': 'manual',
  'field-names-missing': 'names-filled',
  'aggregate-autoclosed': 'manual',
  'aggregate-end-orphan': 'manual',
};

/** One-line hint on what closes the issue, shown under the message. */
const ADVICE: Record<ResolutionKind, string> = {
  'field-exists': 'Clears itself once a field or option of this name exists in the builder.',
  'logic-present': 'Clears itself once this field or section has a show/hide condition.',
  'name-gone': 'Clears itself once the Fachdatenbezeichner is renamed to letters, digits and _ only.',
  'names-filled': 'Clears itself once every field has a Fachdatenbezeichner.',
  'manual': 'Check this one in the builder, then mark it as checked.',
};

export function resolutionFor(code: string): ResolutionKind {
  return RESOLUTION[code] ?? 'manual';
}

export function adviceFor(issue: ImportIssue): string {
  return ADVICE[issue.ambiguous ? 'manual' : resolutionFor(issue.code)];
}

function norm(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function titleOf(comp: FormComponentInstance): string {
  return comp.translations?.title?.['DE'] || comp.title || comp.translations?.content?.['DE']
    || comp.content || '';
}

function hasLogic(target: { showLogic?: LogicCondition[]; hideLogic?: LogicCondition[] }): boolean {
  return !!(target.showLogic?.length || target.hideLogic?.length);
}

/** Every name a canvas thing can be found by: labels in any language, plus data names. */
function namesIn(sections: FormSection[]): Set<string> {
  const names = new Set<string>();
  const add = (value: string | undefined) => {
    const key = norm(value);
    if (key) names.add(key);
  };
  for (const section of sections) {
    add(section.title);
    add(section.sourceRef);
    add(section.aggregateFachdatenbezeichner);
    Object.values(section.translations?.title ?? {}).forEach(add);
    for (const comp of section.components) {
      add(comp.fieldName);
      Object.values(comp.translations?.title ?? {}).forEach(add);
      Object.values(comp.translations?.content ?? {}).forEach(add);
      add(comp.title);
      if (comp.splitConfig) {
        for (const side of [comp.splitConfig.a, comp.splitConfig.b]) {
          add(side.fieldName);
          Object.values(side.titles ?? {}).forEach(add);
        }
      }
      for (const option of comp.options ?? []) {
        add(option.fieldName);
        Object.values(option.translations ?? {}).forEach(add);
      }
    }
  }
  return names;
}

/**
 * Whether the thing the issue names now carries show/hide logic.
 *
 * Matched on the Fachdatenbezeichner first (it survives relabelling) and on the German
 * label otherwise — the same two anchors the importer recorded.
 */
function targetHasLogic(issue: ImportIssue, sections: FormSection[]): boolean {
  const target = issue.target;
  if (!target) return false;
  const wantedName = norm(target.fieldName);
  const wantedLabel = norm(target.label);
  if (!wantedName && !wantedLabel) return false;

  const matches = (name: string | undefined, label: string | undefined) =>
    wantedName ? norm(name) === wantedName : norm(label) === wantedLabel;

  for (const section of sections) {
    if (target.kind === 'section') {
      if (matches(section.sourceRef ?? section.aggregateFachdatenbezeichner, section.title)
          && hasLogic(section)) {
        return true;
      }
      continue;
    }
    for (const comp of section.components) {
      if (matches(comp.fieldName, titleOf(comp)) && hasLogic(comp)) return true;
    }
  }
  return false;
}

/**
 * Whether the document itself shows the issue has been dealt with.
 *
 * Deliberately generous for `field-exists`: a name match is taken as "the user added this
 * row by hand", because the builder has no link back to a row it never imported. The
 * "mark as checked" button covers everything this cannot see.
 */
export function isAutoResolved(issue: ImportIssue, sections: FormSection[],
                               names?: Set<string>): boolean {
  if (issue.ambiguous) return false;
  switch (resolutionFor(issue.code)) {
    case 'field-exists': {
      const pool = names ?? namesIn(sections);
      return [issue.fieldName, issue.label].some(value => {
        const key = norm(value);
        return !!key && pool.has(key);
      });
    }
    case 'logic-present':
      return targetHasLogic(issue, sections);
    case 'name-gone':
      return !invalidFieldNames(sections).some(name => norm(name) === norm(issue.fieldName));
    case 'names-filled':
      return !missingFieldNames(sections).length;
    default:
      return false;
  }
}

/**
 * Flag the issues that already look resolved against the freshly imported form.
 *
 * Run once, on the import's own output: an issue that its own import satisfies can never
 * be read as "the user fixed this", so it is pinned to a manual check instead of being
 * silently hidden. Must run before the user edits anything.
 */
export function annotateAmbiguity(issues: ImportIssue[], sections: FormSection[]): ImportIssue[] {
  if (!issues.length) return issues;
  const names = namesIn(sections);
  return issues.map(issue =>
    isAutoResolved(issue, sections, names) ? { ...issue, ambiguous: true } : issue);
}

/** The issues still outstanding: not marked fixed, and not resolved by the document. */
export function outstandingIssues(issues: ImportIssue[], sections: FormSection[]): ImportIssue[] {
  if (!issues.length) return [];
  const names = namesIn(sections);
  return issues.filter(issue => !issue.fixedAt && !isAutoResolved(issue, sections, names));
}

/**
 * Ask before replacing a form from a spreadsheet. Shared by the three places that offer
 * it (My Forms, the import-issue panel, the Generate menu) so the warning is the same one.
 */
export function confirmReimport(fileName: string, formName?: string): boolean {
  const what = formName ? `"${formName}"` : 'this form';
  return confirm(
    `Replace ${what} with the contents of ${fileName}?\n\n` +
    `Everything built in the builder for this form is overwritten by the spreadsheet. ` +
    `Its name, deployment settings and display toggles are kept.`
  );
}

/** Stable identity for an issue, so marking one fixed doesn't depend on list order. */
export function issueKey(issue: ImportIssue): string {
  return `${issue.code}|${issue.row ?? 0}|${issue.inputId ?? ''}|${issue.label ?? ''}`;
}
