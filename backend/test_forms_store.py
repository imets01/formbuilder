"""
Self-checking test for the saved-form store's name uniqueness.

    python test_forms_store.py     # prints OK or raises AssertionError

Covers: free names pass through, clashes on case/punctuation/whitespace, the
" (n)" disambiguation imports rely on, renaming onto a taken name, renaming a
form to its own name, that a title at the length cap still terminates, and what
a spreadsheet re-import keeps of the form it overwrites.
"""

import json
import tempfile
from pathlib import Path

import paths
import forms_store
from json_builder import MAX_FORM_NAME_LEN


def _save(form_id, title):
    return forms_store.save_form({"id": form_id, "title": title, "updatedAt": 1, "payload": {}})


def _run():
    assert forms_store.unique_title("Permit application") == "Permit application"
    _save("form_a", "Permit application")

    # Same name in the eyes of safe_form_name: case, punctuation, whitespace.
    for same in ["Permit application", "PERMIT APPLICATION", "permit  application", "Permit-application"]:
        assert forms_store.find_by_title(same) == "form_a", same
        try:
            _save("form_b", same)
        except forms_store.DuplicateFormTitle as exc:
            assert exc.existing_id == "form_a", exc.existing_id
        else:
            raise AssertionError(f"saving {same!r} should have been refused")

    # A form keeps its own name on every later save (autosave overwrites itself).
    _save("form_a", "Permit application")

    # Disambiguation walks up until it finds a gap.
    assert forms_store.unique_title("Permit application") == "Permit application (2)"
    _save("form_b", forms_store.unique_title("Permit application"))
    assert forms_store.unique_title("Permit application") == "Permit application (3)"
    # ...except for the form that already holds the name.
    assert forms_store.unique_title("Permit application", exclude_id="form_a") == "Permit application"

    # An empty title is the default name, and collides with a form actually called that.
    assert forms_store.unique_title("") == forms_store.DEFAULT_TITLE
    _save("form_c", "")
    assert forms_store.find_by_title(forms_store.DEFAULT_TITLE) == "form_c"
    assert forms_store.unique_title("   ") == f"{forms_store.DEFAULT_TITLE} (2)"

    print("OK: forms_store name-uniqueness checks pass.")


def _run_legacy_duplicates():
    """Forms stored before names were unique keep saving — only a *rename* is refused."""
    for form_id in ("form_x", "form_y"):
        (paths.FORMS_DIR / f"{form_id}.json").write_text(
            json.dumps({"id": form_id, "title": "Shared name", "updatedAt": 1, "payload": {}}),
            encoding="utf-8")

    _save("form_y", "Shared name")           # autosave under the name it already has
    _save("form_y", "shared  NAME")          # ...including a cosmetic respelling of it

    try:
        _save("form_y", "Shared name three")  # a free name is fine
    except forms_store.DuplicateFormTitle:
        raise AssertionError("renaming onto a free name should be allowed")

    _save("form_z", "Taken")
    try:
        _save("form_y", "Taken")
    except forms_store.DuplicateFormTitle as exc:
        assert exc.existing_id == "form_z", exc.existing_id
    else:
        raise AssertionError("renaming onto a taken name should be refused")

    print("OK: forms_store tolerates pre-existing duplicate names.")


def _run_long_title():
    """safe_form_name truncates at MAX_FORM_NAME_LEN, which would otherwise eat the " (n)"."""
    long = "L" * (MAX_FORM_NAME_LEN + 20)
    _save("form_long", long)

    nxt = forms_store.unique_title(long)
    assert nxt.endswith(" (2)"), nxt
    assert forms_store.find_by_title(nxt) is None, nxt
    _save("form_long2", nxt)
    third = forms_store.unique_title(long)
    assert forms_store.find_by_title(third) is None, third
    assert third != nxt, third

    print("OK: forms_store long-title disambiguation terminates.")


def _run_reimport():
    """A re-import takes the sheet's content but keeps what the sheet cannot express."""
    forms_store.save_form({
        "id": "form_r", "title": "Permit", "updatedAt": 1,
        "payload": {
            "formTitle": "Permit",
            "sections": [{"id": "old", "title": "Old", "components": []}],
            "disableInputSize": True,
            "disableMouseOver": False,
            "deployment": {"compName": "permit", "usrId": "42", "contactEmail": ""},
        },
    })

    fresh = {
        "formTitle": "Permit",
        "sections": [{"id": "new", "title": "New", "components": []}],
        "disableInputSize": False,
        "disableMouseOver": False,
        "deployment": {"compName": "", "usrId": "", "contactEmail": "a@b.ch"},
        "skipped": ["Feld — unknown format \"Wurst\""],
        "issues": [{"code": "format-unknown", "message": "Feld — unknown format \"Wurst\"", "row": 9}],
    }
    saved = forms_store.reimport_form("form_r", fresh, fresh["issues"])
    payload = saved["payload"]

    assert saved["id"] == "form_r", saved["id"]
    assert payload["sections"][0]["id"] == "new", payload["sections"]
    # Deployment values someone typed in the builder survive; blanks take the sheet's.
    assert payload["deployment"]["compName"] == "permit", payload["deployment"]
    assert payload["deployment"]["usrId"] == "42", payload["deployment"]
    assert payload["deployment"]["contactEmail"] == "a@b.ch", payload["deployment"]
    # Builder-only toggles are not in the sheet, so they are not reset by it.
    assert payload["disableInputSize"] is True, payload["disableInputSize"]
    # The importer's own bookkeeping keys never reach the stored payload.
    assert "skipped" not in payload and "issues" not in payload, payload.keys()
    assert [i["code"] for i in saved["importIssues"]] == ["format-unknown"], saved["importIssues"]
    assert saved["updatedAt"] > 1, saved["updatedAt"]
    # Keeping its own name is not a duplicate of itself.
    assert saved["title"] == "Permit", saved["title"]
    renamed = forms_store.reimport_form("form_r", dict(fresh, formTitle="Heading on the form"), [])
    assert renamed["title"] == "Permit" and renamed["payload"]["formTitle"] == "Permit", \
        "a re-import keeps the form's name, as its dialog promises"

    # A later re-import with no findings clears the ones that were stored.
    cleared = forms_store.reimport_form("form_r", fresh, [])
    assert cleared["importIssues"] == [], cleared["importIssues"]

    assert forms_store.reimport_form("form_missing", fresh, []) is None

    print("OK: forms_store re-import keeps builder-owned settings.")


def _run_source_name():
    """The imported spreadsheet's file name is listed and survives later autosaves."""
    _save("form_s", "Permit")
    forms_store.set_source_name("form_s", r"C:\Users\x\Downloads\PSPH_Permit_V25.xlsx")

    listed = {s["id"]: s["sourceFileName"] for s in forms_store.list_forms()}
    assert listed["form_s"] == "PSPH_Permit_V25.xlsx", listed

    # The builder's autosave replaces the stored form wholesale and never sends the name back.
    _save("form_s", "Permit")
    assert forms_store.load_form("form_s")["sourceFileName"] == "PSPH_Permit_V25.xlsx"

    # A re-import is from a different sheet, so its name takes over.
    saved = forms_store.reimport_form(
        "form_s",
        {"formTitle": "Permit", "sections": [{"id": "s", "title": "S", "components": []}]},
        [],
        source_name="PSPH_Permit_V26.xlsx",
    )
    assert saved["sourceFileName"] == "PSPH_Permit_V26.xlsx", saved["sourceFileName"]

    # Forms built in the builder have no source sheet, and list an empty name.
    _save("form_t", "Hand-built")
    assert {s["id"]: s["sourceFileName"] for s in forms_store.list_forms()}["form_t"] == ""

    print("OK: forms_store records the imported spreadsheet's file name.")


if __name__ == "__main__":
    for case in (_run, _run_long_title, _run_legacy_duplicates, _run_reimport, _run_source_name):
        with tempfile.TemporaryDirectory() as tmp:
            paths.FORMS_DIR = Path(tmp)
            case()
