import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { FormStateService } from '../../services/form-state.service';
import { RightSidebarComponent } from './right-sidebar.component';

describe('RightSidebarComponent tour anchors', () => {
  let fixture: ComponentFixture<RightSidebarComponent>;
  let form: FormStateService;

  const query = (selector: string) =>
    (fixture.nativeElement as HTMLElement).querySelector(selector);

  /** Click a tab by its visible label. */
  const openTab = (label: string) => {
    const tabs = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.mat-mdc-tab')
    );
    const tab = tabs.find(t => t.textContent?.trim() === label);
    expect(tab).withContext(`a tab labelled "${label}"`).toBeTruthy();
    tab!.click();
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RightSidebarComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    });

    form = TestBed.inject(FormStateService);
    form.newForm();
    form.addComponent({ id: 'text-input', name: 'Text Input', icon: 'x' }, 0, 0);
    form.addComponent({ id: 'radio', name: 'Radio Button', icon: 'x' }, 0, 1);
    form.addSection();

    fixture = TestBed.createComponent(RightSidebarComponent);
    fixture.detectChanges();
  });

  it('labels the field Logic tab and anchors it', () => {
    form.selectComponent(0, 0);
    fixture.detectChanges();

    const anchor = query('[data-tour="component-tab-logic"]');
    expect(anchor).withContext('field Logic tab anchor').toBeTruthy();
    expect(anchor!.textContent!.trim()).toBe('Logic');
  });

  it('exposes field-scoped logic anchors when a field is selected', () => {
    form.selectComponent(0, 0);
    fixture.detectChanges();
    openTab('Logic');

    expect(query('[data-tour="logic-add-field"]')).withContext('+ Add condition').toBeTruthy();
  });

  it('exposes NO field anchors when a section is selected', () => {
    form.selectSection(1, 'logic');
    fixture.detectChanges();

    expect(query('[data-tour="logic-add-field"]')).toBeNull();
    expect(query('[data-tour="logic-ref-field"]')).toBeNull();
    expect(query('[data-tour="component-tab-logic"]')).toBeNull();
    expect(query('[data-tour="section-tab-logic"]')).withContext('section tab').toBeTruthy();
  });

  it('anchors the option picker once a condition row exists', () => {
    form.updateComponentProperty(0, 0, 'showLogic', ['']);
    form.selectComponent(0, 0);
    fixture.detectChanges();
    openTab('Logic');

    expect(query('[data-tour="logic-ref-field"]')).withContext('option picker').toBeTruthy();
  });
});
