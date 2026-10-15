import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, of } from 'rxjs';
import { catchError, debounceTime, map, switchMap } from 'rxjs/operators';
import { FormStorageService, SavedForm, SavedFormPayload, SavedFormSummary, DeploymentSettings } from './form-storage.service';
import { DEFAULT_FORM_TITLE, isFormTitleTaken } from './form-title';
import { COUNTRY_CATALOG, CANTON_CATALOG, CatalogEntry } from './catalogs';
import { TelemetryService } from './telemetry.service';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';

export type AppView = 'landing' | 'editor';

/** The language the canvas and the properties panel show until the user picks another. */
export const DEFAULT_LANGUAGE = 'DE';

/** Blank deployment settings (every field empty → backend keeps today's placeholder behaviour). */
export function emptyDeployment(): DeploymentSettings {
  return { compName: '', usrId: '', usrIdDev: '', contactEmail: '', deId: '', frId: '', itId: '', enId: '', wikiLink: '', issueLink: '', validatorClass: '' };
}

export type SplitVariant = 'name-vorname' | 'strasse-nr' | 'plz-ort';

/**
 * Single condition for show/hide logic. Either:
 *  - a single optionId (AND-condition)
 *  - an array of optionIds (OR-group, "any of these")
 * The full showLogic/hideLogic is then an array of LogicConditions, all of which must hold (AND).
 */
export type LogicCondition = string | string[];

/** a, b … z, aa, ab … so a catalog with more than 26 options keeps labelling cleanly. */
function optionSuffix(index: number): string {
  let suffix = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
  }
  return suffix;
}

/** Components whose every option takes an Input ID of its own (json_builder.OPTION_GROUP_FORMATS). */
const NUMBERED_OPTION_GROUP_IDS = new Set([
  'radio', 'checkbox', 'select-single', 'select-multi',
  'korrespondenzsprache', 'catalog-countries', 'catalog-cantons',
]);

export interface LogicOption {
  optionId: string;
  label: string;
  parentQuestion: string;
  /** The display label shown to the user, e.g. "7b". */
  displayId: string;
}

export interface SplitSubConfig {
  placeholders: Record<string, string>;
  titles?: Record<string, string>;
  mouseOverDe?: string;
  mouseOverFr?: string;
  mouseOverIt?: string;
  fieldName: string;
  refID?: string;
}

export interface SplitConfig {
  a: SplitSubConfig;
  b: SplitSubConfig;
}

export const METADATA_COMPONENTS: { id: string; label: string; format: string }[] = [
  { id: 'meta-title',         label: 'Form Title',     format: 'Formulartitel' },
  { id: 'meta-description',   label: 'Description',    format: 'Beschreibung' },
  { id: 'meta-department',    label: 'Department',     format: 'Departement' },
  { id: 'meta-federalOffice', label: 'Federal Office', format: 'Bundesamt' },
  { id: 'meta-section',       label: 'Section',        format: 'Sektion Bundesamt' },
  { id: 'meta-address',       label: 'Address',        format: 'Adresse Bundesamt' },
  { id: 'meta-zipCity',       label: 'ZIP and City',   format: 'PLZ und Ort des Bundesamtes' }
];

export function isMetadataComponentId(id: string | undefined): boolean {
  return !!id && id.startsWith('meta-');
}

export function metadataLabelFor(id: string | undefined): string | null {
  return METADATA_COMPONENTS.find(m => m.id === id)?.label ?? null;
}

export interface ComponentOption {
  optionId: string;
  fieldName?: string;
  refID?: string;
  translations: Record<string, string>;
}

export const YES_NO_DEFAULTS: { translations: Record<string, string> }[] = [
  { translations: { DE: 'Ja', FR: 'Oui', IT: 'Sì', EN: 'Yes' } },
  { translations: { DE: 'Nein', FR: 'Non', IT: 'No', EN: 'No' } }
];

export const LANGUAGE_OPTIONS_DEFAULTS: { translations: Record<string, string> }[] = [
  { translations: { DE: 'Deutsch',     FR: 'Allemand', IT: 'tedesco',  EN: 'German'  } },
  { translations: { DE: 'Französisch', FR: 'Français', IT: 'francese', EN: 'French'  } },
  { translations: { DE: 'Italienisch', FR: 'Italien',  IT: 'italiano', EN: 'Italian' } },
  { translations: { DE: 'Englisch',    FR: 'Anglais',  IT: 'Inglese',  EN: 'English' } }
];

export const NATIVE_LANGUAGE_OPTIONS = LANGUAGE_OPTIONS_DEFAULTS.slice(0, 3);

export function usesNativeLanguagePicker(comp: FormComponentInstance): boolean {
  const opts = comp.options ?? [];
  if (opts.length !== NATIVE_LANGUAGE_OPTIONS.length) return false;
  return opts.every((opt, i) => ['DE', 'FR', 'IT', 'EN'].every(lang =>
    (opt.translations?.[lang] ?? '').trim().toLowerCase()
      === NATIVE_LANGUAGE_OPTIONS[i].translations[lang].toLowerCase()));
}

export const KORRESPONDENZSPRACHE_TITLE = {
  DE: 'Korrespondenzsprache',
  FR: 'Langue de correspondance',
  IT: 'Lingua della corrispondenza',
  EN: 'Language of correspondence'
};

export const ELECTRONIC_CONSENT_TITLE = {
  DE: 'Elektronische Verfügung',
  FR: 'Notification électronique',
  IT: 'Notifica elettronica',
  EN: 'Electronic Consent'
};

export const SINGLE_CHECKBOX_TITLE = {
  DE: 'Ich stimme zu',
  FR: 'J’accepte',
  IT: 'Accetto',
  EN: 'I agree'
};

export const COUNTRY_CATALOG_TITLE = {
  DE: 'Land',
  FR: 'Pays',
  IT: 'Nazione',
  EN: 'Country'
};

export const CANTON_CATALOG_TITLE = {
  DE: 'Kanton',
  FR: 'Canton',
  IT: 'Cantone',
  EN: 'Canton'
};

export const LABEL_DEFAULTS: Record<string, Record<string, string>> = {
  'text-input': { DE: 'Text',         FR: 'Texte',                IT: 'Testo',              EN: 'Text' },
  'text-area':  { DE: 'Textbereich',  FR: 'Zone de texte',        IT: 'Area di testo',      EN: 'Text area' }, 
  'date':       { DE: 'Datum',        FR: 'Date',                 IT: 'Data',               EN: 'Date' },
  'number':     { DE: 'Zahl',         FR: 'Nombre',               IT: 'Numero',             EN: 'Number' },
  'email':      { DE: 'E-Mail',       FR: 'Adresse électronique', IT: 'Indirizzo e-mail',   EN: 'E-mail' },
  'phone':      { DE: 'Telefonnummer', FR: 'Numéro de téléphone', IT: 'Numero di telefono', EN: 'Phone number' }
};

export const SPLIT_LABELS: Record<SplitVariant, { a: Record<string, string>; b: Record<string, string> }> = {
  'name-vorname': {
    a: { DE: 'Vorname', FR: 'Prénom', IT: 'Nome', EN: 'First Name' },
    b: { DE: 'Nachname', FR: 'Nom', IT: 'Cognome', EN: 'Last Name' }
  },
  'strasse-nr': {
    a: { DE: 'Strasse', FR: 'Rue', IT: 'Via', EN: 'Street' },
    b: { DE: 'Nr.', FR: 'Nº', IT: 'Nº', EN: '#' }
  },
  'plz-ort': {
    a: { DE: 'PLZ', FR: 'NPA', IT: 'NPA', EN: 'ZIP' },
    b: { DE: 'Ort', FR: 'Localité', IT: 'Luogo', EN: 'Location' }
  }
};

export interface FormComponentInstance {
  id: string;
  name: string;
  icon: string;
  instanceId: string;
  fieldName?: string;
  refID?: string;
  compId?: string;
  commentsForDevs?: string;
  dec?: string;
  mouseOverDe?: string;
  mouseOverFr?: string;
  mouseOverIt?: string;
  label: string;
  required: boolean;
  hiddenField?: boolean;
  showLogic?: LogicCondition[];
  hideLogic?: LogicCondition[];
  placeholder?: string;
  title?: string;
  content?: string;
  fontSize?: 'sm' | 'base' | 'lg' | 'xl' | '2xl';
  alignedInfobox?: boolean;
  translations?: {
    title?: Record<string, string>;
    placeholder?: Record<string, string>;
    content?: Record<string, string>;
  };
  inputType?: string;
  minLength?: number;
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  minDate?: string;
  maxDate?: string;
  editField?: string;
  splitVariant?: SplitVariant;
  splitConfig?: SplitConfig;
  disableMouseOver?: boolean;
  allowDecimals?: boolean;
  weblink?: string;
  linkUrl?: string;
  options?: ComponentOption[];
  fileFormats?: string;
  fileRestriction?: 'none' | 'allow' | 'block' | 'block-standard';
}

export interface AggregateGroup {
  groupId: string;
  refID?: string;
}

/** Right-sidebar panel shown for a section selection. Not every kind of section has all three. */
export type SectionTab = 'content' | 'data' | 'logic';

export interface FormSection {
  id: string;
  title: string;
  /** Per-language heading text (DE/FR/IT/EN). Falls back to `title` when a language is unset. */
  translations?: { title?: Record<string, string> };
  sourceRef?: string;
  refID?: string;
  compId?: string;
  components: FormComponentInstance[];
  /** When set, the whole section (heading + fields) is shown/hidden by these option refs. */
  showLogic?: LogicCondition[];
  hideLogic?: LogicCondition[];
  /** Whole section starts hidden on load (pair with showLogic to reveal it conditionally). */
  hiddenField?: boolean;
  isMetadata?: boolean;
  isAggregate?: boolean;
  aggregateRefID?: string;
  aggregateFachdatenbezeichner?: string;
  aggregateCompId?: string;
  groups?: AggregateGroup[];
}
export const ID_RANGE_SEPARATOR = '–';

@Injectable({ providedIn: 'root' })
export class FormStateService {
  private storage = inject(FormStorageService);
  private telemetry = inject(TelemetryService);
  private auth = inject(AuthService);

  sections = signal<FormSection[]>([
    { id: `Section_${Date.now()}`, title: 'Section', components: [] }
  ]);
  selectedSectionIndex = signal<number | null>(null);
  selectedComponentIndex = signal<number | null>(null);
  displayLanguage = signal<string>(DEFAULT_LANGUAGE);
  formTitle = signal<string>('Untitled Form');
  disableInputSize = signal<boolean>(false);
  disableMouseOver = signal<boolean>(false);
  deployment = signal<DeploymentSettings>(emptyDeployment());

  view = signal<AppView>('landing');
  currentFormId = signal<string | null>(null);
  /** Summaries of the saved forms, refreshed whenever a form is opened — the names a rename
   *  must stay clear of. The server has the last word; this is what makes the title field
   *  object to a duplicate while it is being typed. */
  private savedForms = signal<SavedFormSummary[]>([]);
  /** Name of a rename the server refused because another browser took it first. */
  titleConflict = signal<string | null>(null);
  /** Last name the server accepted, restored if a later rename is refused. */
  private lastSavedTitle: string | null = null;
  /** True when this form was created by importing a spreadsheet stored server-side (round-trip export available). */
  hasSourceSpreadsheet = signal<boolean>(false);
  /** Rows the importer couldn't reconstruct from the last import (e.g. unknown/typo'd formats). */
  importWarnings = signal<string[]>([]);
  /** Observable so the walkthrough can react to a preview click. */
  previewRequests = signal<number>(0);
  /** Counted, not inferred from the section list, so an undo isn't read as a deletion. */
  deletions = signal<number>(0);

  dismissImportWarnings() {
    this.importWarnings.set([]);
  }

  // ── Undo / redo ────────────────────────────────────────────────────────────
  // History holds JSON snapshots of the editable document (sections + title +
  // toggles + deployment). Edits are coalesced: a burst of changes (e.g. typing)
  // within HISTORY_COALESCE_MS collapses into a single undo step.
  private static readonly HISTORY_LIMIT = 100;
  private static readonly HISTORY_COALESCE_MS = 450;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** The last snapshot committed to history; the baseline the next undo restores to. */
  private committed: string | null = null;
  private historyTimer: any = null;
  canUndo = signal<boolean>(false);
  canRedo = signal<boolean>(false);

  // Autosave goes over the network now, so debounce edits and let switchMap drop
  // any in-flight save when a newer one arrives (last write wins).
  private saveTrigger = new Subject<SavedForm>();

  constructor() {
    this.saveTrigger.pipe(
      debounceTime(600),
      // Caught per request: an error reaching the outer pipe kills the subscription for
      // good, silently dropping every later edit until the page is reloaded.
      switchMap(form => this.storage.save(form).pipe(
        map(saved => ({ sent: form, saved, conflict: false })),
        catchError((err: unknown) => of({
          sent: form,
          saved: null,
          conflict: (err as { status?: number })?.status === 409
        }))
      )),
      takeUntilDestroyed()
    ).subscribe(result => this.reconcileSavedTitle(result));

    // Watch the document signals; schedule a coalesced history commit on real changes.
    effect(() => {
      const snap = this.serializeDoc();  // reading the signals registers the dependency
      if (this.committed === null) { this.committed = snap; return; }
      if (snap === this.committed) return;  // no net change (e.g. just after a restore)
      this.scheduleHistoryCommit();
    });

    effect(() => {
      const id = this.currentFormId();
      if (!id || this.view() !== 'editor') return;
      // Demo visitors edit in memory only; the server would refuse the save anyway.
      if (!this.auth.canWrite()) return;
      // Track signals so the effect re-runs on edits.
      const payload: SavedFormPayload = {
        sections: this.sections(),
        formTitle: this.formTitle(),
        disableInputSize: this.disableInputSize(),
        disableMouseOver: this.disableMouseOver(),
        deployment: this.deployment()
      };
      this.saveTrigger.next({
        id,
        title: payload.formTitle || DEFAULT_FORM_TITLE,
        updatedAt: Date.now(),
        payload
      });
    });
  }

  /**
   * Reconcile the local name with the server's answer to a save:
   *  - a brand-new form may have been given a free variant of its name ("Permit (2)");
   *  - a rename that lost a race against another browser comes back 409, and the accepted
   *    name is put back so the edits that followed it still reach the server.
   * Either way the local title is only touched while it still matches what was sent, so a
   * reply landing after the user typed on cannot clobber them.
   */
  private reconcileSavedTitle(
    { sent, saved, conflict }: { sent: SavedForm; saved: SavedForm | null; conflict: boolean }
  ) {
    if (sent.id !== this.currentFormId()) return;  // form closed while the save was in flight
    const unchanged = this.formTitle() === sent.title;
    if (conflict) {
      this.titleConflict.set(sent.title);
      if (this.lastSavedTitle !== null && unchanged) this.formTitle.set(this.lastSavedTitle);
      return;
    }
    if (!saved || typeof saved.title !== 'string') return;  // transient failure: keep editing
    this.titleConflict.set(null);
    this.lastSavedTitle = saved.title;
    if (saved.title !== sent.title && unchanged) this.formTitle.set(saved.title);
  }

  /** Whether another saved form already goes by this name. */
  isTitleTaken(title: string): boolean {
    const id = this.currentFormId();
    return isFormTitleTaken(title, this.savedForms().filter(f => f.id !== id).map(f => f.title));
  }

  private refreshSavedForms() {
    this.storage.list().subscribe(forms => this.savedForms.set(forms));
  }

  /** Serialize just the editable document (not selection / view / language). */
  private serializeDoc(): string {
    return JSON.stringify({
      sections: this.sections(),
      formTitle: this.formTitle(),
      disableInputSize: this.disableInputSize(),
      disableMouseOver: this.disableMouseOver(),
      deployment: this.deployment(),
    });
  }

  /** Restore a serialized document onto the signals (used by undo/redo). */
  private applyDoc(json: string) {
    const d = JSON.parse(json);
    this.sections.set(d.sections);
    this.formTitle.set(d.formTitle);
    this.disableInputSize.set(!!d.disableInputSize);
    this.disableMouseOver.set(!!d.disableMouseOver);
    this.deployment.set({ ...emptyDeployment(), ...(d.deployment ?? {}) });
    this.clampSelection();
  }

  /** Drop any selection that no longer points at an existing section/component. */
  private clampSelection() {
    const secs = this.sections();
    const s = this.selectedSectionIndex();
    if (s === null) return;
    if (s >= secs.length) {
      this.selectedSectionIndex.set(null);
      this.selectedComponentIndex.set(null);
      return;
    }
    const c = this.selectedComponentIndex();
    if (c !== null && c >= (secs[s]?.components.length ?? 0)) {
      this.selectedComponentIndex.set(null);
    }
  }

  private scheduleHistoryCommit() {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.canUndo.set(true);  // an edit is pending — undo is already meaningful
    this.historyTimer = setTimeout(() => this.commitHistory(), FormStateService.HISTORY_COALESCE_MS);
  }

  /** Push the previous baseline onto the undo stack and adopt the current state as the new baseline. */
  private commitHistory() {
    if (this.historyTimer) { clearTimeout(this.historyTimer); this.historyTimer = null; }
    const current = this.serializeDoc();
    if (this.committed === null || current === this.committed) { this.updateHistoryFlags(); return; }
    this.undoStack.push(this.committed);
    if (this.undoStack.length > FormStateService.HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.committed = current;
    this.updateHistoryFlags();
    // The edit-burst counter (one per coalesced ~450ms burst = undo granularity) = "edit count".
    // OVERLAP: every structural mutation (addComponent etc.) also lands here and emits an 'edit',
    // so 'edit' and the structural events count the SAME edits at different granularity — never sum
    // them. (undo/redo don't reach here: applyDoc sets `committed` first, so no net change is seen.)
    this.telemetry.record('edit');
  }

  /** Commit any edit still inside the coalescing window before an undo/redo acts on it. */
  private flushPendingHistory() {
    if (this.historyTimer) this.commitHistory();
  }

  /** Start a fresh history baseline (on load / new form) with empty stacks. */
  private resetHistory() {
    if (this.historyTimer) { clearTimeout(this.historyTimer); this.historyTimer = null; }
    this.undoStack = [];
    this.redoStack = [];
    this.committed = this.serializeDoc();
    this.updateHistoryFlags();
  }

  private updateHistoryFlags() {
    this.canUndo.set(this.undoStack.length > 0 || this.historyTimer !== null);
    this.canRedo.set(this.redoStack.length > 0);
  }

  undo() {
    this.flushPendingHistory();
    if (!this.undoStack.length) return;
    const prev = this.undoStack.pop()!;
    this.redoStack.push(this.committed!);
    this.committed = prev;        // set first so the watcher sees no net change
    this.applyDoc(prev);
    this.updateHistoryFlags();
    this.telemetry.record('undo');
  }

  redo() {
    this.flushPendingHistory();
    if (!this.redoStack.length) return;
    const next = this.redoStack.pop()!;
    this.undoStack.push(this.committed!);
    this.committed = next;
    this.applyDoc(next);
    this.updateHistoryFlags();
    this.telemetry.record('redo');
  }

  newForm() {
    const id = this.storage.newId();
    this.displayLanguage.set(DEFAULT_LANGUAGE);
    this.refreshSavedForms();
    this.lastSavedTitle = null;
    this.titleConflict.set(null);
    this.sections.set([{ id: `Section_${Date.now()}`, title: 'Section', components: [] }]);
    // The server hands back a free variant of this ("Untitled Form (2)") on the first save.
    this.formTitle.set(DEFAULT_FORM_TITLE);
    this.disableInputSize.set(false);
    this.disableMouseOver.set(false);
    this.deployment.set(emptyDeployment());
    this.selectedSectionIndex.set(null);
    this.selectedComponentIndex.set(null);
    this.currentFormId.set(id);
    this.hasSourceSpreadsheet.set(false);
    this.importWarnings.set([]);
    this.view.set('editor');
    this.resetHistory();
    this.telemetry.record('formOpen', 'new', id);
  }

  openForm(id: string) {
    this.importWarnings.set([]);  // cleared synchronously; an import sets warnings after this call
    this.displayLanguage.set(DEFAULT_LANGUAGE);
    this.refreshSavedForms();
    this.titleConflict.set(null);
    this.storage.load(id).subscribe(saved => {
      if (saved) this.applySaved(saved, 'saved');
    });
  }

  /** Open an imported form without storing it — what demo visitors get instead of a save. */
  openUnsaved(payload: SavedFormPayload) {
    this.importWarnings.set([]);
    this.displayLanguage.set(DEFAULT_LANGUAGE);
    this.titleConflict.set(null);
    this.applySaved({
      id: this.storage.newId(),
      title: payload.formTitle || DEFAULT_FORM_TITLE,
      updatedAt: Date.now(),
      payload
    }, 'import');
  }

  private applySaved(saved: SavedForm, source: string) {
    const p = saved.payload;
    this.lastSavedTitle = saved.title ?? p.formTitle ?? DEFAULT_FORM_TITLE;
    this.sections.set(this.normalizeSections(p.sections ?? []));
    this.formTitle.set(p.formTitle ?? DEFAULT_FORM_TITLE);
    this.disableInputSize.set(!!p.disableInputSize);
    this.disableMouseOver.set(!!p.disableMouseOver);
    this.deployment.set({ ...emptyDeployment(), ...(p.deployment ?? {}) });
    this.selectedSectionIndex.set(null);
    this.selectedComponentIndex.set(null);
    this.currentFormId.set(saved.id);
    this.hasSourceSpreadsheet.set(!!saved.hasSource);
    this.view.set('editor');
    this.resetHistory();
    this.telemetry.record('formOpen', source, saved.id);
  }

  /**
   * Bring saved forms in line with the current component definitions:
   *  - korrespondenzsprache's options are editable, but an imported sheet whose
   *    Korrespondenzsprache row carried no option rows arrives with none at all;
   *    seed those with the macro's native DE/FR/IT set so they keep generating it.
   *  - split-input labels became editable; older/imported forms have no titles,
   *    so backfill them from SPLIT_LABELS to make the label fields editable.
   *  - split inputs carry one Ref ID per side; older forms have a single
   *    component-level one that was exported onto both rows — move it to both sides.
   */
  private normalizeSections(sections: FormSection[]): FormSection[] {
    const used = new Set<string>();
    for (const sec of sections) {
      if (sec.sourceRef) used.add(sec.sourceRef);
      for (const c of sec.components) {
        if (c.fieldName) used.add(c.fieldName);
      }
    }

    return sections.map(sec => {
      let base = sec;
      if (!sec.isMetadata && !sec.isAggregate && !sec.sourceRef) {
        const ref = this.makeUniqueName(used, sec.title || 'Section');
        used.add(ref);
        base = { ...sec, sourceRef: ref };
      }
      return ({
      ...base,
      components: base.components
        .map(comp => {
          if (comp.id === 'split-input' && comp.splitConfig) {
            return this.backfillSplitConfig(comp);
          }
          if (comp.id === 'meta-description' && comp.linkUrl && !comp.weblink) {
            // Migrate the old whole-text Link URL to the shared weblink + <a> markup.
            const title = comp.translations?.title ?? {};
            const wrapped = Object.fromEntries(
              Object.entries(title).map(([lang, v]) => [lang, v ? `<a>${v}</a>` : v])
            );
            return {
              ...comp,
              weblink: comp.linkUrl,
              linkUrl: undefined,
              translations: { ...comp.translations, title: wrapped }
            };
          }
          if (comp.id !== 'korrespondenzsprache' || comp.options?.length) return comp;
          return {
            ...comp,
            options: NATIVE_LANGUAGE_OPTIONS.map((o, i) => ({
              optionId: `opt_${Date.now()}_${i}`,
              fieldName: '',
              refID: '',
              translations: { ...o.translations }
            }))
          };
        })
      });
    });
  }

  /** Ensure a split component carries editable per-side titles and Ref IDs. */
  private backfillSplitConfig(comp: FormComponentInstance): FormComponentInstance {
    const cfg = comp.splitConfig!;
    const labels = SPLIT_LABELS[comp.splitVariant ?? 'name-vorname'];
    const legacyRef = comp.refID ?? '';
    const side = (s: SplitSubConfig, defaults: Record<string, string>): SplitSubConfig => ({
      ...s,
      titles: s.titles ?? { ...defaults },
      refID: s.refID ?? legacyRef
    });
    return {
      ...comp,
      refID: '',
      splitConfig: { a: side(cfg.a, labels.a), b: side(cfg.b, labels.b) }
    };
  }

  goToLanding() {
    this.view.set('landing');
    this.currentFormId.set(null);
    this.hasSourceSpreadsheet.set(false);
    this.importWarnings.set([]);
    this.selectedSectionIndex.set(null);
    this.selectedComponentIndex.set(null);
  }

  hasMetadataSection = computed<boolean>(() => this.sections().some(s => s.isMetadata));

  /** All radio/checkbox/select options across the form, usable as references in show/hide logic. */
  /**
   * Input IDs, mirroring the `field_index` counter in backend/json_builder.py — the numbers
   * the "Logik anzeigen" notation references. Keyed by instanceId for a field and by
   * optionId for one of its options. Metadata sections and the electronic-consent
   * component take no number there, so they take none here either. Keep in step with
   * json_builder when its numbering changes.
   */
  inputIdMap = computed<Map<string, number>>(() => {
    const ids = new Map<string, number>();
    let index = 0;
    for (const sec of this.sections()) {
      if (sec.isMetadata) continue;
      if (sec.isAggregate) {
        index += 1;
        for (const _group of sec.groups ?? []) index += 1;
      }
      for (const comp of sec.components) {
        if (comp.id === 'electronic-consent') continue;
        index += 1;
        ids.set(comp.instanceId, index);
        if (NUMBERED_OPTION_GROUP_IDS.has(comp.id)) {
          for (const opt of comp.options ?? []) {
            index += 1;
            ids.set(opt.optionId, index);
          }
        } else if (comp.id === 'split-input') {
          index += 1;  // the pair spans two numbers; the map holds the first
        }
      }
      if (sec.isAggregate) index += 1;
    }
    return ids;
  });

  /** The Input ID the generated form uses, by instanceId (field) or optionId (option). */
  inputIdFor(key: string | undefined | null): number | null {
    return (key ? this.inputIdMap().get(key) : undefined) ?? null;
  }

  /**
   * Labels for the canvas and the logic picker: fields run 1, 2, 3… and a question's
   * options hang off their parent as 7a, 7b…, so one glossary row maps onto one label.
   *
   * Deliberately not the Input ID above. Input IDs number options in the same sequence as
   * fields, so a question with four options leaves its neighbour three numbers further on
   * — correct for the generator, unreadable as a field list.
   */
  displayIdMap = computed<Map<string, string>>(() => {
    const ids = new Map<string, string>();
    let field = 0;
    for (const sec of this.sections()) {
      if (sec.isMetadata) continue;
      for (const comp of sec.components) {
        field += 1;
        // One card, two glossary rows: a split input covers both halves, and the consent
        // block renders its legal text and its Yes/No radio as separate elements.
        if (comp.id === 'split-input' || comp.id === 'electronic-consent') {
          ids.set(comp.instanceId, `${field}${ID_RANGE_SEPARATOR}${field + 1}`);
          field += 1;
          continue;
        }
        ids.set(comp.instanceId, `${field}`);
        if (NUMBERED_OPTION_GROUP_IDS.has(comp.id)) {
          (comp.options ?? []).forEach((opt, i) => {
            ids.set(opt.optionId, `${field}${optionSuffix(i)}`);
          });
        }
      }
    }
    return ids;
  });

  /** The display label for a field (by instanceId) or an option (by optionId). */
  displayIdFor(key: string | undefined | null): string {
    return (key ? this.displayIdMap().get(key) : undefined) ?? '';
  }

  availableLogicOptions = computed<LogicOption[]>(() => {
    const lang = this.displayLanguage();
    const out: LogicOption[] = [];
    // Not electronic-consent: a platform macro renders that block downstream, and it
    // emits its own radios with no id or onChange hook and no Input ID. json_builder drops
    // references to them, so a condition on one resolves to nothing and leaves the target
    // hidden for good — better not to offer it than to let it be picked.
    const optionGroupIds = new Set([
      'radio', 'checkbox', 'select-single', 'select-multi',
      'korrespondenzsprache'
    ]);
    for (const sec of this.sections()) {
      if (sec.isMetadata) continue;
      for (const comp of sec.components) {
        if (!optionGroupIds.has(comp.id) || !comp.options) continue;
        const question = comp.translations?.title?.[lang]
          || comp.translations?.title?.['DE']
          || comp.title
          || '(untitled)';
        for (const opt of comp.options) {
          const label = opt.translations[lang] || opt.translations['DE'] || opt.translations['EN'] || '(empty)';
          out.push({ optionId: opt.optionId, label, parentQuestion: question,
                     displayId: this.displayIdFor(opt.optionId) });
        }
      }
    }
    return out;
  });

  selectedComponent = computed<FormComponentInstance | null>(() => {
    const s = this.selectedSectionIndex();
    const c = this.selectedComponentIndex();
    if (s === null || c === null) {
      return null;
    }
    return this.sections()[s]?.components[c] ?? null;
  });

  /** A section is "selected" (for heading translation) when a section index is set but no component is. */
  selectedSection = computed<FormSection | null>(() => {
    const s = this.selectedSectionIndex();
    const c = this.selectedComponentIndex();
    if (s === null || c !== null) {
      return null;
    }
    return this.sections()[s] ?? null;
  });

  addSection() {
    const id = `Section_${Date.now()}`;
    const title = `Section ${this.sections().length + 1}`;
    const sourceRef = this.generateUniqueFieldName(title);
    this.sections.update(secs => [
      ...secs,
      { id, title, components: [], sourceRef }
    ]);
    this.telemetry.record('addSection', 'section', id);
  }

  addMetadataSection() {
    if (this.hasMetadataSection()) return;
    const now = Date.now();
    const components: FormComponentInstance[] = METADATA_COMPONENTS.map((m, i) => ({
      id: m.id,
      name: m.label,
      icon: 'edit_note',
      instanceId: `Field_${m.id}_${now}_${i}`,
      label: m.label,
      required: false,
      editField: 'title',
      translations: {
        title: { DE: '', FR: '', IT: '', EN: '' }
      }
    }));
    const metaId = `MetadataSection_${now}`;
    this.sections.update(secs => [
      { id: metaId, title: 'Form Header', components, isMetadata: true },
      ...secs
    ]);
    this.telemetry.record('addSection', 'section-metadata', metaId);
  }

  addAggregateSection() {
    const now = Date.now();
    const newSection: FormSection = {
      id: `Aggregate_${now}`,
      title: 'Aggregate',
      components: [],
      isAggregate: true,
      aggregateRefID: '',
      aggregateFachdatenbezeichner: '',
      aggregateCompId: '',
      groups: [
        { groupId: `gr_${now}_1`, refID: '' },
        { groupId: `gr_${now}_2`, refID: '' },
      ]
    };
    this.sections.update(secs => [...secs, newSection]);
    this.telemetry.record('addSection', 'section-aggregate', newSection.id);
  }

  addAggregateGroup(sectionIndex: number) {
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec?.isAggregate) return secs;
      const groups = [...(sec.groups ?? [])];
      groups.push({ groupId: `gr_${Date.now()}_${groups.length}`, refID: '' });
      out[sectionIndex] = { ...sec, groups };
      return out;
    });
    const added = this.sections()[sectionIndex]?.groups?.slice(-1)[0];
    this.telemetry.record('addAggregateGroup', 'group', added?.groupId ?? null);
  }

  removeAggregateGroup(sectionIndex: number, groupIndex: number) {
    const removed = this.sections()[sectionIndex]?.groups?.[groupIndex];
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec?.isAggregate || !sec.groups) return secs;
      const groups = sec.groups.filter((_, i) => i !== groupIndex);
      out[sectionIndex] = { ...sec, groups };
      return out;
    });
    this.telemetry.record('removeAggregateGroup', 'group', removed?.groupId ?? null);
  }

  updateAggregateGroupRefID(sectionIndex: number, groupIndex: number, refID: string) {
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec?.isAggregate || !sec.groups) return secs;
      const groups = [...sec.groups];
      groups[groupIndex] = { ...groups[groupIndex], refID };
      out[sectionIndex] = { ...sec, groups };
      return out;
    });
  }

  moveSection(fromIndex: number, toIndex: number) {
    const secs = this.sections();
    const moved = secs[fromIndex];
    if (!moved || moved.isMetadata) return;
    const floor = secs[0]?.isMetadata ? 1 : 0;
    const target = Math.min(Math.max(toIndex, floor), secs.length - 1);
    if (target === fromIndex) return;

    this.sections.update(list => {
      const out = [...list];
      const [section] = out.splice(fromIndex, 1);
      out.splice(target, 0, section);
      return out;
    });
    this.telemetry.record('moveSection', moved.isAggregate ? 'section-aggregate' : 'section', moved.id);

    const sel = this.selectedSectionIndex();
    if (sel === null) return;
    if (sel === fromIndex) {
      this.selectedSectionIndex.set(target);
    } else if (sel > fromIndex && sel <= target) {
      this.selectedSectionIndex.set(sel - 1);
    } else if (sel < fromIndex && sel >= target) {
      this.selectedSectionIndex.set(sel + 1);
    }
  }

  removeSection(index: number) {
    const removed = this.sections()[index];
    this.sections.update(secs => secs.filter((_, i) => i !== index));
    this.deletions.update(n => n + 1);
    if (this.selectedSectionIndex() === index) {
      this.selectedSectionIndex.set(null);
      this.selectedComponentIndex.set(null);
    }
    this.telemetry.record('removeSection', removed?.isMetadata ? 'section-metadata' : removed?.isAggregate ? 'section-aggregate' : 'section', removed?.id ?? null);
  }

  /**
   * Which right-sidebar tab a section selection shows. Shared state so the canvas can
   * deep-link into a panel (e.g. the aggregate summary → Data) instead of only selecting.
   */
  readonly sectionTab = signal<SectionTab>('content');

  /** Selects a section (for editing its heading) and clears any component selection. */
  selectSection(sectionIndex: number, tab?: SectionTab) {
    this.selectedSectionIndex.set(sectionIndex);
    this.selectedComponentIndex.set(null);
    if (tab) this.sectionTab.set(tab);
  }

  /** Patch one field on a section (used by the section Logic/visibility controls). */
  updateSectionProperty(sectionIndex: number, field: keyof FormSection, value: any) {
    this.sections.update(secs => {
      const out = [...secs];
      if (out[sectionIndex]) {
        out[sectionIndex] = { ...out[sectionIndex], [field]: value };
      }
      return out;
    });
  }

  /**
   * Set the section heading for one language. Mirrors the component translation behaviour: editing in the
   * current display language also updates the base `title` (kept as the fallback + structural-key source).
   */
  updateSectionTranslation(index: number, language: string, value: string) {
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[index];
      if (!sec) {
        return secs;
      }
      const titles = { ...(sec.translations?.title ?? {}), [language]: value };
      out[index] = {
        ...sec,
        translations: { ...sec.translations, title: titles },
        title: language === this.displayLanguage() ? value : sec.title
      };
      return out;
    });
  }

  /** Restore a section's heading translations + base title (used to undo a dictionary auto-fill). */
  restoreSection(index: number, translations: FormSection['translations'], title: string) {
    this.sections.update(secs => {
      const out = [...secs];
      if (out[index]) {
        out[index] = { ...out[index], translations, title };
      }
      return out;
    });
  }

  addComponent(comp: any, sectionIndex: number, insertAt?: number) {
    if (comp.id === 'split-input') {
      this.addSplitInputComponent(comp, sectionIndex, insertAt);
      return;
    }

    const placeholders: Record<string, { placeholder?: string; title?: string; content?: string }> = {
      'text-input': { title: 'Text' },
      'text-area': { title: 'Message' },
      'date': { title: 'Date' },
      'number': { title: 'Number' },
      'email': { title: 'E-mail' },
      'phone': { title: 'Phone number' },
      'radio': { title: 'Question' },
      'checkbox': { title: 'Question' },
      'select-single': { title: 'Choose one' },
      'select-multi': { title: 'Choose any number' },
      'korrespondenzsprache': { title: KORRESPONDENZSPRACHE_TITLE.DE },
      'electronic-consent': { title: ELECTRONIC_CONSENT_TITLE.DE },
      'upload-single': { title: 'Upload file' },
      'upload-multi': { title: 'Upload files' },
      'button': { title: 'Submit' },
      'single-checkbox': { title: 'I agree' },
      'catalog-countries': { title: 'Country' },
      'catalog-cantons': { title: 'Canton' },
      'text': { content: 'Your text here', title: 'Text Block' }
    };

    const defaults = placeholders[comp.id] || { placeholder: '', title: comp.name };
    const isTextBlock = comp.id === 'text';
    const fieldName = this.generateUniqueFieldName(defaults.title || comp.name);

    const titleDefaults = comp.id === 'korrespondenzsprache'
      ? KORRESPONDENZSPRACHE_TITLE
      : comp.id === 'electronic-consent'
      ? ELECTRONIC_CONSENT_TITLE
      : comp.id === 'single-checkbox'
      ? SINGLE_CHECKBOX_TITLE
      : comp.id === 'catalog-countries'
      ? COUNTRY_CATALOG_TITLE
      : comp.id === 'catalog-cantons'
      ? CANTON_CATALOG_TITLE
      : LABEL_DEFAULTS[comp.id]
      ? { ...LABEL_DEFAULTS[comp.id] }
      : {
          DE: defaults.title || '',
          FR: defaults.title || '',
          IT: defaults.title || '',
          EN: defaults.title || ''
        };

    const baseTranslations: FormComponentInstance['translations'] = isTextBlock
      ? {
          content: {
            DE: defaults.content || '',
            FR: defaults.content || '',
            IT: defaults.content || '',
            EN: defaults.content || ''
          }
        }
      : {
          title: titleDefaults,
          placeholder: LABEL_DEFAULTS[comp.id]
            ? { ...titleDefaults }
            : { DE: '', FR: '', IT: '', EN: '' }
        };

    const newComp: FormComponentInstance = {
      ...comp,
      instanceId: `Field_${comp.id}_${Date.now()}`,
      fieldName,
      refID: '',
      compId: '',
      commentsForDevs: '',
      dec: defaults.title || defaults.content || comp.name,
      mouseOverDe: '',
      mouseOverFr: '',
      mouseOverIt: '',
      label: comp.name,
      title: defaults.title,
      placeholder: defaults.placeholder,
      content: defaults.content,
      fontSize: isTextBlock ? 'base' : undefined,
      alignedInfobox: isTextBlock ? false : undefined,
      required: false,
      editField: isTextBlock ? 'content' : 'title',
      minLength: comp.id === 'text-input' ? 1 : (comp.id === 'text-area' ? 10 : undefined),
      maxLength: comp.id === 'text-input' || comp.id === 'email' ? 100
                 : comp.id === 'text-area' ? 500
                 : comp.id === 'phone' ? 50
                 : comp.id === 'upload-multi' ? 5
                 : undefined,
      translations: baseTranslations,
      options: (comp.id === 'radio' || comp.id === 'checkbox' || comp.id === 'electronic-consent')
        ? YES_NO_DEFAULTS.map((o, i) => ({
            optionId: `opt_${Date.now()}_${i}`,
            fieldName: '',
            refID: '',
            translations: { ...o.translations }
          }))
        : (comp.id === 'select-single' || comp.id === 'select-multi')
        ? [1, 2].map((n, i) => ({
            optionId: `opt_${Date.now()}_${i}`,
            fieldName: '',
            refID: '',
            translations: { DE: `Option ${n}`, FR: `Option ${n}`, IT: `Opzione ${n}`, EN: `Option ${n}` }
          }))
        : comp.id === 'korrespondenzsprache'
        ? LANGUAGE_OPTIONS_DEFAULTS.map((o, i) => ({
            optionId: `opt_${Date.now()}_${i}`,
            fieldName: '',
            refID: '',
            translations: { ...o.translations }
          }))
        : comp.id === 'catalog-countries'
        ? COUNTRY_CATALOG.map((entry: CatalogEntry, i: number) => ({
            optionId: `opt_${Date.now()}_${i}`,
            fieldName: '',
            refID: entry.code,
            translations: { ...entry.translations }
          }))
        : comp.id === 'catalog-cantons'
        ? CANTON_CATALOG.map((entry: CatalogEntry, i: number) => ({
            optionId: `opt_${Date.now()}_${i}`,
            fieldName: '',
            refID: entry.code,
            translations: { ...entry.translations }
          }))
        : undefined
    };

    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) {
        return secs;
      }
      const list = [...sec.components];
      if (insertAt === undefined || insertAt < 0 || insertAt > list.length) {
        list.push(newComp);
      } else {
        list.splice(insertAt, 0, newComp);
      }
      out[sectionIndex] = { ...sec, components: list };
      return out;
    });
    // targetType = palette id (fixed vocabulary, never text).
    this.telemetry.record('addComponent', comp.id, newComp.instanceId);
  }

  private addSplitInputComponent(comp: any, sectionIndex: number, insertAt?: number) {
    // The palette item carries which split variant was dragged (Name+Vorname,
    // Strasse+Nr or PLZ+Ort); fall back to name-vorname for older saved palettes.
    const variant: SplitVariant = (comp.splitVariant as SplitVariant) ?? 'name-vorname';
    const labels = SPLIT_LABELS[variant];

    const newComp: FormComponentInstance = {
      ...comp,
      instanceId: `Field_split_${Date.now()}`,
      fieldName: this.generateUniqueFieldName('SplitInput'),
      refID: '',
      compId: '',
      commentsForDevs: '',
      dec: labels.a['DE'],
      mouseOverDe: '',
      mouseOverFr: '',
      mouseOverIt: '',
      label: comp.name,
      title: labels.a['DE'],
      placeholder: '',
      required: false,
      editField: 'splitATitle',
      splitVariant: variant,
      splitConfig: {
        a: {
          placeholders: { ...labels.a },
          titles: { ...labels.a },
          mouseOverDe: '',
          mouseOverFr: '',
          mouseOverIt: '',
          fieldName: this.generateUniqueFieldName(labels.a['DE']),
          refID: ''
        },
        b: {
          placeholders: { ...labels.b },
          titles: { ...labels.b },
          mouseOverDe: '',
          mouseOverFr: '',
          mouseOverIt: '',
          fieldName: this.generateUniqueFieldName(labels.b['DE']),
          refID: ''
        }
      }
    };

    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) return secs;
      const list = [...sec.components];
      if (insertAt === undefined || insertAt < 0 || insertAt > list.length) {
        list.push(newComp);
      } else {
        list.splice(insertAt, 0, newComp);
      }
      out[sectionIndex] = { ...sec, components: list };
      return out;
    });
    this.telemetry.record('addComponent', comp.id, newComp.instanceId);
  }

  addOption(sectionIndex: number, componentIndex: number) {
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) return secs;
      const list = [...sec.components];
      const comp = list[componentIndex];
      if (!comp) return secs;
      const newOption: ComponentOption = {
        optionId: `opt_${Date.now()}_${(comp.options?.length ?? 0)}`,
        fieldName: '',
        refID: '',
        translations: { DE: '', FR: '', IT: '', EN: '' }
      };
      list[componentIndex] = { ...comp, options: [...(comp.options ?? []), newOption] };
      out[sectionIndex] = { ...sec, components: list };
      return out;
    });
    const added = this.sections()[sectionIndex]?.components[componentIndex]?.options?.slice(-1)[0];
    this.telemetry.record('addOption', 'option', added?.optionId ?? null);
  }

  removeOption(sectionIndex: number, componentIndex: number, optionIndex: number) {
    const removed = this.sections()[sectionIndex]?.components[componentIndex]?.options?.[optionIndex];
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) return secs;
      const list = [...sec.components];
      const comp = list[componentIndex];
      if (!comp?.options) return secs;
      const opts = comp.options.filter((_, i) => i !== optionIndex);
      list[componentIndex] = { ...comp, options: opts };
      out[sectionIndex] = { ...sec, components: list };
      return out;
    });
    this.telemetry.record('removeOption', 'option', removed?.optionId ?? null);
  }

  moveOption(sectionIndex: number, componentIndex: number, optionIndex: number, direction: -1 | 1) {
    const moved = this.sections()[sectionIndex]?.components[componentIndex]?.options?.[optionIndex];
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) return secs;
      const list = [...sec.components];
      const comp = list[componentIndex];
      if (!comp?.options) return secs;
      const opts = [...comp.options];
      const target = optionIndex + direction;
      if (target < 0 || target >= opts.length) return secs;
      [opts[optionIndex], opts[target]] = [opts[target], opts[optionIndex]];
      list[componentIndex] = { ...comp, options: opts };
      out[sectionIndex] = { ...sec, components: list };
      return out;
    });
    this.telemetry.record('moveOption', 'option', moved?.optionId ?? null);
  }

  updateOptionField(sectionIndex: number, componentIndex: number, optionIndex: number, field: keyof ComponentOption, value: any) {
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) return secs;
      const list = [...sec.components];
      const comp = list[componentIndex];
      if (!comp?.options) return secs;
      const opts = [...comp.options];
      opts[optionIndex] = { ...opts[optionIndex], [field]: value };
      list[componentIndex] = { ...comp, options: opts };
      out[sectionIndex] = { ...sec, components: list };
      return out;
    });
  }

  updateOptionTranslation(sectionIndex: number, componentIndex: number, optionIndex: number, language: string, value: string) {
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) return secs;
      const list = [...sec.components];
      const comp = list[componentIndex];
      if (!comp?.options) return secs;
      const opts = [...comp.options];
      opts[optionIndex] = {
        ...opts[optionIndex],
        translations: { ...opts[optionIndex].translations, [language]: value }
      };
      list[componentIndex] = { ...comp, options: opts };
      out[sectionIndex] = { ...sec, components: list };
      return out;
    });
  }

  private makeUniqueName(existing: Set<string>, baseTitle: string): string {
    const slug = (baseTitle || 'Field').replace(/[^A-Za-z0-9]+/g, '') || 'Field';
    let suffix = 1;
    while (existing.has(`Field_${slug}${suffix}`)) {
      suffix += 1;
    }
    return `Field_${slug}${suffix}`;
  }

  private collectUsedNames(): Set<string> {
    const existing = new Set<string>();
    for (const sec of this.sections()) {
      if (sec.sourceRef) {
        existing.add(sec.sourceRef);
      }
      for (const c of sec.components) {
        if (c.fieldName) {
          existing.add(c.fieldName);
        }
      }
    }
    return existing;
  }

  private generateUniqueFieldName(baseTitle: string): string {
    return this.makeUniqueName(this.collectUsedNames(), baseTitle);
  }

  removeComponent(sectionIndex: number, componentIndex: number) {
    const removed = this.sections()[sectionIndex]?.components[componentIndex];
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) {
        return secs;
      }
      out[sectionIndex] = {
        ...sec,
        components: sec.components.filter((_, i) => i !== componentIndex)
      };
      return out;
    });
    this.deletions.update(n => n + 1);
    this.selectedSectionIndex.set(null);
    this.selectedComponentIndex.set(null);
    this.telemetry.record('removeComponent', removed?.id ?? null, removed?.instanceId ?? null);
  }

  selectComponent(sectionIndex: number, componentIndex: number) {
    this.selectedSectionIndex.set(sectionIndex);
    this.selectedComponentIndex.set(componentIndex);
  }

  updateComponentProperty(
    sectionIndex: number,
    componentIndex: number,
    property: keyof FormComponentInstance,
    value: any
  ) {
    this.sections.update(secs => {
      const out = [...secs];
      const sec = out[sectionIndex];
      if (!sec) {
        return secs;
      }
      const list = [...sec.components];
      list[componentIndex] = { ...list[componentIndex], [property]: value };
      out[sectionIndex] = { ...sec, components: list };
      return out;
    });
  }

  moveComponent(
    fromSection: number,
    fromIndex: number,
    toSection: number,
    toIndex: number
  ) {
    if (fromSection === toSection && fromIndex === toIndex) {
      return;
    }

    const movedComp = this.sections()[fromSection]?.components[fromIndex];
    this.sections.update(secs => {
      const out = secs.map(s => ({ ...s, components: [...s.components] }));
      const fromList = out[fromSection]?.components;
      const toList = out[toSection]?.components;
      if (!fromList || !toList) {
        return secs;
      }
      const [moved] = fromList.splice(fromIndex, 1);
      toList.splice(toIndex, 0, moved);
      return out;
    });
    this.telemetry.record('moveComponent', movedComp?.id ?? null, movedComp?.instanceId ?? null);

    const sel = this.selectedSectionIndex();
    const ci = this.selectedComponentIndex();
    if (sel === null || ci === null) {
      return;
    }
    if (sel === fromSection && ci === fromIndex) {
      this.selectedSectionIndex.set(toSection);
      this.selectedComponentIndex.set(toIndex);
    }
  }

  private buildPayload() {
    return {
      sections: this.sortedForBackend(this.sections()),
      formTitle: this.formTitle(),
      disableInputSize: this.disableInputSize(),
      disableMouseOver: this.disableMouseOver(),
      deployment: this.deployment()
    };
  }

  private sortedForBackend(sections: FormSection[]): FormSection[] {
    const lang = this.displayLanguage();
    const collator = new Intl.Collator(lang.toLowerCase());
    const isCatalog = (id: string) => id === 'catalog-countries' || id === 'catalog-cantons';
    const label = (o: ComponentOption) => o.translations[lang] || o.translations['DE'] || '';
    return sections.map(sec =>
      sec.components.some(c => isCatalog(c.id) && c.options?.length)
        ? {
            ...sec,
            components: sec.components.map(c =>
              isCatalog(c.id) && c.options
                ? { ...c, options: [...c.options].sort((a, b) => collator.compare(label(a), label(b))) }
                : c
            )
          }
        : sec
    );
  }

  /** Patch one or more deployment settings fields (used by the Settings UI). */
  updateDeployment(patch: Partial<DeploymentSettings>) {
    this.deployment.update(d => ({ ...d, ...patch }));
  }

  async generateJSONFromBackend() {
    const response = await fetch(`${environment.apiUrl}/api/generate-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload())
    });
    if (!response.ok) {
      throw new Error('Failed to generate JSON from backend');
    }
    return await response.json();
  }

  /**
   * Round-trip the imported spreadsheet: overlay the current builder edits onto the original
   * workbook stored with this form, append a Version row, and return the .xlsx blob.
   */
  async exportSpreadsheetFromBackend(meta: { author: string; note: string; version: string }): Promise<Blob> {
    const id = this.currentFormId();
    if (!id) throw new Error('Save the form before exporting.');
    const response = await fetch(`${environment.apiUrl}/api/forms/${encodeURIComponent(id)}/export-xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: this.buildPayload(),
        filename: this.formTitle() || 'form',
        author: meta.author,
        note: meta.note,
        version: meta.version,
      }),
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).message ?? ''; } catch { /* no JSON body */ }
      throw new Error(detail || 'Failed to export spreadsheet.');
    }
    // The export is now persisted server-side as the form's living spec, so it has a source.
    this.hasSourceSpreadsheet.set(true);
    return await response.blob();
  }

  /**
   * Render the current form and return the URL of the preview page the backend serves.
   */
  async generatePreviewFromBackend(language: string = 'en'): Promise<string> {
    // Counted before the request, so an unreachable backend still registers the intent.
    this.previewRequests.update(n => n + 1);
    this.telemetry.record('preview');
    const response = await fetch(
      `${environment.apiUrl}/api/preview?lang=${encodeURIComponent(language)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.telemetry.sessionHeader() },
        body: JSON.stringify(this.buildPayload())
      }
    );
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.json()).message ?? '';
      } catch {
        /* response had no JSON body */
      }
      throw new Error(detail || 'Failed to generate preview from backend');
    }
    const data = await response.json();
    // Open the language the user selected; the in-page D/E/F/I switch handles the rest.
    const initialLang = data.lang ?? language;
    return `${environment.apiUrl}/preview?id=${encodeURIComponent(data.id)}&lang=${encodeURIComponent(initialLang)}`;
  }
}
