"""
Self-checking test for Show conditions whose references no longer resolve.

    python test_orphan_logic.py     # prints OK or raises AssertionError

A Show condition implies the row starts hidden, but `_resolve_logic` runs in a second pass
and drops refs that match no option — the builder never prunes a condition when the option
it points at is deleted (`removeOption`/`removeComponent`). The row was then emitted with
`hidden_field=True` and no reveal path: permanently invisible in the delivered form. It must
degrade to "always shown" instead, while every condition that *does* resolve stays hidden.
"""

from json_builder import build_form_json

DEAD = "opt_deleted_does_not_exist"


def _titled(de):
    return {"title": {"DE": de, "FR": de, "IT": de, "EN": de},
            "placeholder": {"DE": "", "FR": "", "IT": "", "EN": ""}}


def _opt(oid, de):
    return {"optionId": oid, "fieldName": "F_" + oid, "refID": "",
            "translations": {"DE": de, "FR": de, "IT": de, "EN": de}}


def _trigger():
    return {"id": "radio", "fieldName": "F_Q", "translations": _titled("Frage"),
            "options": [_opt("opt_yes", "Ja")]}


def _rows(sections):
    out = {}
    for section_rows in build_form_json(
            {"formTitle": "T", "deployment": {}, "sections": sections})["parts"].values():
        out.update(section_rows)
    return out


def _field(rows, needle):
    return next(v for k, v in rows.items() if needle in k)


def _run_orphan_show_unhides():
    rows = _rows([{"id": "S", "translations": _titled("S"), "components": [
        {"id": "text-input", "fieldName": "F_A", "translations": _titled("A")},
        {"id": "text-input", "fieldName": "F_B", "translations": _titled("B"),
         "showLogic": [DEAD]},
    ]}])
    b = _field(rows, "F_B")
    assert b["show_logic"] is None, b["show_logic"]
    assert b["hidden_field"] is None, "orphaned Show condition left the field hidden"

    # The option rows of a group are ORed into one hidden flag by identify_buttons, so the
    # title and its options have to un-hide together or the group stays hidden regardless.
    rows = _rows([{"id": "S", "translations": _titled("S"), "components": [
        {"id": "radio", "fieldName": "F_Grp", "translations": _titled("Frage"),
         "options": [_opt("o1", "Eins"), _opt("o2", "Zwei")], "showLogic": [DEAD]},
    ]}])
    assert _field(rows, "F_Grp")["hidden_field"] is None, "group title stayed hidden"
    for oid in ("F_o1", "F_o2"):
        assert _field(rows, oid)["hidden_field"] is None, f"{oid} stayed hidden"

    # A whole section can be orphaned the same way; it must not swallow its fields.
    rows = _rows([{"id": "S", "translations": _titled("Block"), "showLogic": [DEAD],
                   "components": [{"id": "text-input", "fieldName": "F_B",
                                   "translations": _titled("B")}]}])
    assert _field(rows, "sectionhdr")["hidden_field"] is None, "section heading stayed hidden"
    assert _field(rows, "F_B")["hidden_field"] is None, "field in orphaned section stayed hidden"

    # Split inputs build their rows on a separate path.
    rows = _rows([{"id": "S", "translations": _titled("S"), "components": [
        {"id": "split-input", "splitVariant": "name-vorname", "fieldName": "F_N",
         "translations": _titled("Name"), "showLogic": [DEAD]},
    ]}])
    for side in ("Vorname", "Name"):
        assert _field(rows, side)["hidden_field"] is None, f"split side {side} stayed hidden"

    print("OK: orphaned Show conditions un-hide their rows.")


def _run_resolvable_still_hidden():
    rows = _rows([{"id": "S", "translations": _titled("S"), "components": [
        _trigger(),
        {"id": "text-input", "fieldName": "F_B", "translations": _titled("B"),
         "showLogic": ["opt_yes"]},
    ]}])
    b = _field(rows, "F_B")
    assert b["show_logic"] == [2], b["show_logic"]
    assert b["hidden_field"] is True, "a resolvable Show condition must start hidden"

    rows = _rows([{"id": "S", "translations": _titled("S"), "components": [
        _trigger(),
        {"id": "checkbox", "fieldName": "F_Grp", "translations": _titled("Mehr"),
         "options": [_opt("c1", "Eins")], "showLogic": ["opt_yes"]},
    ]}])
    assert _field(rows, "F_Grp")["hidden_field"] is True, "resolvable group un-hidden"
    assert _field(rows, "F_c1")["hidden_field"] is True, "resolvable group's option un-hidden"

    rows = _rows([
        {"id": "S1", "translations": _titled("Erste"), "components": [_trigger()]},
        {"id": "S2", "translations": _titled("Block"), "showLogic": ["opt_yes"],
         "components": [{"id": "text-input", "fieldName": "F_B",
                         "translations": _titled("B")}]},
    ])
    assert _field(rows, "sectionhdr_1")["hidden_field"] is True, "resolvable section un-hidden"
    assert _field(rows, "F_B")["hidden_field"] is True, "field in resolvable section un-hidden"

    print("OK: resolvable Show conditions still start hidden.")


def _run_explicit_hidden_wins():
    # "Verstecktes Feld" is an independent instruction — a dropped condition can't reveal it.
    rows = _rows([{"id": "S", "translations": _titled("S"), "components": [
        {"id": "text-input", "fieldName": "F_B", "translations": _titled("B"),
         "hiddenField": True, "showLogic": [DEAD]},
    ]}])
    assert _field(rows, "F_B")["hidden_field"] is True, "explicitly hidden field was revealed"

    # A hide-only condition never implied hidden, orphaned or not.
    rows = _rows([{"id": "S", "translations": _titled("S"), "components": [
        {"id": "text-input", "fieldName": "F_B", "translations": _titled("B"),
         "hideLogic": [DEAD]},
    ]}])
    assert _field(rows, "F_B")["hidden_field"] is None, _field(rows, "F_B")["hidden_field"]

    print("OK: explicit hidden-by-default is unaffected.")


def _run_record_shape():
    # The internal marker is bookkeeping for the hidden-field pass; it must not survive
    # into the emitted record, which downstream consumers read as fixed fields.
    form_json = build_form_json({"formTitle": "T", "deployment": {}, "sections": [
        {"id": "S", "translations": _titled("S"), "components": [
            _trigger(),
            {"id": "text-input", "fieldName": "F_B", "translations": _titled("B"),
             "showLogic": [DEAD]},
        ]}]})
    for rows in form_json["parts"].values():
        for rec in rows.values():
            assert "hidden_by_show_logic" not in rec, "internal marker leaked into the record"

    print("OK: records carry no internal bookkeeping.")


if __name__ == "__main__":
    _run_orphan_show_unhides()
    _run_resolvable_still_hidden()
    _run_explicit_hidden_wins()
    _run_record_shape()
