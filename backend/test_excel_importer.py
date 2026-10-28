"""
Self-checking test for the Phase 1 PSPH spreadsheet importer.

    python test_excel_importer.py     # prints OK or raises AssertionError

Covers: column matching by header name, metadata + contact email, section
headers, common inputs, an option group, uploads, the float→number mapping,
catalog formats importing as a multi-select, Kontrollkasten importing as a
single checkbox, encoding fidelity, that the result is consumable by
build_form_json, and the structured import issues the builder tracks.

"""

import io

from excel_importer import import_spreadsheet
from json_builder import build_form_json

_HEADER = (
    "Input ID,Mussfeld PSPH,Größe/Länge,Feld in PSPH deutsch,Name PSPH französisch,"
    "Name PSPH italienisch,Hinweis im Feld PSPH deutsch,MouseOver PSPH deutsch,"
    "Format PSPH,Fachdatenbezeichner,RefID,Complimentary ID,Dateiformate,Weblinks"
)
_ROWS = [
    "1,,,Mein Formular,Mon formulaire,Il mio modulo,,,Title-of-the-form,,,,,",
    "6,,,kontakt@example.ch,kontakt@example.ch,kontakt@example.ch,,,Email-of-the-form,,,,,",
    "7,,,Persönliche Angaben,Données,Dati,,,Header,,,,,",
    '8,,,"<a href=""https://example.com/info"">Fact sheet on the mutual agreement procedure</a>",'
    '"<a href=""https://example.com/info"">Notice sur la procédure amiable</a>",'
    '"<a href=""https://example.com/info"">Promemoria sulla procedura amichevole</a>",'
    '"<a href=""https://example.com/info"">Fact sheet on the mutual agreement procedure</a>",,Description-of-the-form,,,,,',
    "9,ja,100,Name,Nom,Cognome,Bitte eingeben,Tooltip,Text einzeilig,F_Name,,,,",
    "10,ja,,Betrag,Montant,Importo,,,Float,F_Betrag,,,,https://example.com",
    "11,ja,,Sprache?,Langue?,Lingua?,,,Radio Button Title,F_Lang,R1,C1,,",
    "12,,,Ja,Oui,Sì,,,Radio Button Option,F_Yes,,,,",
    "13,,,Nein,Non,No,,,Radio Button Option,F_No,,,,",
    '14,,,Beleg,Upload,Carica,,,Upload Feld einfach,,,,"pdf,jpg",',
    "15,,,Betroffener Staat,Etat,Stato,,,Auswahlfeld mehrfach (Katalog),F_Staat,,,,",
    "16,,,Belgien,Belgique,Belgio,,,Auswahlfeld mehrfach Option,F_BE,,,,",
    "17,,,Italien,Italie,Italia,,,Auswahlfeld mehrfach Option,F_IT,,,,",
    "18,ja,,Ich stimme zu,J'accepte,Accetto,,,Kontrollkasten,F_Consent,,,,",
]


def _run():
    csv = ("\n".join([_HEADER] + _ROWS)).encode("utf-8")
    p = import_spreadsheet(csv, "form.csv")

    assert p["formTitle"] == "Mein Formular", p["formTitle"]
    assert p["deployment"]["contactEmail"] == "kontakt@example.ch"

    meta, content = p["sections"][0], p["sections"][1]
    assert meta["isMetadata"] and len(meta["components"]) == 7
    assert meta["components"][0]["translations"]["title"]["DE"] == "Mein Formular"
    assert meta["components"][1]["translations"]["title"]["DE"] == "<a>Fact sheet on the mutual agreement procedure</a>"
    assert meta["components"][1]["translations"]["title"]["FR"] == "<a>Notice sur la procédure amiable</a>"
    assert meta["components"][1]["weblink"] == "https://example.com/info"

    assert content["title"] == "Persönliche Angaben"  # encoding preserved
    by_id = [c["id"] for c in content["components"]]
    assert by_id == ["text-input", "number", "radio", "upload-single", "select-multi",
                     "single-checkbox"], by_id

    name = content["components"][0]
    assert name["required"] is True and name["maxLength"] == 100
    assert name["translations"]["placeholder"]["DE"] == "Bitte eingeben"
    assert name["mouseOverDe"] == "Tooltip"

    betrag = content["components"][1]
    assert betrag["allowDecimals"] is True
    assert betrag["weblink"] == "https://example.com"

    radio = content["components"][2]
    assert len(radio["options"]) == 2
    assert radio["options"][0]["translations"]["FR"] == "Oui"
    assert radio["compId"] == "C1" and radio["refID"] == "R1"

    upload = content["components"][3]
    assert upload["fileFormats"] == "pdf,jpg"

    # A catalog imports losslessly as a multi-select carrying its options.
    catalog = content["components"][4]
    assert catalog["id"] == "select-multi" and len(catalog["options"]) == 2
    assert catalog["options"][1]["translations"]["IT"] == "Italia"

    # Kontrollkasten is its own format; it used to land in `skipped`.
    consent = content["components"][5]
    assert consent["id"] == "single-checkbox" and consent["required"] is True
    assert consent["fieldName"] == "F_Consent"
    assert not consent.get("options"), consent.get("options")

    assert not p["skipped"], p["skipped"]

    # And the whole thing is consumable by the generator.
    parts = build_form_json(p).get("parts") or {}
    assert sum(len(v) for v in parts.values()) >= 6

    print("OK: excel_importer Phase 1 checks pass.")


# ── Acta-Nova rows (empty "Feld in PSPH deutsch") are skipped, not imported. ──
_AN_HEADER = "Input ID,Name AN deutsch,Feld in PSPH deutsch,Format PSPH,Fachdatenbezeichner"
_AN_ROWS = [
    "100,,Angaben,Header,F_H",                       # real section
    "101,,Vorname,Text einzeilig,F_V",               # real field
    "137,Datum Gesuch,,Datum,F_Datum",               # Acta-Nova field → skip
    "900,An-Empfänger,,Header,BAV_An",               # Acta-Nova block header → skip
    "145,Zuständige Sektion,,Drop Down Field Titel,F_ZS",  # Acta-Nova group → skip
    "146,bt,,Drop Down Field Option,F_bt",           # its option → eaten with the group
]


def _run_actanova_skip():
    csv = ("\n".join([_AN_HEADER] + _AN_ROWS)).encode("utf-8")
    p = import_spreadsheet(csv, "form.csv")

    # Exactly one section (the Acta-Nova "An-Empfänger" header made no section)…
    assert len(p["sections"]) == 1, [s["title"] for s in p["sections"]]
    section = p["sections"][0]
    assert section["title"] == "Angaben"

    # …holding only the one PSPH-visible field. Datum Gesuch / the drop-down group
    # are dropped because "Feld in PSPH deutsch" is empty.
    ids = [c["id"] for c in section["components"]]
    assert ids == ["text-input"], ids

    # Acta-Nova rows are expected, not mistakes — nothing is surfaced as skipped.
    assert not p["skipped"], p["skipped"]

    print("OK: excel_importer Acta-Nova skip checks pass.")


def _run_logic_without_input_ids():
    """Conditions in a sheet without Input IDs are reported once, with that cause."""
    rows = ["Angaben,Header,S_A,", "Frage,Radio Button Titel,F_Q,", "Ja,Radio Button Option,F_Ja,",
            "Details,Text einzeilig,F_D,[3]", 'Mehr,Text einzeilig,F_M,"[3, 4]"']
    for header, body, cause in (
            ("Feld in PSPH deutsch,Format PSPH,Fachdatenbezeichner,Logik anzeigen", rows,
             'has no "Input ID" column'),
            ("Input ID,Feld in PSPH deutsch,Format PSPH,Fachdatenbezeichner,Logik anzeigen",
             ["," + r for r in rows], 'leaves its "Input ID" column empty')):
        issues = import_spreadsheet("\n".join([header] + body).encode("utf-8"), "form.csv")["issues"]
        assert [i["code"] for i in issues] == ["logic-without-input-ids"], issues
        assert cause in issues[0]["message"] and '"Details", "Mehr"' in issues[0]["message"], issues
    print("OK: excel_importer names a missing Input ID column as the cause.")


def _run_unnamed_fields_reported():
    """Fields imported without a Fachdatenbezeichner are named in one summary issue."""
    csv = "\n".join([
        "Input ID,Feld in PSPH deutsch,Format PSPH,Fachdatenbezeichner",
        "1,Angaben,Header,S_A",
        "2,Lizenz-Nummer,Text einzeilig,",
        "3,Name,Text einzeilig,",
        "4,Vorname,Text einzeilig,F_Vorname",
        "5,Bemerkung,Text einzeilig,F_Rem",
    ]).encode("utf-8")
    issues = [i for i in import_spreadsheet(csv, "form.csv")["issues"]
              if i["code"] == "field-names-missing"]
    assert len(issues) == 1, issues
    assert issues[0]["message"].startswith('2 field(s) have no Fachdatenbezeichner ("Lizenz-Nummer", '), issues
    named = "\n".join(["Input ID,Feld in PSPH deutsch,Format PSPH,Fachdatenbezeichner",
                       "1,Angaben,Header,S_A", "2,Eins,Text einzeilig,F_1"]).encode("utf-8")
    assert not [i for i in import_spreadsheet(named, "form.csv")["issues"]
                if i["code"] == "field-names-missing"]
    print("OK: excel_importer reports fields without a Fachdatenbezeichner once.")


def _run_unnamed_section():
    """A section left without a name comes back as its own section, not merged into a neighbour."""
    csv = "\n".join([
        "Input ID,Feld in PSPH deutsch,Name AN deutsch,Format PSPH,Fachdatenbezeichner",
        "1,Erster,,Header,S_A",
        "2,Eins,,Text einzeilig,F_1",
        "3,,,Header,S_Empty",
        "4,Zwei,,Text einzeilig,F_2",
        "5,,An-Empfänger,Header,AN_Block",
        "6,,Empfänger,Text einzeilig,AN_Empf",
        "7,,,Header,",
        "8,,Datum Gesuch,Datum,AN_Datum",
        "9,,,Header,",
        "10,Drei,,Text einzeilig,F_3",
    ]).encode("utf-8")
    sections = import_spreadsheet(csv, "form.csv")["sections"]
    got = [(s["title"], s.get("sourceRef"), [c["fieldName"] for c in s["components"]]) for s in sections]
    assert got == [("Erster", "S_A", ["F_1"]), ("", "S_Empty", ["F_2"]), ("", None, ["F_3"])], \
        "a bare Header row is a section without a name; one holding only Acta-Nova rows is dropped"

    headless = "\n".join(["Feld in PSPH deutsch,Format PSPH,Fachdatenbezeichner",
                          "Eins,Text einzeilig,F_1"]).encode("utf-8")
    assert [s["title"] for s in import_spreadsheet(headless, "form.csv")["sections"]] == [""], \
        "fields before any header get a section without an invented name"
    print("OK: excel_importer unnamed-section checks pass.")


# ── Korrespondenzsprache rows keep whatever option rows the sheet carries. ──
_KS_HEADER = "Input ID,Feld in PSPH deutsch,Name PSPH französisch,Name PSPH italienisch,Format PSPH,Fachdatenbezeichner"
_KS_ROWS = [
    "200,Angaben,Données,Dati,Header,F_H",
    "201,Korrespondenzsprache,Langue,Lingua,Korrespondenzsprache,F_KS",
    "202,Deutsch,allemand,tedesco,Drop Down Field Option,F_De",
    "203,Französisch,français,francese,Drop Down Field Option,F_Fr",
    "204,Italienisch,italien,italiano,Drop Down Field Option,F_It",
    "205,Englisch,anglais,inglese,Drop Down Field Option,F_En",
    "206,Formularsprache,Langue,Lingua,Formularsprache,F_FS",
    "207,Bemerkung,Remarque,Osservazione,Text einzeilig,F_Rem",
]


def _run_correspondence_language():
    csv = ("\n".join([_KS_HEADER] + _KS_ROWS)).encode("utf-8")
    p = import_spreadsheet(csv, "form.csv")

    comps = p["sections"][0]["components"]
    ids = [c["id"] for c in comps]
    assert ids == ["korrespondenzsprache", "korrespondenzsprache", "text-input"], ids

    # The sheet's own four languages survive, English included.
    listed = comps[0]
    assert [o["translations"]["DE"] for o in listed["options"]] == [
        "Deutsch", "Französisch", "Italienisch", "Englisch"], listed["options"]
    assert listed["options"][3]["translations"]["FR"] == "anglais"

    # A row with no option rows imports empty; the builder seeds the native DE/FR/IT set.
    assert comps[1]["options"] == [], comps[1]["options"]

    assert not p["skipped"], p["skipped"]
    print("OK: excel_importer correspondence-language checks pass.")


# ── Structured import issues: codes + the anchors the builder re-checks them by. ──
_ISSUE_HEADER = (
    "Input ID,Feld in PSPH deutsch,Format PSPH,Fachdatenbezeichner,"
    "Logik anzeigen,Logik ausblenden"
)
_ISSUE_ROWS = [
    "1,Mein Formular,Title-of-the-form,,,",
    "7,Angaben,Header,S_Ang,,",
    "9,Kaputtes Feld,Wurstformat,F_Broken,,",
    "10,Kein Format,,F_NoFmt,,",
    "11,Verwaiste Option,Radio Button Option,F_Orphan,,",
    "12,Bedingtes Feld,Text einzeilig,F_Cond,[99],",
]


def _stale_dimension_workbook(rows: int) -> bytes:
    """An .xlsx of `rows` field rows whose declared <dimension> stops less than halfway."""
    import re
    import zipfile
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Form"
    ws.append(_HEADER.split(","))
    for i in range(1, rows + 1):
        ws.append([str(i), "", "", f"Feld {i}", f"Champ {i}", f"Campo {i}", "", "",
                   "Text einzeilig", f"F_{i}", "", "", "", ""])
    buf = io.BytesIO()
    wb.save(buf)

    out = io.BytesIO()
    source = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dest:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                data, n = re.subn(rb'<dimension ref="[^"]+"\s*/>',
                                  f'<dimension ref="A1:N{rows // 2}"/>'.encode(), data)
                assert n == 1, "no <dimension> to stale out"
            dest.writestr(item, data)
    return out.getvalue()


def _run_stale_dimension():
    """Every row is imported even when the workbook under-declares its used range."""
    raw = _stale_dimension_workbook(80)
    payload = import_spreadsheet(raw, "form.xlsx")

    fields = [c for section in payload["sections"] for c in section["components"]]
    assert len(fields) == 80, f"truncated to {len(fields)}"
    assert fields[-1]["translations"]["title"]["DE"] == "Feld 80"
    assert not payload["skipped"], payload["skipped"]

    print("OK: excel_importer reads past a stale sheet dimension.")


def _run_bare_metadata_formats():
    """A bare 'Sektion' is metadata, not a section header."""
    rows = [
        "1,,,,Mein Formular,Mon formulaire,Il mio modulo,,,Formulartitel,,,,,",
        "2,,,,Departement UVEK,DETEC,DATEC,,,Departement,,,,,",
        "3,,,,Bundesamt BFE,OFEN,UFE,,,Bundesamt,,,,,",
        "4,,,,Dienst Effizienzsteigerungen,Service,Servizio,,,Sektion,,,,,",
        "5,,,,CH-3003 Bern,CH-3003 Berne,CH-3003 Berna,,,PLZ und Ort des Bundesamtes,,,,,",
        "6,ja,,,Name,Nom,Cognome,,,Text einzeilig,F_Name,,,,",
    ]
    header = ("Input ID,Mussfeld PSPH,Grosse/Lange,Name AN deutsch,Feld in PSPH deutsch,"
              "Name PSPH franzosisch,Name PSPH italienisch,Hinweis im Feld PSPH deutsch,"
              "MouseOver PSPH deutsch,Format PSPH,Fachdatenbezeichner,RefID,"
              "Complimentary ID,Dateiformate,Weblinks")
    csv_text = "\n".join([header] + rows)
    payload = import_spreadsheet(csv_text.encode("utf-8"), "form.csv")

    meta = {c["id"]: c["translations"]["title"]["DE"] for c in payload["sections"][0]["components"]}
    assert meta["meta-section"] == "Dienst Effizienzsteigerungen", meta["meta-section"]
    assert meta["meta-department"] == "Departement UVEK", meta["meta-department"]
    assert meta["meta-zipCity"] == "CH-3003 Bern", meta["meta-zipCity"]

    empty = [s for s in payload["sections"][1:] if not s["components"]]
    assert not empty, f"stray empty section(s): {[s.get('title') for s in empty]}"

    print("OK: bare metadata formats land in the form header.")


def _run_dangling_ref_explains_itself():
    """A reference to a real-but-unusable row says what that row is."""
    header = ("Input ID,Logik anzeigen,Mussfeld PSPH,Feld in PSPH deutsch,"
              "Name PSPH franzosisch,Name PSPH italienisch,Format PSPH,"
              "Fachdatenbezeichner,RefID,Complimentary ID")
    rows = [
        "1,,,Mein Formular,Mon formulaire,Il mio modulo,Formulartitel,,,",
        "2,,ja,Sprache?,Langue?,Lingua?,Radiobutton Titel,F_Lang,R1,C1",
        "3,,,Deutsch,allemand,tedesco,Radiobutton Option,F_De,,",
        "4,,,Italienisch,italien,italiano,Radiobutton Option,F_It,,",
        "5,,ja,Betrag,Montant,Importo,Festkomma Zahl,F_Betrag,,",
        # Points at the number field - real Input ID, unusable as a condition.
        "6,[5],ja,Beleg,Justificatif,Giustificativo,Text einzeilig,F_Beleg,,",
        # Points at the group's title row instead of one of its options.
        "7,[2],ja,Grund,Motif,Motivo,Text einzeilig,F_Grund,,",
        # Points at nothing at all.
        "8,[99],ja,Rest,Reste,Resto,Text einzeilig,F_Rest,,",
        # The one that works: an option row.
        "9,[3],ja,Nur Deutsch,Seulement allemand,Solo tedesco,Text einzeilig,F_Nur,,",
    ]
    csv_text = "\n".join([header] + rows)
    payload = import_spreadsheet(csv_text.encode("utf-8"), "form.csv")
    by_row = {i["row"]: i["message"] for i in payload["issues"]
              if i["code"] == "logic-dangling-ref"}

    assert '"Festkomma Zahl" row' in by_row[7], by_row[7]
    assert "only option rows" in by_row[7], by_row[7]
    assert "group title" in by_row[8], by_row[8]
    assert "not the question" in by_row[8], by_row[8]
    assert "no row in this sheet carries" in by_row[9], by_row[9]
    # The working reference raises nothing, and keeps its condition.
    assert 10 not in by_row, by_row
    fields = {c["translations"]["title"]["DE"]: c
              for s in payload["sections"] for c in s["components"]}
    assert fields["Nur Deutsch"].get("showLogic"), fields["Nur Deutsch"]

    print("OK: a dangling logic reference explains what the row is.")


def _run_hidden_unreachable():
    """A hidden field whose only show condition was unusable is reported as unreachable."""
    header = ("Input ID,Logik anzeigen,Verstecktes Feld,Feld in PSPH deutsch,"
              "Name PSPH franzosisch,Name PSPH italienisch,Format PSPH,Fachdatenbezeichner")
    rows = [
        "1,,nein,Angaben,Donnees,Dati,Header,F_H",
        "2,,nein,Frage?,Question?,Domanda?,Radiobutton Titel,F_Q",
        "3,,nein,Ja,Oui,Si,Radiobutton Option,F_Ja",
        "4,,nein,Betrag,Montant,Importo,Festkomma Zahl,F_Betrag",
        # Hidden, and its only term points at the value field -> nothing can reveal it.
        "5,[4],ja,Beleg,Justificatif,Giustificativo,Upload Feld einfach,F_Beleg",
        # Hidden, but its term resolves -> fine, no complaint.
        "6,[3],ja,Grund,Motif,Motivo,Text einzeilig,F_Grund",
        # Unusable term, but not hidden -> visible, so not unreachable.
        "7,[4],nein,Rest,Reste,Resto,Text einzeilig,F_Rest",
    ]
    csv_text = "\n".join([header] + rows)
    payload = import_spreadsheet(csv_text.encode("utf-8"), "form.csv")

    stranded = {i["row"] for i in payload["issues"]
                if i["code"] == "logic-hidden-unreachable"}
    assert stranded == {6}, stranded  # sheet row 6 == the Beleg upload

    fields = {c["translations"]["title"]["DE"]: c
              for s in payload["sections"] for c in s["components"]}
    assert fields["Beleg"]["hiddenField"] is True and not fields["Beleg"].get("showLogic")
    assert fields["Grund"].get("showLogic"), "a resolvable term still applies"
    assert not fields["Rest"].get("hiddenField"), "never hidden, so never stranded"

    print("OK: a hidden field with no usable show condition is reported.")


def _run_prose_in_logic_column():
    """Prose in a logic column is ignored, not mined for numbers, and reported once."""
    header = ("Input ID,Logik anzeigen,Logik ausblenden,Verstecktes Feld,"
              "Feld in PSPH deutsch,Name PSPH franzosisch,Name PSPH italienisch,"
              "Format PSPH,Fachdatenbezeichner")
    note = "IF(30.06<Actual Date<=31.12)"
    rows = [
        "1,,,nein,Angaben,Donnees,Dati,Header,F_H",
        "2,,,nein,Frage?,Question?,Domanda?,Radiobutton Titel,F_Q",
        "3,,,nein,Ja,Oui,Si,Radiobutton Option,F_Ja",
        # Input ID 30/31 exist as options, so the note's numbers would have resolved.
        "30,,,nein,Egal A,Peu importe A,Indifferente A,Radiobutton Option,F_A",
        "31,,,nein,Egal B,Peu importe B,Indifferente B,Radiobutton Option,F_B",
        f"4,,{note},nein,Name,Nom,Cognome,Text einzeilig,F_Name",
        f"5,,{note},nein,Ort,Lieu,Luogo,Text einzeilig,F_Ort",
        f"6,,{note},nein,Jahr,Annee,Anno,Ganzzahl,F_Jahr",
        # A real condition in the same sheet still works.
        "7,[3],,ja,Grund,Motif,Motivo,Text einzeilig,F_Grund",
    ]
    csv_text = "\n".join([header] + rows)
    payload = import_spreadsheet(csv_text.encode("utf-8"), "form.csv")

    fields = {c["translations"]["title"]["DE"]: c
              for s in payload["sections"] for c in s["components"]}
    for name in ("Name", "Ort", "Jahr"):
        assert not fields[name].get("hideLogic"), (name, fields[name].get("hideLogic"))
        assert not fields[name].get("showLogic"), (name, fields[name].get("showLogic"))
    assert not any(s.get("hideLogic") or s.get("showLogic")
                   for s in payload["sections"]), "nor on any section"

    # One finding for the repeated note, naming how many rows carry it - not three.
    unreadable = [i for i in payload["issues"] if i["code"] == "logic-unreadable"]
    assert len(unreadable) == 1, [i["message"] for i in unreadable]
    assert "2 more rows" in unreadable[0]["message"], unreadable[0]["message"]
    assert note in unreadable[0]["message"]

    # And the genuine condition beside it is untouched.
    assert fields["Grund"].get("showLogic"), fields["Grund"]

    print("OK: prose in a logic column is ignored, and reported once.")


def _run_issues():
    csv = ("\n".join([_ISSUE_HEADER] + _ISSUE_ROWS)).encode("utf-8")
    p = import_spreadsheet(csv, "form.csv")
    issues = p["issues"]

    # Every free-text line has a structured twin, in the same order.
    assert p["skipped"] == [i["message"] for i in issues], issues

    by_code = {i["code"]: i for i in issues}
    assert set(by_code) == {
        "format-unknown", "format-missing", "option-without-group", "logic-dangling-ref",
    }, sorted(by_code)

    # Row numbers are the ones Excel shows (the header is row 1).
    assert by_code["format-unknown"]["row"] == 4, by_code["format-unknown"]
    assert by_code["format-missing"]["row"] == 5, by_code["format-missing"]

    # The anchors the builder matches against the canvas to see if a row was added by hand.
    unknown = by_code["format-unknown"]
    assert unknown["label"] == "Kaputtes Feld" and unknown["fieldName"] == "F_Broken", unknown

    # A dangling reference is anchored to the field whose condition was dropped, so the
    # builder can tell that that field has since been given logic of its own.
    dangling = by_code["logic-dangling-ref"]
    assert dangling["inputId"] == "99", dangling
    assert dangling["target"] == {
        "kind": "field", "row": 7, "label": "Bedingtes Feld", "fieldName": "F_Cond",
    }, dangling["target"]

    print("OK: excel_importer structured-issue checks pass.")


if __name__ == "__main__":
    _run()
    _run_actanova_skip()
    _run_unnamed_section()
    _run_unnamed_fields_reported()
    _run_logic_without_input_ids()
    _run_correspondence_language()
    _run_issues()
    _run_stale_dimension()
    _run_bare_metadata_formats()
    _run_dangling_ref_explains_itself()
    _run_hidden_unreachable()
    _run_prose_in_logic_column()
