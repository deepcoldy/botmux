import { bridgeCodexUserInput, type CodexUserInputContext } from './codex-user-input.js';

type Field = { id: string; prompt: string; multi: boolean; required: boolean;
  options?: Array<{ value: string; label: string }>; other?: Field };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const unsupported = () => new Error('mcode ACP 表单包含不支持或不完整的字段');

/** Accept the native questionnaire's bounded schema subset. Preserve native
 * option ids separately from labels; never infer questions from prose. */
export function parseMinimaxForm(params: unknown): { message: string; fields: Field[] } {
  if (!object(params) || params.mode !== 'form' || !object(params.requestedSchema)) throw unsupported();
  const schema = params.requestedSchema;
  if (schema.type !== 'object' || !object(schema.properties)) throw unsupported();
  const entries = Object.entries(schema.properties);
  if (!entries.length || entries.length > 24 || (schema.required !== undefined
    && (!Array.isArray(schema.required) || schema.required.some((id: unknown) => typeof id !== 'string' || !Object.hasOwn(schema.properties, id))))) throw unsupported();
  const fields: Field[] = entries.map(([id, value]) => {
    if (!id || !object(value) || !['string', 'array'].includes(value.type)) throw unsupported();
    // Constraints outside the native questionnaire shape need a richer form
    // UI. Reject rather than silently accepting a value that violates them.
    const allowed = new Set(['type', 'title', 'description', 'oneOf', 'items', 'default']);
    if (Object.keys(value).some(key => !allowed.has(key))) throw unsupported();
    const multi = value.type === 'array';
    const choices = multi ? value.items?.anyOf : value.oneOf;
    if (multi && (!object(value.items) || Object.keys(value.items).some(key => key !== 'anyOf'))) throw unsupported();
    let options: Field['options'];
    if (choices !== undefined) {
      if (!Array.isArray(choices) || !choices.length || choices.length > 20) throw unsupported();
      const ids = new Set<string>();
      options = choices.map(choice => {
        if (!object(choice) || typeof choice.const !== 'string' || !choice.const || ids.has(choice.const)) throw unsupported();
        ids.add(choice.const);
        return { value: choice.const, label: typeof choice.title === 'string' && choice.title.trim() ? choice.title : choice.const };
      });
      // The existing broker uses visible labels as keys. Make duplicate labels
      // distinct without ever changing the native values sent back to mcode.
      const labels = options.map(o => o.label);
      options = options.map((o, i) => ({ ...o, label: labels.indexOf(o.label) !== labels.lastIndexOf(o.label)
        ? `${o.label} (${i + 1})` : o.label }));
      if (new Set(options.map(o => o.label)).size !== options.length) throw unsupported();
    } else if (multi) throw unsupported();
    const details = Array.isArray(choices) ? choices.filter(c => typeof c.description === 'string' && c.description.trim())
      .map(c => `${c.title ?? c.const}: ${c.description}`) : [];
    return { id, multi, options, required: schema.required?.includes(id) === true,
      prompt: [value.title ?? id, value.description, ...details].filter(v => typeof v === 'string' && v.trim()).join('\n\n') };
  });
  // Native allowOther is represented by a separate, collision-safe field.
  // Only group it when both its id AND generated title establish the link.
  const consumed = new Set<string>();
  for (const field of fields) {
    if (!field.options) continue;
    const prefix = `${field.id}__other`;
    const other = fields.find(f => f.id.startsWith(prefix) && /^_*$/.test(f.id.slice(prefix.length)) && !f.options
      && schema.properties[f.id].title === `${schema.properties[field.id].title} — Other`);
    if (other) { field.other = other; consumed.add(other.id); }
  }
  return { message: typeof params.message === 'string' ? params.message : 'MiniMax Code 需要你的选择',
    fields: fields.filter(f => !consumed.has(f.id)) };
}

type Ask = typeof bridgeCodexUserInput;
/** Reuse the authenticated Ask transport unchanged. Pure choice fields are
 * batched; text fields are asked separately because the broker's custom text
 * reply is one value, not a separate value for every field in a batch. */
export async function bridgeMinimaxForm(context: CodexUserInputContext, params: unknown,
  signal: AbortSignal, ask: Ask = bridgeCodexUserInput): Promise<{ action: 'accept'; content: Record<string, string | string[]> }> {
  const { message, fields } = parseMinimaxForm(params);
  const content: Record<string, string | string[]> = Object.create(null);
  const pendingText: Array<{ field: Field; optional: boolean }> = [];
  const choices = fields.filter(f => f.options);
  const meta = choices.map(field => {
    const labels = field.options!.map(o => o.label);
    const unique = (label: string) => {
      let candidate = label; let suffix = 2;
      while (labels.includes(candidate)) candidate = `${label}（${suffix++}）`;
      labels.push(candidate); return candidate;
    };
    const other = field.other ? unique('填写其他答案') : undefined;
    // allowOther's schema cannot express whether the combined step is
    // required. Always collect an explicit option/Other for that step.
    const skip = !field.required && !field.other && !field.multi ? unique('跳过此项（可选）') : undefined;
    const cancel = labels.length < 2 ? unique('取消本次提问') : undefined;
    return { field, other, skip, cancel, labels };
  });
  if (meta.length) {
    const result = await ask(context, { questions: meta.map(m => ({ id: m.field.id,
      question: [message, m.field.prompt].filter(Boolean).join('\n\n'), multiSelect: m.field.multi,
      options: m.labels.map(label => ({ label })) })) }, signal);
    signal.throwIfAborted();
    for (const m of meta) {
      const values = result.answers[m.field.id]?.answers;
      if (meta.length === 1 && m.field.other && Array.isArray(values) && values.length === 1
        && typeof values[0] === 'string' && values[0].trim() && !m.labels.includes(values[0])) {
        content[m.field.other.id] = values[0];
        continue;
      }
      if (!Array.isArray(values) || values.some(v => !m.labels.includes(v)) || values.includes(m.cancel!)) throw new Error('mcode ACP 提问未获得有效选择；多题请在卡片中逐项作答');
      if (values.includes(m.skip!)) continue;
      const selected = values.flatMap(label => m.field.options!.filter(o => o.label === label).map(o => o.value));
      const wantsOther = values.includes(m.other!);
      if ((m.field.required || m.field.other) && !selected.length && !wantsOther) throw new Error('mcode ACP 必填问题没有答案');
      if (m.field.multi) content[m.field.id] = selected;
      else if (selected.length) content[m.field.id] = selected[0];
      if (wantsOther) pendingText.push({ field: m.field.other!, optional: false });
    }
  }
  pendingText.push(...fields.filter(f => !f.options).map(field => ({ field, optional: !field.required })));
  for (const { field, optional } of pendingText) {
    if (optional) {
      const choice = await ask(context, { questions: [{ id: field.id, question: `${message}\n\n${field.prompt}（可选）`,
        options: [{ label: '填写' }, { label: '跳过' }] }] }, signal);
      if (choice.answers[field.id]?.answers[0] === '跳过') continue;
      if (choice.answers[field.id]?.answers[0] !== '填写') throw new Error('mcode ACP 可选字段未获得有效选择');
    }
    const result = await ask(context, { questions: [{ id: field.id, question: `${message}\n\n${field.prompt}` }] }, signal);
    signal.throwIfAborted();
    const values = result.answers[field.id]?.answers;
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim()) throw new Error('mcode ACP 文本问题没有答案');
    content[field.id] = values[0];
  }
  return { action: 'accept', content };
}

export async function bridgeMinimaxPermission(context: CodexUserInputContext, params: unknown,
  signal: AbortSignal, ask: Ask = bridgeCodexUserInput): Promise<{ outcome: { outcome: 'selected'; optionId: string } }> {
  if (!object(params) || !Array.isArray(params.options) || params.options.length < 2 || params.options.length > 10) throw unsupported();
  const ids = new Set<string>();
  const options = params.options.map((option: unknown, i: number) => {
    if (!object(option) || typeof option.optionId !== 'string' || !option.optionId || ids.has(option.optionId)) throw unsupported();
    ids.add(option.optionId);
    return { id: option.optionId, label: `${typeof option.name === 'string' ? option.name : option.optionId} (${i + 1})` };
  });
  const title = typeof params.toolCall?.title === 'string' ? params.toolCall.title : '执行工具';
  const result = await ask(context, { questions: [{ id: 'permission', question: `MiniMax Code 请求权限：${title}`,
    options: options.map(o => ({ label: o.label })) }] }, signal);
  const selected = options.find(o => o.label === result.answers.permission?.answers[0]);
  if (!selected) throw new Error('mcode ACP 权限请求没有有效答案');
  return { outcome: { outcome: 'selected', optionId: selected.id } };
}
