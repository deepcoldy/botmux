export interface OncallCardField {
  key: string;
  label: string;
  required: boolean;
  requiredMessage?: string;
  /** Missing on persisted single-line fields from older versions. */
  type?: 'input' | 'textArea' | 'radio' | 'select';
  options?: { value: string | number | boolean; label: string }[];
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
export function botmuxOncallFields(workflow: unknown[] | undefined, onUnsupported?: (reason: string) => void): OncallCardField[] | undefined {
  const unsupported = (reason: string): undefined => { onUnsupported?.(reason); return undefined; };
  if (!workflow) return unsupported('未取得完整表单定义，需要在 Oncall 侧栏填写。');
  if (!workflow.length) return;
  if (workflow.length > 20) return unsupported('表单超过 20 个字段，需要在 Oncall 侧栏填写。');
  const fields: OncallCardField[] = [];
  const keys = new Set<string>();
  for (const item of workflow) {
    const field = object(item, ['base', 'custom', 'shown', 'helper', 'validate', 'validations']);
    const base = object(field?.base, ['key', 'label', 'type', 'disabled', 'ignoreReadonly', 'defaultValue', 'required']);
    if (!base || typeof base.key !== 'string' || !base.key || keys.has(base.key)
      || typeof base.label !== 'string' || !base.label.trim() || base.label.length > 80) {
      return unsupported('表单含无法识别的字段配置，需要在 Oncall 侧栏填写。');
    }
    const type = base.type;
    const fail = (detail: string) => unsupported(`「${base.label}」${detail}，需要在 Oncall 侧栏填写。`);
    if (!['input', 'textArea', 'radio', 'select'].includes(type as string)) {
      const names: Record<string, string> = { imageUpload: '图片上传', fileUpload: '文件上传', subForm: '子表单' };
      return fail(`使用了分类卡暂不支持的${names[String(type)] ?? '字段类型'}`);
    }
    if ([base.disabled, base.ignoreReadonly].some(value => value !== undefined && literal(value) !== false)
      || (base.defaultValue !== undefined && ![undefined, ''].includes(literal(base.defaultValue) as undefined | string))) {
      return fail('含只读或预填配置');
    }
    const choice = type === 'radio' || type === 'select';
    const custom = object(field?.custom, choice
      ? ['valueType', 'isRemoteOptions', 'customOptions', 'selectFirst', 'itemStyle', 'valueTrigger',
        ...(type === 'select' ? ['isMultiple', 'allowCreate', 'checkValueInOptions', 'complete'] : [])] : ['valueTrigger']);
    if (field?.custom !== undefined && (!custom || (custom.valueTrigger !== undefined && custom.valueTrigger !== 'onChange'))) {
      return fail('含未支持的控件配置');
    }
    const shown = object(field?.shown, ['exist', 'untouchable']);
    if (field?.shown !== undefined && (!shown || (shown.exist !== undefined && literal(shown.exist) !== true)
      || (shown.untouchable !== undefined && literal(shown.untouchable) !== false))) return fail('含条件显隐');
    const helper = object(field?.helper, ['tooltip', 'help']);
    if (field?.helper !== undefined && (!helper || Object.values(helper).some(value => literal(value) !== ''))) return fail('含附加帮助配置');
    const validate = object(field?.validate, ['required']);
    if (field?.validate !== undefined && !validate) return fail('含未支持的校验规则');
    const required = [base.required, validate?.required].filter(value => value !== undefined).map(literal);
    let requiredMessage: string | undefined;
    if (field?.validations !== undefined) {
      if (!Array.isArray(field.validations)) return fail('含无法识别的校验规则');
      for (const rule of field.validations) {
        const validation = object(rule, ['type', 'message']);
        if (!validation || validation.type !== 'required'
          || (validation.message !== undefined && typeof validation.message !== 'string')) return fail('含未支持的校验规则');
        required.push(true);
        if (typeof validation.message === 'string' && validation.message.trim()) requiredMessage ??= validation.message;
      }
    }
    if (required.some(value => typeof value !== 'boolean') || new Set(required).size > 1) return fail('含不一致的必填规则');
    let options: OncallCardField['options'];
    if (choice) {
      if (!custom || (custom.isRemoteOptions !== undefined && custom.isRemoteOptions !== false)
        || (custom.valueType !== undefined && custom.valueType !== 'unset')
        || (custom.selectFirst !== undefined && custom.selectFirst !== false)
        || (custom.itemStyle !== undefined && custom.itemStyle !== 'default')
        || [custom.isMultiple, custom.allowCreate, custom.complete].some(value => value !== undefined && value !== false)
        || (custom.checkValueInOptions !== undefined && typeof custom.checkValueInOptions !== 'boolean')
        || !Array.isArray(custom.customOptions) || !custom.customOptions.length || custom.customOptions.length > 100) {
        return fail('含动态选项或未支持的选择配置');
      }
      options = [];
      const values = new Set<string>();
      for (const item of custom.customOptions) {
        const option = object(item, ['value', 'displayName']);
        if (!option || !['string', 'number', 'boolean'].includes(typeof option.value)
          || (typeof option.value === 'string' && !option.value.trim())
          || (typeof option.value === 'number' && !Number.isFinite(option.value))
          || typeof option.displayName !== 'string' || !option.displayName.trim() || option.displayName.length > 80
          || values.has(JSON.stringify(option.value))) return fail('含重复、动态或无效选项');
        values.add(JSON.stringify(option.value));
        options.push({ value: option.value as string | number | boolean, label: option.displayName });
      }
    }
    keys.add(base.key);
    fields.push({ key: base.key, label: base.label, required: required.includes(true),
      ...(requiredMessage ? { requiredMessage } : {}),
      ...(type !== 'input' ? { type: type as OncallCardField['type'] } : {}), ...(options ? { options } : {}) });
  }
  return fields;
}

export function oncallFieldName(index: number): string {
  return `oncall_field_${index}`;
}

export function oncallOptionValue(index: number): string { return `oncall_option_${index}`; }

export function serializeBotmuxOncallForm(fields: OncallCardField[], values: Record<string, unknown> = {}): string {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('未收到有效的附加信息，请从表单重新提交');
  return JSON.stringify(Object.fromEntries(fields.map((field, index) => {
    const name = oncallFieldName(index);
    let value = Object.hasOwn(values, name) ? values[name] : '';
    if (field.type === 'radio' || field.type === 'select') {
      if (value === undefined || value === null || value === '') {
        if (field.required) throw new Error(field.requiredMessage ?? `请选择「${field.label}」`);
        return [field.key, { name: field.key, type: field.type }];
      }
      const option = field.options?.find((_, index) => oncallOptionValue(index) === value);
      if (!option) throw new Error(`请重新选择「${field.label}」`);
      value = option.value;
    } else {
      if (typeof value !== 'string' || [...value].length > ONCALL_FIELD_LIMIT) throw new Error(`请检查「${field.label}」的内容长度`);
      if (field.required && !value.trim()) throw new Error(field.requiredMessage ?? `请填写「${field.label}」`);
    }
    return [field.key, { value, name: field.key, type: field.type ?? 'input' }];
  })));
}
