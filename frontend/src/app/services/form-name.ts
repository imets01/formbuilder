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

/**
 * The technical form name the generated artifacts are named after.
 *
 * `baseName` (Developer settings) wins over the form title: the platform names a form by a
 * short code (AbcQz356 -> queryAbcQz356_de.sql), not by a sentence. A leading "query" is
 * dropped because the pipeline adds that prefix itself.
 *
 * Mirrors `output_base_name` in backend/json_builder.py — keep the two in sync.
 */
export function outputBaseName(baseName: string, title: string): string {
  const base = (baseName || '').trim();
  if (!base) return safeFormName(title);
  const name = safeFormName(base);
  return name.replace(/^query_*/i, '') || name;
}

/**
 * `<YYMMDD>_<form name>_<version>`, without extension.
 *
 * Mirrors `export_file_name` in backend/json_builder.py. Successive exports of one form
 * differ only by date and version, so both go in the name — the plain form name would just
 * collect the browser's " (1)", " (2)" suffixes and lose which spec is which.
 */
export function exportFileName(title: string, version = '', when: Date = new Date()): string {
  const stamp = [when.getFullYear() % 100, when.getMonth() + 1, when.getDate()]
    .map(n => String(n).padStart(2, '0'))
    .join('');
  // Dots survive — "2.1.1" is the point of it.
  const safeVersion = String(version ?? '').replace(/[^A-Za-z0-9.]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return [stamp, safeFormName(title), safeVersion].filter(Boolean).join('_');
}
