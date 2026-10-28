import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpInterceptorFn } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

const TOKEN_KEY = 'formbuilder.adminToken';

/**
 * Demo mode. When the backend runs with ADMIN_TOKEN set, only requests carrying that key may
 * save or delete forms; everyone else gets a working builder that keeps nothing.
 *
 * The key is handed over once via `?admin=<key>` and remembered in localStorage; `?admin=`
 * (empty) forgets it. Either way the parameter is stripped from the address bar.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);

  /** May this visitor save and delete? Starts false so nothing autosaves before the server says so. */
  canWrite = signal<boolean>(false);
  /** Is the server running in demo mode at all (vs. a local, unlocked backend)? */
  demo = signal<boolean>(false);

  constructor() {
    this.takeTokenFromUrl();
  }

  get token(): string {
    // localStorage can throw when site data is blocked.
    try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
  }

  /** Ask the server what this visitor may do. Called once at startup. */
  async refresh(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ canWrite: boolean; demo: boolean }>(`${environment.apiUrl}/api/auth`)
      );
      this.canWrite.set(!!res.canWrite);
      this.demo.set(!!res.demo);
    } catch {
      this.canWrite.set(false);
    }
  }

  private takeTokenFromUrl() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('admin')) return;
    const key = url.searchParams.get('admin') ?? '';
    try {
      if (key) localStorage.setItem(TOKEN_KEY, key); else localStorage.removeItem(TOKEN_KEY);
    } catch { /* blocked storage: stays read-only */ }
    url.searchParams.delete('admin');
    history.replaceState(history.state, '', url.toString());
  }
}

/** Attach the admin key to every call to our own backend. */
export const adminTokenInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(AuthService).token;
  const ours = !environment.apiUrl || req.url.startsWith(environment.apiUrl) || req.url.startsWith('/');
  if (!token || !ours) return next(req);
  return next(req.clone({ setHeaders: { 'X-Admin-Token': token } }));
};
