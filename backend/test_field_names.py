"""
Self-checking test for the Fachdatenbezeichner character rule.

    python test_field_names.py     # prints OK or raises AssertionError
"""

import csv
import io

from excel_importer import import_spreadsheet
from field_names import InvalidFieldNames, invalid_field_names, is_valid_field_name
from json_builder import build_form_json


def _run_rule():
    for ok in ("F_Lic", "SIF_VV_VP_ErklärungAllesKorrekt", "Feld2", "", "  ", None, " F_Trim "):
        assert is_valid_field_name(ok), ok
    for bad in ("Name (alt)", "F-Lic", "F Lic", "F.Lic", "F/Lic", "F'Lic", 'F"Lic', "F$Lic"):
        assert not is_valid_field_name(bad), bad
    print("OK: letters, digits and _ only; umlauts and blanks pass.")


def _payload(**names):
    return {
        "formTitle": "Names",
        "sections": [
            {"id": "S1", "title": "Angaben", "sourceRef": names.get("section", "S_A"), "components": [
                {"id": "text-input", "fieldName": names.get("field", "F_A"),
                 "translations": {"title": {"DE": "A"}}},
                {"id": "radio", "fieldName": "F_R", "translations": {"title": {"DE": "R"}},
                 "options": [{"optionId": "o1", "fieldName": names.get("option", "F_R1"),
                              "translations": {"DE": "Ja"}}]},
            ]},
        ],
    }


def _run_generation_refuses():
    assert invalid_field_names(_payload()) == []
    payload = _payload(field="Lizenz (Nr)", option="Ja/Nein", section="S A")
    assert invalid_field_names(payload) == ["S A", "Lizenz (Nr)", "Ja/Nein"], invalid_field_names(payload)
    try:
        build_form_json(payload)
    except InvalidFieldNames as exc:
        assert exc.names == ["S A", "Lizenz (Nr)", "Ja/Nein"], exc.names
        assert '"Lizenz (Nr)"' in str(exc), str(exc)
    else:
        raise AssertionError("build_form_json accepted invalid names")
    print("OK: the generator refuses invalid names and lists them.")


def _run_import_reports():
    buf = io.StringIO()
    csv.writer(buf).writerows([
        ["Input ID", "Feld in PSPH deutsch", "Format PSPH", "Fachdatenbezeichner"],
        ["1", "Angaben", "Header", "S_A"],
        ["2", "Lizenz-Nummer", "Text einzeilig", "LizenzNr (alt)"],
        ["3", "Erklärung", "Text einzeilig", "F_Erklärung"],
    ])
    payload = import_spreadsheet(buf.getvalue().encode("utf-8"), "form.csv")
    issues = [i for i in payload["issues"] if i["code"] == "field-name-invalid"]
    assert [(i["row"], i["fieldName"]) for i in issues] == [(3, "LizenzNr (alt)")], issues
    comps = [c for s in payload["sections"] for c in s["components"]]
    assert any(c.get("fieldName") == "LizenzNr (alt)" for c in comps), "kept, so it can be renamed"
    print("OK: the import keeps the row and reports the name.")


if __name__ == "__main__":
    _run_rule()
    _run_generation_refuses()
    _run_import_reports()
