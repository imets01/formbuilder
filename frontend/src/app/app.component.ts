import { Component, HostListener, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { TopNavBarComponent } from './components/top-nav-bar/top-nav-bar.component';
import { LeftSidebarComponent } from './components/left-sidebar/left-sidebar.component';
import { RightSidebarComponent } from './components/right-sidebar/right-sidebar.component';
import { CanvasComponent } from './components/canvas/canvas.component';
import { LandingPageComponent } from './components/landing-page/landing-page.component';
import { TourComponent } from './components/tour/tour.component';
import { FormStateService, isMetadataComponentId } from './services/form-state.service';
import { TelemetryService } from './services/telemetry.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    TopNavBarComponent,
    LeftSidebarComponent,
    RightSidebarComponent,
    CanvasComponent,
    LandingPageComponent,
    TourComponent
  ]
})
export class AppComponent {
  formState = inject(FormStateService);
  telemetry = inject(TelemetryService);
  title = 'frontend';

  // --- Resizable right sidebar -------------------------------------------------
  // Wide catalogs (e.g. a country list in "Katalog mehrfach") are unreadable at the
  // default width, so the properties panel can be dragged wider and remembers it.

  private static readonly WIDTH_KEY = 'formbuilder.rightSidebarWidth';
  /** Room the left sidebar (288px) + a usable canvas need to keep. */
  private static readonly RESERVED_WIDTH = 640;
  readonly minSidebarWidth = 320;
  readonly defaultSidebarWidth = 384;

  rightSidebarWidth = signal<number>(this.loadSidebarWidth());
  resizingSidebar = signal<boolean>(false);

  maxSidebarWidth(): number {
    return Math.max(this.minSidebarWidth, window.innerWidth - AppComponent.RESERVED_WIDTH);
  }

  onSidebarResizeStart(event: PointerEvent) {
    event.preventDefault();
    this.resizingSidebar.set(true);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  onSidebarResizeMove(event: PointerEvent) {
    if (!this.resizingSidebar()) return;
    this.setSidebarWidth(window.innerWidth - event.clientX);
  }

  onSidebarResizeEnd(event: PointerEvent) {
    if (!this.resizingSidebar()) return;
    this.resizingSidebar.set(false);
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    this.persistSidebarWidth();
  }

  onSidebarResizeKeydown(event: KeyboardEvent) {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') this.setSidebarWidth(this.rightSidebarWidth() + step);
    else if (event.key === 'ArrowRight') this.setSidebarWidth(this.rightSidebarWidth() - step);
    else if (event.key === 'Home') this.setSidebarWidth(this.defaultSidebarWidth);
    else return;
    event.preventDefault();
    this.persistSidebarWidth();
  }

  resetSidebarWidth() {
    this.setSidebarWidth(this.defaultSidebarWidth);
    this.persistSidebarWidth();
  }

  /** Keep the panel inside the viewport when the window shrinks. */
  @HostListener('window:resize')
  onWindowResize() {
    this.setSidebarWidth(this.rightSidebarWidth());
  }

  private setSidebarWidth(width: number) {
    const clamped = Math.round(Math.min(this.maxSidebarWidth(), Math.max(this.minSidebarWidth, width)));
    this.rightSidebarWidth.set(clamped);
  }

  private loadSidebarWidth(): number {
    // localStorage can throw when site data is blocked — never let that break startup.
    let stored = NaN;
    try {
      stored = Number(localStorage.getItem(AppComponent.WIDTH_KEY));
    } catch {}
    if (!Number.isFinite(stored) || stored <= 0) return this.defaultSidebarWidth;
    return Math.min(this.maxSidebarWidth(), Math.max(this.minSidebarWidth, Math.round(stored)));
  }

  private persistSidebarWidth() {
    try {
      localStorage.setItem(AppComponent.WIDTH_KEY, String(this.rightSidebarWidth()));
    } catch {}
  }

  /**
   * Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo,
   * Del/Backspace = remove the selected field.
   */
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent) {
    if (this.formState.view() !== 'editor') return;
    if (this.isEditableTarget(event.target)) return;

    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;

      const redo = key === 'y' || (key === 'z' && event.shiftKey);
      event.preventDefault();
      if (redo) this.formState.redo();
      else this.formState.undo();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!this.canDeleteSelection(event.target)) return;
      event.preventDefault();
      this.formState.removeComponent(
        this.formState.selectedSectionIndex()!,
        this.formState.selectedComponentIndex()!
      );
    }
  }

  private canDeleteSelection(target: EventTarget | null): boolean {
    if (this.formState.selectedComponentIndex() === null) return false;
    const component = this.formState.selectedComponent();
    if (!component || isMetadataComponentId(component.id)) return false;

    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== 'function') return true;
    return !el.closest('app-right-sidebar, app-left-sidebar, app-top-nav-bar, .cdk-overlay-container');
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
}
