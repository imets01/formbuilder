import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { FormStateService } from './form-state.service';
import { TourService } from './tour.service';

describe('TourService', () => {
  let tour: TourService;
  let form: FormStateService;

  const DONE_KEY = 'formbuilder.tour.v1.done';
  const HINT_KEY = 'formbuilder.tour.undoHint.v1';

  const stepId = () => tour.step()?.id ?? null;

  const settle = () => TestBed.tick();

  const clearFlags = () => {
    localStorage.removeItem(DONE_KEY);
    localStorage.removeItem(HINT_KEY);
  };

  beforeEach(() => {
    clearFlags();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    form = TestBed.inject(FormStateService);
    tour = TestBed.inject(TourService);
  });

  afterEach(clearFlags);

  const drop = (id: string, name: string, sectionIndex = 0, at = 0) => {
    form.addComponent({ id, name, icon: 'x' }, sectionIndex, at);
    settle();
  };

  const labelSelected = (value: string) => {
    const component = form.selectedComponent()!;
    form.updateComponentProperty(0, 0, 'translations', {
      ...component.translations,
      title: { ...(component.translations?.title ?? {}), EN: value },
    });
    settle();
  };

  const finishChapter1 = () => {
    form.newForm();
    settle();
    drop('text-input', 'Text Input');
    form.selectComponent(0, 0);
    settle();
    labelSelected('What is your name?');
    form.previewRequests.update(n => n + 1);
    settle();
  };

  describe('chapter 1', () => {
    it('stays closed on the landing page', () => {
      settle();
      expect(stepId()).toBeNull();
    });

    it('opens on the first empty form and runs its four steps in order', () => {
      form.newForm();
      settle();
      expect(stepId()).toBe('drop');

      drop('text-input', 'Text Input');
      expect(stepId()).toBe('select');

      form.selectComponent(0, 0);
      settle();
      expect(stepId()).toBe('label');

      labelSelected('What is your name?');
      expect(stepId()).toBe('preview');

      form.previewRequests.update(n => n + 1);
      settle();
      expect(stepId()).toBeNull();
    });

    it('does not advance past select just because a component was dropped', () => {
      form.newForm();
      settle();
      drop('text-input', 'Text Input');
      // addComponent deliberately leaves nothing selected — the click is the step.
      expect(form.selectedComponentIndex()).toBeNull();
      expect(stepId()).toBe('select');
    });

    it('does not treat selecting a different field as labelling', () => {
      form.newForm();
      settle();
      drop('text-input', 'Text Input');
      drop('email', 'E-mail', 0, 1);
      form.selectComponent(0, 0);
      settle();
      expect(stepId()).toBe('label');

      form.selectComponent(0, 1);  // re-baselines rather than advancing
      settle();
      expect(stepId()).toBe('label');
    });

    it('latches steps so an undo does not rewind the walkthrough', () => {
      form.newForm();
      settle();
      drop('text-input', 'Text Input');
      form.selectComponent(0, 0);
      settle();
      expect(stepId()).toBe('label');

      form.undo();  // flushes the pending history commit, then reverts the drop
      settle();
      // Asserted so this can't pass for the wrong reason if undo ever no-ops.
      expect(form.sections()[0].components.length).toBe(0);
      expect(stepId()).toBe('label');
    });

    it('does not open on top of a form that already has fields', () => {
      form.newForm();
      settle();
      tour.dismiss();
      clearFlags();

      const fresh = TestBed.runInInjectionContext(() => new TourService());
      drop('text-input', 'Text Input');
      expect(fresh.step()).toBeNull();
    });

    it('does not open again once it has been seen', () => {
      form.newForm();
      settle();
      tour.dismiss();
      settle();
      expect(stepId()).toBeNull();
      expect(localStorage.getItem(DONE_KEY)).toBe('1');

      form.goToLanding();
      form.newForm();
      settle();
      expect(stepId()).toBeNull();
    });
  });

  describe('?tour=1', () => {
    const forcedTour = () => {
      const original = location.href;
      history.replaceState(null, '', `${location.pathname}?tour=1`);
      try {
        return TestBed.runInInjectionContext(() => new TourService());
      } finally {
        history.replaceState(null, '', original);
      }
    };

    it('opens even though the walkthrough has already been seen', () => {
      localStorage.setItem(DONE_KEY, '1');
      const forced = forcedTour();

      form.newForm();
      settle();
      expect(forced.step()?.id).toBe('drop');
    });

    it('opens on a form that already has fields, skipping what is already done', () => {
      localStorage.setItem(DONE_KEY, '1');
      form.newForm();
      drop('text-input', 'Text Input');

      const forced = forcedTour();
      settle();
      // Step 1 is already satisfied, so it opens on the next goal.
      expect(forced.step()?.id).toBe('select');
    });
  });

  describe('the offer between chapters', () => {
    it('offers chapter 2 instead of running straight on', () => {
      finishChapter1();
      expect(tour.offering()).toBeTrue();
      expect(stepId()).toBeNull();  // no beacon while the offer is up
    });

    it('starts chapter 2 when accepted', () => {
      finishChapter1();
      tour.acceptOffer();
      settle();
      expect(tour.offering()).toBeFalse();
      expect(stepId()).toBe('options');
    });

    it('closes out with the farewell when declined', () => {
      finishChapter1();
      tour.declineOffer();
      settle();
      expect(stepId()).toBeNull();
      expect(tour.farewell()).toBeTrue();
      expect(localStorage.getItem(DONE_KEY)).toBe('1');
    });
  });

  describe('chapter 2', () => {
    beforeEach(() => {
      finishChapter1();
      tour.acceptOffer();
      settle();
    });

    const reachConditionStep = () => {
      drop('radio', 'Radio Button', 0, 1);
      form.selectComponent(0, 0);
      settle();
      expect(stepId()).toBe('condition');
    };

    it('teaches the conditional field before ever mentioning sections', () => {
      expect(stepId()).toBe('options');

      // A radio arrives with Yes/No, so options exist immediately.
      drop('radio', 'Radio Button', 0, 1);
      expect(form.availableLogicOptions().length).toBeGreaterThan(0);

      // Adding a section here is what made users read the lesson as being about sections.
      expect(stepId()).toBe('condition');

      const yes = form.availableLogicOptions()[0].optionId;
      form.updateComponentProperty(0, 0, 'showLogic', [yes]);
      settle();
      expect(stepId()).toBe('section');

      form.addSection();
      settle();
      expect(stepId()).toBeNull();
      expect(tour.farewell()).toBeTrue();
    });

    it('points at the field — never the section — while nothing is selected', () => {
      drop('radio', 'Radio Button', 0, 1);
      form.addSection();
      form.selectSection(1);  // user wandered onto a section
      settle();
      expect(tour.step()!.copy()).toBe('Click the field you want to reveal.');
      expect(tour.step()!.anchor())
        .toBe(`[data-tour="canvas-field-${form.sections()[0].components[0].instanceId}"]`);
    });

    it('uses field-scoped logic anchors so it cannot land on the section panel', () => {
      reachConditionStep();

      // The logic editor template is shared with sections; unscoped would match either.
      expect(tour.step()!.anchor()).toEqual([
        '[data-tour="logic-ref-field"]',
        '[data-tour="logic-add-field"]',
        '[data-tour="component-tab-logic"]',
      ]);
    });

    it('does not complete when the condition is set on the section instead', () => {
      reachConditionStep();

      const yes = form.availableLogicOptions()[0].optionId;
      form.updateSectionProperty(1, 'showLogic', [yes]);
      settle();
      expect(stepId()).toBe('condition');  // a conditional section is not the goal
    });

    it('waits for an option to be picked, not just a condition row added', () => {
      reachConditionStep();

      form.updateComponentProperty(0, 0, 'showLogic', ['']);
      settle();
      expect(stepId()).toBe('condition');
      expect(tour.step()!.copy()).toBe('Now pick the answer that reveals it.');

      const yes = form.availableLogicOptions()[0].optionId;
      form.updateComponentProperty(0, 0, 'showLogic', [yes]);
      settle();
      expect(stepId()).toBe('section');  // on to the closing beat
    });

    it('accepts an OR group with at least one option picked', () => {
      reachConditionStep();

      form.updateComponentProperty(0, 0, 'showLogic', [['', '']]);
      settle();
      expect(stepId()).toBe('condition');

      const yes = form.availableLogicOptions()[0].optionId;
      form.updateComponentProperty(0, 0, 'showLogic', [['', yes]]);
      settle();
      expect(stepId()).toBe('section');
    });
  });

  describe('the undo hint', () => {
    it('fires on the first deletion, once ever', () => {
      form.newForm();
      settle();
      tour.dismiss();  // get the chapter steps out of the way
      settle();
      expect(stepId()).toBeNull();

      drop('text-input', 'Text Input');
      form.removeComponent(0, 0);
      settle();
      expect(stepId()).toBe('undo-hint');
      expect(localStorage.getItem(HINT_KEY)).toBe('1');

      tour.dismiss();
      settle();
      expect(stepId()).toBeNull();

      drop('text-input', 'Text Input');
      form.removeComponent(0, 0);
      settle();
      expect(stepId()).toBeNull();
    });

    it('stands down as soon as the user actually undoes something', () => {
      form.newForm();
      settle();
      tour.dismiss();
      settle();

      // Two fields, delete one: a drop-then-delete round trip leaves nothing to undo.
      drop('text-input', 'Text Input');
      drop('email', 'E-mail', 0, 1);
      form.removeComponent(0, 1);
      settle();
      expect(stepId()).toBe('undo-hint');

      form.undo();
      settle();
      expect(form.canRedo()).toBeTrue();  // the undo really happened
      expect(stepId()).toBeNull();
    });

    it('never talks over a chapter step', () => {
      form.newForm();
      settle();
      expect(stepId()).toBe('drop');

      drop('text-input', 'Text Input');
      form.removeComponent(0, 0);
      settle();
      expect(stepId()).toBe('select');
    });

    it('is deferred, not dropped, when the deletion lands mid-walkthrough', () => {
      form.newForm();
      settle();
      drop('text-input', 'Text Input');
      form.removeComponent(0, 0);
      settle();
      expect(stepId()).toBe('select');  // suppressed for now

      tour.dismiss();
      settle();
      expect(stepId()).toBe('undo-hint');
    });

    it('waits for the between-chapters offer to be answered', () => {
      finishChapter1();
      form.removeComponent(0, 0);
      settle();
      expect(tour.offering()).toBeTrue();
      expect(stepId()).toBeNull();

      tour.declineOffer();
      settle();
      expect(tour.farewell()).toBeTrue();
      expect(stepId()).toBeNull();  // still waiting — the farewell owns the screen
    });
  });
});
