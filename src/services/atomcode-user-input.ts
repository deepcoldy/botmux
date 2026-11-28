import { bridgeCodexUserInput, type CodexUserInputContext } from './codex-user-input.js';

type OptionChoice = { value: string; label: string; description?: string };
type Field = {
  id: string;
  prompt: string;
  multi: boolean;
  required: boolean;
  options?: OptionChoice[];
};

const isObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const unsupported = () => new Error('atomcode ACP 表单包含不支持或不完整的字段');

function parseChoices(rawEnum: unknown, rawTitled: unknown): OptionChoice[] | undefined {
  if (rawEnum !== undefined && rawTitled !== undefined) throw unsupported();
  if (rawEnum !== undefined) {
    if (!Array.isArray(rawEnum) || !rawEnum.length || rawEnum.length > 20) throw unsupported();
    const seen = new Set<string>();
    return rawEnum.map(item => {
      if (typeof item !== 'string' || !item.trim() || seen.has(item)) throw unsupported();
      seen.add(item);
      return { value: item, label: item };
    });
  }
  if (rawTitled !== undefined) {
    if (!Array.isArray(rawTitled) || !rawTitled.length || rawTitled.length > 20) throw unsupported();
    const seen = new Set<string>();
    return rawTitled.map(item => {
      if (!isObject(item) || typeof item.const !== 'string' || !item.const || seen.has(item.const)) {
        throw unsupported();
      }
      seen.add(item.const);
      const label = typeof item.title === 'string' && item.title.trim() ? item.title : item.const;
      const description = typeof item.description === 'string' && item.description.trim()
        ? item.description.trim()
        : undefined;
      return { value: item.const, label, description };
    });
  }
  return undefined;
}

function disambiguateLabels(options: OptionChoice[]): OptionChoice[] {
  const labels = options.map(o => o.label);
  const disambiguated = options.map((o, i) => ({
    ...o,
    label: labels.indexOf(o.label) !== labels.lastIndexOf(o.label) ? `${o.label} (${i + 1})` : o.label,
  }));
  if (new Set(disambiguated.map(o => o.label)).size !== disambiguated.length) throw unsupported();
  return disambiguated;
}

/** Parse AtomCode's ACP form elicitation schema (JSON Schema enum/items.enum as
 *  well as titled oneOf/anyOf). Fail closed on unsupported shapes. */
export function parseAtomcodeForm(params: unknown): { message: string; fields: Field[] } {
  if (!isObject(params) || params.mode !== 'form' || !isObject(params.requestedSchema)) {
    throw unsupported();
  }
  const schema = params.requestedSchema;
  if (schema.type !== 'object' || !isObject(schema.properties)) throw unsupported();
  const entries = Object.entries(schema.properties);
  if (
    !entries.length
    || entries.length > 24
    || (schema.required !== undefined && (
      !Array.isArray(schema.required)
      || schema.required.some((id: unknown) => typeof id !== 'string' || !Object.hasOwn(schema.properties, id))
    ))
  ) {
    throw unsupported();
  }

  const allowedPropKeys = new Set(['type', 'title', 'description', 'enum', 'oneOf', 'items', 'default', 'uniqueItems']);
  const allowedItemKeys = new Set(['type', 'enum', 'anyOf']);

  const fields: Field[] = entries.map(([id, value]) => {
    if (!id || !isObject(value) || !['string', 'array'].includes(value.type)) throw unsupported();
    if (Object.keys(value).some(key => !allowedPropKeys.has(key))) throw unsupported();
    const multi = value.type === 'array';
    let options: OptionChoice[] | undefined;
    if (multi) {
      if (value.enum !== undefined || value.oneOf !== undefined) throw unsupported();
      if (!isObject(value.items) || Object.keys(value.items).some(key => !allowedItemKeys.has(key))) {
        throw unsupported();
      }
      if (value.items.type !== undefined && value.items.type !== 'string') throw unsupported();
      options = parseChoices(value.items.enum, value.items.anyOf);
      if (!options) throw unsupported();
    } else {
      if (value.items !== undefined || value.uniqueItems !== undefined) throw unsupported();
      options = parseChoices(value.enum, value.oneOf);
    }
    if (options) options = disambiguateLabels(options);
    const details = (options ?? [])
      .filter(o => o.description)
      .map(o => `${o.label}: ${o.description}`);
    const prompt = [value.title ?? id, value.description, ...details]
      .filter(part => typeof part === 'string' && part.trim())
      .join('\n\n');
    return {
      id,
      multi,
      options,
      required: schema.required?.includes(id) === true,
      prompt,
    };
  });

  return {
    message: typeof params.message === 'string' && params.message.trim()
      ? params.message.trim()
      : 'AtomCode 需要你的选择',
    fields,
  };
}

type Ask = typeof bridgeCodexUserInput;

export async function bridgeAtomcodeForm(
  context: CodexUserInputContext,
  params: unknown,
  signal: AbortSignal,
  ask: Ask = bridgeCodexUserInput,
): Promise<{ action: 'accept'; content: Record<string, string | string[]> }> {
  const { message, fields } = parseAtomcodeForm(params);
  const content: Record<string, string | string[]> = Object.create(null);
  const choiceFields = fields.filter(f => f.options);
  const meta = choiceFields.map(field => {
    const labels = field.options!.map(o => o.label);
    const unique = (label: string) => {
      let candidate = label;
      let suffix = 2;
      while (labels.includes(candidate)) candidate = `${label}（${suffix++}）`;
      labels.push(candidate);
      return candidate;
    };
    const skip = !field.required && !field.multi ? unique('跳过此项（可选）') : undefined;
    const cancel = labels.length < 2 ? unique('取消本次提问') : undefined;
    return { field, skip, cancel, labels };
  });

  if (meta.length) {
    const result = await ask(context, {
      questions: meta.map(m => ({
        id: m.field.id,
        question: [message, m.field.prompt].filter(Boolean).join('\n\n'),
        multiSelect: m.field.multi,
        options: m.labels.map(label => ({ label })),
      })),
    }, signal);
    signal.throwIfAborted();
    for (const m of meta) {
      const values = result.answers[m.field.id]?.answers;
      if (!Array.isArray(values) || values.some(v => !m.labels.includes(v)) || (m.cancel && values.includes(m.cancel))) {
        throw new Error('atomcode ACP 提问未获得有效选择；多题请在卡片中逐项作答');
      }
      if (m.skip && values.includes(m.skip)) continue;
      const selected = values.flatMap(label => m.field.options!.filter(o => o.label === label).map(o => o.value));
      if (m.field.required && !selected.length) {
        throw new Error('atomcode ACP 必填问题没有答案');
      }
      if (m.field.multi) content[m.field.id] = selected;
      else if (selected.length) content[m.field.id] = selected[0];
    }
  }

  for (const field of fields.filter(f => !f.options)) {
    if (!field.required) {
      const choice = await ask(context, {
        questions: [{
          id: field.id,
          question: `${message}\n\n${field.prompt}（可选）`,
          options: [{ label: '填写' }, { label: '跳过' }],
        }],
      }, signal);
      if (choice.answers[field.id]?.answers[0] === '跳过') continue;
      if (choice.answers[field.id]?.answers[0] !== '填写') {
        throw new Error('atomcode ACP 可选字段未获得有效选择');
      }
    }
    const result = await ask(context, {
      questions: [{ id: field.id, question: `${message}\n\n${field.prompt}` }],
    }, signal);
    signal.throwIfAborted();
    const values = result.answers[field.id]?.answers;
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim()) {
      throw new Error('atomcode ACP 文本问题没有答案');
    }
    content[field.id] = values[0];
  }

  return { action: 'accept', content };
}

function summarizeRawInput(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return '';
  try {
    const text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
    const trimmed = text.trim();
    if (!trimmed || trimmed === '{}') return '';
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  } catch {
    return '';
  }
}

export async function bridgeAtomcodePermission(
  context: CodexUserInputContext,
  params: unknown,
  signal: AbortSignal,
  ask: Ask = bridgeCodexUserInput,
): Promise<{ outcome: { outcome: 'selected'; optionId: string } }> {
  if (!isObject(params) || !Array.isArray(params.options) || params.options.length < 2 || params.options.length > 10) {
    throw unsupported();
  }
  const ids = new Set<string>();
  const options = params.options.map((option: unknown, i: number) => {
    if (!isObject(option) || typeof option.optionId !== 'string' || !option.optionId || ids.has(option.optionId)) {
      throw unsupported();
    }
    ids.add(option.optionId);
    return {
      id: option.optionId,
      label: `${typeof option.name === 'string' && option.name.trim() ? option.name.trim() : option.optionId} (${i + 1})`,
    };
  });
  const title = typeof params.toolCall?.title === 'string' && params.toolCall.title.trim()
    ? params.toolCall.title.trim()
    : '执行工具';
  const inputSummary = summarizeRawInput(params.toolCall?.rawInput);
  const question = inputSummary
    ? `AtomCode 请求权限：${title}\n\n参数：${inputSummary}`
    : `AtomCode 请求权限：${title}`;
  const result = await ask(context, {
    questions: [{ id: 'permission', question, options: options.map(o => ({ label: o.label })) }],
  }, signal);
  const selected = options.find(o => o.label === result.answers.permission?.answers[0]);
  if (!selected) throw new Error('atomcode ACP 权限请求没有有效答案');
  return { outcome: { outcome: 'selected', optionId: selected.id } };
}
