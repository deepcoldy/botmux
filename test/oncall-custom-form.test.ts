import { describe, expect, it } from 'vitest';
import { botmuxOncallFields, oncallOptionValue, serializeBotmuxOncallForm } from '../src/services/oncall-custom-form.js';
import { buildOncallFormCard } from '../src/im/lark/oncall-form-card.js';
import type { OncallFormDraft } from '../src/services/oncall-form-store.js';

const text = (key = 'reference', type = 'input') => ({
  base: { key, label: key, type, disabled: { sourceType: 'value', value: false }, ignoreReadonly: false,
    defaultValue: { sourceType: 'value', value: '' } },
  custom: {}, shown: { exist: { sourceType: 'value', value: true }, untouchable: { sourceType: 'value', value: false } },
});
const choice = (type = 'radio') => ({
  base: { key: 'category', label: '问题方向', type, defaultValue: { sourceType: 'value' } },
  custom: { valueType: 'unset', isRemoteOptions: false, ...(type === 'select'
    ? { isMultiple: false, allowCreate: false, checkValueInOptions: false, complete: false } : {}), customOptions: [
    { value: 'accounting', displayName: '账务咨询' }, { value: 'payment', displayName: '付款咨询' },
  ], selectFirst: false, itemStyle: 'default' },
  validations: [{ type: 'required' }],
});
function draft(workflow: unknown[]): OncallFormDraft {
  return { id: 'test', version: 0, appId: 'app', ownerOpenId: 'ou_owner', source: {
    appId: 'app', chatId: 'oc_test', questionId: 'om_question', messageId: 'om_reply', answer: '',
  }, choices: { regions: { cn: [{ id: 1, tenant_id: 1, name: 'form', type_action: 'create_chat' }] } },
  region: 'cn', typeId: 1, priority: 'P2', description: 'question', createdAtMs: Date.now(),
  botmuxFields: botmuxOncallFields(workflow), visibility: 'thread' };
}

describe('Oncall card field mapping', () => {
  it('displays the region name while keeping the routing key selected', () => {
    const d = draft([]);
    d.choices.regions = { cn_all: d.choices.regions.cn, custom: [] };
    d.region = 'cn_all';
    const card = JSON.parse(buildOncallFormCard(d));
    const region = card.body.elements.find((item: any) => item.tag === 'column_set').columns[0].elements[0];
    expect(region.initial_option).toBe('cn_all');
    expect(region.options.map((item: any) => [item.value, item.text.content])).toEqual([
      ['cn_all', 'CN/所有区域'], ['custom', 'custom'],
    ]);
  });
  it.each([
    { validations: [{ type: 'required' }] },
    { validations: [{ type: 'required', message: '' }] },
    { validate: { required: true } },
  ])('enforces platform required rules: %j', rules => {
    const fields = botmuxOncallFields([{ ...text(), ...rules }])!;
    expect(fields[0].required).toBe(true);
    expect(() => serializeBotmuxOncallForm(fields, {})).toThrow();
    expect(() => serializeBotmuxOncallForm(fields, { oncall_field_0: '  ' })).toThrow();
    expect(JSON.parse(serializeBotmuxOncallForm(fields, { oncall_field_0: 'R001' })).reference.value).toBe('R001');
  });
  it('preserves persisted legacy text fields and optional blanks', () => {
    const legacy = [{ key: 'reference', label: 'reference', required: false }];
    expect(botmuxOncallFields([text()])).toEqual(legacy);
    expect(JSON.parse(serializeBotmuxOncallForm(legacy))).toEqual({ reference: { name: 'reference', type: 'input', value: '' } });
    expect(botmuxOncallFields([{ ...text(), validations: [] }])).toEqual(legacy);
  });
  it.each([text(), choice()])('keeps the configured required message on the field and on empty submission', field => {
    const message = '请补充业务流水号';
    const d = draft([{ ...field, validations: [{ type: 'required', message }] }]);
    const card = JSON.parse(buildOncallFormCard(d));
    const form = card.body.elements.find((item: any) => item.tag === 'form');
    expect(form.elements.find((item: any) => item.name === 'oncall_field_0')).toMatchObject({
      required: true, placeholder: { tag: 'plain_text', content: message },
    });
    expect(() => serializeBotmuxOncallForm(d.botmuxFields!, {})).toThrow(message);
  });
  it('renders multiline text using card 2.0 and preserves newlines in the platform value', () => {
    const d = draft([text('scope', 'textArea')]);
    const card = JSON.parse(buildOncallFormCard(d));
    expect(card.schema).toBe('2.0');
    const form = card.body.elements.find((item: any) => item.tag === 'form');
    expect(form.elements[0]).toMatchObject({ tag: 'input', input_type: 'multiline_text' });
    expect(JSON.parse(serializeBotmuxOncallForm(d.botmuxFields!, { oncall_field_0: 'line 1\nline 2' }))).toEqual({
      scope: { value: 'line 1\nline 2', name: 'scope', type: 'textArea' },
    });
    const row = form.elements.at(-1);
    expect(row.columns[0].elements[0].text.content).toBe('确认发起人工 Oncall');
    const cancel = row.columns[1].elements[0];
    expect(cancel).toMatchObject({ tag: 'interactive_container', elements: [{ text: { content: '取消' } }], behaviors: [{ type: 'callback', value: { action: 'oncall_group_form_cancel' } }] });
    expect(form.elements.at(-1).columns[0].elements[0].form_action_type).toBe('submit');
    expect(form.elements.some((item: any) => item.action_type === 'request')).toBe(false);
  });
  it.each(['radio', 'select'])('renders static %s with display names but submits the original values', type => {
    const d = draft([choice(type)]);
    expect(d.botmuxFields).toBeDefined();
    const form = JSON.parse(buildOncallFormCard(d)).body.elements.find((item: any) => item.tag === 'form');
    const select = form.elements.find((item: any) => item.tag === 'select_static');
    expect(select).toMatchObject({ name: 'oncall_field_0', required: true, options: [
      { text: { content: '账务咨询' }, value: oncallOptionValue(0) },
      { text: { content: '付款咨询' }, value: oncallOptionValue(1) },
    ] });
    expect(() => serializeBotmuxOncallForm(d.botmuxFields!, {})).toThrow();
    expect(() => serializeBotmuxOncallForm(d.botmuxFields!, { oncall_field_0: 'payment' })).toThrow();
    expect(() => serializeBotmuxOncallForm(d.botmuxFields!, { oncall_field_0: ['oncall_option_0'] })).toThrow();
    expect(JSON.parse(serializeBotmuxOncallForm(d.botmuxFields!, { oncall_field_0: select.options[1].value }))).toEqual({
      category: { value: 'payment', name: 'category', type },
    });
  });
  it.each([0, false, '0'])('keeps scalar option types intact: %j', value => {
    const workflow = choice('select');
    const fields = botmuxOncallFields([{ ...workflow, custom: { ...workflow.custom,
      customOptions: [{ value, displayName: '选项' }] } }])!;
    expect(JSON.parse(serializeBotmuxOncallForm(fields, { oncall_field_0: oncallOptionValue(0) })).category.value).toBe(value);
  });
  it('allows an empty optional selection without inventing a platform option', () => {
    const fields = botmuxOncallFields([{ ...choice(), validations: [] }])!;
    expect(JSON.parse(serializeBotmuxOncallForm(fields))).toEqual({ category: { name: 'category', type: 'radio' } });
  });
  it.each([
    { ...text(), base: { ...text().base, type: 'imageUpload' } },
    { ...text(), validations: [{ type: 'regexp', value: '^A' }] },
    { ...text(), linkages: [{ key: 'other' }] },
    { ...text(), shown: { exist: { sourceType: 'expression', value: 'other == 1' } } },
    { ...choice(), custom: { ...choice().custom, isRemoteOptions: true } },
    { ...choice(), custom: { ...choice().custom, customOptions: [{ value: 'a', displayName: 'A', existCondition: 'other == 1' }] } },
    { ...choice(), custom: { ...choice().custom, customOptions: [{ value: 'a', displayName: 'A' }, { value: 'a', displayName: 'B' }] } },
    { ...text(), base: { ...text().base, required: false }, validations: [{ type: 'required' }] },
  ])('keeps the complete form native rather than dropping unsupported behavior: %j', field => {
    let reason: string | undefined;
    expect(botmuxOncallFields([text('supported'), field], detail => { reason = detail; })).toBeUndefined();
    expect(reason).toBeTruthy();
    const d = { ...draft([]), nativeFormLink: 'https://example.test/form', nativeFormReason: reason };
    const card = JSON.parse(buildOncallFormCard(d));
    expect(card.body.elements.find((item: any) => item.tag === 'markdown').content).toContain(reason);
    expect(card.body.elements.at(-1).columns[0].elements[0].behaviors[0].default_url).toBe(d.nativeFormLink);
  });
});
