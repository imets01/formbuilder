import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { CdkDragDrop, CdkDrag, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { FormStateService, FormComponentInstance, FormSection, SPLIT_LABELS, SplitVariant, ComponentOption, isMetadataComponentId, metadataLabelFor, ID_RANGE_SEPARATOR } from '../../services/form-state.service';

interface ConsentText { intro: string; label: string; yes: string; no: string; }

/**
 * Static illustration of the electronic-delivery consent for the canvas. The real
 * form renders this via a platform-side macro (which supplies the
 * legal text + Yes/No itself), so this is display-only and not user-editable.
 */
const CONSENT_TEXT: Record<string, ConsentText> = {
  DE: {
    intro: 'Gemäss Artikel 11 Absatz 2 des Bundesgesetzes über das Verwaltungsverfahren in Verbindung mit Artikel 8 der Verordnung über die elektronische Übermittlung im Rahmen von Verwaltungsverfahren kann die Behörde einer Partei eine Verfügung auf elektronischem Weg eröffnen, sofern die Partei dieser Form der Eröffnung im konkreten Verfahren zugestimmt hat. Die Zustimmung kann jederzeit widerrufen werden.',
    label: 'Eröffnung aller Verfügungen im Zusammenhang mit diesem Verfahren auf elektronischem Weg',
    yes: 'Ja, ich bin einverstanden',
    no: 'Nein, ich bin nicht einverstanden (Weiterführung in Papierform)',
  },
  FR: {
    intro: "Conformément à l'article 11 alinéa 2 de la loi fédérale sur la procédure administrative en relation avec l'article 8 de l'ordonnance sur la communication électronique dans le cadre de procédures administratives, l'autorité peut notifier une décision à une partie par voie électronique, pour autant que la partie ait consenti à ce mode de notification dans la procédure concernée. Le consentement peut être révoqué en tout temps.",
    label: 'Notification de toutes les décisions en relation avec cette procédure par voie électronique',
    yes: "Oui, j'accepte",
    no: 'Non, je refuse (poursuite sous forme papier)',
  },
  IT: {
    intro: "Ai sensi dell'articolo 11 capoverso 2 della legge federale sulla procedura amministrativa in combinato disposto con l'articolo 8 dell'ordinanza sulla comunicazione per via elettronica nell'ambito di procedimenti amministrativi, l'autorità può notificare una decisione a una parte per via elettronica, sempre che la parte abbia acconsentito a questa forma di notificazione nel procedimento specifico. Il consenso può essere revocato in qualsiasi momento.",
    label: 'Notificazione di tutte le decisioni relative a questo procedimento per via elettronica',
    yes: 'Sì, acconsento',
    no: 'No, non acconsento (proseguimento in forma cartacea)',
  },
  EN: {
    intro: 'According to Article 11 paragraph 2 of the Federal Act on Administrative Procedure in conjunction with Article 8 of the Ordinance on the Electronic Transmission of Information in Administrative Proceedings, the authority may issue a decision to a party by electronic means, provided that the party has consented to this form of notification in the specific proceedings. Consent can be withdrawn at any time.',
    label: 'Notification of all decisions in connection with these proceedings by electronic means',
    yes: 'Yes, I agree',
    no: 'No, I disagree (continue in paper form)',
  },
};

@Component({
  selector: 'app-canvas',
  templateUrl: './canvas.component.html',
  styleUrls: ['./canvas.component.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, CdkDrag, CdkDragHandle, CdkDropList]
})
export class CanvasComponent {
  formState = inject(FormStateService);
  componentListIds = computed(() => this.formState.sections().map((_, i) => `canvasList_${i}`));

  private isSectionDrag(drag: CdkDrag): boolean {
    return Array.isArray(drag.data?.components);
  }

  acceptsSection = (drag: CdkDrag) => this.isSectionDrag(drag);
  acceptsComponent = (drag: CdkDrag) => !this.isSectionDrag(drag);

  dropSection(event: CdkDragDrop<FormSection[]>) {
    this.formState.moveSection(event.previousIndex, event.currentIndex);
  }

  drop(event: CdkDragDrop<any>) {
    const targetSection = event.container.data?.sectionIndex;
    if (typeof targetSection !== 'number') {
      return;
    }

    if (event.previousContainer === event.container) {
      this.formState.moveComponent(targetSection, event.previousIndex, targetSection, event.currentIndex);
      return;
    }

    const sourceData = event.previousContainer.data;
    if (sourceData && typeof sourceData.sectionIndex === 'number') {
      this.formState.moveComponent(sourceData.sectionIndex, event.previousIndex, targetSection, event.currentIndex);
      return;
    }

    this.formState.addComponent(event.item.data, targetSection, event.currentIndex);
  }

  dropZoneClass(section: FormSection): string {
    if (section.isMetadata) {
      return section.components.length > 0 ? 'space-y-0.5 pb-2' : 'space-y-0.5';
    }
    const stretched = 'space-y-2 -mx-4 px-4 -mb-4 pb-6';
    return section.isAggregate ? stretched : `${stretched} -mt-5 pt-5`;
  }

  selectComponent(sectionIndex: number, componentIndex: number) {
    this.formState.selectComponent(sectionIndex, componentIndex);
  }

  idChips(component: FormComponentInstance): string[] {
    const label = this.formState.displayIdFor(component.instanceId);
    return label ? label.split(ID_RANGE_SEPARATOR) : [];
  }

  /** Hover text for the field badge: the E-label plus the Input ID the generator uses. */
  idTooltip(component: FormComponentInstance): string {
    const label = this.formState.displayIdFor(component.instanceId);
    if (!label) return '';
    const raw = this.formState.inputIdFor(component.instanceId);
    return raw === null ? `Field ${label}` : `Field ${label} — Input ID ${raw} in the generated form`;
  }

  removeComponent(sectionIndex: number, componentIndex: number) {
    this.formState.removeComponent(sectionIndex, componentIndex);
  }

  isSelected(sectionIndex: number, componentIndex: number): boolean {
    return (
      this.formState.selectedSectionIndex() === sectionIndex &&
      this.formState.selectedComponentIndex() === componentIndex
    );
  }

  /** Click anywhere on a (non-metadata) section header bar to select the section. */
  selectSectionFromHeader(sectionIndex: number, section: FormSection) {
    if (section.isMetadata) return;
    this.formState.selectSection(sectionIndex);
  }

  /** Aggregate identity fields, as shown in the canvas summary strip (edited in the sidebar). */
  aggregateSummary(section: FormSection): { label: string; value: string; required: boolean }[] {
    return [
      { label: 'RefID', value: section.aggregateRefID ?? '', required: false },
      { label: 'Fachdatenbez.', value: section.aggregateFachdatenbezeichner ?? '', required: false },
      { label: 'CompID', value: section.aggregateCompId ?? '', required: true },
    ];
  }

  /** Select the aggregate section and open the sidebar panel holding its IDs + groups. */
  openAggregateSettings(sectionIndex: number) {
    this.formState.selectSection(sectionIndex, 'data');
  }

  isSectionSelected(sectionIndex: number): boolean {
    return (
      this.formState.selectedSectionIndex() === sectionIndex &&
      this.formState.selectedComponentIndex() === null
    );
  }

  sectionBorderClass(section: FormSection, sectionIndex: number): string {
    if (this.isSectionSelected(sectionIndex)) return 'border-blue-500 ring-1 ring-blue-200';
    if (section.isMetadata) return 'border-blue-200';
    if (section.isAggregate) return 'border-amber-200';
    if (this.isConditionalSection(section)) return 'border-violet-300';
    return 'border-gray-200';
  }

  getSectionHeading(section: FormSection): string {
    const lang = this.formState.displayLanguage();
    return section.translations?.title?.[lang] ?? section.title ?? '';
  }

  /** Delete a section, confirming first when it still contains elements (undo can also recover it). */
  removeSection(sectionIndex: number) {
    const section = this.formState.sections()[sectionIndex];
    const count = section?.components.length ?? 0;
    if (count > 0) {
      const name = this.getSectionHeading(section) || 'this section';
      const what = count === 1 ? '1 element' : `${count} elements`;
      if (!confirm(`Delete "${name}" and its ${what}?\n\nYou can undo this with Ctrl+Z.`)) return;
    }
    this.formState.removeSection(sectionIndex);
  }

  /** A section whose whole block is gated by show/hide logic or hidden by default (rendered with a dashed card). */
  isConditionalSection(section: FormSection): boolean {
    return !!(section.showLogic?.length || section.hideLogic?.length || section.hiddenField);
  }

  getDisplayValue(component: FormComponentInstance, field: 'title' | 'placeholder' | 'content'): string {
    const language = this.formState.displayLanguage();
    const translatedValue = component.translations?.[field]?.[language];
    return translatedValue ?? (component as any)[field] ?? '';
  }

  getSplitLabel(component: FormComponentInstance, side: 'a' | 'b'): string {
    const variant = (component.splitVariant ?? 'name-vorname') as SplitVariant;
    const lang = this.formState.displayLanguage();
    return component.splitConfig?.[side]?.titles?.[lang]
      ?? SPLIT_LABELS[variant][side][lang]
      ?? SPLIT_LABELS[variant][side]['DE'];
  }

  getSplitPlaceholder(component: FormComponentInstance, side: 'a' | 'b'): string {
    return component.splitConfig?.[side]?.placeholders?.[this.formState.displayLanguage()] ?? '';
  }

  /**
   * Column widths for a split input, mirroring the real form's proportions:
   * name+vorname roughly equal, street very wide + number narrow, ZIP narrow +
   * city wide. Returned as an inline grid-template-columns value so arbitrary
   * ratios don't depend on Tailwind's class scanning.
   */
  splitGridTemplate(component: FormComponentInstance): string {
    const variant = (component.splitVariant ?? 'name-vorname') as SplitVariant;
    switch (variant) {
      case 'strasse-nr': return '4fr 1fr';
      case 'plz-ort':    return '1fr 2fr';
      default:           return '1fr 1fr';
    }
  }

  getMouseOverTooltip(component: FormComponentInstance): string {
    if (this.formState.disableMouseOver()) return '';
    const lang = this.formState.displayLanguage();
    const langValue = lang === 'DE' ? component.mouseOverDe
                    : lang === 'FR' ? component.mouseOverFr
                    : lang === 'IT' ? component.mouseOverIt
                    : '';
    const custom = langValue || component.mouseOverDe || component.mouseOverFr || component.mouseOverIt || '';
    if (custom) return custom;
    if (component.disableMouseOver) return '';
    const title = this.getDisplayValue(component, 'title');
    if (this.formState.disableInputSize() || !component.maxLength) return title;
    return `${title} (max. length: ${component.maxLength})`;
  }

  isMetadataComponent(id: string | undefined): boolean {
    return isMetadataComponentId(id);
  }

  metadataLabel(id: string | undefined): string {
    return metadataLabelFor(id) ?? 'Metadata';
  }

  metadataDisplayValue(component: FormComponentInstance): string {
    const lang = this.formState.displayLanguage();
    return component.translations?.title?.[lang]
        || component.translations?.title?.['DE']
        || component.translations?.title?.['EN']
        || '';
  }

  addMetadataSection() {
    this.formState.addMetadataSection();
  }

  /** Static consent text for the current display language (display-only on the canvas). */
  consentText(): ConsentText {
    return CONSENT_TEXT[this.formState.displayLanguage()] ?? CONSENT_TEXT['EN'];
  }

  getOptionLabel(opt: ComponentOption): string {
    const lang = this.formState.displayLanguage();
    return opt.translations[lang] || opt.translations['DE'] || opt.translations['EN'] || '(empty option)';
  }

  private multiSelectState = signal<Map<string, Set<string>>>(new Map());

  private getSelectedSet(instanceId: string): Set<string> {
    return this.multiSelectState().get(instanceId) ?? new Set();
  }

  availableOptions(component: FormComponentInstance): ComponentOption[] {
    const set = this.getSelectedSet(component.instanceId);
    return this.orderOptions(component, (component.options ?? []).filter(o => !set.has(o.optionId)));
  }

  selectedMultiOptions(component: FormComponentInstance): ComponentOption[] {
    const set = this.getSelectedSet(component.instanceId);
    return this.orderOptions(component, (component.options ?? []).filter(o => set.has(o.optionId)));
  }

  private orderOptions(component: FormComponentInstance, options: ComponentOption[]): ComponentOption[] {
    if (component.id !== 'catalog-countries' && component.id !== 'catalog-cantons') return options;
    const lang = this.formState.displayLanguage();
    return [...options].sort((a, b) => this.getOptionLabel(a).localeCompare(this.getOptionLabel(b), lang.toLowerCase()));
  }

  moveOptionsRight(component: FormComponentInstance, leftBox: HTMLSelectElement) {
    const ids = Array.from(leftBox.selectedOptions).map(o => o.value);
    if (ids.length === 0) return;
    const map = new Map(this.multiSelectState());
    const set = new Set(map.get(component.instanceId) ?? []);
    ids.forEach(id => set.add(id));
    map.set(component.instanceId, set);
    this.multiSelectState.set(map);
  }

  moveOptionsLeft(component: FormComponentInstance, rightBox: HTMLSelectElement) {
    const ids = Array.from(rightBox.selectedOptions).map(o => o.value);
    if (ids.length === 0) return;
    const map = new Map(this.multiSelectState());
    const set = new Set(map.get(component.instanceId) ?? []);
    ids.forEach(id => set.delete(id));
    map.set(component.instanceId, set);
    this.multiSelectState.set(map);
  }

  getSplitMouseOverTooltip(component: FormComponentInstance, side: 'a' | 'b'): string {
    if (this.formState.disableMouseOver()) return '';
    const sub = component.splitConfig?.[side];
    const lang = this.formState.displayLanguage();
    const langValue = lang === 'DE' ? sub?.mouseOverDe
                    : lang === 'FR' ? sub?.mouseOverFr
                    : lang === 'IT' ? sub?.mouseOverIt
                    : '';
    const custom = langValue || sub?.mouseOverDe || sub?.mouseOverFr || sub?.mouseOverIt || '';
    if (custom) return custom;
    if (component.disableMouseOver) return '';
    const label = this.getSplitLabel(component, side);
    return this.formState.disableInputSize() ? label : `${label} (max. length: 100)`;
  }

  fontClass(size: FormComponentInstance['fontSize'] | undefined): string {
    // Backend renders Header (lg/xl/2xl) as a single style and Infotext (sm/base) as a single style.
    switch (size) {
      case 'lg':
      case 'xl':
      case '2xl':
        return 'text-xl font-semibold';
      default:
        return 'text-base';
    }
  }
}
