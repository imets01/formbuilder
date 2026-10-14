import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface TranslationSuggestion {
  matched: boolean;
  name?: string;
  translations?: Record<string, string>;
}

/**
 * Looks up a term in the backend phrase dictionary so the builder can auto-fill the other
 * languages of a title. Best-effort: any failure (backend down, no match) resolves to
 * { matched: false } so the editor never breaks because of it.
 */
@Injectable({ providedIn: 'root' })
export class DictionaryService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/api/translate-suggest`;

  suggest(text: string, lang: string): Observable<TranslationSuggestion> {
    const params = new HttpParams().set('text', text).set('lang', lang);
    return this.http.get<TranslationSuggestion>(this.base, { params }).pipe(
      catchError(() => of({ matched: false }))
    );
  }
}
