import { TelemetryService } from './telemetry.service';

/**
 * The study runs each participant once, so a lost buffer is unrecoverable. These specs
 * drive the real activation path — the ?sid= URL param — and simulate a page reload the
 * way the browser does: a fresh TelemetryService over the same sessionStorage.
 */
describe('TelemetryService', () => {
  const originalUrl = window.location.href;

  /** Open the app at ?sid=<id> (or with no sid at all) without navigating. */
  const openWith = (sid: string | null) => {
    window.history.replaceState({}, '', sid === null ? window.location.pathname : `?sid=${sid}`);
    return new TelemetryService();
  };

  beforeEach(() => window.sessionStorage.clear());

  afterEach(() => {
    window.history.replaceState({}, '', originalUrl);
    window.sessionStorage.clear();
  });

  it('is inert without a sid — an ordinary visit records and stores nothing', () => {
    const svc = openWith(null);

    expect(svc.enabled).toBeFalse();
    expect(svc.sessionId).toBeNull();
    svc.record('preview');
    expect(svc.events()).toEqual([]);
    expect(svc.sessionHeader()).toEqual({});
    expect(window.sessionStorage.getItem('formbuilder-telemetry-buffer')).toBeNull();
  });

  it('starts a session and forwards the id to the backend when a sid is present', () => {
    const svc = openWith('P07');

    expect(svc.enabled).toBeTrue();
    expect(svc.sessionId).toBe('P07');
    expect(svc.events().map(e => e.action)).toEqual(['sessionStart']);
    expect(svc.sessionHeader()).toEqual({ 'X-Session-Id': 'P07' });
  });

  it('ignores a blank sid rather than opening a session with an empty id', () => {
    const svc = openWith('%20%20');

    expect(svc.enabled).toBeFalse();
    expect(svc.sessionId).toBeNull();
  });

  it('keeps events across a reload and resumes the same session', () => {
    const first = openWith('P07');
    first.record('addComponent', 'text-input', 'Field_1');
    first.record('preview');

    const after = openWith('P07');

    expect(after.events().map(e => e.action))
      .toEqual(['sessionStart', 'addComponent', 'preview', 'sessionResume']);
    expect(after.events().every(e => e.sessionId === 'P07')).toBeTrue();
    expect(after.eventCount()).toBe(4);
  });

  it('leaves t0 unambiguous — a reload adds sessionResume, not a second sessionStart', () => {
    const first = openWith('P07');
    const t0 = first.events()[0].timestamp;

    const after = openWith('P07');

    expect(after.events().filter(e => e.action === 'sessionStart').length).toBe(1);
    expect(after.events()[0].timestamp).toBe(t0);
  });

  it('discards a previous participant’s buffer when the sid differs', () => {
    const first = openWith('P07');
    first.record('addComponent', 'text-input', 'Field_1');

    const next = openWith('P08');

    expect(next.events().map(e => e.action)).toEqual(['sessionStart']);
    expect(next.events().every(e => e.sessionId === 'P08')).toBeTrue();
  });

  it('starts clean instead of throwing when stored data is corrupt', () => {
    window.sessionStorage.setItem('formbuilder-telemetry-buffer', '{not json');

    const svc = openWith('P07');

    expect(svc.events().map(e => e.action)).toEqual(['sessionStart']);
  });

  it('survives sessionStorage being unavailable', () => {
    const setItem = spyOn(window.sessionStorage, 'setItem').and.throwError('QuotaExceededError');

    const svc = openWith('P07');
    expect(() => svc.record('preview')).not.toThrow();
    // The in-memory buffer still exports, which is what the session ultimately needs.
    expect(svc.events().map(e => e.action)).toEqual(['sessionStart', 'preview']);
    expect(setItem).toHaveBeenCalled();
  });
});
