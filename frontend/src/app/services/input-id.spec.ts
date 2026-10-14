import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { FormStateService } from './form-state.service';

/** The expected numbers below were taken from backend/json_builder.py's own output for the
 *  same form. They are the contract: if json_builder's field_index changes, this fails. */
describe('FormStateService input IDs', () => {
  let form: FormStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    form = TestBed.inject(FormStateService);
  });

  const tr = (s: string) => ({ DE: s, FR: s, IT: s, EN: s });
  const opt = (optionId: string, label: string) =>
    ({ optionId, fieldName: '', refID: '', translations: tr(label) });
  const field = (id: string, instanceId: string, extra: any = {}) =>
    ({ id, instanceId, label: id, required: false, translations: { title: tr(instanceId) }, ...extra });

  beforeEach(() => {
    form.sections.set([
      { id: 'M', title: 'Meta', isMetadata: true,
        components: [field('text-input', 'i_meta')] },
      { id: 'S1', title: 'One', components: [
        field('text-input', 'i_a'),
        field('radio', 'i_r', { options: [opt('r1', 'one'), opt('r2', 'two')] }),
        field('split-input', 'i_sp', { splitVariant: 'name-vorname' }),
        field('electronic-consent', 'i_ec', { options: [opt('e1', 'yes'), opt('e2', 'no')] }),
        field('text-input', 'i_b'),
      ] },
      { id: 'S2', title: 'Agg', isAggregate: true,
        groups: [{ groupId: 'g1' }, { groupId: 'g2' }],
        components: [field('text-input', 'i_c')] },
      { id: 'S3', title: 'Three', components: [
        field('checkbox', 'i_cb', { options: [opt('c1', 'one'), opt('c2', 'two')] }),
      ] },
    ] as any);
  });

  it('numbers fields and options the way json_builder does', () => {
    const n = (key: string) => form.inputIdFor(key);
    expect(n('i_a')).toBe(1);
    expect(n('i_r')).toBe(2);
    expect(n('r1')).toBe(3);
    expect(n('r2')).toBe(4);
    expect(n('i_sp')).toBe(5);   // the pair spans 5 and 6
    expect(n('i_b')).toBe(7);
    expect(n('i_c')).toBe(11);   // 8 aggregate start, 9 + 10 the two groups
    expect(n('i_cb')).toBe(13);  // 12 aggregate end
    expect(n('c1')).toBe(14);
    expect(n('c2')).toBe(15);
  });

  it('skips metadata sections and the macro-rendered consent', () => {
    expect(form.inputIdFor('i_meta')).toBeNull();
    expect(form.inputIdFor('i_ec')).toBeNull();
    expect(form.inputIdFor('e1')).toBeNull();
  });

  it('carries the id into the logic picker', () => {
    const picked = form.availableLogicOptions().find(o => o.optionId === 'r2');
    expect(picked?.displayId).toBe('2b');
  });

  describe('display labels', () => {
    const label = (key: string) => form.displayIdFor(key);

    it('numbers fields in sequence, options under their parent', () => {
      expect(label('i_a')).toBe('1');
      expect(label('i_r')).toBe('2');
      expect(label('r1')).toBe('2a');
      expect(label('r2')).toBe('2b');
      // One card, two rows: both halves of a split, and the consent's text + radio.
      expect(label('i_sp')).toBe('3–4');
      expect(label('i_ec')).toBe('5–6');
      expect(label('i_b')).toBe('7');
      expect(label('i_c')).toBe('8');
      expect(label('i_cb')).toBe('9');
      expect(label('c1')).toBe('9a');
    });

    it('leaves no gaps between neighbouring fields', () => {
      // The whole point: the field after a 2-option question is 3, not 4.
      expect(label('i_r')).toBe('2');
      expect(label('i_sp')).toBe('3–4');
    });

    it('labels the consent even though it has no Input ID', () => {
      expect(label('i_ec')).toBe('5–6');
      expect(form.inputIdFor('i_ec')).toBeNull();
    });

    it('keeps consent options out of the logic picker', () => {
      // They can't be wired: eGovResponseSpec renders its own radios and json_builder
      // drops references to them, which would leave the target permanently hidden.
      const ids = form.availableLogicOptions().map(o => o.optionId);
      expect(ids).not.toContain('e1');
      expect(ids).toContain('r1');
    });

    it('skips metadata sections', () => {
      expect(label('i_meta')).toBe('');
    });
  });
});
