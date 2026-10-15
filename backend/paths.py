"""Centralized output file-naming conventions and storage locations."""

import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent

# On Vercel the deployment filesystem is read-only; /tmp is the only writable
# place, so saved forms there are temporary (they reset when the function restarts).
_DEFAULT_FORMS_DIR = Path("/tmp/forms") if os.environ.get("VERCEL") else _REPO_ROOT / "projects"

FORMS_DIR = Path(os.environ.get("FORMS_DIR") or _DEFAULT_FORMS_DIR)


def form_json_filename(form_name: str) -> str:
    return f"{form_name}.json"


def snapshot_filename(form_name: str) -> str:
    """Excel snapshot of the form spec."""
    return f"{form_name}_snapshot.xlsx"
