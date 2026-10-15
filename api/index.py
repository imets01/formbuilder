"""Vercel entry point: serves the Flask backend as a Python function.

The Angular build is served as static files; /api/* and /preview are rewritten
here (see vercel.json). Saved forms go to /tmp, the only writable path on
Vercel, so they are temporary and reset whenever the function restarts.
"""

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("FORMS_DIR", "/tmp/forms")

from app import app  # noqa: E402,F401
