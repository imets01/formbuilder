"""
Self-checking test for the Phase 1 PSPH spreadsheet importer.

    python test_excel_importer.py     # prints OK or raises AssertionError

Covers: column matching by header name, metadata + contact email, section
headers, common inputs, an option group, uploads, the float→number mapping,
catalog formats importing as a multi-select, Kontrollkasten importing as a
single checkbox, encoding fidelity, and that the result is consumable by
build_form_json.
"""

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


if __name__ == "__main__":
    _run()
    _run_actanova_skip()
    _run_correspondence_language()
