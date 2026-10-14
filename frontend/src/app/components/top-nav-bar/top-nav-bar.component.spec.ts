import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TopNavBarComponent } from './top-nav-bar.component';
import { FormStateService } from '../../services/form-state.service';

/** The title field holds a duplicate without committing it, so autosave never carries a
 *  name the server would refuse — and the canvas edits around it keep saving. */
describe('TopNavBarComponent form name', () => {
  let nav: TopNavBarComponent;
  let form: FormStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    form = TestBed.inject(FormStateService);
    const http = TestBed.inject(HttpTestingController);
    // Constructed without rendering: the title logic is all signals, no DOM.
    nav = TestBed.runInInjectionContext(() => new TopNavBarComponent());

    form.newForm();
    http.match(r => r.method === 'GET').forEach(r => r.flush(
      [{ id: 'other', title: 'Permit application', updatedAt: 1 }]
    ));
  });

  it('shows the typed duplicate but keeps it out of the document', () => {
    nav.onTitleInput('Permit application');

    expect(nav.titleDraft()).toBe('Permit application');
    expect(nav.titleError()).toContain('Permit application');
    expect(form.formTitle()).withContext('not committed').toBe('Untitled Form');

    nav.onTitleInput('Permit application 2026');

    expect(nav.titleError()).toBeNull();
    expect(form.formTitle()).toBe('Permit application 2026');
  });

  it('treats a respelling of a taken name as the same name', () => {
    nav.onTitleInput('permit-application');

    expect(nav.titleError()).withContext('same technical name').not.toBeNull();
    expect(form.formTitle()).toBe('Untitled Form');
  });

  it('discards a duplicate left behind in the field', () => {
    nav.onTitleInput('Permit application');

    nav.onTitleBlur();

    expect(nav.titleDraft()).toBe('Untitled Form');
    expect(nav.titleError()).toBeNull();
  });

  it('follows the name when it changes outside the field', () => {
    nav.onTitleInput('Mine');

    form.formTitle.set('Untitled Form (2)');  // e.g. the server disambiguated it

    expect(nav.titleDraft()).toBe('Untitled Form (2)');
  });

  it('reports a rename the server refused', () => {
    form.titleConflict.set('Permit application');

    expect(nav.titleMessage()).toContain('previous name was kept');
  });
});
