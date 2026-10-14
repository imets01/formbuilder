# Recipes

Each change lists every place that has to move. The usual failure is updating a mapping in
three places out of four — see [the invariants](data-model.md#invariants).

## Add a component type

```
Client                              Service
[ ] palette entry                   [ ] COMPONENT_TYPE_MAP or OPTION_GROUP_FORMATS
[ ] addComponent defaults           [ ] _FORMAT_FOR (+ _OPTION_FORMAT_FOR)
[ ] NUMBERED_OPTION_GROUP_IDS       [ ] _SINGLE_FORMATS / _TITLE_FORMATS / _OPTION_FORMATS
[ ] availableLogicOptions           [ ] _PALETTE
[ ] canvas @if block                [ ] generator rendering path (only if a new Format)
[ ] right-sidebar predicates        [ ] stub_renderer rendering branch
```

- **Palette** — `left-sidebar.component.ts`, in the right category.
- **Creation defaults** — `addComponent()` in `form-state.service.ts`: placeholders, a
  `titleDefaults` branch for fixed per-language titles, an `options:` branch if it carries
  options, `minLength`/`maxLength` if it is length-based.
- **Numbering** — add the id to `NUMBERED_OPTION_GROUP_IDS` if each option takes its own
  Input ID. Must match `OPTION_GROUP_FORMATS`.
- **Logic eligibility** — add the id to `optionGroupIds` in `availableLogicOptions` if
  conditions may reference its options. Leave it out if the platform renders the component
  from a macro, because then its options have no ids to reference.
- **Rendering** — an `@if (component.id === 'my-type')` block in `canvas.component.html`,
  and the matching predicates in `right-sidebar.component.ts` (`isOptionGroup`,
  `isLengthBased`, `isNumericRange`, `isDateRange`, `isUpload`, `isCatalog`, `isLabelOnly`,
  `editFieldOptionsFor`).
- **Preview** — `stub_renderer._component` dispatches on the same ids. Add a branch, or an
  entry in `_OPTION_GROUPS` / `_INPUT_TYPES` if it behaves like an existing family. Unknown
  ids fall back to a text field, so a missing branch is silent.

Then run `python test_palette_coverage.py` — it fails if the new id is unmapped in either
workbook layer.

## Add a property to an existing type

1. `FormComponentInstance` — the optional field.
2. `addComponent()` — a default, if needed.
3. `right-sidebar` — a control, via `updateProperty(...)`.
4. `canvas.component.html` — only if it changes the sketch.
5. `build_form_json` — pass it into `FormField(...)`; add it to the dataclass if new.
6. `stub_renderer` — consume it, if it should show in the preview.
7. `spreadsheet_exporter` and `excel_importer` — only if it maps to a column and should
   round-trip.

No `serializeDoc()` change needed; it serialises `sections` wholesale.

## Add a form-level setting

1. A signal on `FormStateService`.
2. **Add it to `serializeDoc()`** — otherwise no undo and no autosave.
3. Add it to `SavedFormPayload` and to the autosave `effect()`'s payload.
4. `form-transfer.service.ts:parseFile` — or it is lost on JSON round-trip.
5. `build_form_json`'s return dict, if downstream needs it.

Deployment-only values go in `DeploymentSettings`, already wired end to end.

## Add a route

Keep the handler in `app.py` small and put the work in a module. Let `forms_store` raise
`InvalidFormId` and return 400, rather than checking the id yourself. On the client, add a
method to `FormStorageService` or `FormTransferService`.

## Add a catalog

List in `catalogs.ts` as `CatalogEntry[]` (`code` becomes `refID`), palette entry, an
`options:` branch in `addComponent`, the id in `NUMBERED_OPTION_GROUP_IDS` and
`OPTION_GROUP_FORMATS`, `isCatalog()` in the right sidebar so it gets the compact
searchable table, and an entry in `stub_renderer._OPTION_GROUPS` so the preview renders it.

## Change the numbering rule

Change both implementations together: `inputIdMap`/`displayIdMap`, and the `field_index`
counter in `build_form_json`. Then update the expected numbers in `input-id.spec.ts` from
`/api/generate-json` output. Input IDs are written into the workbook, so a change to them
changes what exports and re-imports; Display IDs never leave the browser and can change
freely.

## Change the workbook mapping

Any edit to `json_builder`, `excel_importer` or `spreadsheet_exporter` can change what a
form exports — and therefore whether it still re-imports.

```bash
cd backend && python test_spreadsheet_exporter.py && python test_palette_coverage.py
```

## Add a language

A large change: the list is hard-coded in every one of these places — the
`['DE','FR','IT','EN']` literals in `right-sidebar.component.ts` and
`form-state.service.ts`, the `{ DE, FR, IT, EN }` literals in `addComponent` and the
`*_TITLE` consts, `catalogs.ts`, `FormField`'s language fields and the reads in
`build_form_json`, `dictionary._LANGS`, `stub_renderer._LANGUAGES` / `_LANG_KEY` /
`_UI_TEXT`, a new `ftl_consts/<lang>.txt`, and the language columns in `_COLUMN_MATCHERS`
and `_STD_HEADERS`.
