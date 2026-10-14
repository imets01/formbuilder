"""
Self-contained HTML preview, rendered straight from the form payload.

One standalone document per language: inline CSS, no external assets, no template
engine. Option groups become fieldsets, aggregate sections become repeating blocks,
and fields carrying show/hide logic are badged so conditional behaviour is visible
without filling the form in.
"""

from __future__ import annotations

import html
from typing import Any

_LANGUAGES = ("de", "en", "fr", "it")

# Payload translations are keyed by the uppercase two-letter code.
_LANG_KEY = {"de": "DE", "en": "EN", "fr": "FR", "it": "IT"}

_UI_TEXT = {
    "de": {"submit": "Senden", "required": "Pflichtfeld", "conditional": "bedingt eingeblendet",
           "aggregate": "Wiederholbarer Block", "upload": "Datei auswählen",
           "demo": "Vorschau — das Formular kann hier nicht abgeschickt werden"},
    "en": {"submit": "Submit", "required": "required", "conditional": "shown conditionally",
           "aggregate": "Repeatable block", "upload": "Choose file",
           "demo": "Preview — this form cannot be submitted here"},
    "fr": {"submit": "Envoyer", "required": "obligatoire", "conditional": "affiché sous condition",
           "aggregate": "Bloc répétable", "upload": "Choisir un fichier",
           "demo": "Aperçu — ce formulaire ne peut pas être envoyé ici"},
    "it": {"submit": "Invia", "required": "obbligatorio", "conditional": "mostrato condizionalmente",
           "aggregate": "Blocco ripetibile", "upload": "Scegli un file",
           "demo": "Anteprima — questo modulo non può essere inviato qui"},
}

_OPTION_GROUPS = {
    "radio": "radio",
    "checkbox": "checkbox",
    "electronic-consent": "radio",
    "select-single": "select",
    "select-multi": "select-multi",
    "korrespondenzsprache": "select",
    "catalog-countries": "select-multi",
    "catalog-cantons": "select-multi",
}

_INPUT_TYPES = {
    "text-input": "text",
    "text-area": "textarea",
    "date": "date",
    "number": "number",
    "email": "email",
    "phone": "tel",
}

_SPLIT_LABELS = {
    "name-vorname": {"a": {"DE": "Vorname", "FR": "Prénom", "IT": "Nome", "EN": "First Name"},
                     "b": {"DE": "Name", "FR": "Nom", "IT": "Cognome", "EN": "Last Name"}},
    "strasse-nr": {"a": {"DE": "Strasse", "FR": "Rue", "IT": "Via", "EN": "Street"},
                   "b": {"DE": "Nr.", "FR": "No.", "IT": "N.", "EN": "No."}},
    "plz-ort": {"a": {"DE": "PLZ", "FR": "NPA", "IT": "CAP", "EN": "ZIP"},
                "b": {"DE": "Ort", "FR": "Localité", "IT": "Località", "EN": "City"}},
}

_STYLES = """
:root {
  --ink: #1a1d21; --muted: #5d6673; --line: #d8dee6; --bg: #f4f6f8;
  --card: #ffffff; --accent: #1f5fa9; --accent-soft: #eaf1fa; --flag: #8a6d1f;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif; }
.page { max-width: 820px; margin: 0 auto; padding: 24px 16px 56px; }
.banner { background: var(--accent-soft); border: 1px solid #c2d6ee; color: #1b4b85;
  border-radius: 6px; padding: 9px 12px; font-size: 13px; margin-bottom: 18px; }
.langbar { display: flex; gap: 6px; margin-bottom: 14px; }
.langbar a { display: inline-block; min-width: 30px; text-align: center; padding: 4px 8px;
  border: 1px solid var(--line); border-radius: 4px; background: var(--card);
  color: var(--muted); text-decoration: none; font-size: 13px; }
.langbar a.on { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: 28px 30px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.lede { color: var(--muted); margin: 0 0 22px; }
h2 { font-size: 16px; margin: 30px 0 4px; padding-bottom: 6px;
  border-bottom: 1px solid var(--line); }
h2:first-of-type { margin-top: 0; }
.field { margin: 16px 0; }
label.lbl { display: block; font-weight: 600; margin-bottom: 5px; font-size: 14px; }
.req { color: #b3261e; margin-left: 3px; }
input[type=text], input[type=date], input[type=number], input[type=email],
input[type=tel], textarea, select { width: 100%; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: 5px; font: inherit;
  background: #fcfdfe; color: var(--ink); }
textarea { min-height: 84px; resize: vertical; }
select[multiple] { min-height: 128px; }
.split { display: flex; gap: 12px; }
.split > div:first-child { flex: 2; } .split > div:last-child { flex: 1; }
fieldset { border: 1px solid var(--line); border-radius: 6px; margin: 16px 0; padding: 12px 14px; }
legend { font-weight: 600; font-size: 14px; padding: 0 5px; }
.opt { display: block; margin: 5px 0; font-size: 14px; }
.opt input { margin-right: 7px; }
.info { background: #fbfbfc; border-left: 3px solid var(--line); padding: 9px 13px;
  margin: 16px 0; color: var(--muted); font-size: 14px; }
.flag { display: inline-block; margin-left: 7px; padding: 1px 7px; border-radius: 10px;
  background: #fdf5e0; color: var(--flag); font-size: 11px; font-weight: 600;
  vertical-align: middle; }
.agg { border: 1px dashed #b9c4d2; border-radius: 7px; padding: 4px 16px 14px;
  margin: 24px 0; background: #fafcfe; }
.agg > .tag { display: inline-block; margin: -12px 0 6px; background: var(--card);
  padding: 0 7px; font-size: 12px; color: var(--muted); }
.actions { margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--line); }
button.submit { background: var(--accent); color: #fff; border: 0; border-radius: 5px;
  padding: 10px 22px; font: inherit; font-weight: 600; cursor: pointer; }
.hint { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #e8eaed; --muted: #9aa4b1; --line: #343a42; --bg: #16181c;
          --card: #1e2126; --accent: #5b9bd8; --accent-soft: #1d2a38; --flag: #d9b55f; }
  input[type=text], input[type=date], input[type=number], input[type=email],
  input[type=tel], textarea, select { background: #191c20; }
  .info, .agg { background: #1a1d21; }
  .banner { border-color: #2d4055; color: #a9c8ea; }
}
"""


def _t(node: dict, kind: str, lang: str) -> str:
    """A component's or section's translated string of the given kind."""
    block = (node.get("translations") or {}).get(kind) or {}
    key = _LANG_KEY[lang]
    return (block.get(key) or block.get("DE") or block.get("EN") or "").strip()


def _opt_label(option: dict, lang: str) -> str:
    """Option translations are flat: {DE: ..., FR: ...}."""
    block = option.get("translations") or {}
    key = _LANG_KEY[lang]
    return (block.get(key) or block.get("DE") or block.get("EN") or "").strip()


def _has_logic(node: dict) -> bool:
    return bool(node.get("showLogic") or node.get("hideLogic"))


def _flag(node: dict, lang: str) -> str:
    if not _has_logic(node):
        return ""
    return f'<span class="flag">{_UI_TEXT[lang]["conditional"]}</span>'


def _required(component: dict) -> bool:
    validation = component.get("validation") or {}
    return bool(validation.get("required") or validation.get("mandatory"))


def _label(component: dict, lang: str, text: str = "") -> str:
    caption = html.escape(text or _t(component, "title", lang) or component.get("fieldName") or "")
    star = '<span class="req">*</span>' if _required(component) else ""
    return f'<label class="lbl">{caption}{star}{_flag(component, lang)}</label>'


def _input_field(component: dict, lang: str) -> str:
    kind = _INPUT_TYPES.get(component.get("id") or "", "text")
    placeholder = _t(component, "placeholder", lang)
    attr = f' placeholder="{html.escape(placeholder)}"' if placeholder else ""
    if kind == "textarea":
        control = f"<textarea{attr}></textarea>"
    else:
        control = f'<input type="{kind}"{attr}>'
    return f'<div class="field">{_label(component, lang)}{control}</div>'


def _split_field(component: dict, lang: str) -> str:
    config = component.get("splitConfig") or {}
    labels = _SPLIT_LABELS.get(config.get("kind") or component.get("splitKind") or "name-vorname",
                              _SPLIT_LABELS["name-vorname"])
    key = _LANG_KEY[lang]
    sides = "".join(
        f'<div><label class="lbl">{html.escape(labels[side].get(key, ""))}</label>'
        f'<input type="text"></div>'
        for side in ("a", "b")
    )
    title = _t(component, "title", lang)
    heading = f'<label class="lbl">{html.escape(title)}{_flag(component, lang)}</label>' if title else ""
    return f'<div class="field">{heading}<div class="split">{sides}</div></div>'


def _option_field(component: dict, lang: str, group: str) -> str:
    options = component.get("options") or []
    title = _t(component, "title", lang) or component.get("fieldName") or ""
    star = '<span class="req">*</span>' if _required(component) else ""
    legend = f"<legend>{html.escape(title)}{star}{_flag(component, lang)}</legend>"

    if group in ("select", "select-multi"):
        multiple = " multiple" if group == "select-multi" else ""
        items = "".join(f"<option>{html.escape(_opt_label(o, lang))}</option>" for o in options)
        return f'<div class="field"><label class="lbl">{html.escape(title)}{star}' \
               f'{_flag(component, lang)}</label><select{multiple}>{items}</select></div>'

    name = html.escape(component.get("instanceId") or component.get("id") or "g")
    items = "".join(
        f'<label class="opt"><input type="{group}" name="{name}">'
        f"{html.escape(_opt_label(o, lang))}</label>"
        for o in options
    )
    return f"<fieldset>{legend}{items}</fieldset>"


def _upload_field(component: dict, lang: str) -> str:
    multiple = " multiple" if component.get("id") == "upload-multi" else ""
    formats = (component.get("validation") or {}).get("fileFormats")
    hint = f'<div class="hint">{html.escape(str(formats))}</div>' if formats else ""
    return f'<div class="field">{_label(component, lang)}' \
           f'<input type="file"{multiple}>{hint}</div>'


def _text_block(component: dict, lang: str) -> str:
    body = _t(component, "content", lang) or _t(component, "title", lang)
    if not body:
        return ""
    return f'<div class="info">{html.escape(body)}{_flag(component, lang)}</div>'


def _checkbox_field(component: dict, lang: str) -> str:
    caption = _t(component, "title", lang) or component.get("fieldName") or ""
    return f'<div class="field"><label class="opt"><input type="checkbox">' \
           f"{html.escape(caption)}{_flag(component, lang)}</label></div>"


def _button_field(component: dict, lang: str) -> str:
    caption = _t(component, "title", lang) or _UI_TEXT[lang]["submit"]
    return f'<div class="field"><button class="submit" type="button">' \
           f"{html.escape(caption)}</button></div>"


def _component(component: dict, lang: str) -> str:
    comp_id = component.get("id") or ""
    if comp_id in _OPTION_GROUPS:
        return _option_field(component, lang, _OPTION_GROUPS[comp_id])
    if comp_id == "split-input":
        return _split_field(component, lang)
    if comp_id in ("upload-single", "upload-multi"):
        return _upload_field(component, lang)
    if comp_id == "single-checkbox":
        return _checkbox_field(component, lang)
    if comp_id == "button":
        return _button_field(component, lang)
    if comp_id in ("text", "infotext"):
        return _text_block(component, lang)
    if comp_id in _INPUT_TYPES:
        return _input_field(component, lang)
    # Unknown palette ids degrade to a text field, matching _resolve_input_type's fallback.
    return _input_field(component, lang)


def _metadata_header(section: dict, lang: str, fallback_title: str) -> str:
    title, lede = "", ""
    for component in section.get("components") or []:
        text = _t(component, "title", lang) or _t(component, "content", lang)
        if component.get("id") == "meta-title" or (not title and text):
            title = title or text
        elif text:
            lede = lede or text
    title = title or fallback_title
    out = f"<h1>{html.escape(title)}</h1>" if title else ""
    if lede:
        out += f'<p class="lede">{html.escape(lede)}</p>'
    return out


def _section(section: dict, lang: str) -> str:
    title = _t(section, "title", lang) or section.get("title") or ""
    body = "".join(_component(c, lang) for c in section.get("components") or [])
    heading = f"<h2>{html.escape(title)}{_flag(section, lang)}</h2>" if title else ""
    if section.get("isAggregate"):
        tag = _UI_TEXT[lang]["aggregate"]
        return f'<div class="agg"><span class="tag">{tag}</span>{heading}{body}</div>'
    return heading + body


def render(payload: dict, language: str, token: str = "") -> str:
    """Render one language of the form as a standalone HTML document."""
    lang = language if language in _LANGUAGES else "en"
    sections = payload.get("sections") or []
    form_title = (payload.get("formTitle") or "").strip()

    header, body = "", ""
    for section in sections:
        if section.get("isMetadata"):
            header += _metadata_header(section, lang, form_title)
        else:
            body += _section(section, lang)
    if not header:
        header = f"<h1>{html.escape(form_title or 'Form preview')}</h1>"

    langbar = ""
    if token:
        safe_token = html.escape(token)
        langbar = "".join(
            '<a href="/preview?id={t}&lang={c}"{on}>{label}</a>'.format(
                t=safe_token, c=code,
                on=' class="on"' if code == lang else "",
                label=code.upper())
            for code in _LANGUAGES
        )

    submit = _UI_TEXT[lang]["submit"]
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(form_title or "Form preview")}</title>
<style>{_STYLES}</style>
</head>
<body>
<div class="page">
  <div class="banner">{_UI_TEXT[lang]["demo"]}</div>
  <div class="langbar">{langbar}</div>
  <div class="card">
    {header}
    <form onsubmit="return false">
      {body}
      <div class="actions"><button class="submit" type="button">{submit}</button></div>
    </form>
  </div>
</div>
</body>
</html>
"""


def render_all(payload: dict, token: str = "") -> dict[str, str]:
    """Render every language, matching build_preview's return shape."""
    return {lang: render(payload, lang, token) for lang in _LANGUAGES}
