import {
  Component, ElementRef, HostListener, NgZone, OnDestroy, effect, inject, viewChild
} from '@angular/core';
import { TourService, TourPlacement } from '../../services/tour.service';

/** Beacon diameter, in px — keep in sync with .tour-beacon. */
const BEACON = 10;
const GAP = 14;
const EDGE = 8;
const PULSE_CYCLE_MS = 14000;

/** Renders the walkthrough's beacon, ring and prompt over the editor. */
@Component({
  selector: 'app-tour',
  templateUrl: './tour.component.html',
  styleUrls: ['./tour.component.scss'],
  standalone: true,
})
export class TourComponent implements OnDestroy {
  tour = inject(TourService);
  private zone = inject(NgZone);
  private host = inject(ElementRef<HTMLElement>);

  private ringEl = viewChild<ElementRef<HTMLElement>>('ring');
  private beaconEl = viewChild<ElementRef<HTMLElement>>('beacon');
  private cardEl = viewChild<ElementRef<HTMLElement>>('card');

  // Plain fields, not signals: the loop reads them off the reactive path.
  private selectors: string[] = [];
  private stepId: string | null = null;
  /** At most one auto-scroll per step, so we never fight a user who scrolled away. */
  private scrolledForStep: string | null = null;
  private placement: TourPlacement = 'right';
  private anchored = false;
  private dirty = true;
  private lastRect = { top: 0, left: 0, width: 0, height: 0 };
  private raf = 0;
  private pulseTimer: any = null;

  constructor() {
    effect(() => {
      const step = this.tour.step();
      const anchor = step ? step.anchor() : null;
      this.selectors = anchor === null ? [] : Array.isArray(anchor) ? anchor : [anchor];
      this.stepId = step?.id ?? null;
      this.placement = step?.placement() ?? 'right';
      // Read the copy: re-wording mid-step changes the prompt's width, and the anchor
      // rect alone wouldn't tell the loop to re-measure.
      step?.copy();
      this.dirty = true;
      if (step) this.startLoop();
      else this.stopLoop();
    });

    effect(() => {
      const id = this.tour.step()?.id;
      this.clearPulse();
      if (id) {
        this.zone.runOutsideAngular(() => {
          this.pulseTimer = setInterval(() => this.restartPulse(), PULSE_CYCLE_MS);
        });
      }
    });
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    // Esc belongs to an open menu or dialog first.
    if (document.querySelector('.cdk-overlay-container .cdk-overlay-pane')) return;
    this.tour.dismiss();
  }

  ngOnDestroy() {
    this.stopLoop();
    this.clearPulse();
  }

  private startLoop() {
    if (this.raf) return;
    this.zone.runOutsideAngular(() => {
      const tick = () => {
        this.position();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  private stopLoop() {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.setAnchored(false);
  }

  private position() {
    const ringRef = this.ringEl();
    const beaconRef = this.beaconEl();
    const cardRef = this.cardEl();
    if (!ringRef || !beaconRef || !cardRef) {
      this.setAnchored(false);
      return;
    }

    const target = this.resolveAnchor();

    if (!target) {
      this.setAnchored(false);
      this.dirty = true;
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      // Off-screen: bring it into view once, then let the next frame place the beacon.
      this.scrollAnchorIntoView(target);
      this.setAnchored(false);
      this.dirty = true;
      return;
    }

    // Nothing moved — skip the style writes so the loop stays nearly free.
    if (!this.dirty && this.sameRect(rect)) {
      this.setAnchored(true);
      return;
    }

    const card = cardRef.nativeElement;
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    if (cardWidth === 0 || cardHeight === 0) {
      this.dirty = true;
      return;
    }

    const r = rect;
    this.lastRect = { top: r.top, left: r.left, width: r.width, height: r.height };
    this.dirty = false;

    const ring = ringRef.nativeElement;
    ring.style.width = `${r.width + 6}px`;
    ring.style.height = `${r.height + 6}px`;
    ring.style.transform = `translate(${r.left - 3}px, ${r.top - 3}px)`;

    let beaconX: number;
    let beaconY: number;
    switch (this.placement) {
      case 'left':
        beaconX = r.left;
        beaconY = r.top + r.height / 2;
        break;
      case 'bottom':
        beaconX = r.left + r.width / 2;
        beaconY = r.bottom;
        break;
      default:
        beaconX = r.right;
        beaconY = r.top + r.height / 2;
    }
    beaconRef.nativeElement.style.transform =
      `translate(${beaconX - BEACON / 2}px, ${beaconY - BEACON / 2}px)`;

    let cardX: number;
    let cardY: number;
    switch (this.placement) {
      case 'left':
        cardX = beaconX - GAP - cardWidth;
        cardY = beaconY - cardHeight / 2;
        break;
      case 'bottom':
        cardX = beaconX - cardWidth / 2;
        cardY = beaconY + GAP;
        break;
      default:
        cardX = beaconX + GAP;
        cardY = beaconY - cardHeight / 2;
    }
    card.style.transform = `translate(${
      clamp(cardX, EDGE, window.innerWidth - cardWidth - EDGE)
    }px, ${
      clamp(cardY, EDGE, window.innerHeight - cardHeight - EDGE)
    }px)`;

    this.setAnchored(true);
  }

  /** First candidate actually rendered — lets a step fall back to the tab that opens it. */
  private resolveAnchor(): HTMLElement | null {
    for (const selector of this.selectors) {
      const el = document.querySelector<HTMLElement>(selector);
      if (el && el.getClientRects().length > 0) return el;
    }
    return null;
  }

  private scrollAnchorIntoView(el: HTMLElement) {
    if (this.scrolledForStep === this.stepId) return;
    this.scrolledForStep = this.stepId;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  private sameRect(rect: DOMRect): boolean {
    const l = this.lastRect;
    return rect.top === l.top && rect.left === l.left
        && rect.width === l.width && rect.height === l.height;
  }

  private setAnchored(value: boolean) {
    if (value === this.anchored) return;
    this.anchored = value;
    this.host.nativeElement.classList.toggle('is-anchored', value);
    if (value) this.restartPulse();
  }

  /** Three pulses, then a static dot — attenuating is what keeps it from nagging. */
  private restartPulse() {
    const beacon = this.beaconEl()?.nativeElement;
    if (!beacon) return;
    beacon.classList.remove('pulse-on');
    void beacon.offsetWidth;  // reflow, so the animation restarts rather than continues
    beacon.classList.add('pulse-on');
  }

  private clearPulse() {
    if (!this.pulseTimer) return;
    clearInterval(this.pulseTimer);
    this.pulseTimer = null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
