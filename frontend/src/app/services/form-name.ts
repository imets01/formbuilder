/**
 * Technical form name derived from the free-text form title.
 *
 * Mirrors `safe_form_name` in backend/json_builder.py — the backend names every
 * generated file this way, so the download names the browser writes have to agree.
 * Keep the two in sync: ASCII only, underscores for separators, capped length.
 */

const TRANSLITERATIONS: Record<string, string> = {
  'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss'
};

export const MAX_FORM_NAME_LEN = 60;

export function safeFormName(title: string): string {
  let text = (title || '').replace(/[äöüÄÖÜß]/g, ch => TRANSLITERATIONS[ch]);
  // Remaining accents (é, à, ç) fold to their base letter; anything still non-ASCII drops.
  text = text.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  let name = text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (name.length > MAX_FORM_NAME_LEN) {
    const cut = name.slice(0, MAX_FORM_NAME_LEN);
    const atWord = cut.includes('_') ? cut.slice(0, cut.lastIndexOf('_')) : cut;
    name = atWord.replace(/^_+|_+$/g, '') || cut;
  }
  return name || 'actualForm';
}
