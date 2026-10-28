import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { FormStateService } from '../../services/form-state.service';
import { DEFAULT_FORM_TITLE } from '../../services/form-title';
import { ImportIssuesComponent } from '../import-issues/import-issues.component';
import { DeveloperDialogComponent } from '../developer-dialog/developer-dialog.component';

@Component({
  selector: 'app-top-nav-bar',
  templateUrl: './top-nav-bar.component.html',
  styleUrls: ['./top-nav-bar.component.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatMenuModule, MatSlideToggleModule,
            ImportIssuesComponent, DeveloperDialogComponent]
})
export class TopNavBarComponent {
  formState = inject(FormStateService);

  /** What the title field shows. Tracks the form's name, but holds a duplicate the user is
   *  still typing — that one is never committed, so autosave keeps the last accepted name
   *  and the canvas edits around it still persist. */
  titleDraft = linkedSignal(() => this.formState.formTitle());

  titleError = computed<string | null>(() => {
    const draft = this.titleDraft();
    if (draft === this.formState.formTitle()) return null;  // committed, so it was free
    return this.formState.isTitleTaken(draft)
      ? `Another form is already called "${draft.trim() || DEFAULT_FORM_TITLE}".`
      : null;
  });

  /** The duplicate being typed, or the rename the server refused — whichever applies. */
  titleMessage = computed<string | null>(() => {
    const error = this.titleError();
    if (error) return error;
    const refused = this.formState.titleConflict();
    return refused ? `"${refused}" was taken by another form, so the previous name was kept.` : null;
  });

  onTitleInput(value: string) {
    this.titleDraft.set(value);
    if (!this.formState.isTitleTaken(value)) this.formState.formTitle.set(value);
  }

  /** Leaving the field on a duplicate discards it rather than leaving a name that never saves. */
  onTitleBlur() {
    if (this.titleError()) this.titleDraft.set(this.formState.formTitle());
  }

  goToLanding() {
    this.formState.goToLanding();
  }

  // It was a dropdown that had grown into a form with required fields; as a dialog it
  // gets the room to say what each setting does.
  developerOpen = signal<boolean>(false);

  async preview() {
    // Open the tab synchronously (inside the click) so the popup blocker allows it.
    const win = window.open('', '_blank');
    win?.document.write(
      '<p style="font-family: sans-serif; padding: 2rem; color: #555;">Generating preview…</p>'
    );
    try {
      const language = this.formState.displayLanguage().toLowerCase();
      const url = await this.formState.generatePreviewFromBackend(language);
      if (win) {
        win.location.href = url;
      }
    } catch (error) {
      win?.close();
      const message = error instanceof Error ? error.message : String(error);
      alert(`Failed to generate preview.\n\n${message}\n\nIs the Python server running?`);
    }
  }
}
