import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatExpansionModule } from '@angular/material/expansion';
import { CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import { FormStateService } from '../../services/form-state.service';

interface FormComponent {
  id: string;
  name: string;
  icon: string;
  description?: string;
  splitVariant?: string;
}

interface ComponentCategory {
  name: string;
  components: FormComponent[];
}

@Component({
  selector: 'app-left-sidebar',
  templateUrl: './left-sidebar.component.html',
  styleUrls: ['./left-sidebar.component.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatExpansionModule, CdkDrag, CdkDropList]
})
export class LeftSidebarComponent {
  formState = inject(FormStateService);
  search = signal('');

  categories: ComponentCategory[] = [
        {
      name: 'Display',
      components: [
        { id: 'text', name: 'Text', icon: 'short_text' }
      ]
    },
    {
      name: 'Basic Inputs',
      components: [
        { id: 'text-input', name: 'Text Input', icon: 'text_fields' },
        { id: 'email', name: 'E-mail', icon: 'mail' },
        { id: 'phone', name: 'Phone', icon: 'phone' },
        { id: 'text-area', name: 'Text Area', icon: 'notes' },
        { id: 'date', name: 'Date', icon: 'calendar_today' },
        { id: 'number', name: 'Number', icon: 'numbers' },
      ]
    },
    {
      name: 'Name & Address',
      components: [
        { id: 'split-input', name: 'First Name + Last Name', icon: 'badge', description: '', splitVariant: 'name-vorname' },
        { id: 'split-input', name: 'Street + No.', icon: 'signpost', description: '', splitVariant: 'strasse-nr' },
        { id: 'split-input', name: 'ZIP + City', icon: 'location_city', description: '', splitVariant: 'plz-ort' },
      ]
    },
    {
      name: 'Selection Inputs',
      components: [
        { id: 'radio', name: 'Radio Button', icon: 'radio_button_checked', description: 'Choose one' },
        { id: 'single-checkbox', name: 'Checkbox', icon: 'check_box_outline_blank', description: 'Single boolean (e.g. "I agree")' },
        { id: 'checkbox', name: 'Checkbox Group', icon: 'check_box', description: 'Choose multiple' },
        { id: 'select-single', name: 'Dropdown', icon: 'arrow_drop_down_circle', description: 'Select one' },
        { id: 'select-multi', name: 'Multi-Selection', icon: 'playlist_add_check', description: 'Select multiple' },
        { id: 'korrespondenzsprache', name: 'Correspondence Language', icon: 'translate', description: 'pre-filled DE/FR/IT/EN' },
        { id: 'electronic-consent', name: 'Electronic Consent', icon: 'gavel', description: 'Yes/No consent radio' },
        { id: 'catalog-countries', name: 'Country List', icon: 'public', description: 'Multi-select prefilled with countries' },
        { id: 'catalog-cantons', name: 'Canton List', icon: 'map', description: 'Multi-select prefilled with Swiss cantons' },
      ]
    },
    {
      name: 'File Upload',
      components: [
        { id: 'upload-single', name: 'File Upload', icon: 'upload_file', description: 'Single file' },
        { id: 'upload-multi', name: 'Multi-File Upload', icon: 'cloud_upload', description: 'Multiple files' },
      ]
    },
    {
      name: 'Actions',
      components: [
        { id: 'button', name: 'Button', icon: 'smart_button', description: 'Form action button' },
      ]
    }

  ];

  filteredCategories = computed(() => {
    const query = this.search().trim().toLowerCase();
    if (!query) {
      return this.categories;
    }
    return this.categories
      .map(cat => ({
        ...cat,
        components: cat.components.filter(c => c.name.toLowerCase().includes(query))
      }))
      .filter(cat => cat.components.length > 0);
  });

  sectionDropIds = computed(() =>
    this.formState.sections().map((_, i) => `canvasList_${i}`)
  );
}
