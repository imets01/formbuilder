import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { FormStateService } from '../../services/form-state.service';
import { FormTransferService } from '../../services/form-transfer.service';
import { SavedFormPayload } from '../../services/form-storage.service';
import { safeFormName } from '../../services/form-name';
import { DEFAULT_FORM_TITLE } from '../../services/form-title';

@Component({
  selector: 'app-top-nav-bar',
  templateUrl: './top-nav-bar.component.html',
  styleUrls: ['./top-nav-bar.component.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatMenuModule, MatSlideToggleModule]
})
export class TopNavBarComponent {
  formState = inject(FormStateService);
  private transfer = inject(FormTransferService);

  /** What the title field shows. Tracks the form's name, but holds a duplicate the user is
   *  still typing — that one is never committed, so autosave keeps the last accepted name
   *  and the canvas edits around it still persist. */
  titleDraft = linkedSignal(() => this.formState.formTitle());

  titleError = computed<string | null>(() => {
    const draft = this.titleDraft();
    if (draft === this.formState.formTitle()) return null;  // committed, so it was free
    return this.formState.isTitleTaken(draft)
      ? `Another form is already called "${draft.trim() || DEFAULT_FORM_TITLE}".`
      : null;
  });

  /** The duplicate being typed, or the rename the server refused — whichever applies. */
  titleMessage = computed<string | null>(() => {
    const error = this.titleError();
    if (error) return error;
    const refused = this.formState.titleConflict();
    return refused ? `"${refused}" was taken by another form, so the previous name was kept.` : null;
  });

  onTitleInput(value: string) {
    this.titleDraft.set(value);
    if (!this.formState.isTitleTaken(value)) this.formState.formTitle.set(value);
  }

  /** Leaving the field on a duplicate discards it rather than leaving a name that never saves. */
  onTitleBlur() {
    if (this.titleError()) this.titleDraft.set(this.formState.formTitle());
  }

  goToLanding() {
    this.formState.goToLanding();
  }

  async preview() {
    // Open the tab synchronously (inside the click) so the popup blocker allows it.
    const win = window.open('', '_blank');
    win?.document.write(
      '<p style="font-family: sans-serif; padding: 2rem; color: #555;">Generating preview…</p>'
    );
    try {
      const language = this.formState.displayLanguage().toLowerCase();
      const url = await this.formState.generatePreviewFromBackend(language);
      if (win) {
        win.location.href = url;
      }
    } catch (error) {
      win?.close();
      const message = error instanceof Error ? error.message : String(error);
      alert(`Failed to generate preview.\n\n${message}\n\nIs the Python server running?`);
    }
  }

  /** Download the form currently on the canvas as a re-importable JSON file. */
  exportForm() {
    const payload: SavedFormPayload = {
      sections: this.formState.sections(),
      formTitle: this.formState.formTitle(),
      disableInputSize: this.formState.disableInputSize(),
      disableMouseOver: this.formState.disableMouseOver(),
      deployment: this.formState.deployment()
    };
    this.transfer.exportToFile(payload.formTitle, payload);
  }

  async exportJson() {
    try {
      const json = await this.formState.generateJSONFromBackend();

      const jsonString = JSON.stringify(json, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      this.downloadBlob(blob, 'form-structure.json');
    } catch (error) {
      alert('Failed to generate JSON from backend. Is the Python server running?');
    }
  }

  // ── Round-trip spreadsheet export (only for forms imported from a spreadsheet) ──
  exportAuthor = signal<string>('');
  exportNote = signal<string>('');
  exportVersion = signal<string>('');
  exportingXlsx = signal<boolean>(false);

  /** Author + change note are mandatory for every versioned export. */
  canExportSpreadsheet(): boolean {
    return !!this.exportAuthor().trim() && !!this.exportNote().trim();
  }

  async exportSpreadsheet() {
    if (this.exportingXlsx() || !this.canExportSpreadsheet()) return;
    this.exportingXlsx.set(true);
    try {
      const blob = await this.formState.exportSpreadsheetFromBackend({
        author: this.exportAuthor().trim(),
        note: this.exportNote().trim(),
        version: this.exportVersion().trim(),
      });
      this.downloadBlob(blob, `${safeFormName(this.formState.formTitle())}.xlsx`);
      this.exportNote.set('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(`Failed to export spreadsheet.\n\n${message}\n\nIs the Python server running?`);
    } finally {
      this.exportingXlsx.set(false);
    }
  }

  private downloadBlob(blob: Blob, filename: string) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }
}
