import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FormStateService, FormComponentInstance, FormSection, SplitVariant, SplitConfig, SPLIT_LABELS, isMetadataComponentId, metadataLabelFor, LogicCondition, SectionTab, usesNativeLanguagePicker } from '../../services/form-state.service';
import { DictionaryService } from '../../services/dictionary.service';
import { parsePaste, distributePaste, LANGUAGE_ALIASES, DATA_FIELD_ALIASES } from '../../services/paste-fill';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDividerModule } from '@angular/material/divider';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';

type EditField = 'title' | 'placeholder' | 'content' | 'mouseOver';
type SplitEditField = 'title' | 'placeholder' | 'mouseOver';
type SplitDataField = 'fieldName' | 'refID';
type TranslatableField = 'title' | 'placeholder' | 'content';

interface AutofillHint {
  instanceId: string;
  editField: TranslatableField;
  filled: string[];
  prevTranslations: FormComponentInstance['translations'];
  prevBase: any;
}

/** Undo state for a clipboard block that was split across the language fields of one group. */
interface PasteHint {
  key: string;
  filled: string[];
  previous: Record<string, string>;
  restore: (field: string, value: string) => void;
}

/** The identifier trio, in PSPH workbook column order. */
const DATA_FIELDS = ['fieldName', 'refID', 'compId'];
const DATA_FIELD_LABELS: Record<string, string> = {
  fieldName: 'Field Name',
  refID: 'Ref ID',
  compId: 'Complimentary ID'
};

interface SectionAutofillHint {
  sectionId: string;
  filled: string[];
  prevTranslations: FormSection['translations'];
  prevTitle: string;
}

@Component({
  selector: 'app-right-sidebar',
  templateUrl: './right-sidebar.component.html',
  styleUrls: ['./right-sidebar.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatTabsModule,
    MatDividerModule,
    MatSlideToggleModule,
    MatExpansionModule,
    MatIconModule
  ]
})
export class RightSidebarComponent {
  formState = inject(FormStateService);
  private dictionary = inject(DictionaryService);
  languages = ['DE', 'FR', 'IT', 'EN'];

  /** Shows the "filled from dictionary" hint + Undo after a successful auto-fill. */
  autofillHint = signal<AutofillHint | null>(null);
  /** Same, for the section-heading panel. */
  sectionAutofillHint = signal<SectionAutofillHint | null>(null);
  /** Shows the "filled from paste" hint + Undo after a multi-language paste. */
  pasteHint = signal<PasteHint | null>(null);

  /** Value of a translation field when focus entered it — lets us tell a seeded default apart from a real edit. */
  private editStartValue: { language: string; value: string } | null = null;

  fontSizeOptions = [
    { value: 'base', label: 'Normal' },
    { value: 'xl', label: 'Header' }
  ];

  collapsedOptions = signal<Set<string>>(new Set());

  isOptionCollapsed(optionId: string): boolean {
    return this.collapsedOptions().has(optionId);
  }

  toggleOptionCollapsed(optionId: string) {
    const next = new Set(this.collapsedOptions());
    if (next.has(optionId)) {
      next.delete(optionId);
    } else {
      next.add(optionId);
    }
    this.collapsedOptions.set(next);
  }

  allOptionsCollapsed(component: FormComponentInstance | null): boolean {
    const options = component?.options ?? [];
    return options.length > 0 && options.every(o => this.collapsedOptions().has(o.optionId));
  }

  toggleAllOptionsCollapsed(component: FormComponentInstance | null) {
    const options = component?.options ?? [];
    if (!options.length) return;
    const next = new Set(this.collapsedOptions());
    // collapsedOptions is shared across components, so only this component's ids move.
    const collapse = !this.allOptionsCollapsed(component);
    for (const opt of options) {
      if (collapse) next.add(opt.optionId); else next.delete(opt.optionId);
    }
    this.collapsedOptions.set(next);
  }

  isOptionComplete(opt: { translations: Record<string, string> }): boolean {
    return ['DE', 'FR', 'IT', 'EN'].every(l => (opt.translations[l] || '').trim().length > 0);
  }

  optionPreviewLabel(opt: { translations: Record<string, string> }): string {
    const lang = this.formState.displayLanguage();
    return opt.translations[lang] || opt.translations['DE'] || opt.translations['EN'] || '(empty)';
  }

  splitEditOptions: { value: SplitEditField; label: string }[] = [
    { value: 'title', label: 'Field Label' },
    { value: 'placeholder', label: 'Placeholder' },
    { value: 'mouseOver', label: 'Mouseover' }
  ];

  splitEditFieldA = signal<SplitEditField>('title');
  splitEditFieldB = signal<SplitEditField>('title');

  isSplitInput(componentId: string | undefined): boolean {
    return componentId === 'split-input';
  }

  isMetadata(componentId: string | undefined): boolean {
    return isMetadataComponentId(componentId);
  }

  metadataLabel(componentId: string | undefined): string {
    return metadataLabelFor(componentId) ?? 'Metadata';
  }

  setSplitEditField(side: 'a' | 'b', field: SplitEditField) {
    if (side === 'a') this.splitEditFieldA.set(field);
    else this.splitEditFieldB.set(field);
  }

  getSplitEditField(side: 'a' | 'b'): SplitEditField {
    return side === 'a' ? this.splitEditFieldA() : this.splitEditFieldB();
  }

  getSplitTranslation(side: 'a' | 'b', language: string): string {
    const component = this.formState.selectedComponent();
    if (!component) return '';
    const field = this.getSplitEditField(side);
    if (field === 'title') {
      const variant = component.splitVariant ?? 'name-vorname';
      return component.splitConfig?.[side]?.titles?.[language]
        ?? SPLIT_LABELS[variant][side][language] ?? '';
    }
    const sub = component.splitConfig?.[side];
    if (!sub) return '';
    if (field === 'placeholder') return sub.placeholders?.[language] ?? '';
    if (language === 'DE') return sub.mouseOverDe ?? '';
    if (language === 'FR') return sub.mouseOverFr ?? '';
    if (language === 'IT') return sub.mouseOverIt ?? '';
    return '';
  }

  updateSplitTranslation(side: 'a' | 'b', language: string, value: string) {
    this.pasteHint.set(null);
    const component = this.formState.selectedComponent();
    if (!component?.splitConfig) return;
    const field = this.getSplitEditField(side);
    let updatedSub = { ...component.splitConfig[side] };
    if (field === 'title') {
      const variant = component.splitVariant ?? 'name-vorname';
      const existing = updatedSub.titles ?? { ...SPLIT_LABELS[variant][side] };
      updatedSub.titles = { ...existing, [language]: value };
    } else if (field === 'placeholder') {
      updatedSub.placeholders = { ...updatedSub.placeholders, [language]: value };
    } else {
      const target = language === 'DE' ? 'mouseOverDe' : language === 'FR' ? 'mouseOverFr' : language === 'IT' ? 'mouseOverIt' : null;
      if (!target) return;
      (updatedSub as any)[target] = value;
    }
    const newConfig: SplitConfig = { ...component.splitConfig, [side]: updatedSub };
    this.updateProperty('splitConfig', newConfig);
  }

  isTextBlock(componentId: string | undefined): boolean {
    return componentId === 'text';
  }

  isLengthBased(componentId: string | undefined): boolean {
    return componentId === 'text-input' || componentId === 'text-area'
        || componentId === 'email' || componentId === 'phone';
  }

  isNumericRange(componentId: string | undefined): boolean {
    return componentId === 'number';
  }

  isDateRange(componentId: string | undefined): boolean {
    return componentId === 'date';
  }

  editFieldOptionsFor(componentId: string | undefined): { value: EditField; label: string }[] {
    if (this.isTextBlock(componentId)) {
      return [{ value: 'content', label: 'Content' }];
    }
    if (this.isMetadata(componentId)) {
      return [{ value: 'title', label: 'Translations' }];
    }
    if (this.isOptionGroup(componentId) || this.isUpload(componentId) || this.isLabelOnly(componentId)) {
      return [
        { value: 'title', label: 'Field Label' },
        { value: 'mouseOver', label: 'Mouseover' }
      ];
    }
    return [
      { value: 'title', label: 'Field Label' },
      { value: 'placeholder', label: 'Placeholder' },
      { value: 'mouseOver', label: 'Mouseover' }
    ];
  }

  isOptionGroup(componentId: string | undefined): boolean {
    return componentId === 'radio' || componentId === 'checkbox'
        || componentId === 'select-single' || componentId === 'select-multi'
        || componentId === 'korrespondenzsprache' || componentId === 'electronic-consent'
        || componentId === 'catalog-countries' || componentId === 'catalog-cantons';
  }

  /**
   * Option groups whose choices are fixed by the backend macro (<@eGovResponseSpec>).
   * Their options are display-only — editing labels/refIds in the builder has no effect
   * on the generated form, so the sidebar shows a read-only note instead of an editor.
   */
  isFixedOptionGroup(componentId: string | undefined): boolean {
    return componentId === 'electronic-consent';
  }

  isNativeLanguagePicker(component: FormComponentInstance): boolean {
    return usesNativeLanguagePicker(component);
  }

  isCatalog(componentId: string | undefined): boolean {
    return componentId === 'catalog-countries' || componentId === 'catalog-cantons';
  }

  readonly fileRestrictionOptions = [
    { value: 'none', label: 'None (project default)' },
    { value: 'allow', label: 'Allow only listed' },
    { value: 'block', label: 'Block listed' },
    { value: 'block-standard', label: 'Block standard prohibited list' },
  ];

  /** Effective restriction mode, defaulting legacy forms (extensions set, no mode) to 'allow'. */
  fileRestrictionFor(component: FormComponentInstance): string {
    return component.fileRestriction ?? (component.fileFormats ? 'allow' : 'none');
  }

  /** The extension-list field only applies to the two list-based modes. */
  showFileExtensionList(component: FormComponentInstance): boolean {
    const mode = this.fileRestrictionFor(component);
    return mode === 'allow' || mode === 'block';
  }

  /**
   * Setting a Weblink URL means the text is meant to be clickable
   */
  autoLinkTranslations() {
    const component = this.formState.selectedComponent();
    if (!component || !(component.weblink ?? '').trim()) return;
    if (this.getSelectedEditField() === 'mouseOver') return;
    for (const language of this.languages) {
      const value = this.getTranslation(language).trim();
      if (value && !/<a\b/i.test(value)) {
        this.updateTranslation(language, `<a>${value}</a>`);
      }
    }
  }

  wrapSelectionAsLink(language: string, el: HTMLInputElement | HTMLTextAreaElement) {
    const value = el.value ?? '';
    if (/<a\b/i.test(value)) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || 'link text';
    const next = value.slice(0, start) + '<a>' + selected + '</a>' + value.slice(end);
    this.updateTranslation(language, next);
  }

  /** Threshold above which we switch from cards to the compact searchable table. */
  shouldUseCompactOptionTable(component: FormComponentInstance | null): boolean {
    if (!component) return false;
    if (this.isCatalog(component.id)) return true;
    return (component.options?.length ?? 0) > 15;
  }

  // ── Compact-table state ──

  optionSearchQuery = signal<string>('');
  expandedRowId = signal<string | null>(null);

  filteredOptions(component: FormComponentInstance | null): { opt: any; originalIndex: number }[] {
    if (!component?.options) return [];
    const q = this.optionSearchQuery().trim().toLowerCase();
    const lang = this.formState.displayLanguage();
    return component.options
      .map((opt, originalIndex) => ({ opt, originalIndex }))
      .filter(({ opt }) => {
        if (!q) return true;
        const label = (opt.translations[lang] || opt.translations['DE'] || opt.translations['EN'] || '').toLowerCase();
        const fn = (opt.fieldName || '').toLowerCase();
        const ref = (opt.refID || '').toLowerCase();
        return label.includes(q) || fn.includes(q) || ref.includes(q);
      });
  }

  toggleExpandedRow(optionId: string) {
    this.expandedRowId.set(this.expandedRowId() === optionId ? null : optionId);
  }

  isRowExpanded(optionId: string): boolean {
    return this.expandedRowId() === optionId;
  }

  isUpload(componentId: string | undefined): boolean {
    return componentId === 'upload-single' || componentId === 'upload-multi';
  }

  isLabelOnly(componentId: string | undefined): boolean {
    // Components with no placeholder and no separate value input — just a label.
    return componentId === 'button' || componentId === 'single-checkbox';
  }

  // ───── Show/Hide logic picker helpers ─────

  isOrGroup(cond: LogicCondition): boolean {
    return Array.isArray(cond);
  }

  asOrGroup(cond: LogicCondition): string[] {
    return Array.isArray(cond) ? cond : [];
  }

  asSingleRef(cond: LogicCondition): string {
    return typeof cond === 'string' ? cond : '';
  }

  /**
   * Show/hide logic for the current target — the selected component, or (when only a
   * section is selected) the whole section. Used by the shared logic-editor template.
   */
  currentLogic(field: 'showLogic' | 'hideLogic'): LogicCondition[] {
    return this.getLogic(field);
  }

  private getLogic(field: 'showLogic' | 'hideLogic'): LogicCondition[] {
    const c = this.formState.selectedComponent();
    if (c) return (c[field] ?? []) as LogicCondition[];
    const s = this.formState.selectedSection();
    return (s?.[field] ?? []) as LogicCondition[];
  }

  /** A Show condition implies the target starts hidden (revealed when the condition holds). */
  hasShowLogic(): boolean {
    return this.getLogic('showLogic').length > 0;
  }

  /** Whether the current target is hidden on load — explicitly, or implied by a Show condition. */
  effectiveHidden(): boolean {
    if (this.hasShowLogic()) return true;
    const c = this.formState.selectedComponent();
    if (c) return !!c.hiddenField;
    return !!this.formState.selectedSection()?.hiddenField;
  }

  private setLogic(field: 'showLogic' | 'hideLogic', value: LogicCondition[]) {
    // Empty array → undefined so the JSON stays clean.
    this.updateProperty(field, value.length ? value : undefined);
  }

  addLogicCondition(field: 'showLogic' | 'hideLogic', kind: 'single' | 'or') {
    const next = [...this.getLogic(field)];
    next.push(kind === 'single' ? '' : []);
    this.setLogic(field, next);
  }

  removeLogicCondition(field: 'showLogic' | 'hideLogic', index: number) {
    const next = this.getLogic(field).filter((_, i) => i !== index);
    this.setLogic(field, next);
  }

  updateSingleRef(field: 'showLogic' | 'hideLogic', index: number, value: string) {
    const next = [...this.getLogic(field)];
    next[index] = value;
    this.setLogic(field, next);
  }

  addRefToOrGroup(field: 'showLogic' | 'hideLogic', index: number) {
    const next = [...this.getLogic(field)];
    const cur = next[index];
    if (Array.isArray(cur)) {
      next[index] = [...cur, ''];
      this.setLogic(field, next);
    }
  }

  updateOrGroupRef(field: 'showLogic' | 'hideLogic', condIndex: number, refIndex: number, value: string) {
    const next = [...this.getLogic(field)];
    const cur = next[condIndex];
    if (Array.isArray(cur)) {
      const updated = [...cur];
      updated[refIndex] = value;
      next[condIndex] = updated;
      this.setLogic(field, next);
    }
  }

  removeRefFromOrGroup(field: 'showLogic' | 'hideLogic', condIndex: number, refIndex: number) {
    const next = [...this.getLogic(field)];
    const cur = next[condIndex];
    if (Array.isArray(cur)) {
      const updated = cur.filter((_, i) => i !== refIndex);
      // If the OR group is now empty, drop the whole condition.
      if (updated.length === 0) {
        next.splice(condIndex, 1);
      } else {
        next[condIndex] = updated;
      }
      this.setLogic(field, next);
    }
  }

  isUploadMulti(componentId: string | undefined): boolean {
    return componentId === 'upload-multi';
  }

  // ───── Section tabs ─────

  /**
   * The tabs a section actually renders, in order — metadata sections have no Data tab and
   * aggregates have no Logic tab, so the same index means a different panel per section kind.
   * Tracking the tab by name (in shared state) keeps the panel stable across selections and
   * lets the canvas deep-link into one.
   */
  private sectionTabs(section: FormSection): SectionTab[] {
    const tabs: SectionTab[] = ['content'];
    if (!section.isMetadata) tabs.push('data');
    if (!section.isAggregate) tabs.push('logic');
    return tabs;
  }

  sectionTabIndex(section: FormSection): number {
    const index = this.sectionTabs(section).indexOf(this.formState.sectionTab());
    return index === -1 ? 0 : index;
  }

  onSectionTabChange(section: FormSection, index: number) {
    this.formState.sectionTab.set(this.sectionTabs(section)[index] ?? 'content');
  }

  // ───── Aggregate groups ─────

  addAggregateGroup() {
    const sIdx = this.formState.selectedSectionIndex();
    if (sIdx !== null) this.formState.addAggregateGroup(sIdx);
  }

  removeAggregateGroup(groupIndex: number) {
    const sIdx = this.formState.selectedSectionIndex();
    if (sIdx !== null) this.formState.removeAggregateGroup(sIdx, groupIndex);
  }

  updateAggregateGroupRefID(groupIndex: number, refID: string) {
    const sIdx = this.formState.selectedSectionIndex();
    if (sIdx !== null) this.formState.updateAggregateGroupRefID(sIdx, groupIndex, refID);
  }

  updateProperty(property: string, value: any) {
    this.pasteHint.set(null);
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    if (sIdx === null) return;
    if (cIdx !== null) {
      this.formState.updateComponentProperty(sIdx, cIdx, property as keyof FormComponentInstance, value);
    } else {
      // No component selected → the section itself is the target (logic / hidden-by-default).
      this.formState.updateSectionProperty(sIdx, property as keyof FormSection, value);
    }
  }

  updateDisplayLanguage(language: string) {
    this.formState.displayLanguage.set(language);
  }

  getSelectedEditField(): EditField {
    const component = this.formState.selectedComponent();
    if (!component) {
      return 'title';
    }
    if (this.isTextBlock(component.id)) {
      return 'content';
    }
    if (component.editField === 'placeholder' || component.editField === 'mouseOver') {
      return component.editField;
    }
    return 'title';
  }

  getTranslation(language: string): string {
    const component = this.formState.selectedComponent();
    if (!component) {
      return '';
    }
    const editField = this.getSelectedEditField();
    if (editField === 'mouseOver') {
      if (language === 'DE') return component.mouseOverDe ?? '';
      if (language === 'FR') return component.mouseOverFr ?? '';
      if (language === 'IT') return component.mouseOverIt ?? '';
      return '';
    }
    const translated = component.translations?.[editField]?.[language];
    return translated ?? (component as any)[editField] ?? '';
  }

  updateTranslation(language: string, value: string) {
    // Any manual edit dismisses a pending auto-fill hint. (Auto-fill sets the hint AFTER its own
    // updateTranslation calls, so it survives this.)
    this.autofillHint.set(null);
    this.pasteHint.set(null);
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    const component = this.formState.selectedComponent();
    if (sIdx === null || cIdx === null || !component) {
      return;
    }

    const editField = this.getSelectedEditField();
    if (editField === 'mouseOver') {
      const targetField = language === 'DE'
        ? 'mouseOverDe'
        : language === 'FR'
          ? 'mouseOverFr'
          : language === 'IT'
            ? 'mouseOverIt'
            : null;
      if (targetField) {
        this.formState.updateComponentProperty(sIdx, cIdx, targetField as keyof FormComponentInstance, value);
      }
      return;
    }
    const updatedTranslations = {
      ...(component.translations ?? {}),
      [editField]: {
        ...(component.translations?.[editField] ?? {}),
        [language]: value
      }
    };

    this.formState.updateComponentProperty(sIdx, cIdx, 'translations', updatedTranslations);

    if (language === this.formState.displayLanguage()) {
      this.formState.updateComponentProperty(sIdx, cIdx, editField as keyof FormComponentInstance, value);
    }
  }

  /**
   * When a translation field loses focus, look the term up in the backend phrase dictionary and
   * non-destructively fill the OTHER languages that are still empty. Shows an undoable hint.
   */
  /** Remember a field's value when editing starts, so blur can tell a seeded default from a real translation. */
  onTranslationFocus(language: string) {
    this.editStartValue = { language, value: this.getTranslation(language) };
  }

  onTranslationBlur(language: string) {
    const editField = this.getSelectedEditField();
    if (editField === 'mouseOver') {
      return; // mouseOver is stored separately and isn't a dictionary term
    }
    const field = editField as TranslatableField;
    const component = this.formState.selectedComponent();
    if (!component) {
      return;
    }
    const text = this.getTranslation(language).trim();
    if (!text) {
      return;
    }
    // The value this field held before the user typed = the seeded default shared across languages.
    const seededDefault =
      this.editStartValue && this.editStartValue.language === language
        ? this.editStartValue.value.trim()
        : null;
    // Fill the other languages that are still untouched: empty, or still equal to the seeded default.
    const targets = this.languages.filter(l => {
      if (l === language) return false;
      const cur = (component.translations?.[field]?.[l] ?? '').trim();
      return !cur || (seededDefault !== null && cur === seededDefault);
    });
    if (targets.length === 0) {
      return;
    }

    const instanceId = component.instanceId;
    this.dictionary.suggest(text, language).subscribe(res => {
      if (!res.matched || !res.translations) {
        return;
      }
      // Selection may have changed while the request was in flight.
      const current = this.formState.selectedComponent();
      if (!current || current.instanceId !== instanceId) {
        return;
      }
      const prevTranslations = structuredClone(current.translations ?? {});
      const prevBase = (current as any)[field];
      const filled: string[] = [];
      for (const l of targets) {
        const value = (res.translations[l] ?? '').trim();
        if (value) {
          this.updateTranslation(l, value);
          filled.push(l);
        }
      }
      if (filled.length === 0) {
        return;
      }
      this.autofillHint.set({ instanceId, editField: field, filled, prevTranslations, prevBase });
    });
  }

  /** Revert the most recent dictionary auto-fill. */
  undoAutofill() {
    const hint = this.autofillHint();
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    if (!hint || sIdx === null || cIdx === null) {
      this.autofillHint.set(null);
      return;
    }
    this.formState.updateComponentProperty(sIdx, cIdx, 'translations', hint.prevTranslations);
    this.formState.updateComponentProperty(sIdx, cIdx, hint.editField as keyof FormComponentInstance, hint.prevBase);
    this.autofillHint.set(null);
  }

  /**
   * A clipboard block holding one value per field of the group (spreadsheet row, spreadsheet
   * column, or a labelled list) fills the whole group at once. Anything else falls through to
   * the browser's own paste.
   */
  private applyPasteFill(
    event: ClipboardEvent,
    key: string,
    fields: string[],
    focusField: string,
    get: (field: string) => string,
    set: (field: string, value: string) => void,
    opts: { aliases: Record<string, string>; keepEmptyCells?: boolean; requireExactCount?: boolean; labels?: Record<string, string> }
  ) {
    const raw = event.clipboardData?.getData('text/plain') ?? '';
    const parsed = parsePaste(raw, opts.aliases, { keepEmptyCells: opts.keepEmptyCells });
    if (!parsed) {
      return;
    }
    const assignment = distributePaste(parsed, fields, focusField, opts.requireExactCount);
    if (!assignment) {
      return;
    }
    event.preventDefault();

    const previous: Record<string, string> = {};
    const filled: string[] = [];
    for (const [field, value] of Object.entries(assignment)) {
      previous[field] = get(field);
      set(field, value);
      filled.push(opts.labels?.[field] ?? field);
    }
    this.pasteHint.set({ key, filled, previous, restore: set });
  }

  /** The hint belongs to exactly one translation group; every other group renders nothing. */
  pasteHintFor(key: string): PasteHint | null {
    const hint = this.pasteHint();
    return hint && hint.key === key ? hint : null;
  }

  undoPaste() {
    const hint = this.pasteHint();
    if (hint) {
      for (const [language, value] of Object.entries(hint.previous)) {
        hint.restore(language, value);
      }
    }
    this.pasteHint.set(null);
  }

  /** mouseOver text exists in DE/FR/IT only; every other field carries all four languages. */
  translationLanguages(): string[] {
    return this.getSelectedEditField() === 'mouseOver' ? this.languages.slice(0, 3) : this.languages;
  }

  splitTranslationLanguages(side: 'a' | 'b'): string[] {
    return this.getSplitEditField(side) === 'mouseOver' ? this.languages.slice(0, 3) : this.languages;
  }

  onTranslationPaste(event: ClipboardEvent, language: string) {
    const component = this.formState.selectedComponent();
    if (!component) {
      return;
    }
    this.applyPasteFill(
      event,
      `component:${component.instanceId}:${this.getSelectedEditField()}`,
      this.translationLanguages(),
      language,
      l => this.getTranslation(l),
      (l, v) => this.updateTranslation(l, v),
      { aliases: LANGUAGE_ALIASES, requireExactCount: this.isTextBlock(component.id) }
    );
  }

  onSectionTitlePaste(event: ClipboardEvent, language: string) {
    const section = this.formState.selectedSection();
    if (!section) {
      return;
    }
    this.applyPasteFill(
      event,
      `section:${section.id}`,
      this.languages,
      language,
      l => this.getSectionTitle(l),
      (l, v) => this.updateSectionTranslation(l, v),
      { aliases: LANGUAGE_ALIASES }
    );
  }

  onSplitTranslationPaste(event: ClipboardEvent, side: 'a' | 'b', language: string) {
    const component = this.formState.selectedComponent();
    if (!component) {
      return;
    }
    this.applyPasteFill(
      event,
      `split:${component.instanceId}:${side}:${this.getSplitEditField(side)}`,
      this.splitTranslationLanguages(side),
      language,
      l => this.getSplitTranslation(side, l),
      (l, v) => this.updateSplitTranslation(side, l, v),
      { aliases: LANGUAGE_ALIASES }
    );
  }

  onOptionTranslationPaste(event: ClipboardEvent, optionId: string, language: string) {
    const component = this.formState.selectedComponent();
    if (!component) {
      return;
    }
    // Resolved per call so a reorder between paste and Undo cannot redirect the write.
    const optionAt = () => this.formState.selectedComponent()?.options?.findIndex(o => o.optionId === optionId) ?? -1;
    this.applyPasteFill(
      event,
      `option:${component.instanceId}:${optionId}`,
      this.languages,
      language,
      l => this.formState.selectedComponent()?.options?.[optionAt()]?.translations?.[l] ?? '',
      (l, v) => {
        const index = optionAt();
        if (index >= 0) this.updateOptionTranslation(index, l, v);
      },
      { aliases: LANGUAGE_ALIASES }
    );
  }

  /**
   * The identifier trio (Fachdatenbezeichner / RefID / Complimentary ID) sits in three adjacent
   * PSPH workbook columns, so copying those cells out of the spec fills the whole group.
   */
  private applyDataFieldPaste(
    event: ClipboardEvent,
    key: string,
    fields: string[],
    focusField: string,
    get: (field: string) => string,
    set: (field: string, value: string) => void
  ) {
    this.applyPasteFill(event, key, fields, focusField, get, set, {
      aliases: DATA_FIELD_ALIASES,
      keepEmptyCells: true,
      labels: DATA_FIELD_LABELS
    });
  }

  onComponentDataPaste(event: ClipboardEvent, field: string) {
    const component = this.formState.selectedComponent();
    if (!component) {
      return;
    }
    // A split input keeps its own field name and ref id per side; only compId is component-level.
    const fields = this.isSplitInput(component.id) ? ['compId'] : DATA_FIELDS;
    this.applyDataFieldPaste(
      event,
      `data:${component.instanceId}`,
      fields,
      field,
      f => (this.formState.selectedComponent() as any)?.[f] ?? '',
      (f, v) => this.updateProperty(f, v)
    );
  }

  onSectionDataPaste(event: ClipboardEvent, field: string) {
    const section = this.formState.selectedSection();
    if (!section) {
      return;
    }
    // A section's Fachdatenbezeichner is stored as sourceRef.
    const propertyOf = (f: string) => (f === 'fieldName' ? 'sourceRef' : f);
    this.applyDataFieldPaste(
      event,
      `data:section:${section.id}`,
      DATA_FIELDS,
      field,
      f => (this.formState.selectedSection() as any)?.[propertyOf(f)] ?? '',
      (f, v) => this.updateProperty(propertyOf(f), v)
    );
  }

  onSplitDataPaste(event: ClipboardEvent, side: 'a' | 'b', field: string) {
    const component = this.formState.selectedComponent();
    if (!component) {
      return;
    }
    this.applyDataFieldPaste(
      event,
      `data:${component.instanceId}:${side}`,
      ['fieldName', 'refID'],
      field,
      f => this.getSplitDataField(side, f as SplitDataField),
      (f, v) => this.updateSplitDataField(side, f as SplitDataField, v)
    );
  }

  onOptionDataPaste(event: ClipboardEvent, optionId: string, field: string) {
    const component = this.formState.selectedComponent();
    if (!component) {
      return;
    }
    const optionAt = () => this.formState.selectedComponent()?.options?.findIndex(o => o.optionId === optionId) ?? -1;
    this.applyDataFieldPaste(
      event,
      `optiondata:${component.instanceId}:${optionId}`,
      ['fieldName', 'refID'],
      field,
      f => (this.formState.selectedComponent()?.options?.[optionAt()] as any)?.[f] ?? '',
      (f, v) => {
        const index = optionAt();
        if (index >= 0) this.updateOptionField(index, f as SplitDataField, v);
      }
    );
  }

  getSectionTitle(language: string): string {
    const section = this.formState.selectedSection();
    if (!section) {
      return '';
    }
    return section.translations?.title?.[language] ?? section.title ?? '';
  }

  updateSectionTranslation(language: string, value: string) {
    // Any manual edit dismisses a pending auto-fill hint (auto-fill re-sets it afterwards).
    this.sectionAutofillHint.set(null);
    this.pasteHint.set(null);
    const sIdx = this.formState.selectedSectionIndex();
    if (sIdx === null) {
      return;
    }
    this.formState.updateSectionTranslation(sIdx, language, value);
  }

  onSectionTitleFocus(language: string) {
    this.editStartValue = { language, value: this.getSectionTitle(language) };
  }

  /** Same dictionary auto-fill as components, for the section heading. */
  onSectionTitleBlur(language: string) {
    const section = this.formState.selectedSection();
    const idx = this.formState.selectedSectionIndex();
    if (!section || idx === null) {
      return;
    }
    const text = this.getSectionTitle(language).trim();
    if (!text) {
      return;
    }
    const seededDefault =
      this.editStartValue && this.editStartValue.language === language
        ? this.editStartValue.value.trim()
        : null;
    const targets = this.languages.filter(l => {
      if (l === language) return false;
      const cur = (section.translations?.title?.[l] ?? '').trim();
      return !cur || (seededDefault !== null && cur === seededDefault);
    });
    if (targets.length === 0) {
      return;
    }

    const sectionId = section.id;
    this.dictionary.suggest(text, language).subscribe(res => {
      if (!res.matched || !res.translations) {
        return;
      }
      const current = this.formState.selectedSection();
      if (!current || current.id !== sectionId) {
        return;
      }
      const prevTranslations = structuredClone(current.translations ?? {});
      const prevTitle = current.title;
      const filled: string[] = [];
      for (const l of targets) {
        const value = (res.translations[l] ?? '').trim();
        if (value) {
          this.updateSectionTranslation(l, value);
          filled.push(l);
        }
      }
      if (filled.length === 0) {
        return;
      }
      this.sectionAutofillHint.set({ sectionId, filled, prevTranslations, prevTitle });
    });
  }

  undoSectionAutofill() {
    const hint = this.sectionAutofillHint();
    const idx = this.formState.selectedSectionIndex();
    if (!hint || idx === null) {
      this.sectionAutofillHint.set(null);
      return;
    }
    this.formState.restoreSection(idx, hint.prevTranslations, hint.prevTitle);
    this.sectionAutofillHint.set(null);
  }

  getSplitDataField(side: 'a' | 'b', field: SplitDataField): string {
    return this.formState.selectedComponent()?.splitConfig?.[side]?.[field] ?? '';
  }

  updateSplitDataField(side: 'a' | 'b', field: SplitDataField, value: string) {
    const component = this.formState.selectedComponent();
    if (!component?.splitConfig) return;
    const updated: SplitConfig = {
      ...component.splitConfig,
      [side]: { ...component.splitConfig[side], [field]: value }
    };
    this.updateProperty('splitConfig', updated);
  }

  addOption() {
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    if (sIdx !== null && cIdx !== null) {
      this.formState.addOption(sIdx, cIdx);
    }
  }

  removeOption(optionIndex: number) {
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    if (sIdx !== null && cIdx !== null) {
      this.formState.removeOption(sIdx, cIdx, optionIndex);
    }
  }

  moveOption(optionIndex: number, direction: -1 | 1) {
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    if (sIdx !== null && cIdx !== null) {
      this.formState.moveOption(sIdx, cIdx, optionIndex, direction);
    }
  }

  updateOptionTranslation(optionIndex: number, language: string, value: string) {
    this.pasteHint.set(null);
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    if (sIdx !== null && cIdx !== null) {
      this.formState.updateOptionTranslation(sIdx, cIdx, optionIndex, language, value);
    }
  }

  updateOptionField(optionIndex: number, field: 'fieldName' | 'refID', value: string) {
    this.pasteHint.set(null);
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    if (sIdx !== null && cIdx !== null) {
      this.formState.updateOptionField(sIdx, cIdx, optionIndex, field, value);
    }
  }

  removeSelectedComponent() {
    const sIdx = this.formState.selectedSectionIndex();
    const cIdx = this.formState.selectedComponentIndex();
    if (sIdx !== null && cIdx !== null) {
      this.formState.removeComponent(sIdx, cIdx);
    }
  }
}
