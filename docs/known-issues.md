# Known issues

## Export

The overlay matches rows on `Fachdatenbezeichner` — the only key the document carries — and
rewrites only labels, placeholders, mouseovers, Mussfeld and the dev comment
(Fragen/Bemerkungen). Hence:

- **Rows are never removed or reordered.** A deleted component keeps its row; a removed
  condition stays in the sheet.
- **Renaming a `Fachdatenbezeichner` duplicates the field** — the old row no longer matches,
  so a second one is inserted.
- **An existing row's identifiers are never rewritten.** Editing a refID or Complimentary ID
  in the builder does not reach the sheet.
- **Option rows added in the builder are dropped** unless each option was given a field name:
  `_place_new_rows` skips any spec without one. A catalog added to an imported workbook
  exports its title row and none of its options. The from-scratch path writes every row,
  which is why `test_spreadsheet_exporter.py` does not catch this.

A real fix carries the sheet's Input ID through import → payload → export. **Do not simply
drop the `if not fn: continue` guard**: imported options get a fresh `optionId` with no link
to their source row, so every export would re-insert the option rows of existing groups.

## Aggregates

Deliberately incomplete — no logic tab, group RefIDs typed by hand. One real defect: **the
generated Java validator types a block's enumeration to one component's class**, so a
repeating block in any other component does not compile. See `_AGGREGATE_FIELD_NUMBER = 999`,
possibly the cause of the second golden diff below.

## Runtime

- **Previews are kept in memory.** 20 most recent, per process, lost on restart — and with
  more than one worker a token may land on the worker that does not hold it.
- **No form locking.** Two editors on one form overwrite each other.
- **A failed autosave is invisible.** `catchError` sits inside the `switchMap` deliberately —
  move it out and every later save breaks. Surface the error from where it is.

## Tests

No test stage in CI. The exporter's **overlay** path is untested — which is where the dropped
option rows above hide.