import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { FormStorageService, SavedForm, SavedFormPayload } from './form-storage.service';
import { ImportIssue, annotateAmbiguity } from './import-issues';
import { environment } from '../../environments/environment';
import { safeFormName } from './form-name';

/**
 * Exports a form to a JSON file and imports one back, so a form can be saved,
 * sent to someone else, and reopened identically in their builder.
 *
 * The file wraps the SavedFormPayload (the exact canvas state) in a small
 * versioned envelope. `type`/`version` let import reject foreign or
 * future-version files cleanly instead of silently saving garbage. We
 * deliberately omit id/updatedAt: import always mints a fresh id, so the
 * recipient gets an independent copy that never overwrites their own forms.
 */
export const FORM_FILE_TYPE = 'formbuilder-form';
export const FORM_FILE_VERSION = 1;

interface FormExportFile {
  type: string;
  version: number;
  exportedAt: number;
  payload: SavedFormPayload;
}

@Injectable({ providedIn: 'root' })
export class FormTransferService {
  private storage = inject(FormStorageService);

  /** Build the envelope for a form and trigger a download as <title>.json. */
  exportToFile(title: string, payload: SavedFormPayload): void {
    const file: FormExportFile = {
      type: FORM_FILE_TYPE,
      version: FORM_FILE_VERSION,
      exportedAt: Date.now(),
      payload
    };
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.filenameFor(title);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Parse + validate exported file text into a payload. Throws with a readable message. */
  parseFile(text: string): SavedFormPayload {
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (!data || data.type !== FORM_FILE_TYPE) {
      throw new Error('That is not a FormBuilder form file.');
    }
    if (typeof data.version !== 'number' || data.version > FORM_FILE_VERSION) {
      throw new Error('That file was created by a newer version of FormBuilder.');
    }
    const p = data.payload;
    if (!p || !Array.isArray(p.sections)) {
      throw new Error('That form file is missing its sections.');
    }
    return {
      sections: p.sections,
      formTitle: typeof p.formTitle === 'string' ? p.formTitle : 'Imported Form',
      disableInputSize: !!p.disableInputSize,
      disableMouseOver: !!p.disableMouseOver,
      ...(p.deployment ? { deployment: p.deployment } : {})
    };
  }

  /**
   * Upload a legacy PSPH .xlsx/.csv and convert it to a builder payload on the
   * server. Returns the payload plus the rows the importer couldn't reconstruct,
   * coded and anchored to their sheet row so the builder can keep track of them.
   */
  async importExcelFile(file: File): Promise<{ payload: SavedFormPayload; issues: ImportIssue[] }> {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(`${environment.apiUrl}/api/import-excel`, { method: 'POST', body });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.status !== 'success') {
      throw new Error(data?.message || 'Could not import this spreadsheet.');
    }
    const p = data.payload ?? {};
    if (!Array.isArray(p.sections)) {
      throw new Error('The imported spreadsheet produced no fields.');
    }
    const payload: SavedFormPayload = {
      sections: p.sections,
      formTitle: typeof p.formTitle === 'string' ? p.formTitle : 'Imported form',
      disableInputSize: !!p.disableInputSize,
      disableMouseOver: !!p.disableMouseOver,
      ...(p.deployment ? { deployment: p.deployment } : {})
    };
    return { payload, issues: Array.isArray(p.issues) ? p.issues : [] };
  }

  /**
   * Re-import a corrected spreadsheet over an existing form, server-side.
   *
   * The form keeps its id, so this is the alternative to delete-and-import-again:
   * links, the stored spec workbook and the deployment settings all stay put. The
   * saved form that comes back is the new truth for the canvas.
   */
  async reimportExcelFile(formId: string, file: File): Promise<SavedForm> {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(
      `${environment.apiUrl}/api/forms/${encodeURIComponent(formId)}/reimport`,
      { method: 'POST', body }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.status === 'error') {
      throw new Error(data?.message || 'Could not re-import this spreadsheet.');
    }
    if (!data.payload || !Array.isArray(data.payload.sections)) {
      throw new Error('The re-imported spreadsheet produced no fields.');
    }
    return data as SavedForm;
  }

  /**
   * Store the original imported spreadsheet alongside a saved form, so the form can later be
   * exported as "the same workbook plus the builder's edits". Best-effort; resolves to whether
   * the upload succeeded.
   */
  async uploadSource(formId: string, file: File): Promise<boolean> {
    const body = new FormData();
    body.append('file', file);
    try {
      const res = await fetch(
        `${environment.apiUrl}/api/forms/${encodeURIComponent(formId)}/source`,
        { method: 'POST', body }
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Save a parsed payload as a brand-new form on the server, with its import record. */
  importAsNewForm(payload: SavedFormPayload, issues: ImportIssue[] = []): Observable<SavedForm> {
    const form: SavedForm = {
      id: this.storage.newId(),
      title: payload.formTitle || 'Imported Form',
      updatedAt: Date.now(),
      payload,
      // Judged against the import's own output, while nothing has been edited yet.
      importIssues: annotateAmbiguity(issues, payload.sections)
    };
    return this.storage.save(form);
  }

  private filenameFor(title: string): string {
    // Same name the generated package uses, so a form's files all sort together.
    return `${safeFormName(title)}.json`;
  }
}
