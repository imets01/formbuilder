"""
Self-checking round-trip test for the PSPH spreadsheet exporter.

    python test_spreadsheet_exporter.py    # prints OK or raises AssertionError

Covers the Format PSPH mapping for rows *added* in the builder: a generated-from-scratch
workbook must re-import to the same component types it was exported from. Catalogs are
the interesting case — they come back as `select-multi` (identity is not carried in the
sheet) with their options and refIDs intact; a single checkbox keeps its identity via
its own `Kontrollkasten` format.
"""

import io

from openpyxl import Workbook, load_workbook

from spreadsheet_exporter import export_spreadsheet
from excel_importer import import_spreadsheet


def _titled(de, fr=None, it=None, en=None):
    return {"title": {"DE": de, "FR": fr or de, "IT": it or de, "EN": en or de},
            "placeholder": {"DE": "", "FR": "", "IT": "", "EN": ""}}


def _opt(oid, de, ref=""):
    return {"optionId": oid, "fieldName": "F_" + oid, "refID": ref,
            "translations": {"DE": de, "FR": de, "IT": de, "EN": de}}


_PAYLOAD = {
    "formTitle": "Round Trip",
    "deployment": {"contactEmail": "kontakt@example.ch"},
    "sections": [
        {"id": "meta", "isMetadata": True,
         "components": [{"id": "meta-title", "translations": _titled("Round Trip")}]},
        {"id": "S1", "translations": _titled("Angaben"), "components": [
            {"id": "text-input", "fieldName": "F_Name", "translations": _titled("Name")},
            {"id": "select-single", "fieldName": "F_Single", "translations": _titled("Einfach"),
             "options": [_opt("s1", "A"), _opt("s2", "B")]},
            {"id": "select-multi", "fieldName": "F_Multi", "translations": _titled("Mehrfach"),
             "options": [_opt("m1", "Eins"), _opt("m2", "Zwei")]},
            {"id": "catalog-countries", "fieldName": "F_Staat", "required": True,
             "translations": _titled("Staat", "Etat", "Stato", "State"),
             "options": [_opt("c1", "Belgien", "BE"), _opt("c2", "Italien", "IT")]},
            {"id": "catalog-cantons", "fieldName": "F_Kanton",
             "translations": _titled("Kanton", "Canton", "Cantone", "Canton"),
             "options": [_opt("k1", "BL", "BL"), _opt("k2", "ZH", "ZH")]},
            {"id": "checkbox", "fieldName": "F_Grp", "translations": _titled("Frage?"),
             "options": [_opt("g1", "Eins"), _opt("g2", "Zwei")]},
            {"id": "single-checkbox", "fieldName": "F_Consent", "required": True,
             "translations": _titled("Ich stimme zu", "J'accepte", "Accetto", "I agree")},
        ]},
    ],
}


def _formats(xlsx):
    ws = load_workbook(io.BytesIO(xlsx))["Form"]
    header = [str(c.value) for c in ws[1]]
    fmt_col = next(i for i, h in enumerate(header) if "Format PSPH" in h)
    return [ws.cell(row=r, column=fmt_col + 1).value
            for r in range(2, ws.max_row + 1)
            if ws.cell(row=r, column=fmt_col + 1).value]


def _run_catalog_round_trip():
    xlsx = export_spreadsheet(None, _PAYLOAD, author="test", note="initial", version="1.0")

    # Multi-select and both catalogs share the real sheets' multi spelling; single-select
    # keeps the "Drop Down Field" one.
    written = _formats(xlsx)
    assert written.count("Auswahlfeld mehrfach (Katalog)") == 3, written
    assert written.count("Auswahlfeld mehrfach Option") == 6, written
    assert written.count("Drop Down Field Titel") == 1, written
    assert written.count("Drop Down Field Option") == 2, written

    # A single checkbox is its own PSPH format, not a one-option Checkbox group: the group
    # renders the title in the left column *and* the option next to the box, which would
    # duplicate the label. Kontrollkasten keeps the generator's `desc=""`.
    assert written.count("Kontrollkasten") == 1, written
    assert written.count("Checkbox Titel") == 1, written
    assert written.count("Checkbox Option") == 2, written

    p = import_spreadsheet(xlsx, "round-trip.xlsx")
    assert not p["skipped"], p["skipped"]

    content = next(s for s in p["sections"] if not s.get("isMetadata"))
    ids = [c["id"] for c in content["components"]]
    assert ids == ["text-input", "select-single", "select-multi", "select-multi",
                   "select-multi", "checkbox", "single-checkbox"], ids

    multi = content["components"][2]
    assert [o["translations"]["DE"] for o in multi["options"]] == ["Eins", "Zwei"], multi["options"]

    # A catalog's refIDs are the catalog codes; losing them would break the generator.
    countries = content["components"][3]
    assert countries["required"] is True
    assert [(o["translations"]["DE"], o["refID"]) for o in countries["options"]] == [
        ("Belgien", "BE"), ("Italien", "IT")], countries["options"]

    cantons = content["components"][4]
    assert [o["refID"] for o in cantons["options"]] == ["BL", "ZH"], cantons["options"]

    consent = content["components"][6]
    assert consent["required"] is True
    assert not consent.get("options"), consent.get("options")
    assert consent["translations"]["title"]["FR"] == "J'accepte"

    print("OK: spreadsheet_exporter round-trip checks pass.")


def _run_dev_comment_overlay():
    """Fragen/Bemerkungen carries the builder's "Comments for devs" both ways.

    The overlay must leave the column alone for rows the builder has no comment field
    for — options above all, whose notes would otherwise be wiped on every export.
    """
    hdr = ["Input ID", "Mussfeld PSPH", "Feld in PSPH deutsch", "Name PSPH französisch",
           "Name PSPH italienisch", "Format PSPH, Formate gem. TF 00", "Fachdatenbezeichner",
           "RefID", "Complimentary ID", "Fragen/Bemerkungen"]
    rows = [
        ["", "", "Abschnitt", "Section", "Sezione", "Header", "sec1", "", "", ""],
        ["", "Ja", "Feld A", "Champ A", "Campo A", "Text einzeilig", "fA", "R1", "", "from the sheet"],
        ["", "", "Feld B", "Champ B", "Campo B", "Text einzeilig", "fB", "R2", "", ""],
        ["", "", "Wahl", "Choix", "Scelta", "Radiobutton Titel", "fW", "R3", "C3", "group note"],
        ["1", "", "Ja", "Oui", "Si", "Radiobutton Option", "oJa", "R4", "", "option note"],
    ]
    wb = Workbook()
    ws = wb.active
    ws.append(hdr)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    source = buf.getvalue()

    payload = import_spreadsheet(source, "src.xlsx")
    by_fn = {c.get("fieldName"): c
             for sec in payload["sections"] for c in sec["components"]}
    assert by_fn["fA"]["commentsForDevs"] == "from the sheet", by_fn["fA"]
    assert by_fn["fW"]["commentsForDevs"] == "group note", by_fn["fW"]

    by_fn["fA"]["commentsForDevs"] = "edited"
    by_fn["fB"]["commentsForDevs"] = "added"
    by_fn["fW"]["commentsForDevs"] = ""           # cleared in the builder

    out = export_spreadsheet(source, payload, author="test", note="n", bump=False)
    ws2 = load_workbook(io.BytesIO(out))[wb.active.title]
    got = {ws2.cell(row=r, column=7).value: ws2.cell(row=r, column=10).value
           for r in range(2, ws2.max_row + 1)}
    assert got["fA"] == "edited", got
    assert got["fB"] == "added", got
    assert got["fW"] is None, got                 # cleared through to the sheet
    assert got["oJa"] == "option note", got       # option row untouched

    print("OK: dev-comment overlay checks pass.")


if __name__ == "__main__":
    _run_catalog_round_trip()
    _run_dev_comment_overlay()
