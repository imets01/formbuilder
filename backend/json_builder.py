"""Pure function that turns a formbuilder payload into the final form-structure JSON.

No Flask, no I/O. Easy to test in isolation.

Each field in the output is a `FormField` record (see below): empty values are `None`
(never NaN), flags (`required`/`hidden_field`/`dont_show_mouse_over`) are real booleans,
and every record carries a uniform set of keys. `build_form_json` returns plain dicts (via
`FormField.as_record`); `dataObject` consumes those records directly — the debug endpoint
and snapshot builder read the same dicts.
"""

import datetime
import re
import unicodedata
from dataclasses import dataclass, asdict
from typing import Any, Optional

from field_names import reject_invalid_field_names
from input_events import format_events

# Map of component id -> ("Format PSPH" / Fachdatentyp, default input_length)
COMPONENT_TYPE_MAP = {
    'text-input':    ("Text einzeilig", "100"),
    'text-area':     ("Text mehrzeilig", "500"),
    'date':          ("Datum", None),
    'number':        ("Ganzzahl", "10"),
    'number-dropdown': ("Zahl Dropdown", "999"),
    'email':         ("Email-Adressen", "100"),
    'phone':         ("Telefonnummer", "50"),
    'upload-single': ("Upload Feld einfach", None),
    'upload-multi':  ("Upload Feld mehrfach", "5"),
    'button':          ("Button", None),
    'single-checkbox': ("Kontrollkasten", None),
}

OPTION_GROUP_FORMATS = {
    'radio':                ("Radio Button Title",     "Radio Button Option"),
    'checkbox':             ("Checkbox Title",         "Checkbox Option"),
    'select-single':        ("Drop Down Field Title",  "Drop Down Field Option"),
    'select-multi':         ("Drop Down Field Title",  "Drop Down Field Option"),
    'korrespondenzsprache': ("Drop Down Field Title",  "Drop Down Field Option"),
    'electronic-consent':   ("Zustimmung Verfügung",   "Radio Button Option"),
    # Catalog pickers are a multi-select prefilled with countries/cantons —
    # identical format to select-multi (rendered as the dual-listbox picker).
    'catalog-countries':    ("Drop Down Field Title",  "Drop Down Field Option"),
    'catalog-cantons':      ("Drop Down Field Title",  "Drop Down Field Option"),
}

SPLIT_LABELS = {
    'name-vorname': {
        'a': {'DE': 'Vorname', 'FR': 'Prénom',    'IT': 'Nome',    'EN': 'First Name'},
        'b': {'DE': 'Name',    'FR': 'Nom',       'IT': 'Cognome', 'EN': 'Last Name'},
    },
    'strasse-nr': {
        'a': {'DE': 'Strasse', 'FR': 'Rue',       'IT': 'Via',     'EN': 'Street'},
        'b': {'DE': 'Nr.',     'FR': 'No.',        'IT': 'N.',      'EN': 'No.'},
    },
    'plz-ort': {
        'a': {'DE': 'PLZ',     'FR': 'NPA',       'IT': 'CAP',     'EN': 'ZIP'},
        'b': {'DE': 'Ort',     'FR': 'Localité',  'IT': 'Località','EN': 'City'},
    },
}

METADATA_FORMATS = {
    'meta-title':         'Formulartitel',
    'meta-description':   'Beschreibung',
    'meta-department':    'Departement',
    'meta-federalOffice': 'Bundesamt',
    'meta-section':       'Sektion Bundesamt',
    'meta-address':       'Adresse Bundesamt',
    'meta-zipCity':       'PLZ und Ort des Bundesamtes',
}

# Font sizes that should be emitted as Header rather than Infotext.
HEADER_FONT_SIZES = {'lg', 'xl', '2xl'}


@dataclass
class FormField:
    """One field/row in the form-structure output.

    Mirrors the record shape the downstream generator consumes. Empty values are
    `None`; only `required`/`input` default to their canonical strings. Construct a
    record by passing just the fields that differ from these defaults — every other
    key is filled in uniformly.
    """
    de: Optional[str] = None
    fr: Optional[str] = None
    it: Optional[str] = None
    en: Optional[str] = None
    required: bool = False
    input: str = ""
    input_length: Optional[str] = None
    input_id: Optional[float] = None
    hinWeis_deutsch: Optional[str] = None
    hinWeis_franzosisch: Optional[str] = None
    hinWeis_italienisch: Optional[str] = None
    hinWeis_english: Optional[str] = None
    mouseOver_deutsch: Optional[str] = None
    mouseOver_franzosisch: Optional[str] = None
    mouseOver_italienisch: Optional[str] = None
    dec: Optional[str] = None
    subjectIdentifier: Optional[str] = None
    refID: Optional[str] = None
    comp_ID: Optional[str] = None
    # Render type ('select-multi', …). Can't live in comp_ID: on an imported form that
    # holds the sheet's Complimentary ID.
    builder_id: Optional[str] = None
    comments_for_devs: Optional[str] = None
    hidden_field: Optional[str] = None
    file_formats: Optional[str] = None
    file_restriction: Optional[str] = None
    dont_show_mouse_over: Optional[str] = None
    weblink: Optional[str] = None
    show_logic: Any = None
    hide_logic: Any = None
    font_size: Optional[str] = None
    aligned_infobox: Optional[bool] = None
    events: Optional[str] = None
    input_style: Optional[str] = None
    input_class: Optional[str] = None
    hidden_by_show_logic: bool = False

    def as_record(self) -> dict:
        record = asdict(self)
        record.pop('hidden_by_show_logic', None)
        for key in ('events', 'input_style', 'input_class'):
            if record[key] is None:
                del record[key]
        return record


def _slug(value: str) -> str:
    """Strip non-alphanumeric characters so a label can become an identifier."""
    if not value:
        return ""
    return re.sub(r'[^A-Za-z0-9]+', '', value)


def _translation(component, field, language, fallback=""):
    return (
        component.get('translations', {})
        .get(field, {})
        .get(language)
        or component.get(field)
        or fallback
    )


def _resolve_logic(logic, id_map):
    """
    Translate an array of LogicConditions (optionId strings or arrays of strings)
    into the renderer's nested-int-array shape: [5, [7, 11], 17].
    Refs that don't resolve to an Input ID (deleted option, etc.) are dropped.
    Non-list values (None on header/metadata rows) are returned untouched.
    """
    if not isinstance(logic, list):
        return logic
    if not logic:
        return None
    out = []
    for cond in logic:
        if isinstance(cond, list):
            inner = [id_map[r] for r in cond if r in id_map]
            if inner:
                out.append(inner if len(inner) > 1 else inner[0])
        elif isinstance(cond, str) and cond in id_map:
            out.append(id_map[cond])
    return out or None


def _placeholder(component, language):

    per_lang = component.get('translations', {}).get('placeholder', {})
    if language in per_lang:
        return per_lang[language] or ""
    return component.get('placeholder') or ""


def _resolve_input_type(comp):
    comp_id = comp.get('id')
    if comp_id == 'text':
        font_size = comp.get('fontSize') or 'base'
        return ("Header" if font_size in HEADER_FONT_SIZES else "Infotext", None)
    if comp_id == 'number' and comp.get('allowDecimals'):
        return ("Float", "10")
    return COMPONENT_TYPE_MAP.get(comp_id, ("Text einzeilig", "100"))

_TRANSLITERATIONS = {
    'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss',
}

MAX_FORM_NAME_LEN = 60


def safe_form_name(title: str) -> str:
    """
    Technical form name derived from the free-text title.

    The name is the base of every exported file, and an identifier downstream that is
    pasted into generated sources. So it has to survive as both: ASCII,
    no spaces or punctuation, and short enough not to blow the path limit.
    """
    for src, dst in _TRANSLITERATIONS.items():
        title = title.replace(src, dst)
    # Remaining accents (é, à, ç) fold to their base letter; anything still non-ASCII drops.
    title = unicodedata.normalize('NFKD', title).encode('ascii', 'ignore').decode('ascii')
    name = re.sub(r'[^A-Za-z0-9]+', '_', title).strip('_')
    if len(name) > MAX_FORM_NAME_LEN:
        # Cut back to the last whole word so the truncation stays readable.
        name = name[:MAX_FORM_NAME_LEN].rsplit('_', 1)[0].strip('_') or name[:MAX_FORM_NAME_LEN]
    return name or 'actualForm'


def safe_version(version: str) -> str:
    """A version number as it may appear in a file name. Dots are kept — "2.1.1" is the
    point of it — everything else a file name shouldn't carry becomes an underscore."""
    return re.sub(r'[^A-Za-z0-9.]+', '_', str(version or '')).strip('._')


def output_base_name(deployment: dict) -> str:
    """The technical form name chosen in the Developer settings, or '' if none is.

    The form title is a poor base for the generated artifacts: the platform names a form by a
    short code (AbcQz356 -> queryAbcQz356_de.sql), not by a sentence. `baseName` overrides
    it for everything the pipeline emits, while the spec .xlsx keeps its title-based name.

    A leading "query" is dropped, because the pipeline adds that prefix itself — so typing
    either the code (AbcQz356) or the file name as it should appear (queryAbcQz356) lands
    on the same artifacts.

    Mirrored by `outputBaseName` in frontend/src/app/services/form-name.ts — keep in sync.
    """
    base = str(deployment.get('baseName') or '').strip()
    if not base:
        return ''
    name = safe_form_name(base)
    return re.sub(r'^query_*', '', name, flags=re.IGNORECASE) or name


def export_file_name(title: str, version: str = '', when: datetime.date | None = None) -> str:
    """`<YYMMDD>_<form name>_<version>`, without extension.

    Successive exports of one form differ only by date and version, so both go in the
    name: in a downloads folder the plain form name would just collect " (1)", " (2)"
    suffixes from the browser and lose which spec is which.

    Mirrored by `exportFileName` in frontend/src/app/services/form-name.ts, which names the
    download the browser writes — keep the two in sync.
    """
    stamp = (when or datetime.date.today()).strftime('%y%m%d')
    parts = [stamp, safe_form_name(title), safe_version(version)]
    return '_'.join(p for p in parts if p)


def build_form_json(payload: dict) -> dict:
    """Turn the raw formbuilder payload (as sent by the frontend) into the final form-structure JSON."""
    reject_invalid_field_names(payload)
    sections = payload.get('sections', [])
    form_title = (payload.get('formTitle') or 'actualForm').strip() or 'actualForm'
    dep = payload.get('deployment') or {}
    # Every generated file (and the identifiers pasted inside them) is named from this.
    form_name = output_base_name(dep) or safe_form_name(form_title)
    disable_input_size = bool(payload.get('disableInputSize', False))
    disable_mouse_over = bool(payload.get('disableMouseOver', False))

    parts = {}

    # Pull out metadata sections, emit them at the top into TO_BE_REMOVED.
    metadata_section = {}
    metadata_index = 0
    user_sections = []
    for sec in sections:
        if sec.get('isMetadata'):
            for comp in sec.get('components') or []:
                comp_id = comp.get('id')
                fmt = METADATA_FORMATS.get(comp_id)
                if not fmt:
                    continue
                translations = (comp.get('translations') or {}).get('title') or {}
                de = (translations.get('DE') or '').strip()
                fr = (translations.get('FR') or '').strip()
                it = (translations.get('IT') or '').strip()
                en = (translations.get('EN') or '').strip()
                if not (de or fr or it or en):
                    continue
                # Header link uses the same mechanism as field labels: the user marks
                # the clickable part with <a>…</a> in the text and sets a Weblink URL.
                weblink = (comp.get('weblink') or '').strip() if comp_id == 'meta-description' else ''
                if not weblink and comp_id == 'meta-description':
                    # Legacy forms stored the URL in linkUrl with the whole text as the link.
                    legacy = (comp.get('linkUrl') or '').strip()
                    if legacy:
                        weblink = legacy
                        de = f"<a>{de}</a>" if de else de
                        fr = f"<a>{fr}</a>" if fr else fr
                        it = f"<a>{it}</a>" if it else it
                        en = f"<a>{en}</a>" if en else en
                entry_key = f"{fmt}{metadata_index}"
                metadata_section[entry_key] = FormField(
                    de=de or "",
                    fr=fr or "",
                    it=it or "",
                    en=en or "",
                    input=fmt,
                    dec=de or fr or it or en,
                    weblink=weblink or None,
                )
                metadata_index += 1
        else:
            user_sections.append(sec)
    if metadata_section:
        parts['TO_BE_REMOVED'] = metadata_section
    sections = user_sections

    # The electronic-delivery consent ("Zustimmung Verfügung") is a closing legal
    # element rendered entirely by a platform-side macro downstream (which
    # supplies its own legal text + Yes/No radio). So we don't emit it as fields —
    # we just record whether the user placed the component, and the generator emits
    # the standard consent block at the end of the form when present. The settings that
    # still mean something for a macro-rendered block travel with it.
    has_consent = False
    consent_hidden = False
    consent_has_logic = False
    trimmed_sections = []
    for sec in sections:
        comps = sec.get('components') or []
        for c in comps:
            if c.get('id') != 'electronic-consent':
                continue
            has_consent = True
            if c.get('hiddenField') or c.get('showLogic') or sec.get('hiddenField') or sec.get('showLogic'):
                consent_hidden = True
            if c.get('showLogic') or c.get('hideLogic'):
                consent_has_logic = True
        kept = [c for c in comps if c.get('id') != 'electronic-consent']
        trimmed_sections.append({**sec, 'components': kept})
    sections = trimmed_sections

    used_section_keys = set()
    field_index = 0
    # Map optionId (from the builder) -> input_id (int the renderer uses for logic).
    option_id_to_input_id = {}

    # makes non unique identifiers unique.
    used_subject_ids: set[str] = set()

    def _unique_subject_id(base: str) -> str:
        sid, n = base, 2
        while sid in used_subject_ids:
            sid = f"{base}_{n}"
            n += 1
        used_subject_ids.add(sid)
        return sid

    for sec_idx, section in enumerate(sections):
        raw_section_title = (section.get('title') or '').strip()
        section_title = raw_section_title or f'Section {sec_idx + 1}'
        section_key = _slug(section_title) or f'Section{sec_idx + 1}'

        # Per-language heading text (DE/FR/IT/EN); FR/IT/EN fall back to DE, DE to the base title.
        section_titles = (section.get('translations') or {}).get('title') or {}
        hdr_de = (section_titles.get('DE') or '').strip() or raw_section_title
        hdr_fr = (section_titles.get('FR') or '').strip() or hdr_de
        hdr_it = (section_titles.get('IT') or '').strip() or hdr_de
        hdr_en = (section_titles.get('EN') or '').strip() or hdr_de

        unique_key = section_key
        dedupe = 2
        while unique_key in used_section_keys:
            unique_key = f"{section_key}_{dedupe}"
            dedupe += 1
        used_section_keys.add(unique_key)
        parts[unique_key] = {}
        section_payload = parts[unique_key]
        is_aggregate = bool(section.get('isAggregate'))

        # A conditional section toggles as a whole: its heading and every field inside it
        # appear/disappear together. We implement that by pushing the section's logic down
        # onto the heading row and onto each field that has no logic of its own, so the
        # existing per-field show/hide machinery reveals the block in unison.
        sec_show = section.get('showLogic') or None
        sec_hide = section.get('hideLogic') or None
        # "Hidden by default" can be set on its own (a permanently hidden section) or
        # together with a Show condition (hidden until the option is selected).
        sec_hidden = bool(section.get('hiddenField'))
        sec_conditional = bool(sec_show or sec_hide or sec_hidden)

        # Emit a <@titleRow> for the section heading when the user named the section.
        if raw_section_title or any((v or '').strip() for v in section_titles.values()):
            section_payload[f'__sectionhdr_{sec_idx}'] = FormField(
                de=hdr_de,
                fr=hdr_fr,
                it=hdr_it,
                en=hdr_en,
                input='header',
                dec=raw_section_title,
                show_logic=sec_show,
                hide_logic=sec_hide,
                hidden_field=True if sec_conditional else None,
                hidden_by_show_logic=bool(sec_show) and not sec_hidden and not sec_hide,
            )

        if is_aggregate:
            agg_refid = (section.get('aggregateRefID') or '').strip()
            agg_fdb = (section.get('aggregateFachdatenbezeichner') or '').strip()
            agg_compid = (section.get('aggregateCompId') or '').strip() or None
            field_index += 1
            start_key = f"Aggregate_Start_{field_index}"
            section_payload[start_key] = FormField(
                input="Aggregate start",
                input_id=float(field_index),
                subjectIdentifier=agg_fdb or None,
                refID=agg_refid or "",
                comp_ID=agg_compid,
            )
            for gIdx, group in enumerate(section.get('groups') or [], start=1):
                field_index += 1
                group_key = f"Group_{gIdx}_{field_index}"
                section_payload[group_key] = FormField(
                    input=f"Group {gIdx}",
                    input_id=float(field_index),
                    refID=(group.get('refID') or '').strip() or "",
                )

        for comp in section.get('components', []):
            field_index += 1
            comp_id = comp.get('id')

            if comp_id in OPTION_GROUP_FORMATS:
                title_input, option_input = OPTION_GROUP_FORMATS[comp_id]
                de_label = _translation(comp, 'title', 'DE', comp.get('label', ''))
                fr_label = _translation(comp, 'title', 'FR', de_label)
                it_label = _translation(comp, 'title', 'IT', de_label)
                en_label = _translation(comp, 'title', 'EN', de_label)
                required = bool(comp.get('required'))
                title_subject_id = _unique_subject_id(
                    (comp.get('fieldName') or '').strip() or f"Field_{_slug(de_label) or comp_id}")
                dont_show = True if comp.get('disableMouseOver') else None
                # A Show condition implies the field starts hidden (it's revealed when the
                # condition holds), so showLogic counts as hidden-by-default on its own.
                hidden = True if (comp.get('hiddenField') or comp.get('showLogic')) else None
                hidden_by_show = (bool(comp.get('showLogic') or sec_show)
                                  and not comp.get('hiddenField')
                                  and not sec_hidden and not sec_hide)
                # dont_show only suppresses the macro's derived tooltip; explicit text is
                # kept and still rendered (PSPH sheets set "Mouseover nicht anzeigen" on
                # rows that do carry a mouseover).
                mouse_over_de = (comp.get('mouseOverDe') or '').strip() or None
                mouse_over_fr = (comp.get('mouseOverFr') or '').strip() or None
                mouse_over_it = (comp.get('mouseOverIt') or '').strip() or None
                title_key = f"{title_subject_id}{field_index}"
                dedupe_suffix = 2
                while title_key in section_payload:
                    title_key = f"{title_subject_id}{field_index}_{dedupe_suffix}"
                    dedupe_suffix += 1
                section_payload[title_key] = FormField(
                    de=de_label,
                    fr=fr_label,
                    it=it_label,
                    en=en_label,
                    required=required,
                    input=title_input,
                    input_id=float(field_index),
                    mouseOver_deutsch=mouse_over_de,
                    mouseOver_franzosisch=mouse_over_fr,
                    mouseOver_italienisch=mouse_over_it,
                    dec=de_label,
                    subjectIdentifier=title_subject_id,
                    refID=comp.get('refID', '') or "",
                    comp_ID=comp.get('compId') or comp_id,
                    builder_id=comp_id,
                    comments_for_devs=comp.get('commentsForDevs') or None,
                    hidden_field=hidden or (True if sec_conditional else None),
                    hidden_by_show_logic=hidden_by_show,
                    dont_show_mouse_over=dont_show,
                    weblink=(comp.get('weblink') or '').strip() or None,
                    show_logic=comp.get('showLogic') or sec_show,
                    hide_logic=comp.get('hideLogic') or sec_hide,
                )

                for opt in comp.get('options') or []:
                    field_index += 1
                    opt_id = opt.get('optionId')
                    if opt_id:
                        option_id_to_input_id[opt_id] = field_index
                    translations = opt.get('translations') or {}
                    opt_de = translations.get('DE', '')
                    opt_fr = translations.get('FR', opt_de)
                    opt_it = translations.get('IT', opt_de)
                    opt_en = translations.get('EN', opt_de)
                    opt_subject_id = _unique_subject_id(
                        (opt.get('fieldName') or '').strip() or f"Field_{_slug(opt_de) or 'Option'}")
                    opt_key = f"{opt_subject_id}{field_index}"
                    dedupe_suffix = 2
                    while opt_key in section_payload:
                        opt_key = f"{opt_subject_id}{field_index}_{dedupe_suffix}"
                        dedupe_suffix += 1
                    section_payload[opt_key] = FormField(
                        de=opt_de,
                        fr=opt_fr,
                        it=opt_it,
                        en=opt_en,
                        input=option_input,
                        input_id=float(field_index),
                        dec=opt_de,
                        subjectIdentifier=opt_subject_id,
                        refID=(opt.get('refID') or '').strip() or "",
                        hidden_field=hidden,
                        dont_show_mouse_over=True,
                    )
                continue

            if comp_id == 'split-input':
                variant = comp.get('splitVariant') or 'name-vorname'
                labels = SPLIT_LABELS.get(variant, SPLIT_LABELS['name-vorname'])
                split_cfg = comp.get('splitConfig') or {}
                required = bool(comp.get('required'))
                for side in ('a', 'b'):
                    side_cfg = split_cfg.get(side) or {}
                    side_labels = labels[side]
                    titles = side_cfg.get('titles') or {}
                    label = lambda lng: (titles.get(lng) or '').strip() or side_labels[lng]
                    placeholders = side_cfg.get('placeholders') or {}
                    subject_id = _unique_subject_id(
                        (side_cfg.get('fieldName') or '').strip() or f"Field_{_slug(label('DE'))}")
                    side_mouse_de = (side_cfg.get('mouseOverDe') or '').strip() or None
                    side_mouse_fr = (side_cfg.get('mouseOverFr') or '').strip() or None
                    side_mouse_it = (side_cfg.get('mouseOverIt') or '').strip() or None
                    side_dont_show = True if comp.get('disableMouseOver') else None
                    instance_key = f"{subject_id}{field_index}"
                    dedupe_suffix = 2
                    while instance_key in section_payload:
                        instance_key = f"{subject_id}{field_index}_{dedupe_suffix}"
                        dedupe_suffix += 1
                    section_payload[instance_key] = FormField(
                        de=label('DE'),
                        fr=label('FR'),
                        it=label('IT'),
                        en=label('EN'),
                        required=required,
                        input="Text einzeilig",
                        input_length="100",
                        input_id=float(field_index),
                        hinWeis_deutsch=placeholders.get('DE') or None,
                        hinWeis_franzosisch=placeholders.get('FR') or None,
                        hinWeis_italienisch=placeholders.get('IT') or None,
                        mouseOver_deutsch=side_mouse_de,
                        mouseOver_franzosisch=side_mouse_fr,
                        mouseOver_italienisch=side_mouse_it,
                        dec=side_labels['DE'],
                        subjectIdentifier=subject_id,
                        refID=(side_cfg.get('refID') or comp.get('refID') or '').strip(),
                        comp_ID=comp.get('compId') or None,
                        comments_for_devs=comp.get('commentsForDevs') or None,
                        hidden_field=True if (comp.get('hiddenField') or comp.get('showLogic') or sec_conditional) else None,
                        hidden_by_show_logic=(bool(comp.get('showLogic') or sec_show)
                                              and not comp.get('hiddenField')
                                              and not sec_hidden and not sec_hide),
                        dont_show_mouse_over=side_dont_show,
                        weblink=(comp.get('weblink') or '').strip() or None,
                        show_logic=comp.get('showLogic') or sec_show,
                        hide_logic=comp.get('hideLogic') or sec_hide,
                    )
                    field_index += 1
                field_index -= 1
                continue

            input_type, default_length = _resolve_input_type(comp)
            is_text_block = comp_id == 'text'

            required = bool(comp.get('required'))

            max_length = comp.get('maxLength')
            if max_length is None or max_length == '':
                input_length = default_length
            else:
                input_length = str(max_length)

            if is_text_block:
                de_label = _translation(comp, 'content', 'DE', comp.get('content', ''))
                fr_label = _translation(comp, 'content', 'FR', de_label)
                it_label = _translation(comp, 'content', 'IT', de_label)
                en_label = _translation(comp, 'content', 'EN', de_label)
                de_hint = fr_hint = it_hint = en_hint = None
            else:
                de_label = _translation(comp, 'title', 'DE', comp.get('label', ''))
                fr_label = _translation(comp, 'title', 'FR', de_label)
                it_label = _translation(comp, 'title', 'IT', de_label)
                en_label = _translation(comp, 'title', 'EN', de_label)
                de_hint = _placeholder(comp, 'DE') or None
                fr_hint = _placeholder(comp, 'FR') or None
                it_hint = _placeholder(comp, 'IT') or None
                en_hint = _placeholder(comp, 'EN') or None

            user_field_name = (comp.get('fieldName') or '').strip()
            subject_id = _unique_subject_id(
                user_field_name
                or comp.get('subjectIdentifier')
                or comp.get('fachdatenbezeichner')
                or f"Field_{_slug(de_label) or comp_id}"
            )

            dec_value = de_label
            dont_show = True if comp.get('disableMouseOver') else None
            mouse_over_de = (comp.get('mouseOverDe') or '').strip() or None
            mouse_over_fr = (comp.get('mouseOverFr') or '').strip() or None
            mouse_over_it = (comp.get('mouseOverIt') or '').strip() or None

            instance_key = f"{subject_id}{field_index}"
            dedupe_suffix = 2
            while instance_key in section_payload:
                instance_key = f"{subject_id}{field_index}_{dedupe_suffix}"
                dedupe_suffix += 1

            section_payload[instance_key] = FormField(
                de=de_label,
                fr=fr_label,
                it=it_label,
                en=en_label,
                required=required,
                input=input_type,
                input_length=input_length,
                input_id=float(field_index),
                hinWeis_deutsch=de_hint,
                hinWeis_franzosisch=fr_hint,
                hinWeis_italienisch=it_hint,
                hinWeis_english=en_hint,
                mouseOver_deutsch=mouse_over_de,
                mouseOver_franzosisch=mouse_over_fr,
                mouseOver_italienisch=mouse_over_it,
                dec=dec_value,
                subjectIdentifier=subject_id,
                refID=comp.get('refID', '') or "",
                comp_ID=comp.get('compId') or None,
                comments_for_devs=comp.get('commentsForDevs') or None,
                hidden_field=True if (comp.get('hiddenField') or comp.get('showLogic') or sec_conditional) else None,
                hidden_by_show_logic=(bool(comp.get('showLogic') or sec_show)
                                      and not comp.get('hiddenField')
                                      and not sec_hidden and not sec_hide),
                file_formats=(comp.get('fileFormats') or '').strip() or None,
                file_restriction=(comp.get('fileRestriction') or '').strip() or None,
                dont_show_mouse_over=dont_show,
                weblink=(comp.get('weblink') or '').strip() or None,
                show_logic=comp.get('showLogic') or sec_show,
                hide_logic=comp.get('hideLogic') or sec_hide,
                font_size=comp.get('fontSize') if is_text_block else None,
                aligned_infobox=True if (is_text_block and comp.get('alignedInfobox')) else None,
                # onChange: builder files saved before events were generic.
                events=format_events(comp.get('events') or comp.get('onChange')) or None,
                input_style=(comp.get('inputStyle') or '').strip() or None,
                input_class=(comp.get('inputClass') or '').strip() or None,
            )

        if is_aggregate:
            field_index += 1
            end_key = f"Aggregate_End_{field_index}"
            section_payload[end_key] = FormField(
                input="Aggregate end",
                input_id=float(field_index),
            )

    # Resolve all show_logic / hide_logic optionId refs to numeric Input IDs, then
    # flatten the FormField records to plain dicts for the downstream consumers.

    option_inputs = {option for _, option in OPTION_GROUP_FORMATS.values()}
    for section_entries in parts.values():
        unhiding_group = False
        for entry in section_entries.values():
            entry.show_logic = _resolve_logic(entry.show_logic, option_id_to_input_id)
            entry.hide_logic = _resolve_logic(entry.hide_logic, option_id_to_input_id)
            if entry.input in option_inputs:
                if unhiding_group:
                    entry.hidden_field = None
                continue
            unhiding_group = entry.hidden_by_show_logic and not entry.show_logic
            if unhiding_group:
                entry.hidden_field = None
    parts = {
        section_key: {key: entry.as_record() for key, entry in section_entries.items()}
        for section_key, section_entries in parts.items()
    }

    def _dep(field, default):
        return (str(dep.get(field) or '')).strip() or default

    return {
        "formNameFull": form_name,
        "formName": form_name,
        "parts": parts,
        "compName": _dep('compName', ''),
        "usr_id": _dep('usrId', ''),
        "usr_id_dev": _dep('usrIdDev', ''),
        "de_id": _dep('deId', ''),
        "it_id": _dep('itId', ''),
        "fr_id": _dep('frId', ''),
        "en_id": _dep('enId', ''),
        "email": _dep('contactEmail', ''),
        "wiki_link": _dep('wikiLink', ''),
        "issue_link": _dep('issueLink', ''),
        "validator_class": _dep('validatorClass', ''),
        "has_consent": has_consent,
        "consent_hidden": consent_hidden,
        "consent_has_logic": consent_has_logic,
        "disable_mouse_over": disable_mouse_over,
        "disable_input_size": disable_input_size,
    }
