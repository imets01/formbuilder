"""
Self-checking test for demo mode (ADMIN_TOKEN locks saving and deleting).

    python test_demo_mode.py     # prints OK or raises AssertionError

Covers: no token = everything writable; with a token, PUT/DELETE/source upload are refused
without the header or with a wrong one, allowed with the right one; reads and builds stay
open; /api/auth reports what the visitor may do.
"""

import io
import os
import tempfile
from pathlib import Path

import paths

FORM = {"title": "Demo", "updatedAt": 1, "payload": {"sections": [], "formTitle": "Demo"}}


def _run(client):
    os.environ.pop("ADMIN_TOKEN", None)
    assert client.get("/api/auth").json == {"canWrite": True, "demo": False}
    assert client.put("/api/forms/form_open", json=FORM).status_code == 200

    os.environ["ADMIN_TOKEN"] = "s3cret"
    good = {"X-Admin-Token": "s3cret"}
    for headers in ({}, {"X-Admin-Token": "wrong"}):
        assert client.get("/api/auth", headers=headers).json == {"canWrite": False, "demo": True}
        assert client.put("/api/forms/form_x", json=FORM, headers=headers).status_code == 403
        assert client.delete("/api/forms/form_open", headers=headers).status_code == 403
        upload = {"file": (io.BytesIO(b"x"), "spec.xlsx")}
        assert client.post("/api/forms/form_open/source", data=upload, headers=headers).status_code == 403
        assert client.options("/api/forms/form_x", headers=headers).status_code == 200  # preflight

    # Reading and building stay open to everyone.
    assert client.get("/api/forms").status_code == 200
    assert client.get("/api/forms/form_open").status_code == 200
    assert client.post("/api/generate-json", json=FORM["payload"]).status_code == 200

    assert client.get("/api/auth", headers=good).json == {"canWrite": True, "demo": True}
    assert client.put("/api/forms/form_x", json=FORM, headers=good).status_code == 200
    assert client.delete("/api/forms/form_x", headers=good).status_code == 200


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        paths.FORMS_DIR = Path(tmp)
        from app import app
        try:
            _run(app.test_client())
        finally:
            os.environ.pop("ADMIN_TOKEN", None)
    print("OK")
