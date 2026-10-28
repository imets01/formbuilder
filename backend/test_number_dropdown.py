"""
Self-checking test for the NumberDropDown field (a bounded integer picker).

    python test_number_dropdown.py     # prints OK or raises AssertionError
"""

import csv
import io
import os

from excel_importer import import_spreadsheet
from spreadsheet_exporter import export_spreadsheet
from test_developer_attrs import _titled

_PAYLOAD = {
    "formTitle": "Kopien", "deployment": {"baseName": "Kopien"},
    "sections": [{"id": "S1", "translations": _titled("Angaben"), "components": [
        {"id": "number-dropdown", "fieldName": "F_AnzahlKopien", "required": True,
         "translations": _titled("Anzahl Kopien")},
        {"id": "number-dropdown", "fieldName": "F_AnzahlOpt", "maxLength": 20,
         "translations": _titled("Anzahl optional")},
        {"id": "number-dropdown", "fieldName": "F_Zuviel", "maxLength": 5000,
         "translations": _titled("Zu viel")},
    ]}],
}


def _csv(rows):
    buf = io.StringIO()
    csv.writer(buf).writerows(
        [["Input ID", "Mussfeld PSPH", "Feld in PSPH deutsch", "Format PSPH",
          "Grösse/Länge", "Fachdatenbezeichner"]] + rows)
    return buf.getvalue().encode("utf-8")


def _run_import_is_exact():
    payload = import_spreadsheet(_csv([
        ["1", "", "Angaben", "Header", "", "S_A"],
        ["2", "ja", "Anzahl Kopien", "Zahl Dropdown", "35", "F_Kopien"],
        ["3", "", "Anzahl", "Number Dropdown", "", "F_Anzahl"],
        ["4", "", "Anzahl Exemplare", "Drop Down Field Titel", "", "F_Exemplare"],
        ["5", "", "Eins", "Drop Down Field Option", "", "F_Eins"],
        ["6", "", "Zahl", "Ganzzahl", "", "F_Zahl"],
        ["7", "", "Fast", "Zahl Dropdown Feld", "", "F_Fast"],
    ]), "form.csv")
    comps = {c.get("fieldName"): c for s in payload["sections"] for c in s["components"]}
    assert comps["F_Kopien"]["id"] == "number-dropdown" and comps["F_Kopien"]["maxLength"] == 35
    assert comps["F_Kopien"]["required"] is True
    assert comps["F_Anzahl"]["id"] == "number-dropdown" and "maxLength" not in comps["F_Anzahl"]
    assert comps["F_Exemplare"]["id"] == "select-single", "a real dropdown stays one"
    assert comps["F_Zahl"]["id"] == "number"
    assert "F_Fast" not in comps, "only the exact names count"
    assert any(i["code"] == "format-unknown" and i.get("fieldName") == "F_Fast"
               for i in payload["issues"]), payload["issues"]
    print("OK: only 'Zahl Dropdown' / 'Number Dropdown' import as a NumberDropDown.")


def _run_export_round_trip():
    back = {c.get("fieldName"): c
            for s in import_spreadsheet(export_spreadsheet(None, _PAYLOAD), "spec.xlsx")["sections"]
            for c in s["components"]}
    assert back["F_AnzahlKopien"]["id"] == "number-dropdown"
    assert back["F_AnzahlOpt"]["maxLength"] == 20, back["F_AnzahlOpt"]
    print("OK: a NumberDropDown survives an export and re-import.")


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    _run_import_is_exact()
    _run_export_round_trip()
