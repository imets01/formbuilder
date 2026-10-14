"""Centralized output file-naming conventions and storage locations."""

import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent

FORMS_DIR = Path(os.environ.get("FORMS_DIR") or (_REPO_ROOT / "projects"))


def form_json_filename(form_name: str) -> str:
    return f"{form_name}.json"


def snapshot_filename(form_name: str) -> str:
    """Excel snapshot of the form spec."""
    return f"{form_name}_snapshot.xlsx"
