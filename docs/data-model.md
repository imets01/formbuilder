# The form model

Two representations:

| | Written by | Read by |
|---|---|---|
| **Form document** | the client | `forms_store`, `spreadsheet_exporter`, `json_builder` |
| **Form-structure JSON** | `json_builder.build_form_json` | the three generator modules |

`build_form_json` is the only conversion point. If generator input looks wrong, the bug is
there or in the client.

## Document shape

```
SavedForm            id, title, updatedAt, hasSource?
└─ payload           formTitle, disableInputSize, disableMouseOver
   ├─ deployment     compName, usrId, usrIdDev, contactEmail, de/fr/it/enId,
   │                 validatorClass, wikiLink, issueLink
   └─ sections[]     id, title, translations.title, isMetadata?, isAggregate?,
                     showLogic?, hideLogic?, hiddenField?
      ├─ components[]  id (palette type), instanceId (stable), fieldName
      │                (Fachdatenbezeichner), refID, compId, translations
      │                (title/placeholder/content), showLogic?, hideLogic?,
      │                validation, splitConfig?
      │  └─ options[]  optionId (stable), fieldName?, refID?, translations
      └─ groups[]      groupId, refID?           (aggregate sections only)
```

Interfaces in [`form-state.service.ts`](../frontend/src/app/services/form-state.service.ts)
and [`form-storage.service.ts`](../frontend/src/app/services/form-storage.service.ts).

Two special section types: `isMetadata` (the header, emitted as the `TO_BE_REMOVED` part)
and `isAggregate` (a repeating block, emits the `Aggregate start`/`end` markers and the
Java enumeration).

## Identity and numbering

**Identifiers are stable; Input IDs are derived.** `instanceId` and `optionId` are assigned
when the component or option is created, and never change. The Input ID is not stored — it
is recomputed from document order on every change.

That is what makes conditions survive editing: a condition holds an `optionId`, so
inserting a field above it or reordering sections leaves it correct. References to a
deleted option resolve to nothing and are dropped.

| | Rule | Where |
|---|---|---|
| **Input ID** | options counted alongside fields | `inputIdMap` (client); the `field_index` counter in `build_form_json` |
| **Display ID** | fields `1, 2, 3…`, options as `7a`, `7b`… | `displayIdMap` — client only, never sent |

`split-input` and `electronic-consent` each take two display numbers, shown as a range.

**Form names are unique.** Comparison runs on `safe_form_name(title)` case-folded, because
that name is both the filename base and an identifier inside the generated files — so
"Permit (2)" and "Permit 2" are one name. A colliding *rename* is refused; creates and
imports get a free " (n)" variant. `form-title.ts` applies the same rule client-side.

## Logic

```ts
type LogicCondition = string | string[];   // optionId | OR-group
```

`showLogic` / `hideLogic` are arrays of those, **AND** across entries: `['a', ['b','c']]`
means *a, and either b or c*.

This mirrors the sheet exactly. The rule is set by
`the PSPH business-specification guide (V25, not in this repo)`, section "Logik anzeigen" — the
document the code comments call *the field guide*. A `Logik anzeigen` / `Logik ausblenden`
cell holds Input IDs in brackets: the top level is an AND, and a nested array is an OR, at
any depth. So `[[5, 7, [11, 12]], 17]` means *(5 or 7 or 11 or 12) and 17*.

Four places have to read it the same way:

| Place | Shape |
|---|---|
| `_parse_logic_cell`, `excel_importer.py` | sheet cell → AND/OR terms |
| `_logic_to_cell`, `spreadsheet_exporter.py` | builder logic → sheet cell |
| `_resolve_logic`, `json_builder.py` | optionIds → Input ID numbers, nesting kept |

`_resolve_logic` turns them into `[2, [2, 3]]` notation and runs **last**, once every
option has a number.

Conditions cannot reference `electronic-consent` options: the platform renders that block
from a macro whose radios carry no ids, so such a condition resolves to nothing and would
hide its target forever.

## The `Format PSPH` mapping lives in four places

| Direction | Location |
|---|---|
| id → Format (fields) | `COMPONENT_TYPE_MAP`, `json_builder.py` |
| id → Format (option groups) | `OPTION_GROUP_FORMATS`, `json_builder.py` |
| id → Format (export) | `_FORMAT_FOR` / `_OPTION_FORMAT_FOR`, `spreadsheet_exporter.py` |
| Format → id (import) | `_SINGLE_FORMATS` / `_TITLE_FORMATS` / `_OPTION_FORMATS` / `_classify`, `excel_importer.py` |

The palette is closed — all entries live in `left-sidebar.component.ts`. Metadata ids
(`meta-title`, `meta-description`, …) arrive with the metadata section instead.
`test_palette_coverage.py` asserts every palette id is mapped in every layer, so a new
component cannot be half-wired.

Four of these spellings cannot be guessed, and getting one wrong fails silently:

| Builder id | Format PSPH | Option rows | Re-imports as |
| --- | --- | --- | --- |
| `select-multi` | `Auswahlfeld mehrfach (Katalog)` | `Auswahlfeld mehrfach Option` | `select-multi` |
| `catalog-countries` | `Auswahlfeld mehrfach (Katalog)` | `Auswahlfeld mehrfach Option` | `select-multi` |
| `catalog-cantons` | `Auswahlfeld mehrfach (Katalog)` | `Auswahlfeld mehrfach Option` | `select-multi` |
| `single-checkbox` | `Kontrollkasten` | — | `single-checkbox` |

- **Not `Drop Down Field Titel` for a multi-select.** That is the *single*-select spelling;
  the importer reads it back as `select-single`, silently downgrading the field.
- **Not a one-option `Checkbox Titel` group for a single checkbox.** The group renders the
  title in the left column *and* the option next to the box, so a round trip through it
  duplicates the label and adds `mandatoryAlsoBoxes`. `Kontrollkasten` is its own format
  throughout, in `json_builder.py` and both workbook layers.
- **A catalog re-imports as `select-multi`.** Options and their refIDs survive but catalog
  identity does not, so the options come back editable rather than prefilled. Accepted: a
  catalog is a multi-select whose options happen to come from a list, and preserving the
  identity would need a marker in the sheet.
- **`electronic-consent` has no row in either layer.** It is signalled by `has_consent` and
  rendered downstream by a platform macro; its `OPTION_GROUP_FORMATS` entry is never consulted.

## Form-structure JSON

`POST /api/generate-json` returns it — the fastest way to debug a generation problem.
Shape: `formName`, `parts` (section title → record key → field record), plus the
deployment and form-level flags. Each record carries the four languages, `required`,
`input`, `input_length`, `input_id`, `subjectIdentifier`, `refID`, `show_logic`,
`hide_logic` and the boolean flags. Records are `FormField` dataclasses flattened by
`as_record()`: empty values are `None` (never `NaN`), flags are real booleans.

Four cases are more than a copy: the metadata section becomes `TO_BE_REMOVED`; the consent
block is replaced by three flags because the platform renders it; a section's conditions
are pushed onto its heading and onto every field without its own; a duplicate
`Fachdatenbezeichner` gets a suffix.

## Invariants

Each of these is implemented in more than one place, and fails **silently** when only
partly updated.

1. **The numbering rule exists twice** — `inputIdMap`/`displayIdMap` and the `field_index`
   counter in `build_form_json`. `input-id.spec.ts` checks the client against numbers
   copied in by hand; nothing compares the two automatically.
2. **The AND/OR reading of a logic cell is implemented four times** (above). Reading it as
   a flat list turns *a and b* into *a or b*, which changes the delivered form and nothing
   complains. `test_logic_notation.py` checks all four against the field guide's examples.
3. **The `Format PSPH` mapping is in four places** (above). A missing entry never raises:
   it falls back to `Text einzeilig` and writes a blank Format cell. `test_palette_coverage.py`
   fails on one, so the gap surfaces at test time rather than in a delivered workbook.
4. **`safe_form_name` exists twice** — `json_builder` and `form-name.ts`. The two must
   agree, since it is both filename and identifier.
5. **Anything persisted must be in `FormStateService.serializeDoc()`** — otherwise undo
   and autosave ignore it.
6. **Generated identifiers derive from the form**, never from process state.
