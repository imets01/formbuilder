import { Injectable, signal } from '@angular/core';

export interface TelemetryEvent {
  action: string;
  targetType: string | null;
  targetId: string | null;
  timestamp: number;
  sessionId: string | null;
}

const STORAGE_KEY = 'formbuilder-telemetry-buffer';

/** `?sid=<participant>` is the single switch that makes a page load a study session. */
function readSessionIdParam(): string | null {
  try {
    const raw = (new URLSearchParams(window.location.search).get('sid') ?? '').trim();
    return raw || null;
  } catch {
    // Exotic/blocked location access: treat as an ordinary visit.
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class TelemetryService {
  readonly sessionId: string | null = readSessionIdParam();
  readonly enabled = this.sessionId !== null;

  private buffer: TelemetryEvent[] = [];
  private restoredSessionId: string | null = null;

  readonly eventCount = signal<number>(0);

  constructor() {
    if (!this.enabled) return;
    this.restore();
    const resumed = this.restoredSessionId === this.sessionId && this.buffer.length > 0;
    if (!resumed) this.buffer = [];
    this.restoredSessionId = this.sessionId;
    this.push(resumed ? 'sessionResume' : 'sessionStart');
  }

  record(action: string, targetType: string | null = null, targetId: string | null = null): void {
    if (!this.enabled) return;
    this.push(action, targetType, targetId);
  }

  private push(action: string, targetType: string | null = null, targetId: string | null = null): void {
    this.buffer.push({ action, targetType, targetId, timestamp: Date.now(), sessionId: this.sessionId });
    this.eventCount.set(this.buffer.length);
    this.persist();
  }

  private persist(): void {
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sessionId: this.sessionId, events: this.buffer }),
      );
    } catch {
      // Full or unavailable storage: keep the in-memory buffer, which still exports.
    }
  }

  private restore(): void {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved?.events)) return;
      this.buffer = saved.events;
      this.restoredSessionId = typeof saved.sessionId === 'string' ? saved.sessionId : null;
      this.eventCount.set(this.buffer.length);
    } catch {
      // Corrupt or unreadable: start empty rather than fail app startup.
    }
  }

  events(): TelemetryEvent[] {
    return [...this.buffer];
  }

  sessionHeader(): Record<string, string> {
    if (!this.enabled) return {};
    return { 'X-Session-Id': this.sessionId as string };
  }

  export(): void {
    if (!this.enabled) return;
    const doc = {
      type: 'formbuilder-telemetry',
      version: 1,
      sessionId: this.sessionId,
      exportedAt: Date.now(),
      eventCount: this.buffer.length,
      events: this.buffer,
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `telemetry_${this.sessionId}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }
}
