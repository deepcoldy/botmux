export interface OncallTextField {
  key: string;
  label: string;
  required: boolean;
}

export const ONCALL_FIELD_LIMIT = 1000;

function object(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).every(key => keys.includes(key))) return record;
}

function literal(value: unknown): unknown {
  const wrapped = object(value, ['sourceType', 'value']);
  return wrapped?.sourceType === 'value' ? wrapped.value : value;
}

/** Only map fields whose behavior can be reproduced in a Feishu card. */
export function botmuxOncallFields(workflow: unknown[] | undefined): OncallTextField[] | undefined {
  if (!workflow?.length || workflow.length > 20) return;
  const fields: OncallTextField[] = [];
  const keys = new Set<string>();
  for (const item of workflow) {
    const field = object(item, ['base', 'custom', 'shown', 'helper', 'validate']);
    const base = object(field?.base, ['key', 'label', 'type', 'disabled', 'ignoreReadonly', 'defaultValue', 'required']);
    if (!base || base.type !== 'input' || typeof base.key !== 'string' || !base.key || keys.has(base.key)
      || typeof base.label !== 'string' || !base.label.trim() || base.label.length > 80) return;
    if ([base.disabled, base.ignoreReadonly].some(value => value !== undefined && literal(value) !== false)
      || (base.defaultValue !== undefined && literal(base.defaultValue) !== '')) return;
    const custom = object(field?.custom, ['valueTrigger']);
    if (field?.custom !== undefined && (!custom || (custom.valueTrigger !== undefined && custom.valueTrigger !== 'onChange'))) return;
    const shown = object(field?.shown, ['exist', 'untouchable']);
    if (field?.shown !== undefined && (!shown || (shown.exist !== undefined && literal(shown.exist) !== true)
      || (shown.untouchable !== undefined && literal(shown.untouchable) !== false))) return;
    const helper = object(field?.helper, ['tooltip', 'help']);
    if (field?.helper !== undefined && (!helper || Object.values(helper).some(value => literal(value) !== ''))) return;
    const validate = object(field?.validate, ['required']);
    if (field?.validate !== undefined && !validate) return;
    const required = [base.required, validate?.required].filter(value => value !== undefined).map(literal);
    if (required.some(value => typeof value !== 'boolean') || new Set(required).size > 1) return;
    keys.add(base.key);
    fields.push({ key: base.key, label: base.label, required: required.includes(true) });
  }
  return fields;
}

export function oncallFieldName(index: number): string {
  return `oncall_field_${index}`;
}

export function serializeBotmuxOncallForm(fields: OncallTextField[], values: Record<string, unknown> = {}): string {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('未收到有效的附加信息，请从表单重新提交');
  return JSON.stringify(Object.fromEntries(fields.map((field, index) => {
    const name = oncallFieldName(index);
    const value = Object.hasOwn(values, name) ? values[name] : '';
    if (typeof value !== 'string' || value.length > ONCALL_FIELD_LIMIT) throw new Error(`请检查「${field.label}」的内容长度`);
    if (field.required && !value.trim()) throw new Error(`请填写「${field.label}」`);
    return [field.key, { value, name: field.key, type: 'input' }];
  })));
}
