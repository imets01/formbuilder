import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { FormStateService } from '../../services/form-state.service';
import { TourService } from '../../services/tour.service';
import { TourComponent } from './tour.component';

/**
 * Covers the part the service specs can't: the rAF positioning loop, which runs
 * outside Angular and writes transforms straight to the DOM.
 */
describe('TourComponent', () => {
  let fixture: ComponentFixture<TourComponent>;
  let form: FormStateService;
  let anchor: HTMLElement;

  const frames = (count = 2) =>
    new Promise<void>(resolve => {
      const step = (n: number) =>
        n <= 0 ? resolve() : requestAnimationFrame(() => step(n - 1));
      step(count);
    });

  const host = () => fixture.nativeElement as HTMLElement;
  const beacon = () => host().querySelector<HTMLElement>('.tour-beacon');
  const card = () => host().querySelector<HTMLElement>('.tour-card');

  const translation = (el: HTMLElement) => {
    const [x, y] = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform)!.slice(1);
    return { x: Number(x), y: Number(y) };
  };

  beforeEach(() => {
    localStorage.removeItem('formbuilder.tour.v1.done');

    anchor = document.createElement('div');
    anchor.setAttribute('data-tour', 'palette-text-input');
    anchor.style.cssText =
      'position:fixed;left:40px;top:120px;width:200px;height:36px;background:#eee';
    document.body.appendChild(anchor);

    TestBed.configureTestingModule({
      imports: [TourComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    form = TestBed.inject(FormStateService);
     TestBed.inject(TourService);
    form.newForm();
    TestBed.tick();

    fixture = TestBed.createComponent(TourComponent);
    fixture.detectChanges();

    expect(host().querySelector('.tour-beacon')).withContext('walkthrough open').not.toBeNull();
  });

  afterEach(() => {
    anchor.remove();
    localStorage.removeItem('formbuilder.tour.v1.done');
  });

  it('renders the first prompt', () => {
    expect(host().querySelector('.tour-copy')?.textContent?.trim())
      .toBe('Drag this onto the canvas to add your first question.');
  });

  it('places the beacon on the anchor edge the prompt reads from', async () => {
    await frames();

    const rect = anchor.getBoundingClientRect();
    const { x, y } = translation(beacon()!);

    expect(x).toBeCloseTo(rect.right - 5, 0);
    expect(y).toBeCloseTo(rect.top + rect.height / 2 - 5, 0);
  });

  it('puts the prompt clear of the anchor, inside the viewport', async () => {
    await frames();

    const rect = anchor.getBoundingClientRect();
    const el = card()!;
    const { x, y } = translation(el);

    expect(x).toBeGreaterThan(rect.right);
    expect(x + el.offsetWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it('follows the anchor when it moves', async () => {
    await frames();
    const before = translation(beacon()!);

    anchor.style.top = '300px';
    await frames();
    const after = translation(beacon()!);

    expect(after.y - before.y).toBeCloseTo(180, 0);
  });

  it('waits silently while the anchor is missing', async () => {
    await frames();
    expect(host().classList).toContain('is-anchored');

    anchor.remove();
    await frames();
    expect(host().classList).not.toContain('is-anchored');
  });

  it('never intercepts pointer events, so the drag still works', async () => {
    await frames();

    expect(getComputedStyle(host()).pointerEvents).toBe('none');
    expect(getComputedStyle(beacon()!).pointerEvents).toBe('none');
    expect(getComputedStyle(card()!).pointerEvents).toBe('none');
    // ...except the skip link, which has to be clickable.
    const skip = host().querySelector<HTMLElement>('.tour-skip')!;
    expect(getComputedStyle(skip).pointerEvents).toBe('auto');
  });

  const pressEscape = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
  };

  it('closes on Escape', async () => {
    await frames();
    expect(beacon()).not.toBeNull();

    pressEscape();

    expect(beacon()).toBeNull();
  });

  it('leaves Escape alone while a menu or dialog is open', async () => {
    await frames();

    // Stand in for an open mat-menu; Esc belongs to the menu, not the walkthrough.
    const overlay = document.createElement('div');
    overlay.className = 'cdk-overlay-container';
    overlay.innerHTML = '<div class="cdk-overlay-pane"></div>';
    document.body.appendChild(overlay);

    try {
      pressEscape();
      expect(beacon()).not.toBeNull();
    } finally {
      overlay.remove();
    }

    pressEscape();
    expect(beacon()).toBeNull();
  });
});
