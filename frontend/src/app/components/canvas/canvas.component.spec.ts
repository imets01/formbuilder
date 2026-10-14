import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { CdkDropList } from '@angular/cdk/drag-drop';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { FormStateService } from '../../services/form-state.service';
import { CanvasComponent } from './canvas.component';

/**
 * Moving a field between sections was impossible for as long as the canvas relied on
 * cdkDropListGroup: CdkDropList provides CDK_DROP_LIST_GROUP: undefined to everything
 * nested inside it, and every per-section list sits inside the section list, so each one
 * ended up with no siblings and the CDK could never hand a drag over. These cover the
 * wiring that replaced it — the connections, and the handler they end up calling.
 */
describe('CanvasComponent drag and drop', () => {
  let fixture: ComponentFixture<CanvasComponent>;
  let form: FormStateService;

  const dropLists = () =>
    fixture.debugElement.queryAll(By.directive(CdkDropList)).map(d => d.injector.get(CdkDropList));
  const componentLists = () => dropLists().filter(l => l.id.startsWith('canvasList_'));

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [CanvasComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    fixture = TestBed.createComponent(CanvasComponent);
    form = TestBed.inject(FormStateService);

    form.sections.set([
      { id: 'Section_A', title: 'A', components: [] },
      { id: 'Section_B', title: 'B', components: [] },
      { id: 'Section_C', title: 'C', components: [] },
    ]);
    fixture.detectChanges();

    form.addComponent({ id: 'email', name: 'E-mail' }, 0);
    form.addComponent({ id: 'text-input', name: 'Text' }, 1);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('gives every section a drop list', () => {
    expect(fixture.componentInstance.componentListIds())
      .toEqual(['canvasList_0', 'canvasList_1', 'canvasList_2']);
    expect(componentLists().map(l => l.id))
      .toEqual(['canvasList_0', 'canvasList_1', 'canvasList_2']);
  });

  it('connects every section list to every other one', () => {
    const ids = fixture.componentInstance.componentListIds();
    for (const list of componentLists()) {
      // Without this the CDK finds no sibling under the pointer and the drag stays put.
      expect(list.connectedTo).toEqual(ids);
    }
  });

  it('keeps sections out of the field lists', () => {
    const sectionDrag = { data: form.sections()[0] } as any;
    expect(fixture.componentInstance.acceptsComponent(sectionDrag)).toBeFalse();
    expect(fixture.componentInstance.acceptsSection(sectionDrag)).toBeTrue();
  });

  it('moves the component across when a drop arrives from another section', () => {
    const [from, to] = componentLists();
    fixture.componentInstance.drop({
      previousContainer: from,
      container: to,
      previousIndex: 0,
      currentIndex: 1,
      item: { data: form.sections()[0].components[0] },
    } as any);

    expect(form.sections()[0].components.length).toBe(0);
    expect(form.sections()[1].components.map(c => c.id)).toEqual(['text-input', 'email']);
  });

  it('reorders within one section when the drop stays in its own list', () => {
    form.addComponent({ id: 'phone', name: 'Phone number' }, 0);
    fixture.detectChanges();
    const [list] = componentLists();

    fixture.componentInstance.drop({
      previousContainer: list,
      container: list,
      previousIndex: 1,
      currentIndex: 0,
      item: { data: form.sections()[0].components[1] },
    } as any);

    expect(form.sections()[0].components.map(c => c.id)).toEqual(['phone', 'email']);
  });
});
