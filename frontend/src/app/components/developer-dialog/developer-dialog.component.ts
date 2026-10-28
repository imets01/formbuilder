import { Component, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { FormStateService } from '../../services/form-state.service';

/**
 * The deployment settings of a form: how it is named and registered downstream.
 */
@Component({
  selector: 'app-developer-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule],
  templateUrl: './developer-dialog.component.html',
})
export class DeveloperDialogComponent {
  formState = inject(FormStateService);

  open = input<boolean>(false);
  closed = output<void>();

  close() {
    this.closed.emit();
  }
}
