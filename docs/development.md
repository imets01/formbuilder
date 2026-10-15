# Development

## Running locally

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate   # elsewhere: source .venv/bin/activate
pip install -r requirements.txt
python app.py                                    # :5000, debug=True

cd frontend && npm install && npm start          # :4200
```

Forms go to `projects/` unless `FORMS_DIR` says otherwise. Production runs gunicorn on
:8080.

## Preview

`POST /api/preview` hands the payload to [`stub_renderer.py`](../backend/stub_renderer.py),
which walks it and emits a self-contained HTML document per language — inline CSS, no
external assets, no template engine. Documents are cached in memory under a token (20 most
recent) and served by `GET /preview?id=…&lang=…`.

The renderer is pure: same payload in, same HTML out, no files touched and no lock needed.
Option groups become fieldsets, aggregate sections become dashed repeating blocks, and any
field carrying show/hide logic is badged, so conditional behaviour is visible without
filling the form in.


## Tests

**CI has no test stage** — all of this is by hand.

```bash
cd backend
python test_excel_importer.py
python test_spreadsheet_exporter.py         # export -> re-import round-trip of Format PSPH
python test_orphan_logic.py                 # show/hide conditions that no longer resolve
python test_palette_coverage.py             # every palette id is mapped in both layers
python test_logic_notation.py               # AND/OR reading of a Logik anzeigen cell
python test_forms_store.py
python test_demo_mode.py                    # ADMIN_TOKEN locks writes, not reads

cd frontend
npx ng test --watch=false --browsers=ChromeHeadless
```

`test_palette_coverage.py` is the one that catches silent breakage: an unmapped palette id
falls back to a plain text field and writes an empty Format cell, so the row will not
re-import. It reads the ids straight out of the left-sidebar source.

The frontend suite passes. Two things make it fail intermittently:

- **`fakeAsync` with root effects is unreliable** — `TestBed.tick()` does not dependably
  run an `effect()`, so a spec that needs an effect *and then* a debounce fails at random.
  Use real timers; there is a working example in `form-state.service.spec.ts`.
- **Spec order is random**, and Jasmine reports an async error against whichever spec

## Flags

| Flag | Where | Default | Effect |
|---|---|---|---|
| `environment.tour` | `frontend/src/environments/` | `true` | First-run walkthrough |

Backend env vars: `FORMS_DIR`, `ADMIN_TOKEN`.

### Demo mode (`ADMIN_TOKEN`)

Set `ADMIN_TOKEN` (for example in the Vercel project's environment variables) to make the
public site read-only. Saving, deleting and uploading an imported source spreadsheet then need
the key in an `X-Admin-Token` header; without it the backend answers `403`. Everything else —
building, preview, generate JSON, import, export — stays open. Visitors without the key edit in
memory only, with no autosave and no delete button. Imports open in the editor instead of being
saved.

To unlock a browser, open the site once with `?admin=<the key>`. The key is kept in
localStorage and removed from the address bar. `?admin=` with no value forgets it.
`GET /api/auth` reports `{canWrite, demo}`. Leave `ADMIN_TOKEN` unset locally and nothing is
locked.

## Docker

```bash
docker build -t formbuilder/frontend ./frontend
docker build -t formbuilder/backend ./backend
```

The backend image is Python + Flask + gunicorn on :8080.
The frontend image builds the Angular bundle and serves it from nginx on :80 with SPA
fallback.

Point the client at the deployed backend by setting `apiUrl` in
[`environment.prod.ts`](../frontend/src/environments/environment.prod.ts), and make sure
that origin is allowed by `flask-cors`.

`FORMS_DIR` is where saved forms live. On an ephemeral host it is wiped on every redeploy —
mount a volume if forms should survive.


## Debugging

| Symptom | First move |
|---|---|
| Generated structure wrong | `POST /api/generate-json` and read the records |

## Before committing

Run the backend suites if you touched `json_builder` or the workbook layers; check
[the invariants](data-model.md#invariants) if you changed anything mapped in more than one
place.
