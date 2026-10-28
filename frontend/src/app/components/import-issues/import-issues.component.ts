import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { FormStateService } from '../../services/form-state.service';
import { ImportIssue, adviceFor, confirmReimport, issueKey, resolutionFor } from '../../services/import-issues';

/**
 * The import record of a form that came from a spreadsheet: a counter beside the form
 * title that opens the list of findings.
 *
 * Kept with the form rather than shown once, because the old one-shot banner was gone the
 * moment it was dismissed. Findings the document can speak for (a skipped field that now
 * exists, a dropped condition now filled in) drop off the list by themselves; the rest are
 * ticked off by hand.
 */
@Component({
  selector: 'app-import-issues',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './import-issues.component.html',
  // The host takes no layout room of its own, so a form with no import record leaves the
  // title bar exactly as it was.
  styles: [':host { display: contents; }']
})
export class ImportIssuesComponent {
  formState = inject(FormStateService);

  open = signal<boolean>(false);
  showSettled = signal<boolean>(false);
  reimporting = signal<boolean>(false);

  outstanding = computed<ImportIssue[]>(() => this.formState.outstandingImportIssues());
  settled = computed<ImportIssue[]>(() => this.formState.settledImportIssues());
  total = computed<number>(() => this.formState.importIssues().length);

  constructor() {
    // Open on arrival of a fresh import, and close when there is nothing left to show.
    effect(() => {
      if (this.formState.importIssuesJustArrived() > 0) this.open.set(true);
    });
    effect(() => {
      if (!this.total()) {
        this.open.set(false);
        this.showSettled.set(false);
      }
    });
  }

  toggle() {
    this.open.update(v => !v);
  }

  toggleSettled() {
    this.showSettled.update(v => !v);
  }

  trackIssue = (_index: number, issue: ImportIssue) => issueKey(issue);

  advice(issue: ImportIssue): string {
    return adviceFor(issue);
  }

  /** Whether ticking this one off by hand is the only way it can clear. */
  needsManualCheck(issue: ImportIssue): boolean {
    return !!issue.ambiguous || resolutionFor(issue.code) === 'manual';
  }

  markFixed(issue: ImportIssue, fixed: boolean) {
    this.formState.markImportIssueFixed(issue, fixed);
  }

  /** Where a finding's row ended up on the canvas, if anything there still carries its name. */
  private locate(issue: ImportIssue): { section: number; component: number } | null {
    const wanted = [issue.target?.fieldName, issue.target?.label, issue.fieldName, issue.label]
      .map(v => (v ?? '').trim().toLowerCase())
      .filter(Boolean);
    if (!wanted.length) return null;

    const sections = this.formState.sections();
    for (let s = 0; s < sections.length; s++) {
      const section = sections[s];
      const comps = section.components;
      for (let c = 0; c < comps.length; c++) {
        const names = [
          comps[c].fieldName,
          comps[c].translations?.title?.['DE'],
          comps[c].title
        ].map(v => (v ?? '').trim().toLowerCase());
        if (names.some(name => !!name && wanted.includes(name))) return { section: s, component: c };
      }
      const sectionNames = [section.sourceRef, section.title]
        .map(v => (v ?? '').trim().toLowerCase());
      if (sectionNames.some(name => !!name && wanted.includes(name))) {
        return { section: s, component: -1 };
      }
    }
    return null;
  }

  canReveal(issue: ImportIssue): boolean {
    return this.locate(issue) !== null;
  }

  reveal(issue: ImportIssue) {
    const at = this.locate(issue);
    if (!at) return;
    if (at.component < 0) this.formState.selectSection(at.section);
    else this.formState.selectComponent(at.section, at.component);
  }

  /** Forget the import record. Nothing restores it but another import. */
  clearAll() {
    if (!confirm('Clear the import issue list for this form? This cannot be undone.')) return;
    this.formState.clearImportIssues();
  }

  async reimport(file: File) {
    this.reimporting.set(true);
    try {
      await this.formState.reimportSpreadsheet(file);
    } catch (error) {
      alert(`Could not re-import this spreadsheet.\n\n${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.reimporting.set(false);
    }
  }

  onReimportFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!confirmReimport(file.name, this.formState.formTitle())) return;
    this.reimport(file);
  }
}
