"""
Self-checking test for the "Logik anzeigen" / "Logik ausblenden" notation.

    python test_logic_notation.py     # prints OK or raises AssertionError

Per the PSPH field guide the cell is a bracketed array of Input IDs whose top level is an
AND — every entry must hold — while a nested array is an OR, of which at least one entry
must hold. The importer used to scrape the numbers out with a regex and make them all
alternatives, so "[3, 6]" ("shown only when both are activated") generated
`optOn(a) || optOn(b)` and revealed the field on either one. The exporter flattened the
same structure on the way out, writing "[3] [6]" and overwriting hand-authored notation.

References are also resolved in a second pass, after the whole sheet has been read: doing
it during the row walk dropped any reference to an option defined further *down* the sheet,
which under AND semantics reveals the field earlier than the workbook specifies.
"""

import io

from openpyxl import load_workbook

from excel_importer import _parse_logic_cell, import_spreadsheet
from json_builder import build_form_json
from spreadsheet_exporter import _logic_to_cell, export_spreadsheet

# Every example in the field guide, with the reading it documents.
_GUIDE = [
    ("[5]",                    ["5"],                           "5"),
    ("[5, 8]",                 ["5", "8"],                      "5 and 8"),
    ("[5, [8, 11]]",           ["5", ["8", "11"]],              "5 and (8 or 11)"),
    ("[5, [7, 11, 12], 17]",   ["5", ["7", "11", "12"], "17"],  "5 and (7|11|12) and 17"),
    ("[[5, 7, [11, 12]], 17]", [["5", "7", "11", "12"], "17"],  "(5|7|11|12) and 17"),
]

_HEADER = ("Input ID,Feld in PSPH deutsch,Name PSPH französisch,Name PSPH italienisch,"
           "Format PSPH,Fachdatenbezeichner,Logik anzeigen,Logik ausblenden")
_ROWS = [
    "1,Angaben,Donnees,Dati,Header,F_H,,",
    "2,Frage A?,Q A,D A,Radio Button Titel,F_QA,,",
    "3,Ja,Oui,Si,Radio Button Option,F_A_Ja,,",
    "4,Nein,Non,No,Radio Button Option,F_A_Nein,,",
    "5,Frage B?,Q B,D B,Radio Button Titel,F_QB,,",
    "6,Ja,Oui,Si,Radio Button Option,F_B_Ja,,",
    "7,Nein,Non,No,Radio Button Option,F_B_Nein,,",
    '8,Und Feld,Deux,Due,Text einzeilig,F_And,"[3, 6]",',
    '9,Oder Feld,Ou,O,Text einzeilig,F_Or,"[[3, 6]]",',
    '10,Gemischt,Mixte,Misto,Text einzeilig,F_Mixed,"[3, [6, 7]]",',
    "11,Ausblenden,Masquer,Nascondi,Text einzeilig,F_Hide,,[4]",
]


def _sheet():
    return ("\n".join([_HEADER] + _ROWS)).encode("utf-8")


def _imported():
    payload = import_spreadsheet(_sheet(), "logic.csv")
    comps = {c["fieldName"]: c for sec in payload["sections"] if not sec.get("isMetadata")
             for c in sec["components"]}
    options = {o["fieldName"]: o["optionId"]
               for c in comps.values() for o in (c.get("options") or [])}
    return payload, comps, options


def _run_parses_the_guide():
    for raw, expected, reading in _GUIDE:
        terms, well_formed = _parse_logic_cell(raw)
        assert well_formed, raw
        assert terms == expected, f'{raw} ({reading}) parsed as {terms}, expected {expected}'

    # Shapes that are not the documented notation but do turn up.
    assert _parse_logic_cell("")[0] == []
    assert _parse_logic_cell("siehe Bemerkung")[0] == []          # prose names no id
    assert _parse_logic_cell("5")[0] == ["5"]                     # bare single
    assert _parse_logic_cell("5, 8")[0] == ["5", "8"]             # bare, so top level: AND
    assert _parse_logic_cell("[17] [31]")[0] == ["17", "31"]      # what this used to emit
    assert _parse_logic_cell("[60.00]")[0] == ["60.00"]           # float-shaped Input ID
    assert _parse_logic_cell("[5, [8, 11]")[1] is False           # unbalanced is reported
    print("OK: every field-guide example parses to its documented reading.")


def _run_import_builds_and_or():
    payload, comps, options = _imported()
    assert not payload["skipped"], payload["skipped"]

    # AND: two separate conditions, not one group of alternatives.
    assert comps["F_And"]["showLogic"] == [options["F_A_Ja"], options["F_B_Ja"]], \
        comps["F_And"]["showLogic"]
    # OR: a single nested group stays one group.
    assert comps["F_Or"]["showLogic"] == [[options["F_A_Ja"], options["F_B_Ja"]]], \
        comps["F_Or"]["showLogic"]
    # Mixed: an AND entry alongside an OR group.
    assert comps["F_Mixed"]["showLogic"] == [options["F_A_Ja"],
                                             [options["F_B_Ja"], options["F_B_Nein"]]], \
        comps["F_Mixed"]["showLogic"]
    assert comps["F_Hide"]["hideLogic"] == [options["F_A_Nein"]], comps["F_Hide"]["hideLogic"]
    print("OK: import keeps the AND/OR distinction.")


def _run_export_writes_the_notation():
    ids = {"a": "3", "b": "6", "c": "7"}
    assert _logic_to_cell(["a"], ids) == "[3]"
    assert _logic_to_cell(["a", "b"], ids) == "[3, 6]"
    assert _logic_to_cell(["a", ["b", "c"]], ids) == "[3, [6, 7]]"
    assert _logic_to_cell([["a", "b"]], ids) == "[[3, 6]]"
    assert _logic_to_cell(["a", ["b"]], ids) == "[3, 6]"   # one-entry group is just the ref
    assert _logic_to_cell(["a", "zz"], ids) == "[3]"       # unresolvable ref is dropped
    assert _logic_to_cell([], ids) == ""

    # And the cells survive a full import -> export round trip unchanged.
    payload, _, _ = _imported()
    xlsx = export_spreadsheet(_sheet(), payload, author="t", note="round trip", version="1.1")
    ws = load_workbook(io.BytesIO(xlsx)).worksheets[0]
    header = [str(c.value) for c in ws[1]]
    fn_i, show_i, hide_i = (header.index("Fachdatenbezeichner"),
                            header.index("Logik anzeigen"), header.index("Logik ausblenden"))
    cells = {}
    for r in range(2, ws.max_row + 1):
        name = ws.cell(row=r, column=fn_i + 1).value
        if name:
            cells[name] = (ws.cell(row=r, column=show_i + 1).value,
                           ws.cell(row=r, column=hide_i + 1).value)
    assert cells["F_And"][0] == "[3, 6]", cells["F_And"]
    assert cells["F_Or"][0] == "[[3, 6]]", cells["F_Or"]
    assert cells["F_Mixed"][0] == "[3, [6, 7]]", cells["F_Mixed"]
    assert cells["F_Hide"][1] == "[4]", cells["F_Hide"]
    print("OK: export writes the notation back, structure intact.")


_FORWARD_HEADER = ("Input ID,Feld in PSPH deutsch,Name PSPH französisch,"
                   "Name PSPH italienisch,Format PSPH,Fachdatenbezeichner,"
                   "Logik anzeigen,Verstecktes Feld")
_FORWARD_ROWS = [
    "1,Angaben,Donnees,Dati,Header,F_H,,",
    "2,Sind Sie Schweizer?,Q1,D1,Radio Button Titel,F_CH,,",
    "3,Ja,Oui,Si,Radio Button Option,F_CH_Ja,,",
    "4,Nein,Non,No,Radio Button Option,F_CH_Nein,,",
    # Needs 3 (above) AND 8 (below): the forward reference.
    '5,AHV-Nummer,AVS,AVS,Text einzeilig,F_AHV,"[3, 8]",',
    "6,Haben Sie eine AHV-Nr?,Q2,D2,Radio Button Titel,F_HasAHV,,",
    "7,Nein,Non,No,Radio Button Option,F_HasAHV_Nein,,",
    "8,Ja,Oui,Si,Radio Button Option,F_HasAHV_Ja,,",
    # A real typo must still be reported, and only partly resolve.
    '9,Typo-Feld,Faute,Errore,Text einzeilig,F_Typo,"[3, 99]",',
    # Nothing resolves: no reveal path, so the field must not be left hidden...
    "10,Nur Typo,Faute,Errore,Text einzeilig,F_Dead,[99],",
    # ...unless the sheet hides it in its own right.
    "11,Versteckt,Cache,Nascosto,Text einzeilig,F_Hidden,[99],Ja",
]


def _run_forward_references_resolve():
    csv = ("\n".join([_FORWARD_HEADER] + _FORWARD_ROWS)).encode("utf-8")
    payload = import_spreadsheet(csv, "forward.csv")
    comps = {c["fieldName"]: c for sec in payload["sections"] if not sec.get("isMetadata")
             for c in sec["components"]}
    options = {o["fieldName"]: o["optionId"]
               for c in comps.values() for o in (c.get("options") or [])}

    # [3, 8] with 8 defined four rows below: both entries must survive as an AND.
    assert comps["F_AHV"]["showLogic"] == [options["F_CH_Ja"], options["F_HasAHV_Ja"]], \
        comps["F_AHV"]["showLogic"]
    assert comps["F_AHV"]["hiddenField"] is True

    # A dangling id is still dropped *and* reported — resolving later must not mask typos.
    assert comps["F_Typo"]["showLogic"] == [options["F_CH_Ja"]], comps["F_Typo"]["showLogic"]
    assert any("[99]" in m for m in payload["skipped"]), payload["skipped"]
    assert not any("[8]" in m for m in payload["skipped"]), \
        f"the forward reference was reported as dangling: {payload['skipped']}"

    assert comps["F_Dead"].get("showLogic") is None
    assert comps["F_Dead"].get("hiddenField") is None, "a field with no reveal path was hidden"
    assert comps["F_Hidden"].get("hiddenField") is True, "Verstecktes Feld was lost"

    print("OK: forward references resolve; dangling ones are still reported.")


if __name__ == "__main__":
    _run_parses_the_guide()
    _run_import_builds_and_or()
    _run_export_writes_the_notation()
    _run_forward_references_resolve()
