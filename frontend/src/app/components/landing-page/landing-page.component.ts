import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { FormStateService } from '../../services/form-state.service';
import { FormStorageService, SavedFormSummary } from '../../services/form-storage.service';
import { FormTransferService } from '../../services/form-transfer.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-landing-page',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatMenuModule],
  templateUrl: './landing-page.component.html',
  styleUrls: ['./landing-page.component.scss']
})
export class LandingPageComponent {
  private formState = inject(FormStateService);
  private storage = inject(FormStorageService);
  private transfer = inject(FormTransferService);
  /** False in demo mode: no delete, and imports open in memory instead of being saved. */
  canWrite = inject(AuthService).canWrite;

  forms = signal<SavedFormSummary[]>([]);
  importing = signal<boolean>(false);

  constructor() {
    this.refresh();
  }

  private refresh() {
    this.storage.list().subscribe(forms => this.forms.set(forms));
  }

  newForm() {
    this.formState.newForm();
  }

  openForm(id: string) {
    this.formState.openForm(id);
  }

  deleteForm(event: Event, id: string) {
    event.stopPropagation();
    if (!confirm('Delete this form? This cannot be undone.')) return;
    this.storage.delete(id).subscribe(() => this.refresh());
  }

  /** Download a saved form as a shareable, re-importable JSON file. */
  exportForm(event: Event, id: string) {
    event.stopPropagation();
    this.storage.load(id).subscribe(form => {
      if (!form) return;
      this.transfer.exportToFile(form.title, form.payload);
    });
  }

  /** Read a chosen .json file, save it as a new form, and open it on the canvas. */
  onImportFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';  // allow re-importing the same file later
    if (!file) return;

    this.importing.set(true);
    file.text().then(text => {
      const payload = this.transfer.parseFile(text);  // throws on bad input
      if (!this.canWrite()) {
        this.importing.set(false);
        this.formState.openUnsaved(payload);
        return;
      }
      this.transfer.importAsNewForm(payload).subscribe({
        next: form => {
          this.importing.set(false);
          this.formState.openForm(form.id);  // land on the canvas with the imported form
        },
        error: () => {
          this.importing.set(false);
          alert('Import failed while saving to the server. Is it running?');
        }
      });
    }).catch(err => {
      this.importing.set(false);
      alert(`Could not import this file.\n\n${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Read a chosen .xlsx/.csv PSPH spreadsheet, convert it on the server, save + open it. */
  onImportExcelSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.importing.set(true);
    this.transfer.importExcelFile(file).then(({ payload, skipped }) => {
      if (!this.canWrite()) {
        this.importing.set(false);
        this.formState.openUnsaved(payload);
        this.formState.importWarnings.set(skipped);
        return;
      }
      this.transfer.importAsNewForm(payload).subscribe({
        next: form => {
          // Keep the original workbook with the form so it can be round-tripped on export.
          // Best-effort: a failed source upload only disables the spreadsheet export.
          this.transfer.uploadSource(form.id, file).finally(() => {
            this.importing.set(false);
            this.formState.openForm(form.id);
            this.formState.importWarnings.set(skipped);
          });
        },
        error: () => {
          this.importing.set(false);
          alert('Import failed while saving to the server. Is it running?');
        }
      });
    }).catch(err => {
      this.importing.set(false);
      alert(`Could not import this spreadsheet.\n\n${err instanceof Error ? err.message : String(err)}`);
    });
  }

  formatDate(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleString();
  }
}
