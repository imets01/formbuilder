import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { FormSection } from './form-state.service';
import { environment } from '../../environments/environment';

/** Project-specific values carried into the generated deployment artifacts. */
export interface DeploymentSettings {
  compName: string;
  usrId: string;          
  usrIdDev: string;      
  contactEmail: string;
  deId: string;
  frId: string;
  itId: string;
  enId: string;
  wikiLink: string;
  issueLink: string;
  validatorClass: string;
}

export interface SavedFormPayload {
  sections: FormSection[];
  formTitle: string;
  disableInputSize: boolean;
  disableMouseOver: boolean;
  deployment?: DeploymentSettings;
}

export interface SavedForm {
  id: string;
  title: string;
  updatedAt: number;
  payload: SavedFormPayload;
  /** Set by the server when an imported-source spreadsheet is stored (enables round-trip export). */
  hasSource?: boolean;
}

export interface SavedFormSummary {
  id: string;
  title: string;
  updatedAt: number;
}

@Injectable({ providedIn: 'root' })
export class FormStorageService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/forms`;

  list(): Observable<SavedFormSummary[]> {
    return this.http.get<SavedFormSummary[]>(this.base).pipe(
      catchError(() => of([]))
    );
  }

  load(id: string): Observable<SavedForm | null> {
    return this.http.get<SavedForm>(`${this.base}/${encodeURIComponent(id)}`).pipe(
      catchError(() => of(null))
    );
  }

  save(form: SavedForm): Observable<SavedForm> {
    return this.http.put<SavedForm>(`${this.base}/${encodeURIComponent(form.id)}`, form);
  }

  delete(id: string): Observable<void> {
    return this.http.delete(`${this.base}/${encodeURIComponent(id)}`).pipe(
      map(() => undefined)
    );
  }

  newId(): string {
    return `form_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
