# FormBuilder

Visual authoring for multilingual, conditional web forms — a drag-and-drop editor that
replaces a 25-page Excel specification workbook as the place forms get written, while
still reading and writing that workbook.

```
Angular editor ──▶ form document ──▶ build_form_json ──▶ preview / spreadsheet / JSON
                   (JSON per form)
```

## What it does

- **Drag-and-drop authoring** of the full field palette — text, dates, numbers, uploads,
  radio and checkbox groups, dual-listbox country/canton pickers, split fields
  (street/number, ZIP/city), consent blocks.
- **Four languages per form** (DE/FR/IT/EN), with a phrase library that suggests
  translations for common field labels so wording stays consistent.
- **Conditional logic** — show/hide rules nesting AND and OR to any depth, held against
  stable option ids, so conditions survive inserting, reordering and renaming fields.
- **Excel round-trip** — import an existing specification workbook, keep editing visually,
  export it back with a recorded version and change note. Export overlays the original
  file rather than regenerating it, so columns the builder doesn't own are preserved.
- **Live preview** in all four languages, with conditional fields visibly marked.
- **Repeatable sections** (aggregates) for blocks that repeat per person or per item.

## Quickstart

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate     # or: source .venv/bin/activate
pip install -r requirements.txt
python app.py                                       # :5000

cd ../frontend
npm install && npm start                            # :4200
```

## Tests

```bash
cd backend && for t in test_*.py; do python "$t"; done    # 6 suites, no pytest needed
cd frontend && npm test
```

## Layout

| Path | Contents |
|---|---|
| [frontend/](frontend/) | Angular 21 client. Standalone components, signals, no router |
| [backend/](backend/) | Flask service: form storage, Excel round-trip, preview rendering |
| [docs/](docs/) | Architecture, data model, extension recipes, known issues |

| Backend module | Role |
|---|---|
| `app.py` | Flask routes |
| `json_builder.py` | Form document → generator-ready structure. The single conversion point |
| `excel_importer.py` / `spreadsheet_exporter.py` | Workbook round-trip |
| `stub_renderer.py` | Payload → standalone HTML preview, one document per language |
| `dictionary.py` | Phrase-library translation lookup |
| `forms_store.py` | One JSON file per form under `FORMS_DIR` |

## Docs

| | |
|---|---|
| [architecture.md](docs/architecture.md) | Which file does what, control flow, constraints |
| [data-model.md](docs/data-model.md) | The form model and **the invariants** |
| [extending.md](docs/extending.md) | Recipes: add a component type, a property, a route |
| [known-issues.md](docs/known-issues.md) | Known defects, and what only looks like one |
| [development.md](docs/development.md) | Setup, tests, flags, deployment |

## Background

FormBuilder was built at PrivaSphere AG, where it generates deployment artifacts for their
e-government form platform. This is a trimmed public version: the platform-specific code
generation and its proprietary toolchain are not included, and the preview here is rendered
by `stub_renderer.py` rather than compiled by the real pipeline. The editor, the form model,
the conditional-logic engine and the Excel round-trip are the production code.

Published with PrivaSphere's permission. No license is granted — ask if you want to reuse
any of it.
