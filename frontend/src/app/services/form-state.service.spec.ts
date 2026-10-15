import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { FormStateService } from './form-state.service';
import { AuthService } from './auth.service';

/** Real timers, not fakeAsync: TestBed.tick() doesn't reliably flush the effect feeding
 *  saveTrigger under fakeAsync, which flaked about one run in six. */
describe('FormStateService autosave', () => {
  let form: FormStateService;
  let http: HttpTestingController;

  const DEBOUNCE_MS = 600;
  const SETTLE_MS = DEBOUNCE_MS + 150;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    TestBed.inject(AuthService).canWrite.set(true);  // not a demo visitor
    form = TestBed.inject(FormStateService);
    http = TestBed.inject(HttpTestingController);
  });

  const settleSaves = async (): Promise<TestRequest[]> => {
    TestBed.tick();
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    TestBed.tick();
    return http.match(r => r.method === 'PUT');
  };

  /** newForm() also fetches the saved-form list (the names a rename must avoid). */
  const flushFormList = (titles: string[] = []) =>
    http.match(r => r.method === 'GET').forEach((r, i) =>
      r.flush(titles.map((title, n) => ({ id: `other_${i}_${n}`, title, updatedAt: 1 }))));

  const startForm = async (existingTitles: string[] = []) => {
    form.newForm();
    flushFormList(existingTitles);
    (await settleSaves()).forEach(r => r.flush({ id: r.request.body.id, title: r.request.body.title }));
  };

  const editAndSettle = async (title: string) => {
    form.formTitle.set(title);
    return settleSaves();
  };

  it('saves nothing for a demo visitor', async () => {
    TestBed.inject(AuthService).canWrite.set(false);
    await startForm();

    const saves = await editAndSettle('Permit application');

    expect(saves.length).toBe(0);
    http.verify();
  });

  it('saves an edit', async () => {
    await startForm();

    const saves = await editAndSettle('Permit application');

    expect(saves.length).toBe(1);
    expect(saves[0].request.body.payload.formTitle).toBe('Permit application');
    saves[0].flush({});
    http.verify();
  });

  it('keeps saving after a request fails', async () => {
    await startForm();

    const failing = await editAndSettle('Before the blip');
    expect(failing.length).toBe(1);
    failing[0].flush('boom', { status: 500, statusText: 'Server Error' });

    // The regression: an error reaching the outer pipe killed the subscription, so every
    // later edit was silently dropped until a page reload.
    const recovered = await editAndSettle('After the blip');

    expect(recovered.length).withContext('autosave still alive').toBe(1);
    expect(recovered[0].request.body.payload.formTitle).toBe('After the blip');
    recovered[0].flush({});
    http.verify();
  });

  it('survives repeated failures', async () => {
    await startForm();

    for (const label of ['First', 'Second']) {
      const saves = await editAndSettle(label);
      expect(saves.length).withContext(`save "${label}"`).toBe(1);
      saves[0].error(new ProgressEvent('network error'));
    }

    const saves = await editAndSettle('Finally');
    expect(saves.length).toBe(1);
    expect(saves[0].request.body.payload.formTitle).toBe('Finally');
    saves[0].flush({});
    http.verify();
  });

  it('flags a name another form already uses', async () => {
    await startForm(['Permit application']);

    expect(form.isTitleTaken('Permit application')).toBeTrue();
    // Same technical name (safe_form_name) → the same form as far as a deployment goes.
    expect(form.isTitleTaken('PERMIT  application')).toBeTrue();
    expect(form.isTitleTaken('Permit-application')).toBeTrue();
    expect(form.isTitleTaken('Permit applications')).toBeFalse();
    http.verify();
  });

  it('adopts a name the server had to disambiguate', async () => {
    form.newForm();
    flushFormList(['Untitled Form']);

    const created = await settleSaves();
    expect(created.length).toBe(1);
    created[0].flush({ id: created[0].request.body.id, title: 'Untitled Form (2)' });

    expect(form.formTitle()).toBe('Untitled Form (2)');
    (await settleSaves()).forEach(r => r.flush({ id: r.request.body.id, title: r.request.body.title }));
    http.verify();
  });

  it('restores the accepted name when the server refuses a rename', async () => {
    await startForm();

    const refused = await editAndSettle('Permit application');
    expect(refused.length).toBe(1);
    refused[0].flush({ status: 'error' }, { status: 409, statusText: 'Conflict' });

    expect(form.titleConflict()).toBe('Permit application');
    expect(form.formTitle()).withContext('last accepted name restored').toBe('Untitled Form');

    // Restoring it saves again, so the edits made under the refused name still land.
    const resaved = await settleSaves();
    expect(resaved.length).toBe(1);
    expect(resaved[0].request.body.title).toBe('Untitled Form');
    resaved[0].flush({ id: resaved[0].request.body.id, title: 'Untitled Form' });
    expect(form.titleConflict()).toBeNull();
    http.verify();
  });

});

/** Imported PSPH sheets carry DE/FR/IT and often no EN, so an EN canvas would read as empty. */
describe('FormStateService display language', () => {
  let form: FormStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    form = TestBed.inject(FormStateService);
  });

  it('starts in DE', () => {
    expect(form.displayLanguage()).toBe('DE');
  });

  it('returns to DE when a form is created or opened', () => {
    form.displayLanguage.set('EN');
    form.newForm();
    expect(form.displayLanguage()).toBe('DE');

    form.displayLanguage.set('EN');
    form.openForm('form_imported');
    expect(form.displayLanguage()).withContext('set before the load resolves').toBe('DE');
  });
});

describe('FormStateService section reordering', () => {
  let form: FormStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    form = TestBed.inject(FormStateService);
    form.newForm();
  });

  const titles = () => form.sections().map(s => s.title);

  it('moves a section down and keeps the selection on it', () => {
    form.addSection();
    form.addSection();
    const moved = form.sections()[0].title;
    form.selectSection(0);

    form.moveSection(0, 2);

    expect(titles()[2]).toBe(moved);
    expect(form.selectedSectionIndex()).toBe(2);
  });

  it('shifts the selected index when another section moves past it', () => {
    form.addSection();
    form.addSection();
    const selected = form.sections()[2].title;
    form.selectSection(2);

    form.moveSection(0, 2);

    expect(form.sections()[form.selectedSectionIndex()!].title).toBe(selected);
  });

  it('pins the form header: it cannot move and nothing lands above it', () => {
    form.addSection();
    form.addMetadataSection();
    const last = form.sections()[2].title;

    form.moveSection(0, 2);  // dragging the header itself is a no-op
    expect(form.sections()[0].isMetadata).toBeTrue();

    form.moveSection(2, 0);  // a drop above the header clamps to the slot below it
    expect(form.sections()[0].isMetadata).toBeTrue();
    expect(form.sections()[1].title).toBe(last);
  });
});
