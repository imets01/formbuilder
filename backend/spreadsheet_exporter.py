"""
Round-trip a PSPH form back to its original spreadsheet.

The builder's data model is *lossy* relative to the PSPH spec workbook — it drops
the Acta-Nova-internal rows (Datum Gesuch, Geschäfts-Nr., Status, e-mail routing…)
and whole columns (Fachdatentyp, Befüllung, DFS, Registerkarte, …). So we cannot
regenerate a faithful workbook from the builder alone. Instead we keep the
*original* workbook bytes (stored as a sidecar when the form is imported) and
*overlay* the builder's current values onto it:

  - existing rows are matched by Fachdatenbezeichner (the one stable unique key —
    Input IDs repeat) and only the cells the builder owns (labels, placeholders,
    mouseovers, Mussfeld) are rewritten, and only when they actually changed, so
    untouched rows/columns/formatting pass through verbatim;
  - rows for fields deleted in the builder are removed, and the rows the builder owns are
    put in the builder's order (see `_drop_deleted_rows` / `_reorder_rows`). "Owned" means
    the importer turns the row into builder content; everything else (Acta-Nova rows,
    metadata) is never removed;
  - fields added in the builder are inserted at their correct line — right after
    the spreadsheet row of the nearest preceding field that already exists (its
    section header counts), so an added field lands in its section rather than at
    the end (see `_place_new_rows`);
  - show/hide logic is translated back: the builder's optionId conditions are
    resolved to the corresponding [Input ID] tokens and written to the Logik
    anzeigen / Logik ausblenden columns, but only when the builder actually has
    logic for the row and the cell changed (see `_apply_logic`);
  - the "Version" sheet records the change + author (a re-used version number updates its
    existing row rather than duplicating it);
  - the "Deployment" sheet carries the deployment ids the form sheet has no column for, so
    importing the workbook afresh elsewhere needs no manual re-entry (see
    `_write_deployment_sheet`).

Other structural columns (Fachdatentyp, Befüllung, DFS, …) are left untouched, so
importing → exporting unchanged yields the same form sheet plus only the new
Version row.
"""

from __future__ import annotations

import datetime
import io
import re
from typing import Any, Optional

from openpyxl import load_workbook
from openpyxl.worksheet.worksheet import Worksheet

from copy import copy

from input_events import format_events
from excel_importer import (_fold, _match_columns, _strip_html, _split_link, _classify,
                            import_spreadsheet,
                            DEVELOPER_ATTR_COMPONENTS, DEVELOPER_ATTRS,
                            DEPLOYMENT_FIELDS, DEPLOYMENT_HEADERS, DEPLOYMENT_SHEET,
                            deployment_key, deployment_value_column)


# Builder component id -> Format PSPH text, for rows *added* in the builder.
_FORMAT_FOR = {
    'text-input': 'Text einzeilig',
    'text-area': 'Text mehrzeilig',
    'phone': 'Telefonnummer',
    'date': 'Datum',
    'email': 'E-Mail-Adresse',
    'number': 'Ganzzahl',
    'number-dropdown': 'Zahl Dropdown',
    'upload-single': 'Upload Feld einfach',
    'upload-multi': 'Upload Feld mehrfach',
    'radio': 'Radio Button Titel',
    'checkbox': 'Checkbox Titel',
    'select-single': 'Drop Down Field Titel',
    'select-multi': 'Auswahlfeld mehrfach (Katalog)',
    'catalog-countries': 'Auswahlfeld mehrfach (Katalog)',
    'catalog-cantons': 'Auswahlfeld mehrfach (Katalog)',
    'korrespondenzsprache': 'Korrespondenzsprache',
    'single-checkbox': 'Kontrollkasten',
    'text': 'Infotext',
    'button': 'Button',
}
_OPTION_FORMAT_FOR = {
    'radio': 'Radio Button Option',
    'checkbox': 'Checkbox Option',
    'select-single': 'Drop Down Field Option',
    'select-multi': 'Auswahlfeld mehrfach Option',
    'catalog-countries': 'Auswahlfeld mehrfach Option',
    'catalog-cantons': 'Auswahlfeld mehrfach Option',
    'korrespondenzsprache': 'Drop Down Field Option',
}

# Builder metadata id -> Format PSPH, for generating a workbook from scratch.
_META_FORMAT_FOR = {
    'meta-title': 'Formulartitel',
    'meta-description': 'Beschreibung',
    'meta-department': 'Departement',
    'meta-federalOffice': 'Bundesamt',
    'meta-section': 'Sektion Bundesamt',
    'meta-address': 'Adresse Bundesamt',
    'meta-zipCity': 'PLZ und Ort des Bundesamtes',
}

# Column headers for a workbook generated from scratch, matching the PSPH template
# (FormGeneratorTemplate). Names are chosen so the importer's name-based matchers (and a
# later round-trip) recognise every column.
_STD_HEADERS = [
    'Input ID', 'Bemerkung Steuerung', 'Logik anzeigen', 'Logik ausblenden', 'Verstecktes Feld',
    'Mussfeld PSPH', 'Grösse/Länge', 'Name AN deutsch', 'Feld in PSPH deutsch',
    'Name PSPH französisch', 'Name PSPH italienisch',
    'Hinweis im Feld PSPH italienisch', 'Hinweis im Feld PSPH französisch', 'Hinweis im Feld PSPH deutsch',
    'MouseOver PSPH italienisch', 'MouseOver PSPH französisch', 'MouseOver PSPH deutsch',
    'Format PSPH, Formate gem. TF 00', 'Fachdatenbezeichner', 'RefID', 'Complimentary ID',
    'Fachdatentyp', 'Dateiformate', 'Befüllung', 'DFS', 'Registerkarte', 'Fragen/Bemerkungen',
    'Mouseover nicht anzeigen', 'Weblinks',
    *(title for _, _, title in DEVELOPER_ATTRS),
]


def export_spreadsheet(source: Optional[bytes], payload: dict, *,
                       author: str = '', note: str = '',
                       version: str = '', bump: bool = True) -> bytes:
    """Return PSPH .xlsx bytes for the form; see export_spreadsheet_versioned."""
    data, _ = export_spreadsheet_versioned(
        source, payload, author=author, note=note, version=version, bump=bump)
    return data


def export_spreadsheet_versioned(source: Optional[bytes], payload: dict, *,
                                 author: str = '', note: str = '',
                                 version: str = '', bump: bool = True) -> tuple[bytes, str]:
    """Return PSPH .xlsx bytes for the form, plus the version the workbook now carries.

    The version is worth having back: left blank it is bumped from the sheet's own history,
    so only the export itself knows which one was recorded.

    With a stored `source` workbook: overlay the builder's edits onto it (faithful round-trip).
    Without one (a form built from scratch): generate a fresh PSPH workbook from the payload.

    When `bump` is True the Version sheet records the change: a `version` that already exists
    updates that row (same version, refreshed date/note/author), any other one appends a row.
    When False the spec is produced without recording a version, but a baseline 0.1 row is
    seeded if the workbook has no versions yet.
    """
    if source:
        try:
            wb = load_workbook(io.BytesIO(source))
        except Exception:
            # The stored source isn't an .xlsx (e.g. the form was imported from a CSV) — rebuild
            # a single-sheet workbook from those rows so we can still overlay onto the real data.
            wb = _workbook_from_csv(source)
        form_ws = _pick_form_sheet(wb)
        if form_ws is not None:
            _overlay_form_sheet(form_ws, payload, *_builder_owned(source))
    else:
        wb = _generate_workbook(payload)
    _write_deployment_sheet(wb, payload)
    if bump:
        recorded = _append_version_row(wb, author=author, note=note, version=version)
    else:
        recorded = _ensure_baseline_version(wb)
    _strip_query_tables(wb)  # avoid Excel's "Removed Part: External data range" repair on open
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue(), recorded


def _strip_query_tables(wb) -> None:
    for ws in wb.worksheets:
        tables = getattr(ws, 'tables', None) or {}
        names = [n for n in list(tables) if getattr(tables[n], 'tableType', None) == 'queryTable']
        for name in names:
            del ws.tables[name]


def _workbook_from_csv(source: bytes):
    """Build a single-sheet workbook from CSV bytes, preserving every row and column."""
    import csv
    from openpyxl import Workbook
    from excel_importer import _decode_csv
    rows = list(csv.reader(io.StringIO(_decode_csv(source))))
    wb = Workbook()
    ws = wb.active
    ws.title = 'Form'
    for row in rows:
        ws.append(list(row))
    return wb


def _generate_workbook(payload: dict):
    """Build a fresh PSPH workbook (Form + empty Version sheet) from the builder payload."""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = 'Form'
    ws.append(_STD_HEADERS)
    cols = _match_columns(_STD_HEADERS)  # canonical column key -> 0-based index
    for i, h in enumerate(_STD_HEADERS):
        if _fold(h) == 'nameandeutsch':
            cols['name_an_de'] = i

    _, _, ordered, _ = _flatten_payload(payload)

    # Each emitted row gets a sequential Input ID (its 1-based ordinal), so option rows can
    # be referenced from the show/hide logic columns.
    optid_to_inputid = {spec['option_id']: str(i)
                        for i, spec in enumerate(ordered, start=1) if spec.get('option_id')}
    for i, spec in enumerate(ordered, start=1):
        _write_row(ws, i + 1, cols, spec, optid_to_inputid, input_id=str(i))

    version_ws = wb.create_sheet('Version')
    version_ws.append(['Version', 'Datum', 'Änderung', 'Autor'])
    return wb


# ── Picking + reading sheets ──────────────────────────────────────────────────

def _cell_text(value: Any) -> str:
    return '' if value is None else str(value)


def _row_values(ws: Worksheet, r: int) -> list[str]:
    return [_cell_text(c.value) for c in ws[r]]


def _find_header_row(ws: Worksheet) -> Optional[int]:
    """1-based index of the row that carries the 'Format PSPH' header, if any."""
    for r in range(1, min(ws.max_row, 8) + 1):
        if any('formatpsph' in _fold(v) for v in _row_values(ws, r)):
            return r
    return None


def _effective_last_row(ws: Worksheet, header_row: int, key_cols: list[int],
                        cap: int = 10000, gap: int = 100) -> int:
    """Last data row, judged by the key columns only.

    openpyxl often reports ws.max_row as the whole-sheet maximum (~1,048,576) when a template
    has column-wide formatting; scanning that twice would appear to hang. We instead walk down
    from the header, reading just the key cells, and stop after a long run of empty rows.
    """
    last = header_row
    empty = 0
    upper = min(ws.max_row, header_row + cap)
    r = header_row + 1
    while r <= upper:
        if any(_cell_text(ws.cell(row=r, column=ci + 1).value).strip() for ci in key_cols):
            last, empty = r, 0
        else:
            empty += 1
            if empty >= gap:
                break
        r += 1
    return last


def _pick_form_sheet(wb) -> Optional[Worksheet]:
    """The sheet with a 'Format PSPH' header and the most form-like rows."""
    best, best_score = None, -1
    for ws in wb.worksheets:
        header_row = _find_header_row(ws)
        if header_row is None:
            continue
        cols = _match_columns(_row_values(ws, header_row))
        fmt_idx = cols.get('format')
        if fmt_idx is None:
            continue
        kinds = ('metadata', 'header', 'component', 'option', 'title')
        key_cols = [i for i in (fmt_idx, cols.get('field_name')) if i is not None]
        last = _effective_last_row(ws, header_row, key_cols)
        score = 0
        for r in range(header_row + 1, last + 1):
            fmt = _cell_text(ws.cell(row=r, column=fmt_idx + 1).value)
            if _classify(fmt)[0] in kinds:
                score += 1
        if score > best_score:
            best, best_score = ws, score
    return best


# ── Overlay ───────────────────────────────────────────────────────────────────

def _titles(obj: dict, field: str = 'title') -> dict:
    return ((obj.get('translations') or {}).get(field) or {})


def _spec_for_component(comp: dict) -> Optional[dict]:
    """The Format/labels/etc. describing the spreadsheet row(s) for a builder component.

    Returns the *title* spec; option/ split sub-rows are attached under 'children'.
    """
    cid = comp.get('id')
    if cid == 'electronic-consent':
        return None  # backend-macro driven; not a plain editable row set
    base_field = 'content' if cid == 'text' else 'title'
    show, hide = comp.get('showLogic'), comp.get('hideLogic')
    fmt = 'Infobox' if (cid == 'text' and comp.get('alignedInfobox')) else _FORMAT_FOR.get(cid, '')
    spec: dict[str, Any] = {
        'format': fmt,
        'field_name': (comp.get('fieldName') or '').strip(),
        'sheet_row': comp.get('sheetRow'),
        'label': _titles(comp, base_field),
        'ph': _titles(comp, 'placeholder'),
        'mo': {'DE': comp.get('mouseOverDe', ''), 'FR': comp.get('mouseOverFr', ''),
               'IT': comp.get('mouseOverIt', '')},
        'required': bool(comp.get('required')),
        'ref_id': comp.get('refID', ''),
        'comp_id': comp.get('compId', ''),
        'file_formats': comp.get('fileFormats', ''),
        'weblink': comp.get('weblink', ''),
        'comments': comp.get('commentsForDevs', ''),
        'disable_mo': bool(comp.get('disableMouseOver')),
        'hidden': _hidden_by_default(comp),
        'show': show, 'hide': hide,
        'children': [],
    }
    if cid in DEVELOPER_ATTR_COMPONENTS:
        spec['dev'] = {key: comp.get(prop) or '' for key, prop, _ in DEVELOPER_ATTRS}
        # onChange: builder files saved before events were generic.
        spec['dev']['events'] = format_events(comp.get('events') or comp.get('onChange'))
    if cid == 'number' and comp.get('allowDecimals'):
        spec['format'] = 'Float'
    if cid == 'number-dropdown' and comp.get('maxLength'):
        spec['size'] = str(comp['maxLength'])
    if cid == 'split-input':
        cfg = comp.get('splitConfig') or {}
        return {'split': [
            {'format': 'Text einzeilig', 'field_name': (cfg.get(side, {}).get('fieldName') or '').strip(),
             'sheet_row': cfg.get(side, {}).get('sheetRow'),
             'label': cfg.get(side, {}).get('titles') or {},
             'ph': cfg.get(side, {}).get('placeholders') or {},
             'mo': {'DE': cfg.get(side, {}).get('mouseOverDe', ''),
                    'FR': cfg.get(side, {}).get('mouseOverFr', ''),
                    'IT': cfg.get(side, {}).get('mouseOverIt', '')},
             'required': bool(comp.get('required')),
             'ref_id': (cfg.get(side, {}).get('refID') or comp.get('refID', '') or ''),
             'comp_id': '',
             **({'comments': comp.get('commentsForDevs', '')} if side == 'a' else {}),
             'hidden': _hidden_by_default(comp),
             'show': show, 'hide': hide}
            for side in ('a', 'b')
        ]}
    opt_fmt = _OPTION_FORMAT_FOR.get(cid)
    if opt_fmt:
        for opt in comp.get('options') or []:
            spec['children'].append({
                'format': opt_fmt,
                'field_name': (opt.get('fieldName') or '').strip(),
                'label': opt.get('translations') or {},
                'ph': {}, 'mo': {}, 'required': False,
                'ref_id': opt.get('refID', ''), 'comp_id': '',
                'option_id': opt.get('optionId'),  # so logic can resolve refs to its Input ID
            })
    return spec


def _flatten_payload(payload: dict) -> tuple[dict, dict, list, dict]:
    """Return (by_fieldname, by_meta, ordered_rows, optid_to_fieldname).

    by_fieldname:       Fachdatenbezeichner -> row spec (for matching existing rows).
    by_meta:            meta id             -> spec (matched by Format, not field name).
    ordered_rows:       every emittable row spec in document order (metadata, headers,
                        components, options) — used to place new rows and to generate
                        a workbook from scratch.
    optid_to_fieldname: builder optionId    -> its Fachdatenbezeichner (to resolve logic).
    """
    by_fieldname: dict[str, dict] = {}
    by_meta: dict[str, dict] = {}
    ordered: list[dict] = []
    optid_to_fieldname: dict[str, str] = {}

    def add(spec: dict):
        ordered.append(spec)
        fn = spec.get('field_name')
        if fn:
            by_fieldname.setdefault(fn, spec)

    email = ((payload.get('deployment') or {}).get('contactEmail') or '').strip()
    email_spec = ({'label': {'DE': email}, 'field_name': '', 'ph': {}, 'mo': {},
                   'required': False, 'ref_id': '', 'comp_id': '',
                   'format': 'Email-of-the-form', 'email_of_form': True} if email else None)
    email_emitted = False

    for sec in payload.get('sections') or []:
        if sec.get('isMetadata'):
            for comp in sec.get('components') or []:
                mid = comp.get('id')
                if not mid:
                    continue
                spec = {'label': _titles(comp), 'field_name': '', 'ph': {}, 'mo': {},
                        'required': False, 'ref_id': '', 'comp_id': '',
                        'weblink': comp.get('weblink', ''),
                        'format': _META_FORMAT_FOR.get(mid, ''), 'meta': mid}
                by_meta[mid] = spec
                ordered.append(spec)
            if email_spec and not email_emitted:  # sits just after the address rows
                ordered.append(email_spec)
                email_emitted = True
            continue
        ref = (sec.get('sourceRef') or '').strip()
        # Keep the header in document order so it can anchor a new first-field-in-section,
        # and match its existing row when ref is known.
        add({'label': _titles(sec), 'field_name': ref, 'format': 'Header',
             'sheet_row': sec.get('sheetRow'),
             'ph': {}, 'mo': {}, 'required': False, 'ref_id': '', 'comp_id': '', 'header': True,
             'hidden': _hidden_by_default(sec),
             'show': sec.get('showLogic'), 'hide': sec.get('hideLogic')})
        for comp in sec.get('components') or []:
            spec = _spec_for_component(comp)
            if not spec:
                continue
            if 'split' in spec:
                for s in spec['split']:
                    add(s)
                continue
            add(spec)
            for child in spec.get('children') or []:
                if child.get('option_id') and child.get('field_name'):
                    optid_to_fieldname[child['option_id']] = child['field_name']
                add(child)
    if email_spec and not email_emitted:  # no metadata section, but an e-mail is set
        ordered.append(email_spec)
    return by_fieldname, by_meta, ordered, optid_to_fieldname


def _render_link(text: str, weblink: str) -> str:
    """Builder marker form (<a>…</a> plus a separate URL) -> the sheet's inline <a href="…">."""
    if not (text and weblink):
        return text
    return re.sub(r'<a\b[^>]*>', f'<a href="{weblink}">', text, flags=re.I)


def _write_if_changed(ws: Worksheet, r: int, col_idx: Optional[int], new_value: str) -> None:
    """Overwrite a cell only when the builder value differs from the original."""
    if col_idx is None:
        return
    new_value = (new_value or '').strip()
    cell = ws.cell(row=r, column=col_idx + 1)
    existing = _cell_text(cell.value)
    if _split_link(existing) == _split_link(new_value):
        return  # unchanged → leave the original cell (and its formatting) untouched
    if not new_value and not _strip_html(existing):
        return
    cell.value = new_value or None


def _apply_email(ws: Worksheet, r: int, cols: dict, email: str) -> None:
    """Write the contact e-mail back onto the Email-of-the-form row.

    Sheets keep the address in different columns (Name AN deutsch or Feld in PSPH
    deutsch); write to whichever already holds it so the round-trip stays faithful,
    defaulting to Feld in PSPH deutsch when the row is currently blank.
    """
    if not email:
        return
    for key in ('name_an_de', 'label_de'):
        ci = cols.get(key)
        if ci is not None and '@' in _cell_text(ws.cell(row=r, column=ci + 1).value):
            _write_if_changed(ws, r, ci, email)
            return
    ci = cols.get('label_de')
    if ci is None:
        ci = cols.get('name_an_de')
    _write_if_changed(ws, r, ci, email)


def _hidden_by_default(target: dict) -> Optional[bool]:
    """The Verstecktes Feld value to write, or None to leave the cell alone.

    The importer marks every field that carries a show/hide condition as hidden, so for those
    the flag says nothing the condition doesn't; writing it would stamp "Ja" onto rows whose
    author never set it.
    """
    if target.get('showLogic') or target.get('hideLogic'):
        return None
    return bool(target.get('hiddenField'))


def _write_flag(ws: Worksheet, r: int, col_idx: Optional[int], value: Optional[bool]) -> None:
    """Set a Ja/blank column, leaving the cell untouched when its truth value already matches."""
    if col_idx is None or value is None:
        return
    cell = ws.cell(row=r, column=col_idx + 1)
    if _as_flag(cell.value) != value:
        cell.value = 'Ja' if value else None


def _as_flag(value) -> bool:
    return _fold(_cell_text(value)) in ('ja', 'yes', 'true', 'x', '1')


def _apply_overlay(ws: Worksheet, r: int, cols: dict, spec: dict) -> None:
    label, ph, mo = spec.get('label') or {}, spec.get('ph') or {}, spec.get('mo') or {}
    link = spec.get('weblink') or ''
    _write_if_changed(ws, r, cols.get('label_de'), _render_link(label.get('DE', ''), link))
    _write_if_changed(ws, r, cols.get('label_fr'), _render_link(label.get('FR', ''), link))
    _write_if_changed(ws, r, cols.get('label_it'), _render_link(label.get('IT', ''), link))
    _write_if_changed(ws, r, cols.get('ph_de'), ph.get('DE', ''))
    _write_if_changed(ws, r, cols.get('ph_fr'), ph.get('FR', ''))
    _write_if_changed(ws, r, cols.get('ph_it'), ph.get('IT', ''))
    _write_if_changed(ws, r, cols.get('mo_de'), mo.get('DE', ''))
    _write_if_changed(ws, r, cols.get('mo_fr'), mo.get('FR', ''))
    _write_if_changed(ws, r, cols.get('mo_it'), mo.get('IT', ''))
    if spec.get('comments') is not None:
        _write_if_changed(ws, r, cols.get('comments'), spec['comments'])
    for key, value in (spec.get('dev') or {}).items():
        _write_if_changed(ws, r, cols.get(key), value)
    if spec.get('size'):
        _write_if_changed(ws, r, cols.get('size'), spec['size'])
    _write_flag(ws, r, cols.get('hidden'), spec.get('hidden'))
    # Mussfeld: only flip when the boolean actually changes, so "--"/blank N/A markers
    # are left alone unless the user genuinely made the field required.
    required = spec.get('required')
    _write_flag(ws, r, cols.get('required'), None if required is None else bool(required))


def _norm_input_id(token: str) -> str:
    token = (token or '').strip().strip('[]').strip()
    try:
        return str(int(float(token)))
    except (TypeError, ValueError):
        return token


def _logic_to_cell(logic, optid_to_inputid: dict) -> str:
    """Render builder logic as the sheet's bracketed Input ID array.

    The builder's model is the sheet's (PSPH field guide, "Logik anzeigen"): the top level
    is an AND of its entries and a nested list is an OR of alternatives, so [5, [8, 11]]
    means 5 and either 8 or 11. Flattening that to "[5] [8] [11]" — as this used to — turns
    every OR into an AND on the next import, and overwrites hand-authored notation.
    """
    if not logic:
        return ''
    terms: list[str] = []
    for cond in logic:
        if isinstance(cond, list):
            alts: list[str] = []
            for oid in cond:
                iid = optid_to_inputid.get(oid)
                if iid and iid not in alts:
                    alts.append(iid)
            if len(alts) > 1:
                terms.append('[' + ', '.join(alts) + ']')
            elif alts:
                terms.append(alts[0])
        else:
            iid = optid_to_inputid.get(cond)
            if iid:
                terms.append(iid)
    if not terms:
        return ''
    return '[' + ', '.join(terms) + ']'


def _apply_logic(ws: Worksheet, r: int, cols: dict, spec: dict, optid_to_inputid: dict) -> None:
    """Write the Logik anzeigen/ausblenden columns when the builder defines logic for this row.

    Only writes when the builder actually has logic (so logic the builder can't model — e.g.
    per-option display rules — is left untouched rather than wiped)."""
    for key, col in (('show', 'show_logic'), ('hide', 'hide_logic')):
        desired = _logic_to_cell(spec.get(key), optid_to_inputid)
        if not desired:
            continue
        ci = cols.get(col)
        if ci is None:
            continue
        cell = ws.cell(row=r, column=ci + 1)
        current = _strip_html(_cell_text(cell.value))
        if re.sub(r'\s+', '', current) != re.sub(r'\s+', '', desired):
            cell.value = desired


def _builder_owned(source: bytes) -> tuple[set[str], set[int]]:
    """What the importer turns into builder content for this workbook: the rows it finds by
    Fachdatenbezeichner, and the rows without one, by number."""
    for filename in ('source.xlsx', 'source.csv'):
        try:
            imported = import_spreadsheet(source, filename)
        except Exception:
            continue
        by_fieldname, _, ordered, _ = _flatten_payload(imported)
        return set(by_fieldname), {s['sheet_row'] for s in ordered if s.get('sheet_row')}
    return set(), set()


def _overlay_form_sheet(ws: Worksheet, payload: dict, owned: set[str] = frozenset(),
                        owned_rows: set[int] = frozenset()) -> None:
    header_row = _find_header_row(ws)
    if header_row is None:
        return
    cols = _match_columns(_row_values(ws, header_row))
    fmt_idx, fn_idx, iid_idx = cols.get('format'), cols.get('field_name'), cols.get('input_id')
    by_fieldname, by_meta, ordered, optid_to_fieldname = _flatten_payload(payload)
    _add_missing_columns(ws, header_row, cols, ordered)

    # Bound the scan to the real data extent (see _effective_last_row).
    key_cols = [i for i in (fmt_idx, fn_idx) if i is not None]
    last_row = _effective_last_row(ws, header_row, key_cols)

    def cell(r, ci):
        return _cell_text(ws.cell(row=r, column=ci + 1).value) if ci is not None else ''

    # Pass 1: map each existing row by Fachdatenbezeichner and its Input ID (logic refs can
    # point at options defined later, so we need the full table before writing logic).
    row_for_fieldname: dict[str, int] = {}
    fieldname_to_inputid: dict[str, str] = {}
    for r in range(header_row + 1, last_row + 1):
        fn = cell(r, fn_idx).strip()
        if fn:
            row_for_fieldname[fn] = r
            iid = cell(r, iid_idx).strip()
            if iid:
                fieldname_to_inputid[fn] = _norm_input_id(iid)
    optid_to_inputid = {oid: fieldname_to_inputid[fn]
                        for oid, fn in optid_to_fieldname.items() if fn in fieldname_to_inputid}

    email = ((payload.get('deployment') or {}).get('contactEmail') or '').strip()

    # A row imported without a Fachdatenbezeichner is found by its number, as long as it is
    # still that kind of row without one. A name typed for it since is written into that row,
    # so the row is not added a second time below.
    by_sheet_row = {s['sheet_row']: s for s in ordered
                    if s.get('sheet_row') and s.get('field_name') not in row_for_fieldname}

    def same_kind(spec: dict, kind: str) -> bool:
        return kind == 'header' if spec.get('header') else kind in ('component', 'title')

    # Pass 2: overlay labels/placeholders/required and (changed) show/hide logic.
    for r in range(header_row + 1, last_row + 1):
        fn = cell(r, fn_idx).strip()
        kind = _classify(cell(r, fmt_idx)) if fmt_idx is not None else ('blank',)
        spec = by_fieldname.get(fn) if fn else by_sheet_row.get(r)
        if spec is not None and not fn and not same_kind(spec, kind[0]):
            spec = None
        if spec is not None and not fn and spec.get('field_name') and fn_idx is not None:
            ws.cell(row=r, column=fn_idx + 1).value = spec['field_name']
        if spec is None and kind[0] == 'metadata':
            spec = by_meta.get(kind[1])
        if spec is not None:
            _apply_overlay(ws, r, cols, spec)
            _apply_logic(ws, r, cols, spec, optid_to_inputid)
        elif kind[0] == 'email-of-form':
            _apply_email(ws, r, cols, email)

    sheet_rows_kept = {s['sheet_row'] for s in ordered if s.get('sheet_row')}
    _drop_deleted_rows(ws, header_row, cols, owned - set(by_fieldname), owned_rows - sheet_rows_kept)
    _reorder_rows(ws, header_row, cols, ordered)
    last_row = _effective_last_row(ws, header_row, key_cols)
    row_for_fieldname = {fn: r for r in range(header_row + 1, last_row + 1)
                         if (fn := cell(r, fn_idx).strip())}
    # Rows found by number are positions too, if the row still is that row (deleting and
    # moving rows can shift it): the same kind, no Fachdatenbezeichner, the label just written.
    located_rows = {id(spec): r for r, spec in by_sheet_row.items()
                    if not spec.get('field_name')
                    and same_kind(spec, _classify(cell(r, fmt_idx))[0]) and not cell(r, fn_idx).strip()
                    and cell(r, cols.get('label_de')) == _render_link(
                        (spec.get('label') or {}).get('DE', ''), spec.get('weblink') or '')}
    _place_new_rows(ws, cols, header_row, last_row, ordered, row_for_fieldname, located_rows,
                    optid_to_inputid)


def _row_units(ws: Worksheet, header_row: int, cols: dict, heads: set[str]):
    """Split the form rows into (prefix, units, suffix).

    A unit is a row whose Fachdatenbezeichner is in `heads`, followed by its option rows
    (which carry no Fachdatenbezeichner of their own) and any other rows up to the next unit;
    rows after the last unit's options form the suffix, so trailing Acta-Nova blocks stay put.
    """
    fmt_idx, fn_idx = cols.get('format'), cols.get('field_name')
    key_cols = [i for i in (fmt_idx, fn_idx) if i is not None]

    def text(r, ci):
        return _cell_text(ws.cell(row=r, column=ci + 1).value).strip() if ci is not None else ''

    prefix: list[int] = []
    units: list[tuple[str, list[int], int]] = []  # (head name, rows, how many are its own)
    for r in range(header_row + 1, _effective_last_row(ws, header_row, key_cols) + 1):
        fn = text(r, fn_idx)
        if fn in heads:
            units.append((fn, [r], 1))
        elif not units:
            prefix.append(r)
        else:
            name, rows, own = units[-1]
            is_option = not fn and _classify(text(r, fmt_idx))[0] == 'option'
            units[-1] = (name, rows + [r], own + 1 if is_option and own == len(rows) else own)
    suffix: list[int] = []
    if units:
        name, rows, own = units[-1]
        units[-1], suffix = (name, rows[:own], own), rows[own:]
    return prefix, units, suffix


def _drop_deleted_rows(ws: Worksheet, header_row: int, cols: dict, deleted: set[str],
                       deleted_rows: set[int] = frozenset()) -> None:
    """Remove the rows (and option rows) of fields the builder no longer has: by name, and
    by number for rows that were imported without a Fachdatenbezeichner."""
    fmt_idx, fn_idx = cols.get('format'), cols.get('field_name')

    def text(r, ci):
        return _cell_text(ws.cell(row=r, column=ci + 1).value).strip() if ci is not None else ''

    spans = []  # (first row, how many)
    if deleted:
        spans += [(rows[0], own) for _, rows, own in _row_units(ws, header_row, cols, deleted)[1]]
    for r in deleted_rows:
        if text(r, fn_idx) or _classify(text(r, fmt_idx))[0] not in ('header', 'component', 'title'):
            continue  # no longer the row it was
        own = 1
        while not text(r + own, fn_idx) and _classify(text(r + own, fmt_idx))[0] == 'option':
            own += 1
        spans.append((r, own))
    for first, count in sorted(set(spans), reverse=True):
        ws.delete_rows(first, amount=count)


def _reorder_rows(ws: Worksheet, header_row: int, cols: dict, ordered: list[dict]) -> None:
    """Put the rows the builder knows into the builder's order, moving each with its option
    rows and the rows that follow it. A sheet already in order is left untouched."""
    rank: dict[str, int] = {}
    for spec in ordered:
        if spec.get('field_name'):
            rank.setdefault(spec['field_name'], len(rank))
    prefix, units, suffix = _row_units(ws, header_row, cols, set(rank))
    names = [u[0] for u in units]
    if len(set(names)) != len(names):
        return  # a Fachdatenbezeichner on several rows: no single place to put it
    wanted = sorted(units, key=lambda u: rank[u[0]])
    if [u[0] for u in wanted] == [u[0] for u in units]:
        return
    # Aggregate start/end rows bracket their fields by position; moving rows across them
    # could pull a field into or out of the block, so such sheets keep their order.
    fmt_idx = cols.get('format')
    if fmt_idx is not None and any(
            _classify(_cell_text(ws.cell(row=r, column=fmt_idx + 1).value))[0].startswith('aggregate')
            for _, rows, _ in units for r in rows):
        return
    order = prefix + [r for _, rows, _ in wanted for r in rows] + suffix
    width = max(i for i, h in enumerate(_row_values(ws, header_row), start=1) if h.strip())
    snapshot = {r: _snapshot_row(ws, r, width) for r in order}
    for target, source in zip(sorted(order), order):
        _restore_row(ws, target, snapshot[source])


def _snapshot_row(ws: Worksheet, r: int, width: int):
    cells = [ws.cell(row=r, column=c) for c in range(1, width + 1)]
    return ([(c.value, copy(c._style), copy(c.hyperlink), copy(c.comment)) for c in cells],
            ws.row_dimensions[r].height)


def _restore_row(ws: Worksheet, r: int, snapshot) -> None:
    cells, height = snapshot
    for c, (value, style, link, comment) in enumerate(cells, start=1):
        target = ws.cell(row=r, column=c)
        target.value, target._style = value, copy(style)
        target.hyperlink, target.comment = copy(link), copy(comment)
    ws.row_dimensions[r].height = height


def _add_missing_columns(ws: Worksheet, header_row: int, cols: dict, specs: list[dict]) -> None:
    """Append a column the workbook lacks (Verstecktes Feld, developer attributes), once some
    field uses it."""
    header = _row_values(ws, header_row)
    next_idx = max((i for i, h in enumerate(header) if h.strip()), default=-1) + 1
    wanted = [('hidden', 'Verstecktes Feld', lambda s: s.get('hidden'))] + [
        (key, title, lambda s, key=key: (s.get('dev') or {}).get(key))
        for key, _, title in DEVELOPER_ATTRS]
    for key, title, used in wanted:
        if cols.get(key) is not None or not any(used(s) for s in specs):
            continue
        cell = ws.cell(row=header_row, column=next_idx + 1)
        cell.value = title
        if next_idx:
            cell._style = copy(ws.cell(row=header_row, column=next_idx)._style)
        cols[key] = next_idx
        next_idx += 1


def _place_new_rows(ws: Worksheet, cols: dict, header_row: int, last_row: int,
                    ordered: list[dict], row_for_fieldname: dict[str, int],
                    header_rows: dict[int, int], optid_to_inputid: dict) -> None:
    """Insert fields added in the builder at their correct line.

    Walking the builder's document order, each new field is queued to be inserted right after
    the spreadsheet row of the nearest preceding field that already exists (its section header
    counts). Consecutive new fields sharing an anchor are inserted as a block, in order.

    Builder content without a Fachdatenbezeichner cannot be looked up in the sheet. A new
    field that follows such content goes before the next field that can be found instead, or
    after the form's last row when none follows: anchoring on the last field found further up
    would pull it above everything in between (to the very top, in a sheet without the column).
    """
    groups: list[tuple[int, list[dict]]] = []  # (anchor original-row, specs to insert after it)

    def queue(anchor: int, specs: list[dict]):
        if groups and groups[-1][0] == anchor:
            groups[-1][1].extend(specs)
        else:
            groups.append((anchor, list(specs)))

    last_anchor = header_row
    unlocated = False   # builder content since last_anchor that the sheet cannot be searched for
    waiting: list[dict] = []  # new rows to go before the next row that is found
    for spec in ordered:
        fn = spec.get('field_name')
        found = row_for_fieldname.get(fn) if fn else header_rows.get(id(spec))
        if found:
            if waiting:
                queue(found - 1, waiting)
                waiting = []
            last_anchor, unlocated = found, False
            continue
        if not fn:
            # Metadata rows are found by their Format, so they say nothing about position.
            if not (spec.get('meta') or spec.get('email_of_form')):
                unlocated = True
            continue
        if unlocated:
            waiting.append(spec)
        else:
            queue(last_anchor, [spec])
    if waiting:
        queue(last_row, waiting)

    # Apply from the bottom up so the anchors of not-yet-processed (higher) groups stay valid.
    for anchor_row, specs in sorted(groups, key=lambda g: g[0], reverse=True):
        _insert_specs_after(ws, cols, anchor_row, specs, optid_to_inputid)


def _write_row(ws: Worksheet, r: int, cols: dict, spec: dict, optid_to_inputid: dict,
               input_id: Optional[str] = None) -> None:
    """Write a full spec into row r (used for both inserted and from-scratch rows)."""
    if input_id is not None and cols.get('input_id') is not None:
        ws.cell(row=r, column=cols['input_id'] + 1).value = input_id
    if cols.get('format') is not None and spec.get('format'):
        ws.cell(row=r, column=cols['format'] + 1).value = spec['format']
    if cols.get('field_name') is not None and spec.get('field_name'):
        ws.cell(row=r, column=cols['field_name'] + 1).value = spec['field_name']
    if cols.get('ref_id') is not None and spec.get('ref_id'):
        ws.cell(row=r, column=cols['ref_id'] + 1).value = spec['ref_id']
    if cols.get('comp_id') is not None and spec.get('comp_id'):
        ws.cell(row=r, column=cols['comp_id'] + 1).value = spec['comp_id']
    if cols.get('file_formats') is not None and spec.get('file_formats'):
        ws.cell(row=r, column=cols['file_formats'] + 1).value = spec['file_formats']
    if cols.get('weblink') is not None and spec.get('weblink'):
        ws.cell(row=r, column=cols['weblink'] + 1).value = spec['weblink']
    if cols.get('disable_mouse_over') is not None and spec.get('disable_mo'):
        ws.cell(row=r, column=cols['disable_mouse_over'] + 1).value = 'Ja'
    # Mirror the German label into the internal "Name AN deutsch" column when generating
    # from scratch (templates carry it); never set in overlay where that column isn't present.
    if cols.get('name_an_de') is not None:
        de = _strip_html((spec.get('label') or {}).get('DE', ''))
        if de:
            ws.cell(row=r, column=cols['name_an_de'] + 1).value = de
    _apply_overlay(ws, r, cols, spec)
    _apply_logic(ws, r, cols, spec, optid_to_inputid)


def _insert_specs_after(ws: Worksheet, cols: dict, anchor_row: int, specs: list[dict],
                        optid_to_inputid: dict) -> None:
    at = anchor_row + 1
    ws.insert_rows(at, amount=len(specs))
    for i, spec in enumerate(specs):
        _write_row(ws, at + i, cols, spec, optid_to_inputid)


# ── Deployment tab ──────────────────────────────────────────────────

def _find_deployment_sheet(wb):
    for ws in wb.worksheets:
        if _fold(ws.title) == _fold(DEPLOYMENT_SHEET):
            return ws
    return None


def _deployment_rows_by_key(ws) -> dict[str, int]:
    return {key: r for r in range(1, ws.max_row + 1)
            if (key := deployment_key(_cell_text(ws.cell(row=r, column=1).value)))}


def _write_deployment_sheet(wb, payload: dict) -> None:
    """Record the builder's deployment ids on their own tab of the workbook.

    This is what makes a spec workbook self-sufficient: importing it afresh elsewhere
    picks the ids up (see excel_importer.read_deployment_sheet) instead of asking for
    them again. The tab is written even when every value is still blank — it then
    doubles as the sheet to fill in by hand.

    An existing tab is updated row by row rather than rewritten, so anything else
    somebody put on it survives the export.
    """
    dep = {**(payload.get('deployment') or {}), 'formName': payload.get('formTitle')}
    ws = _find_deployment_sheet(wb)
    if ws is None:
        ws = wb.create_sheet(DEPLOYMENT_SHEET)
        ws.append(list(DEPLOYMENT_HEADERS))
        for col, width in zip('ABC', (18, 26, 44)):
            ws.column_dimensions[col].width = width
    value_col = deployment_value_column(
        [_row_values(ws, r) for r in range(1, ws.max_row + 1)])
    rows_by_key = _deployment_rows_by_key(ws)
    for key, label in DEPLOYMENT_FIELDS:
        value = (str(dep.get(key) or '')).strip() or None
        r = rows_by_key.get(key)
        if r is None:
            ws.append([key, label] + [''] * (value_col - 2) + [value])
        else:
            ws.cell(row=r, column=value_col + 1).value = value


# ── Version sheet ─────────────────────────────────────────────────────────────

def _find_version_sheet(wb):
    for ws in wb.worksheets:
        if _fold(ws.title) == 'version':
            return ws
    for ws in wb.worksheets:
        head = _row_values(ws, 1)
        folded = [_fold(v) for v in head]
        if any(h == 'version' for h in folded) and any('datum' in h for h in folded):
            return ws
    return None


def _last_content_row(ws, cols: list[int], header_row: int = 1) -> int:
    """Highest row (> header_row) holding any value in `cols`; header_row if none.

    Used to append after the real last version row, so a trailing blank-but-formatted row in
    the template doesn't leave a gap (openpyxl's ws.max_row counts such rows)."""
    last = header_row
    for r in range(header_row + 1, ws.max_row + 1):
        if any(_cell_text(ws.cell(row=r, column=ci + 1).value).strip() for ci in cols):
            last = r
    return last


def _version_cell_value(v: str):
    """Store a version the way the existing rows do: as a number when it round-trips exactly
    (so 0.4 / 19 right-align and read as numbers like the rows above), otherwise as the plain
    string (preserving e.g. a trailing-zero '0.10')."""
    v = (v or '').strip()
    for conv in (int, float):
        try:
            if str(conv(v)) == v:
                return conv(v)
        except ValueError:
            pass
    return v


def _date_number_format(ws, date_col: int, default: str = 'mm-dd-yy') -> str:
    """The number format the Datum column already uses (copied from an existing date cell),
    so an appended real date renders like the rows above. 'mm-dd-yy' is Excel's builtin
    locale-aware short date (id 14) — it displays per the user's locale (e.g. 04.07.2026)."""
    for r in range(2, ws.max_row + 1):
        cell = ws.cell(row=r, column=date_col + 1)
        if isinstance(cell.value, (datetime.date, datetime.datetime)):
            return cell.number_format
    return default


def _write_version_cells(ws, r: int, version_col: int, date_col: int, version: str) -> None:
    """Write the Version + Datum cells of a version row with real numeric/date types (not text),
    so they match the formatting of the existing rows."""
    ws.cell(row=r, column=version_col + 1).value = _version_cell_value(version)
    date_cell = ws.cell(row=r, column=date_col + 1)
    date_cell.value = datetime.date.today()
    date_cell.number_format = _date_number_format(ws, date_col)


def _next_version(ws, version_col: int) -> str:
    """Bump the last version: 18 -> 19, 0.2 -> 0.3; fall back to '0.1' / a date stamp."""
    last = ''
    for r in range(2, ws.max_row + 1):
        v = _cell_text(ws.cell(row=r, column=version_col + 1).value).strip()
        if v:
            last = v
    if not last:
        return '0.1'  # first version of a from-scratch workbook
    try:
        if '.' in last:
            major, minor = last.split('.', 1)
            return f'{int(major)}.{int(minor) + 1}'
        return str(int(last) + 1)
    except (ValueError, AttributeError):
        return datetime.date.today().isoformat()


def _norm_version(value) -> str:
    """Comparable form of a version cell: numbers and their text spellings must match, so a
    stored 0.3 and a typed "0.3" are the same version."""
    text = _cell_text(value).strip()
    try:
        return repr(float(text))
    except ValueError:
        return text.casefold()


def _find_version_row(ws, version_col: int, version: str) -> Optional[int]:
    """Row of an existing entry for `version` (last one wins), or None."""
    target = _norm_version(version)
    if not target:
        return None
    for r in range(ws.max_row, 1, -1):
        if _norm_version(ws.cell(row=r, column=version_col + 1).value) == target:
            return r
    return None


def _ensure_baseline_version(wb) -> str:
    """Seed a single '0.1' version row if the workbook has no version history yet.

    Returns the version the workbook now carries, so an unversioned export can still be
    named after it."""
    ws = _find_version_sheet(wb)
    if ws is None:
        ws = wb.create_sheet('Version')
        ws.append(['Version', 'Datum', 'Änderung', 'Autor'])
    rows = [v for r in range(2, ws.max_row + 1)
            if (v := _cell_text(ws.cell(row=r, column=1).value).strip())]
    if rows:
        return rows[-1]
    r = _last_content_row(ws, [0, 1, 2, 3]) + 1
    _write_version_cells(ws, r, version_col=0, date_col=1, version='0.1')
    return '0.1'



def _version_columns(ws) -> tuple[list[str], int, int, int]:
    """(folded header, Version column, Datum column, Änderung column) of a Version sheet."""
    folded = [_fold(v) for v in _row_values(ws, 1)]

    def col(*needles, default):
        for i, h in enumerate(folded):
            if any(n in h for n in needles):
                return i
        return default

    return (folded, col('version', default=0), col('datum', 'date', default=1),
            col('nderung', 'change', default=2))  # "Änderung" folds to "nderung"


def spec_revision(xlsx: Optional[bytes]) -> Optional[dict]:
    """{'version', 'date'} of the spec workbook's latest Version row — the last one filled
    in, as _next_version reads it — or None when there is no such row."""
    if not xlsx:
        return None
    try:
        wb = load_workbook(io.BytesIO(xlsx), data_only=True)
    except Exception:
        return None
    ws = _find_version_sheet(wb)
    if ws is None:
        return None
    _, version_col, date_col, _ = _version_columns(ws)
    row = _last_content_row(ws, [version_col])
    if row == 1:
        return None
    version = _cell_text(ws.cell(row=row, column=version_col + 1).value).strip()
    date = ws.cell(row=row, column=date_col + 1).value
    if isinstance(date, (datetime.date, datetime.datetime)):
        date = date.strftime('%Y-%m-%d')
    return {'version': version, 'date': _cell_text(date).strip()}


def _append_version_row(wb, *, author: str, note: str, version: str) -> str:
    ws = _find_version_sheet(wb)
    if ws is None:
        ws = wb.create_sheet('Version')
        ws.append(['Version', 'Datum', 'Änderung', 'Autor'])
    folded, version_col, date_col, change_col = _version_columns(ws)
    author_col = change_col + 1
    # Some templates have a dedicated author column after "Änderung" (BAV); others fold the
    # author into the Änderung column itself (FormGeneratorTemplate). Detect which.
    has_author_col = (author_col < len(folded) and bool(folded[author_col])) or any(
        _cell_text(ws.cell(row=r, column=author_col + 1).value).strip()
        for r in range(2, ws.max_row + 1))

    note, author = (note or '').strip(), (author or '').strip()
    version = (version or '').strip()
    # Re-using an existing version number means "this stays that version" — update that row in
    # place instead of adding a duplicate. Otherwise append after the last row that actually
    # holds data (not ws.max_row, which counts a trailing blank-but-formatted template row and
    # would leave a gap).
    r = _find_version_row(ws, version_col, version)
    if r is None:
        r = _last_content_row(ws, [version_col, date_col, change_col, author_col]) + 1
    recorded = version or _next_version(ws, version_col)
    # Write Version + Datum as real number/date values (matching the rows above), so Excel
    # right-aligns and formats them instead of storing left-aligned General text.
    _write_version_cells(ws, r, version_col, date_col, recorded)
    if has_author_col:
        ws.cell(row=r, column=change_col + 1).value = note or None
        if author:
            ws.cell(row=r, column=author_col + 1).value = author
    else:
        # No author column → combine into the change cell (matches templates that put the name there).
        ws.cell(row=r, column=change_col + 1).value = ' – '.join(p for p in (note, author) if p) or None
    return recorded
