import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormComponentInstance, FormSection, FormStateService, LogicCondition } from './form-state.service';
import { environment } from '../../environments/environment';
import { TelemetryService } from './telemetry.service';

export type TourPlacement = 'left' | 'right' | 'bottom';

export interface TourStep {
  id: string;
  copy: () => string;
  placement: () => TourPlacement;
  /** Selector, or a list meaning "the first of these that's actually on screen". */
  anchor: () => string | string[] | null;
  /** Pure: signal reads only, no writes. */
  done: () => boolean;
  onEnter?: () => void;
}

const DONE_KEY = 'formbuilder.tour.v1.done';
const UNDO_HINT_KEY = 'formbuilder.tour.undoHint.v1';
const UNDO_HINT_MS = 9000;

type Phase = 'idle' | 'chapter1' | 'offer' | 'chapter2' | 'farewell';
type TourEndReason = 'completed' | 'declined' | 'dismissed' | 'interrupted';

/**
 * First-run walkthrough. Steps advance on form state, never DOM events, so nothing hooks
 * into CanvasComponent.drop() and the whole machine is testable without a DOM.
 */
@Injectable({ providedIn: 'root' })
export class TourService {
  private form = inject(FormStateService);
  private telemetry = inject(TelemetryService);

  private phase = signal<Phase>('idle');
  private index = signal<number>(0);

  private labelBaseline = signal<{ instanceId: string; json: string } | null>(null);
  private sectionBaseline = signal<number>(0);

  private undoHintVisible = signal<boolean>(false);
  private undoHintPending = signal<boolean>(false);
  private undoHintTimer: any = null;

  /** `?tour=1` ignores the "already seen" flags — they're per browser profile. */
  private readonly forced = readTourParam();
  private everCompleted = !this.forced && readFlag(DONE_KEY);
  private undoHintShown = !this.forced && readFlag(UNDO_HINT_KEY);

  private readonly chapter1: TourStep[] = [
    {
      id: 'drop',
      copy: () => 'Drag this onto the canvas to add your first question.',
      placement: () => 'right',
      anchor: () => '[data-tour="palette-text-input"]',
      done: () => this.fields().length > 0,
    },
    {
      id: 'select',
      // addComponent doesn't select what it creates, so the properties panel stays empty
      // until the user clicks the card. That stall is where first-timers give up.
      copy: () => 'Click your new field to edit it.',
      placement: () => 'right',
      anchor: () => {
        const field = this.fields()[0];
        return field ? `[data-tour="canvas-field-${field.instanceId}"]` : null;
      },
      done: () => this.form.selectedComponentIndex() !== null,
    },
    {
      id: 'label',
      copy: () => 'Type your question here. Watch the canvas.',
      placement: () => 'left',
      anchor: () => `[data-tour="tr-${this.form.displayLanguage()}"]`,
      done: () => {
        const component = this.form.selectedComponent();
        const baseline = this.labelBaseline();
        if (!component || !baseline || baseline.instanceId !== component.instanceId) return false;
        return translationsOf(component) !== baseline.json;
      },
      onEnter: () => this.captureLabelBaseline(),
    },
    {
      id: 'preview',
      copy: () => 'Preview it. This is the real form.',
      placement: () => 'bottom',
      anchor: () => '[data-tour="preview"]',
      done: () => this.form.previewRequests() > 0,
    },
  ];

  private readonly chapter2: TourStep[] = [
    {
      id: 'options',
      copy: () => 'Drag in a Radio Button. It brings Yes/No with it.',
      placement: () => 'right',
      anchor: () => '[data-tour="palette-radio"]',
      done: () => this.form.availableLogicOptions().length > 0,
    },
    {
      id: 'condition',
      copy: () => {
        if (!this.targetFieldSelected()) return 'Click the field you want to reveal.';
        if (this.hasEmptyCondition()) return 'Now pick the answer that reveals it.';
        return 'Open Logic, then show this field only when someone answers Yes.';
      },
      placement: () => (this.targetFieldSelected() ? 'left' : 'right'),
      anchor: () => {
        if (!this.targetFieldSelected()) {
          const field = this.targetField();
          return field ? `[data-tour="canvas-field-${field.instanceId}"]` : null;
        }
        return [
          '[data-tour="logic-ref-field"]',
          '[data-tour="logic-add-field"]',
          '[data-tour="component-tab-logic"]',
        ];
      },
      done: () => {
        if (!this.targetFieldSelected()) return false;
        const logic = this.targetField()?.showLogic;
        return !!logic?.length && !!firstRef(logic[0]);
      },
    },
    {
      id: 'section',
      copy: () => 'Last one: sections group fields. Add a second.',
      placement: () => 'left',
      anchor: () => '[data-tour="add-section"]',
      done: () => this.plainSections().length > this.sectionBaseline(),
      onEnter: () => this.sectionBaseline.set(untracked(() => this.plainSections().length)),
    },
  ];

  private readonly chapterStep = computed<TourStep | null>(() => {
    const phase = this.phase();
    if (phase === 'chapter1') return this.chapter1[this.index()] ?? null;
    if (phase === 'chapter2') return this.chapter2[this.index()] ?? null;
    return null;
  });

  private readonly hintStep = computed<TourStep | null>(() =>
    this.undoHintVisible()
      ? {
          id: 'undo-hint',
          copy: () => 'Deleted something? Ctrl+Z brings it back.',
          placement: () => 'bottom',
          anchor: () => '[data-tour="undo"]',
          done: () => false,
        }
      : null
  );

  readonly step = computed<TourStep | null>(() => this.chapterStep() ?? this.hintStep());
  readonly isFirstStep = computed<boolean>(() => this.phase() === 'chapter1' && this.index() === 0);
  readonly offering = computed<boolean>(() => this.phase() === 'offer');
  readonly farewell = computed<boolean>(() => this.phase() === 'farewell');

  constructor() {
    effect(() => {
      if (!environment.tour) return;

      if (this.form.view() !== 'editor') {
        if (untracked(() => this.phase()) !== 'idle') untracked(() => this.reset());
        return;
      }

      if (this.everCompleted) return;
      if (untracked(() => this.phase()) !== 'idle') return;
      if (!this.form.currentFormId()) return;
      if (!this.forced && !this.form.sections().every(s => s.components.length === 0)) return;

      untracked(() => this.startChapter('chapter1'));
    });

    effect(() => {
      const step = this.chapterStep();
      if (!step) return;
      if (!step.done()) return;
      untracked(() => this.advance());
    });

    effect(() => {
      if (this.chapterStep()?.id !== 'label') return;
      const component = this.form.selectedComponent();
      if (!component) return;
      untracked(() => {
        if (this.labelBaseline()?.instanceId !== component.instanceId) {
          this.captureLabelBaseline();
        }
      });
    });

    effect(() => {
      const deletions = this.form.deletions();
      if (!environment.tour || this.undoHintShown || deletions === 0) return;
      untracked(() => this.undoHintPending.set(true));
    });

    effect(() => {
      if (!this.undoHintPending()) return;
      if (this.phase() !== 'idle') return;
      untracked(() => this.showUndoHint());
    });

    effect(() => {
      if (!this.undoHintVisible()) return;
      if (!this.form.canRedo()) return;  // only possible after an undo
      untracked(() => this.dismissUndoHint());
    });
  }

  dismiss() {
    if (this.undoHintVisible()) {
      this.dismissUndoHint();
      return;
    }
    if (this.phase() === 'idle' || this.phase() === 'farewell') return;
    this.finish(false, 'dismissed');
  }

  acceptOffer() {
    if (this.phase() !== 'offer') return;
    this.startChapter('chapter2');
  }

  declineOffer() {
    if (this.phase() !== 'offer') return;
    this.finish(true, 'declined');
  }

  private startChapter(phase: 'chapter1' | 'chapter2') {
    const steps = phase === 'chapter1' ? this.chapter1 : this.chapter2;
    this.index.set(0);
    this.phase.set(phase);
    this.telemetry.record('tourStart', phase);
    this.telemetry.record('tourStep', phase, steps[0].id);
    steps[0].onEnter?.();
  }

  private advance() {
    const phase = this.phase();
    const steps = phase === 'chapter1' ? this.chapter1 : this.chapter2;
    const next = this.index() + 1;

    if (next < steps.length) {
      this.index.set(next);
      this.telemetry.record('tourStep', phase, steps[next].id);
      steps[next].onEnter?.();
      return;
    }

    if (phase === 'chapter1') {
      this.phase.set('offer');
      this.telemetry.record('tourOffer');
      return;
    }
    this.finish(true, 'completed');
  }

  private finish(withFarewell: boolean, reason: TourEndReason) {
    this.telemetry.record('tourEnd', reason);
    this.everCompleted = true;
    writeFlag(DONE_KEY);
    this.labelBaseline.set(null);

    if (!withFarewell) {
      this.phase.set('idle');
      return;
    }
    this.phase.set('farewell');
    setTimeout(() => {
      if (this.phase() === 'farewell') this.phase.set('idle');
    }, 5000);
  }

  private reset() {
    // 'farewell' has already emitted its tourEnd — don't double-count it as an interruption.
    const phase = this.phase();
    if (phase !== 'idle' && phase !== 'farewell') this.telemetry.record('tourEnd', 'interrupted');
    this.phase.set('idle');
    this.index.set(0);
    this.labelBaseline.set(null);
    this.dismissUndoHint();
  }

  private showUndoHint() {
    this.telemetry.record('tourUndoHint');
    this.undoHintShown = true;
    this.undoHintPending.set(false);
    writeFlag(UNDO_HINT_KEY);
    this.undoHintVisible.set(true);
    this.undoHintTimer = setTimeout(() => this.dismissUndoHint(), UNDO_HINT_MS);
  }

  private dismissUndoHint() {
    if (this.undoHintTimer) {
      clearTimeout(this.undoHintTimer);
      this.undoHintTimer = null;
    }
    this.undoHintVisible.set(false);
  }

  private captureLabelBaseline() {
    const component = this.form.selectedComponent();
    this.labelBaseline.set(
      component ? { instanceId: component.instanceId, json: translationsOf(component) } : null
    );
  }

  /**
   * The field chapter 2 makes conditional: the first carrying no options of its own, i.e.
   * the plain field, not the radio that triggers it. Located by position, not id, because
   * addComponent derives ids from Date.now() and same-millisecond ids collide.
   */
  private targetFieldLocation(): { section: number; component: number } | null {
    const sections = this.form.sections();
    for (let s = 0; s < sections.length; s++) {
      if (sections[s].isMetadata) continue;
      for (let c = 0; c < sections[s].components.length; c++) {
        if (!sections[s].components[c].options?.length) return { section: s, component: c };
      }
    }
    return null;
  }

  private targetField(): FormComponentInstance | null {
    const at = this.targetFieldLocation();
    return at ? this.form.sections()[at.section].components[at.component] : null;
  }

  private targetFieldSelected(): boolean {
    const at = this.targetFieldLocation();
    if (!at) return false;
    return this.form.selectedSectionIndex() === at.section
        && this.form.selectedComponentIndex() === at.component;
  }

  private hasEmptyCondition(): boolean {
    const logic = this.targetField()?.showLogic;
    return !!logic?.length && !firstRef(logic[0]);
  }

  private plainSections(): FormSection[] {
    return this.form.sections().filter(s => !s.isMetadata && !s.isAggregate);
  }

  private fields(): FormComponentInstance[] {
    return this.form.sections()
      .filter(s => !s.isMetadata)
      .flatMap(s => s.components);
  }
}

function translationsOf(component: FormComponentInstance): string {
  return JSON.stringify(component.translations ?? {});
}

function firstRef(condition: LogicCondition): string {
  return typeof condition === 'string' ? condition : condition.find(ref => !!ref) ?? '';
}

function readTourParam(): boolean {
  try {
    return new URLSearchParams(location.search).get('tour') === '1';
  } catch {
    return false;
  }
}

// localStorage can throw when site data is blocked.
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    localStorage.setItem(key, '1');
  } catch {}
}
