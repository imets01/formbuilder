"""
Import a legacy PSPH form spreadsheet (.xlsx/.csv) into a formbuilder payload.

This is the inverse of json_builder's forward mapping: it reads the "Format PSPH"
column and rebuilds builder components, producing the same
{sections, formTitle, deployment, ...} shape the frontend emits — so an imported
form flows straight through the existing clean pipeline.

Phase 1 covers: the metadata header, common single-row inputs (text/number/date/
email/phone/textarea), option groups (radio/checkbox/dropdown), correspondence
language, uploads, info-text/header blocks and buttons. Adjacent Name+Vorname /
Strasse+Nr / PLZ+Ort text rows are recombined into split inputs. Catalogs and
show/hide-logic ID translation are reconstructed too. Aggregates (repeatable blocks)
are rebuilt as `isAggregate` sections: the rows between "Aggregat(e) start" and
"Aggregate end" become the block's components and the "Group N" rows its groups.

Columns are matched by header *name* (ASCII-folded, so umlaut/encoding variants
collapse together), never by position — different template versions reorder and
rename columns.

A row whose "Feld in PSPH deutsch" cell is empty is treated as Acta-Nova-managed
and skipped
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any, Optional


# ── The 7 form-header metadata fields, in builder order (mirrors the frontend). ──
METADATA_FIELDS = [
    ('meta-title', 'Form Title'),
    ('meta-description', 'Description'),
    ('meta-department', 'Department'),
    ('meta-federalOffice', 'Federal Office'),
    ('meta-section', 'Section'),
    ('meta-address', 'Address'),
    ('meta-zipCity', 'ZIP and City'),
]

# id -> (palette name, material icon) for the components Phase 1 can emit.
_PALETTE = {
    'text-input': ('Text Input', 'text_fields'),
    'text-area': ('Text Area', 'notes'),
    'email': ('E-mail', 'mail'),
    'phone': ('Phone', 'phone'),
    'date': ('Date', 'calendar_today'),
    'number': ('Number', 'numbers'),
    'radio': ('Radio Button', 'radio_button_checked'),
    'checkbox': ('Checkbox Group', 'check_box'),
    'select-single': ('Dropdown', 'arrow_drop_down_circle'),
    'select-multi': ('Multi-Selection', 'playlist_add_check'),
    'korrespondenzsprache': ('Correspondence Language', 'translate'),
    'electronic-consent': ('Electronic Consent', 'gavel'),
    'upload-single': ('File Upload', 'upload_file'),
    'upload-multi': ('Multi-File Upload', 'cloud_upload'),
    'button': ('Button', 'smart_button'),
    'text': ('Text', 'short_text'),
}

# Format PSPH (ASCII-folded) -> builder component id, for single-row fields.
_SINGLE_FORMATS = {
    'texteinzeilig': 'text-input',
    'textmehrzeilig': 'text-area',
    'ganzzahl': 'number',
    'float': 'number',
    'telefonnummer': 'phone',
    'datum': 'date',
    'uploadfeldeinfach': 'upload-single',
    'uploadfeldmehrfach': 'upload-multi',
    'button': 'button',
    'infobox': 'text',
    'infotext': 'text',
    'kontrollkasten': 'single-checkbox',
}
_SPLIT_PAIRS = [
    (('name',),    ('vorname',),                              'name-vorname'),
    (('strasse',), ('nr', 'nummer', 'hausnr', 'hausnummer'), 'strasse-nr'),
    (('plz',),     ('ort',),                                  'plz-ort'),
]

# Split variant -> (palette name, material icon), mirroring the frontend palette.
_SPLIT_PALETTE = {
    'name-vorname': ('First Name + Name', 'badge'),
    'strasse-nr':   ('Street + No.', 'signpost'),
    'plz-ort':      ('ZIP + City', 'location_city'),
}

# Option-group title rows -> component id (each starts a group that consumes the
# option rows that follow it). Keyed on the canonical "title" spelling; _classify
# folds the German "Titel" to "title" first, so either spelling matches.
_TITLE_FORMATS = {
    'radiobuttontitle': 'radio',
    'checkboxtitle': 'checkbox',
    'dropdownfieldtitle': 'select-single',
}

# Option rows that attach to the current group.
_OPTION_FORMATS = {
    'radiobuttonoption', 'checkboxoption', 'dropdownfieldoption',
    'auswahlfeldeinfachoption', 'auswahlfeldmehrfachoption',
}

# ASCII-folded metadata formats -> meta id. The German spellings are the ones the PSPH
# template now writes; the English ones stay for sheets built against older templates.
# 'formulartitel' is keyed as 'formulartitle' because _classify folds Titel -> title first.
_METADATA_FORMATS = {
    'titleoftheform': 'meta-title',
    'descriptionoftheform': 'meta-description',
    'departmentoftheform': 'meta-department',
    'federalofficeoftheform': 'meta-federalOffice',
    'sectionoftheform': 'meta-section',
    'addressoftheform': 'meta-address',
    'zipandcityoftheform': 'meta-zipCity',
    'formulartitle': 'meta-title',
    'beschreibung': 'meta-description',
    'beschreibungformular': 'meta-description',
    'departement': 'meta-department',
    'bundesamt': 'meta-federalOffice',
    'sektionbundesamt': 'meta-section',
    'adressebundesamt': 'meta-address',
    'plzundortdesbundesamtes': 'meta-zipCity',
    'plzundortdesbundesamt': 'meta-zipCity',
}

# Canonical column key -> ASCII-folded header substrings that identify it.
_COLUMN_MATCHERS = {
    'input_id': ['inputid'],
    'show_logic': ['logikanzeigen'],
    'hide_logic': ['logikausblenden'],
    'hidden': ['verstecktesfeld'],
    'required': ['mussfeld'],
    'size': ['grsse', 'lnge', 'grsselnge'],
    'name_an_de': ['nameandeutsch'],
    'label_de': ['feldinpsphdeutsch'],
    'label_fr': ['namepsphfranz'],
    'label_it': ['namepsphitalien'],
    'label_en': ['namepsphengl'],
    'ph_it': ['hinweisimfeldpsphitalien'],
    'ph_fr': ['hinweisimfeldpsphfranz'],
    'ph_de': ['hinweisimfeldpsphdeutsch'],
    'mo_it': ['mouseoverpsphitalien'],
    'mo_fr': ['mouseoverpsphfranz'],
    'mo_de': ['mouseoverpsphdeutsch'],
    'format': ['formatpsph'],
    'field_name': ['fachdatenbezeichner'],
    'ref_id': ['refid'],
    'comp_id': ['complimentaryid'],
    'file_formats': ['dateiformate'],
    'comments': ['fragenbemerkungen'],
    'disable_mouse_over': ['mouseovernichtanzeigen'],
    'weblink': ['weblink'],
    'control': ['bemerkungsteuerung'],
}


def _fold(value: Any) -> str:
    """Lowercase, drop non-ASCII (so ö/ä and their mojibake collapse), keep a-z0-9."""
    text = '' if value is None else str(value)
    ascii_only = text.encode('ascii', 'ignore').decode('ascii')
    return re.sub(r'[^a-z0-9]', '', ascii_only.lower())


_LOGIC_TOKEN = re.compile(r'\d+(?:\.\d+)?|[\[\]]')


def _flatten_or_group(node: list) -> list[str]:
    """Every Input ID token inside a (possibly nested) OR group, in order, de-duplicated."""
    out: list[str] = []
    for item in node:
        for tok in (_flatten_or_group(item) if isinstance(item, list) else [item]):
            if tok not in out:
                out.append(tok)
    return out


def _parse_logic_cell(raw: str) -> tuple[list, bool]:
    """Parse a "Logik anzeigen"/"Logik ausblenden" cell into AND/OR terms.

    The sheet notation (PSPH field guide, "Logik anzeigen") is a bracketed array whose
    top level is an AND — every entry must hold — while a nested array is an OR, of which
    at least one entry must hold: "[5, [8, 11]]" is 5 and either 8 or 11. Nesting below
    the first level stays OR, since the guide reads "[[5, 7, [11, 12]], 17]" as "5 or 7 or
    11 or 12, and 17", so a group collapses to a flat set of alternatives.

    Returns (terms, well_formed), where each term is an Input ID token (an AND entry) or a
    list of them (an OR group). A cell with no brackets at all is read as the top level,
    so a bare "5" and a bare "5, 8" mean 5, and 5 and 8 respectively.
    """
    stack: list[list] = [[]]
    well_formed = True
    for tok in _LOGIC_TOKEN.findall(raw or ''):
        if tok == '[':
            stack.append([])
        elif tok == ']':
            if len(stack) == 1:
                well_formed = False  # a ] that closes nothing
                continue
            stack[-2].append(stack.pop())
        else:
            stack[-1].append(tok)
    if len(stack) > 1:  # brackets left open
        well_formed = False
        while len(stack) > 1:
            stack[-2].append(stack.pop())

    top = stack[0]
    # The cell is normally wrapped in one pair of brackets, and that outer array *is* the
    # top-level AND list rather than a single OR group.
    if len(top) == 1 and isinstance(top[0], list):
        top = top[0]

    terms: list = []
    for item in top:
        if isinstance(item, list):
            alts = _flatten_or_group(item)
            if alts:
                terms.append(alts[0] if len(alts) == 1 else alts)
        else:
            terms.append(item)
    return terms, well_formed


def _as_bool(value: Any) -> bool:
    return _fold(value) in ('ja', 'yes', 'true', 'x', '1')


def _strip_tags(text: str) -> str:
    return re.sub(r'<[^>]+>', '', text or '')


def _strip_html(text: str) -> str:
    return _strip_tags(text).strip()


def _split_link(text: str) -> tuple[str, str]:
    """Return (label, href) for a value that may contain an <a href="...">…</a>.
    """
    if not text:
        return '', ''
    match = re.search(r'<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>(.*?)</a>', text, re.S | re.I)
    if not match:
        return _strip_html(text), ''
    href = (match.group(1) or '').strip()
    inner = _strip_html(match.group(2))
    before, after = _strip_tags(text[:match.start()]), _strip_tags(text[match.end():])
    if not inner:
        return f'{before}{after}'.strip(), href
    return f'{before}<a>{inner}</a>{after}'.strip(), href


def _decode_csv(raw: bytes) -> str:
    for encoding in ('utf-8-sig', 'utf-8', 'cp1252'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode('cp1252', 'replace')


def _read_rows(raw: bytes, filename: str) -> list[list[str]]:
    """Return the spreadsheet (the form sheet) as a list of string rows."""
    if filename.lower().endswith('.csv'):
        text = _decode_csv(raw)
        return [[(c or '') for c in row] for row in csv.reader(io.StringIO(text))]

    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    # A workbook usually has several sheets (the form, an internal Acta-Nova sheet,
    # a Version sheet, catalogs…). Several carry a "Format PSPH" column, so pick the
    # one with the most actual form rows rather than the first match.
    def sheet_rows(ws):
        return [['' if c is None else str(c) for c in row]
                for row in ws.iter_rows(values_only=True)]

    def form_score(rows):
        header = next((r for r in rows[:6] if any('formatpsph' in _fold(c) for c in r)), None)
        if header is None:
            return 0
        fmt_idx = _match_columns(header).get('format')
        if fmt_idx is None:
            return 0
        kinds = ('metadata', 'header', 'component', 'option', 'title')
        return sum(1 for r in rows
                   if fmt_idx < len(r) and _classify(r[fmt_idx])[0] in kinds)

    best = max((sheet_rows(ws) for ws in wb.worksheets),
               key=form_score, default=[])
    wb.close()
    return best


def _match_columns(header: list[str]) -> dict[str, int]:
    folded = [_fold(h) for h in header]
    cols: dict[str, int] = {}
    for key, needles in _COLUMN_MATCHERS.items():
        for idx, h in enumerate(folded):
            if h and any(n in h for n in needles):
                cols[key] = idx
                break
    return cols


def _classify(fmt: str):
    """Return a classification tuple for a Format PSPH cell.

    Kinds: blank, internal, metadata, email-of-form, header, option, defer,
    aggregate-start, aggregate-group, aggregate-end,
    unknown, ('component', id, is_float) and ('title', id, silent_options) where
    `silent_options` means the group's option rows are rebuilt by the builder
    (electronic consent) and shouldn't be imported.
    """
    f = _fold(fmt)
    if not f:
        return ('blank',)
    # English "title" and German "Titel" are used interchangeably in these sheets
    # (and either spelling can appear in future templates), so collapse them.
    f = f.replace('titel', 'title')
    if f in _METADATA_FORMATS:
        return ('metadata', _METADATA_FORMATS[f])
    if 'emailoftheform' in f or 'emailbundesamt' in f:
        return ('email-of-form',)
    if f in ('header', 'textheader'):
        return ('header',)
    if 'keinfeld' in f and 'formularsprache' not in f:
        return ('internal',)  # "kein Feld (interne Daten)" — backend-only, not shown
    if f in _OPTION_FORMATS:
        return ('option',)
    if f in _TITLE_FORMATS:
        return ('title', _TITLE_FORMATS[f], False)
    if 'korrespondenzsprache' in f or 'formularsprache' in f:
        return ('title', 'korrespondenzsprache', False)
    if 'zustimmung' in f:
        return ('title', 'electronic-consent', True)  # fixed Yes/No, options rebuilt
    if 'auswahlfeld' in f or 'katalog' in f:
        single = 'einfach' in f and 'mehrfach' not in f
        return ('title', 'select-single' if single else 'select-multi', False)
    if f.startswith('group'):
        return ('aggregate-group',)
    if 'aggregat' in f:  # 'aggregat', so the German "Aggregat start/end" matches too
        if f.endswith('start'):
            return ('aggregate-start',)
        if f.endswith('end'):
            return ('aggregate-end',)
        return ('defer', 'unrecognised aggregate marker')
    if 'emailadresse' in f:
        return ('component', 'email', False)
    if f in _SINGLE_FORMATS:
        return ('component', _SINGLE_FORMATS[f], f == 'float')
    return ('unknown', fmt)


class _Importer:
    def __init__(self, rows: list[list[str]]):
        self.rows = rows
        self.skipped: list[str] = []
        self.metadata: dict[str, dict[str, str]] = {}
        self.metadata_links: dict[str, str] = {}
        self.contact_email = ''
        self.sections: list[dict] = []
        self.current: Optional[dict] = None
        self.group: Optional[dict] = None  # last option-group component
        self.group_silent = False           # eat the group's option rows (fixed lists)
        self.aggregate: Optional[dict] = None  # open repeatable block, until "Aggregate end"
        self._n = 0
        self._optid_by_input_id: dict[str, str] = {}
        # (target dict, show terms, hide terms, source, mark-hidden) per row carrying logic,
        # resolved only once every option has been seen — see _resolve_pending_logic.
        self._pending_logic: list[tuple] = []
        # (normalised Input ID token, source label) for every show/hide reference seen,
        # checked against the complete option map at the end of the pass.
        self._logic_refs: list[tuple[str, str]] = []

    def _uid(self, prefix: str) -> str:
        self._n += 1
        return f'{prefix}_{self._n}'

    @staticmethod
    def _norm_input_id(token: str) -> str:
        """Normalise an Input ID / reference token so "[17]", "17" and "60.00" all match."""
        token = (token or '').strip().strip('[]').strip()
        try:
            return str(int(float(token)))
        except (TypeError, ValueError):
            return token

    def _defer_logic(self, target: dict, row, cols, source: str, *,
                     mark_hidden: bool = False) -> None:
        """Parse this row's show/hide cells now; resolve their references later.

        Only the parse happens here, so a malformed cell is reported in document order.
        Resolution waits for the whole sheet (see _resolve_pending_logic). `mark_hidden`
        says a resolved Show/Hide condition implies the row starts hidden — true for
        fields, false for a section, whose heading carries that itself.
        """
        parsed_cells = []
        for key in ('show_logic', 'hide_logic'):
            raw = self._get(row, cols, key)
            terms, well_formed = _parse_logic_cell(raw)
            if raw.strip() and not terms:
                self.skipped.append(
                    f'{source} — show/hide condition "{raw.strip()}" names no Input ID; '
                    f'the condition was dropped')
            elif terms and not well_formed:
                self.skipped.append(
                    f'{source} — show/hide condition "{raw.strip()}" has unbalanced '
                    f'brackets; the groups were read as best they could be, so check it')
            parsed_cells.append(terms)
        if parsed_cells[0] or parsed_cells[1]:
            self._pending_logic.append(
                (target, parsed_cells[0], parsed_cells[1], source, mark_hidden))

    def _terms_to_conditions(self, terms: list, source: str):
        """Map parsed Input ID terms onto builder LogicCondition[] — an AND of entries.

        Every token is recorded (with `source` naming the field or section it belongs to)
        so genuinely dangling references can be reported once the sheet has been read.
        """
        out: list = []
        for term in terms:
            tokens = term if isinstance(term, list) else [term]
            oids: list[str] = []
            for tok in tokens:
                norm = self._norm_input_id(tok)
                if source:
                    self._logic_refs.append((norm, source))
                oid = self._optid_by_input_id.get(norm)
                if oid and oid not in oids:
                    oids.append(oid)
            if oids:
                out.append(oids if len(oids) > 1 else oids[0])
        return out or None

    def _resolve_pending_logic(self) -> None:
        """Resolve every show/hide cell against the complete option map.

        Resolving during the row walk silently dropped any reference to an option defined
        further *down* the sheet, because its Input ID wasn't in the map yet — and the
        dangling-reference report could not see it either, since by the end of the pass the
        id does exist. With the cell's top level being an AND, losing one entry weakens the
        condition and reveals the field earlier than the workbook specifies, so a forward
        reference like "[3, 8]" on row 5 would show the field on 3 alone.

        Runs before _merge_split_inputs, which copies the resolved values into the merged
        component.
        """
        for target, show_terms, hide_terms, source, mark_hidden in self._pending_logic:
            show = self._terms_to_conditions(show_terms, source)
            hide = self._terms_to_conditions(hide_terms, source)
            if show:
                target['showLogic'] = show
            if hide:
                target['hideLogic'] = hide
            if mark_hidden and (show or hide):
                target['hiddenField'] = True

    def run(self) -> dict:
        if not self.rows:
            return self._payload()
        header = self._find_header()
        cols = _match_columns(header)
        if 'format' not in cols:
            raise ValueError("Not a PSPH form sheet: no 'Format PSPH' column found.")

        start = self.rows.index(header) + 1
        for row in self.rows[start:]:
            self._row(row, cols)
        if self.aggregate is not None:
            self.skipped.append(
                f'{self.aggregate["title"]} — aggregate has no "Aggregate end" row; every '
                f'field after its start was imported into the block')
        self._resolve_pending_logic()
        self._merge_split_inputs()
        self._report_unresolved_logic()
        return self._payload()

    def _find_header(self) -> list[str]:
        for row in self.rows:
            if any('formatpsph' in _fold(c) for c in row):
                return row
        return self.rows[0]

    def _get(self, row, cols, key) -> str:
        idx = cols.get(key)
        return (row[idx].strip() if idx is not None and idx < len(row) and row[idx] else '')

    def _report_unresolved_logic(self) -> None:
        """Warn about show/hide references that match no imported option.

        Checked against the *complete* option map so backward references that were
        resolved during the pass stay silent; only genuinely dangling [Input ID]
        tokens (typo'd, or pointing at a row that wasn't imported) are reported.
        """
        seen: set[tuple[str, str]] = set()
        for tok, source in self._logic_refs:
            if tok in self._optid_by_input_id or (tok, source) in seen:
                continue
            seen.add((tok, source))
            self.skipped.append(
                f'{source} — show/hide condition references [{tok}], which matches no '
                f'option; the condition was dropped')

    def _langs(self, row, cols, prefix) -> dict[str, str]:
        de = self._get(row, cols, f'{prefix}_de')
        fr = self._get(row, cols, f'{prefix}_fr')
        it = self._get(row, cols, f'{prefix}_it')
        en = self._get(row, cols, f'{prefix}_en')
        return {'DE': de, 'FR': fr, 'IT': it, 'EN': en}

    def _clean_langs_and_weblink(self, row, cols, prefix, keep_link=True) -> tuple[dict[str, str], str]:
        """Per-language labels plus the first href found across them.
        """
        cleaned = {}
        weblink = ''
        for lang, key in (('DE', 'de'), ('FR', 'fr'), ('IT', 'it'), ('EN', 'en')):
            label, href = _split_link(self._get(row, cols, f'{prefix}_{key}'))
            cleaned[lang] = label if keep_link else _strip_html(label)
            if href and not weblink:
                weblink = href
        return cleaned, weblink

    def _has_label(self, row, cols) -> bool:
        return any(self._langs(row, cols, 'label').values())

    def _has_de_label(self, row, cols) -> bool:
        """True when "Feld in PSPH deutsch" carries text — the PSPH-visible marker.

        Rows without it are Acta-Nova-managed (their German text lives in "Name AN
        deutsch") and are never applicant-facing, so they aren't builder components.
        """
        return bool(self._get(row, cols, 'label_de'))

    def _row(self, row, cols):
        kind = _classify(self._get(row, cols, 'format'))
        tag = kind[0]

        if tag in ('blank', 'internal'):
            if tag == 'blank' and self._has_label(row, cols):
                label = self._get(row, cols, 'label_de') or '(row)'
                self.skipped.append(
                    f'{label} — empty "Format PSPH" cell; row skipped (set a format so it can be imported)')
            return
        if tag == 'metadata':
            keep_link = kind[1] == 'meta-description'
            titles, weblink = self._clean_langs_and_weblink(row, cols, 'label', keep_link)
            self.metadata[kind[1]] = titles
            if weblink:
                self.metadata_links[kind[1]] = weblink
            return
        if tag == 'email-of-form':
            candidates = [self._get(row, cols, k)
                          for k in ('label_de', 'label_fr', 'label_it', 'label_en', 'name_an_de')]
            email = next((c for c in candidates if '@' in c), '') or next((c for c in candidates if c), '')
            if email:
                self.contact_email = email
            return
        if tag == 'header':
            if not self._has_de_label(row, cols):
                # No "Feld in PSPH deutsch" → Acta-Nova-managed block (An-/Cc-Empfänger,
                # Versandbestätigung …). Not a PSPH section; skip it.
                self.group, self.group_silent = None, False
                return
            self._start_section(row, cols)
            return
        if tag == 'option':
            self._add_option(row, cols)
            return
        if tag == 'title':
            comp_id, silent = kind[1], kind[2]
            if not self._has_de_label(row, cols) and comp_id not in ('electronic-consent', 'korrespondenzsprache'):
                # No "Feld in PSPH deutsch" → Acta-Nova-managed group (Status,
                # Zuständige Sektion …). Skip it and eat its option rows.
                self.group, self.group_silent = None, True
                return
            self._add_component(comp_id, row, cols, is_float=False, is_group=True, silent_group=silent)
            return
        if tag == 'component':
            comp_id, is_float = kind[1], kind[2]
            if not self._has_de_label(row, cols):
                # No "Feld in PSPH deutsch" → Acta-Nova-managed field (Datum Gesuch,
                # Geschäfts-Nr. …). Not a PSPH form field; skip it (ends any open group).
                self.group, self.group_silent = None, False
                return
            self._add_component(comp_id, row, cols, is_float=is_float, is_group=False)
            return
        if tag == 'aggregate-start':
            self._start_aggregate(row, cols)
            return
        if tag == 'aggregate-group':
            self._add_aggregate_group(row, cols)
            return
        if tag == 'aggregate-end':
            self._end_aggregate(row, cols)
            return
        if tag == 'defer':
            label = self._get(row, cols, 'label_de') or self._get(row, cols, 'format')
            self.skipped.append(f'{label or "(row)"} — {kind[1]}')
            self.group, self.group_silent = None, True  # eat any option rows that follow
            return
        # unknown
        if self._has_label(row, cols):
            self.skipped.append(f'{self._get(row, cols, "label_de") or "(row)"} — unknown format "{kind[1]}"')

    def _ensure_section(self):
        if self.current is None:
            self.current = {'id': self._uid('Section'), 'title': 'Section', 'components': []}
            self.sections.append(self.current)

    def _start_section(self, row, cols):
        clean, _weblink = self._clean_langs_and_weblink(row, cols, 'label', keep_link=False)
        self.current = {
            'id': self._uid('Section'),
            'title': clean['DE'] or clean['FR'] or clean['IT'] or clean['EN'] or 'Section',
            'translations': {'title': clean},
            'components': [],
        }
        # Remember the header's Fachdatenbezeichner so a round-trip export can find and
        # update this exact header row in the original spreadsheet.
        source_ref = self._get(row, cols, 'field_name')
        if source_ref:
            self.current['sourceRef'] = source_ref
        ref_id = self._get(row, cols, 'ref_id')
        if ref_id:
            self.current['refID'] = ref_id
        comp_id = self._get(row, cols, 'comp_id')
        if comp_id:
            self.current['compId'] = comp_id
        ctx = f'section "{self.current["title"]}"'
        self._defer_logic(self.current, row, cols, ctx)
        self.sections.append(self.current)
        self.group, self.group_silent = None, False

    def _start_aggregate(self, row, cols):
        """Open an isAggregate section; rows up to "Aggregate end" become its components."""
        if self.aggregate is not None:  # PSPH sheets don't nest aggregates
            self.skipped.append(
                f'{self.aggregate["title"]} — aggregate not closed before the next '
                f'"Aggregate start"; it was closed automatically')
            self._end_aggregate(row, cols)
        clean, _weblink = self._clean_langs_and_weblink(row, cols, 'label', keep_link=False)
        section: dict[str, Any] = {
            'id': self._uid('Section'),
            'title': clean['DE'] or clean['FR'] or clean['IT'] or clean['EN'] or 'Aggregate',
            'translations': {'title': clean},
            'components': [],
            'isAggregate': True,
            'groups': [],
        }
        field_name = self._get(row, cols, 'field_name')
        if field_name:
            section['aggregateFachdatenbezeichner'] = field_name
            section['sourceRef'] = field_name
        ref_id = self._get(row, cols, 'ref_id')
        if ref_id:
            section['aggregateRefID'] = ref_id
        comp_id = self._get(row, cols, 'comp_id')
        if comp_id:
            section['aggregateCompId'] = comp_id
        self.sections.append(section)
        self.current = self.aggregate = section
        self.group, self.group_silent = None, False

    def _add_aggregate_group(self, row, cols):
        """Record a "Group N" row; the builder only counts them."""
        if self.aggregate is None:
            self.skipped.append(
                f'{self._get(row, cols, "format") or "(row)"} — "Group" row outside an aggregate')
            return
        self.aggregate['groups'].append({'groupId': self._uid('gr'), 'refID': ''})

    def _end_aggregate(self, row, cols):
        if self.aggregate is None:
            self.skipped.append(
                f'{self._get(row, cols, "format") or "(row)"} — "Aggregate end" with no matching start')
            return
        self.aggregate = None
        self.current = None  # later rows start a fresh section
        self.group, self.group_silent = None, False

    def _add_option(self, row, cols):
        if self.group_silent:
            return  # electronic consent: its Yes/No options are rebuilt by the frontend
        if self.group is None:
            self.skipped.append(f'{self._get(row, cols, "label_de") or "(option)"} — option with no group')
            return
        option_id = self._uid('opt')
        input_id = self._norm_input_id(self._get(row, cols, 'input_id'))
        if input_id:
            self._optid_by_input_id[input_id] = option_id
        self.group.setdefault('options', []).append({
            'optionId': option_id,
            'fieldName': self._get(row, cols, 'field_name'),
            'refID': self._get(row, cols, 'ref_id'),
            'translations': self._langs(row, cols, 'label'),
        })

    def _add_component(self, comp_id, row, cols, *, is_float, is_group, silent_group=False):
        self._ensure_section()
        name, icon = _PALETTE.get(comp_id, (comp_id, 'help'))
        labels, link_from_labels = self._clean_langs_and_weblink(row, cols, 'label')
        comp: dict[str, Any] = {
            'id': comp_id,
            'name': name,
            'icon': icon,
            'instanceId': self._uid(f'Field_{comp_id}'),
            'label': name,
            'required': _as_bool(self._get(row, cols, 'required')),
        }
        for key, prop in (('field_name', 'fieldName'), ('ref_id', 'refID'),
                          ('comp_id', 'compId'), ('comments', 'commentsForDevs'),
                          ('weblink', 'weblink')):
            val = self._get(row, cols, key)
            if val:
                comp[prop] = val
        if link_from_labels and not comp.get('weblink'):
            comp['weblink'] = link_from_labels
        if self._get(row, cols, 'hidden') and _as_bool(self._get(row, cols, 'hidden')):
            comp['hiddenField'] = True
        ctx = f'"{labels["DE"] or name}"'
        self._defer_logic(comp, row, cols, ctx, mark_hidden=True)
        if _as_bool(self._get(row, cols, 'disable_mouse_over')):
            comp['disableMouseOver'] = True
        if is_float:
            comp['allowDecimals'] = True
        size = self._get(row, cols, 'size')
        if size and size.isdigit():
            comp['maxLength'] = int(size)
        for key, prop in (('mo_de', 'mouseOverDe'), ('mo_fr', 'mouseOverFr'), ('mo_it', 'mouseOverIt')):
            val = self._get(row, cols, key)
            if val:
                comp[prop] = val

        if comp_id == 'text':
            comp['editField'] = 'content'
            comp['fontSize'] = 'base'
            comp['content'] = labels['DE']
            comp['translations'] = {'content': labels}
            if _fold(self._get(row, cols, 'format')) == 'infobox':
                comp['alignedInfobox'] = True
        else:
            comp['editField'] = 'title'
            comp['title'] = labels['DE']
            translations: dict[str, Any] = {'title': labels}
            placeholders = self._langs(row, cols, 'ph')
            if any(placeholders.values()):
                translations['placeholder'] = placeholders
                comp['placeholder'] = placeholders['DE']
            comp['translations'] = translations

        if comp_id == 'upload-single':
            fmts = self._get(row, cols, 'file_formats')
            if fmts:
                comp['fileFormats'] = fmts
        if comp_id == 'upload-multi':
            fmts = self._get(row, cols, 'file_formats')
            if fmts:
                comp['fileFormats'] = fmts

        if is_group:
            comp['options'] = []

        self.current['components'].append(comp)
        self.group = comp if is_group else None
        self.group_silent = silent_group

    @staticmethod
    def _title_de(comp: dict) -> str:
        return ((comp.get('translations') or {}).get('title') or {}).get('DE', '') or comp.get('title', '')

    @staticmethod
    def _split_variant_for(a_label: str, b_label: str) -> Optional[str]:
        fa, fb = _fold(a_label), _fold(b_label)
        for firsts, seconds, variant in _SPLIT_PAIRS:
            if fa in firsts and fb in seconds:
                return variant
        return None

    def _make_split(self, c1: dict, c2: dict, variant: str) -> dict:
        """Combine two adjacent single-row text fields into one split-input component."""
        name, icon = _SPLIT_PALETTE[variant]

        def side(c: dict) -> dict:
            tr = c.get('translations') or {}
            cfg: dict[str, Any] = {
                'titles': dict(tr.get('title') or {}),
                'placeholders': dict(tr.get('placeholder') or {}),
                'fieldName': c.get('fieldName', '') or '',
                'refID': c.get('refID', '') or '',
            }
            for prop in ('mouseOverDe', 'mouseOverFr', 'mouseOverIt'):
                if c.get(prop):
                    cfg[prop] = c[prop]
            return cfg

        split: dict[str, Any] = {
            'id': 'split-input',
            'name': name,
            'icon': icon,
            'instanceId': self._uid('Field_split'),
            'label': name,
            'required': bool(c1.get('required') or c2.get('required')),
            'splitVariant': variant,
            'splitConfig': {'a': side(c1), 'b': side(c2)},
            'title': self._title_de(c1),
        }
        # Shared single-value props live at the component level; prefer the first row.
        # refID stays per side (each row carries its own).
        for prop in ('compId', 'commentsForDevs', 'weblink'):
            val = c1.get(prop) or c2.get(prop)
            if val:
                split[prop] = val
        if c1.get('disableMouseOver') or c2.get('disableMouseOver'):
            split['disableMouseOver'] = True
        for prop in ('hiddenField', 'showLogic', 'hideLogic'):
            val = c1.get(prop) or c2.get(prop)
            if val:
                split[prop] = val
        return split

    def _merge_split_inputs(self) -> None:
        """Recombine adjacent Name+Vorname / Strasse+Nr / PLZ+Ort text rows into split inputs."""
        for section in self.sections:
            comps = section.get('components') or []
            merged: list[dict] = []
            i = 0
            while i < len(comps):
                c1 = comps[i]
                c2 = comps[i + 1] if i + 1 < len(comps) else None
                variant = None
                if c2 is not None and c1.get('id') == 'text-input' and c2.get('id') == 'text-input':
                    variant = self._split_variant_for(self._title_de(c1), self._title_de(c2))
                if variant:
                    merged.append(self._make_split(c1, c2, variant))
                    i += 2
                else:
                    merged.append(c1)
                    i += 1
            section['components'] = merged

    def _payload(self) -> dict:
        sections: list[dict] = []
        if self.metadata or self.contact_email:
            components = []
            for i, (mid, label) in enumerate(METADATA_FIELDS):
                titles = self.metadata.get(mid, {'DE': '', 'FR': '', 'IT': '', 'EN': ''})
                components.append({
                    'id': mid, 'name': label, 'icon': 'edit_note',
                    'instanceId': f'Field_{mid}_{i}', 'label': label,
                    'required': False, 'editField': 'title',
                    'translations': {'title': titles},
                    'weblink': self.metadata_links.get(mid, '') or None,
                })
            sections.append({
                'id': self._uid('MetadataSection'), 'title': 'Form Header',
                'components': components, 'isMetadata': True,
            })
        sections.extend(self.sections)

        title_de = (self.metadata.get('meta-title') or {}).get('DE', '')
        deployment = {
            'compName': '', 'usrId': '', 'contactEmail': self.contact_email,
            'deId': '', 'frId': '', 'itId': '', 'enId': '',
            'wikiLink': '', 'issueLink': '', 'validatorClass': '',
        }
        return {
            'formTitle': title_de or 'Imported form',
            'disableInputSize': False,
            'disableMouseOver': False,
            'deployment': deployment,
            'sections': sections,
            'skipped': self.skipped,
        }


def import_spreadsheet(raw: bytes, filename: str) -> dict:
    """Parse a PSPH .xlsx/.csv into a builder payload.

    Returns the {sections, formTitle, deployment, ...} payload plus a `skipped`
    list naming rows/formats not yet reconstructed (Phase 1).
    """
    rows = _read_rows(raw, filename)
    return _Importer(rows).run()
