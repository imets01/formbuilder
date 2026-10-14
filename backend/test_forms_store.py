"""
Self-checking test for the saved-form store's name uniqueness.

    python test_forms_store.py     # prints OK or raises AssertionError

Covers: free names pass through, clashes on case/punctuation/whitespace, the
" (n)" disambiguation imports rely on, renaming onto a taken name, renaming a
form to its own name, and that a title at the length cap still terminates.
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


if __name__ == "__main__":
    for case in (_run, _run_long_title, _run_legacy_duplicates):
        with tempfile.TemporaryDirectory() as tmp:
            paths.FORMS_DIR = Path(tmp)
            case()
