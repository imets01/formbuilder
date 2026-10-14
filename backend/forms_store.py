"""
File-backed store for saved forms — one JSON file per form under paths.FORMS_DIR.

This replaces the frontend's old localStorage persistence: storing on the server
(a k8s PersistentVolume in prod) is what makes forms visible across browsers.

There is no per-user separation by design — the tool is internal and everyone
shares the same forms. A single file per form means two people saving *different*
forms at once never collide; writes are atomic (temp file + os.replace) so a
crash mid-write can't leave a half-written form behind.

Names are unique across the store
"""

import json
import os
import re
import tempfile
from pathlib import Path

import paths
from json_builder import MAX_FORM_NAME_LEN, safe_form_name

# Form ids are generated client-side as e.g. "form_1718000000000_a1b2c3". Only
# allow that shape so a malicious id can't escape FORMS_DIR via path traversal.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

DEFAULT_TITLE = "Untitled Form"


class InvalidFormId(ValueError):
    """Raised when an id contains anything other than [A-Za-z0-9_-]."""


class DuplicateFormTitle(ValueError):
    """Raised when another saved form already goes by the same name."""

    def __init__(self, title: str, existing_id: str):
        super().__init__(f'a form named "{title}" already exists')
        self.title = title
        self.existing_id = existing_id


def _forms_dir() -> Path:
    paths.FORMS_DIR.mkdir(parents=True, exist_ok=True)
    return paths.FORMS_DIR


def _form_path(form_id: str) -> Path:
    if not form_id or not _ID_RE.match(form_id):
        raise InvalidFormId(f"invalid form id: {form_id!r}")
    return _forms_dir() / f"{form_id}.json"


def list_forms() -> list[dict]:
    """Return summaries (id, title, updatedAt) for every saved form, newest first."""
    summaries: list[dict] = []
    for path in _forms_dir().glob("*.json"):
        try:
            form = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue  # skip unreadable/corrupt files rather than failing the whole list
        summaries.append({
            "id": form.get("id", path.stem),
            "title": form.get("title", DEFAULT_TITLE),
            "updatedAt": form.get("updatedAt", 0),
        })
    summaries.sort(key=lambda s: s["updatedAt"], reverse=True)
    return summaries


def load_form(form_id: str) -> dict | None:
    """Return the full saved form, or None if it doesn't exist."""
    path = _form_path(form_id)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


# ── Unique names ──────────────────────────────────────────────────────────────
_SUFFIX_ROOM = 5


def _title_key(title: str) -> str:
    return safe_form_name(title or DEFAULT_TITLE).casefold()


def _taken_keys(exclude_id: str | None = None) -> dict[str, str]:
    """Name key -> form id for every saved form but `exclude_id`."""
    return {
        _title_key(s["title"]): s["id"]
        for s in list_forms()
        if s["id"] != exclude_id
    }


def find_by_title(title: str, exclude_id: str | None = None) -> str | None:
    """Id of another form going by this name, or None if the name is free."""
    return _taken_keys(exclude_id).get(_title_key(title))


def unique_title(title: str, exclude_id: str | None = None) -> str:
    """`title` if no other form uses it, else the first free " (n)" variant."""
    base = (title or "").strip() or DEFAULT_TITLE
    taken = _taken_keys(exclude_id)
    if _title_key(base) not in taken:
        return base
    base = _trim_for_suffix(base)
    suffix = 2
    while _title_key(f"{base} ({suffix})") in taken:
        suffix += 1
    return f"{base} ({suffix})"


def _trim_for_suffix(base: str) -> str:
    """Shorten a title until " (n)" survives safe_form_name's length cap.

    Without this, a title already at the cap truncates the suffix straight back
    off — every candidate would key to the same taken name and never terminate.
    """
    while len(base) > 1 and len(_title_key(base)) > MAX_FORM_NAME_LEN - _SUFFIX_ROOM:
        base = base[:-1].rstrip()
    return base or DEFAULT_TITLE


def save_form(form: dict) -> dict:
    """Write the form to <id>.json atomically and return it.
    """
    form_id = form.get("id")
    path = _form_path(form_id)
    title = form.get("title") or DEFAULT_TITLE
    stored = load_form(form_id)
    renamed = stored is None or _title_key(stored.get("title") or DEFAULT_TITLE) != _title_key(title)
    if renamed:
        clash = find_by_title(title, exclude_id=form_id)
        if clash is not None:
            raise DuplicateFormTitle(title, clash)
    data = json.dumps(form, ensure_ascii=False, indent=2)
    # Write to a temp file in the same dir, then atomically replace the target.
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return form


def delete_form(form_id: str) -> bool:
    """Delete the form's file (and any imported-source sidecar). Returns False if it didn't exist."""
    path = _form_path(form_id)
    try:
        _source_path(form_id).unlink()
    except FileNotFoundError:
        pass
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


# ── Imported-source sidecar ───────────────────────────────────────────────────
# When a form is created by importing a PSPH spreadsheet, we keep the original
# workbook bytes next to the form as <id>.source so it can later be round-tripped
# (export = original + the builder's edits). It lives outside the autosaved
# <id>.json so editing the form never rewrites these (potentially large) bytes.

def _source_path(form_id: str) -> Path:
    # Reuse _form_path's validation, then swap the suffix.
    return _form_path(form_id).with_suffix(".source")


def save_source(form_id: str, raw: bytes) -> None:
    """Store the original imported spreadsheet bytes for this form (atomic replace)."""
    path = _source_path(form_id)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_", suffix=".source")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_source(form_id: str) -> bytes | None:
    """Return the stored original spreadsheet bytes, or None if there is none."""
    try:
        return _source_path(form_id).read_bytes()
    except FileNotFoundError:
        return None


def has_source(form_id: str) -> bool:
    """Whether an imported-source spreadsheet is stored for this form."""
    return _source_path(form_id).exists()
