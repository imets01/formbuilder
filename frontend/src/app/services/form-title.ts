/**
 * Name uniqueness for saved forms.
 *
 * Mirrors the `_title_key` / `find_by_title` pair in backend/forms_store.py — the
 * server is the authority, this is what lets the title field object before a
 * rename is ever sent. Comparison runs on the technical name (so "Permit (2)" and
 * "Permit 2" are one name) and ignores case.
 */

import { safeFormName } from './form-name';

export const DEFAULT_FORM_TITLE = 'Untitled Form';

export function formTitleKey(title: string): string {
  return safeFormName((title || '').trim() || DEFAULT_FORM_TITLE).toLowerCase();
}

/** Whether `title` is the same name as any of `taken`. */
export function isFormTitleTaken(title: string, taken: Iterable<string>): boolean {
  const key = formTitleKey(title);
  for (const other of taken) {
    if (formTitleKey(other) === key) return true;
  }
  return false;
}
