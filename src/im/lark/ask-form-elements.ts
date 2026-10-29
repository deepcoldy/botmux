import type { PendingAsk, AskResult } from '../../core/ask-types.js';
import type { Locale } from '../../i18n/index.js';

// Shared by standalone and inline cards. Choice changes stay client-side inside
// ONE Card 2.0 form: no toggle callback/repaint may discard an unfinished input.
const safe = (s: string) => s.replace(/[\\`*_[\]<>!~&]/g, c => `\\${c}`);
const plain = (content: string) => ({ tag: 'plain_text', content });

export function buildAskFormElements(ask: PendingAsk, locale: Locale, result?: AskResult, valueCap = 300): Array<Record<string, any>> {
  const en = locale === 'en';
  const displayValue = (value: string) => {
    if (value.length <= valueCap) return value;
    let head = value.slice(0, valueCap);
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    return head + (en ? '… (full answer returned to caller)' : '…（完整答案已返回调用方）');
  };
  const elements: Array<Record<string, any>> = [{ tag: 'markdown', content:
    `${en ? 'Deadline' : '等待截止'}：${new Date(ask.deadlineAt).toLocaleString(en ? 'en-US' : 'zh-CN')}\n`
    + (ask.answererOpenId ? (en ? 'Only the designated respondent may submit.' : '仅指定答题人可提交。')
      : (en ? 'Members allowed to talk to this bot may answer; this does not grant business approval.' : '本会话可对话成员可作答；不代表具备业务批准权。')) }];
  if (result) {
    for (const [i, q] of ask.questions.entries()) {
      const value = result.kind === 'answered'
        ? result.inputs?.[i] ?? result.answers[i]?.map(k => q.options.find(o => o.key === k)?.label ?? k).join(', ') : '';
      elements.push({ tag: 'markdown', content: `**${safe(q.prompt)}**${value ? `\n${safe(displayValue(value))}` : ''}` });
    }
    if (result.kind === 'answered') {
      if (result.comment) elements.push({ tag: 'markdown', content: safe(displayValue(result.comment)) });
      elements.push({ tag: 'markdown', content: `${en ? 'Submitted by' : '已提交，答题人'}：${safe(result.by)}` });
    } else elements.push({ tag: 'markdown', content: result.kind === 'timedOut'
      ? (en ? 'Timed out — no approval was given.' : '等待已超时，未获得确认。')
      : `${en ? 'Invalidated' : '已失效'}：${safe(displayValue(result.reason))}` });
    return elements;
  }
  const fields: Array<Record<string, any>> = [];
  ask.questions.forEach((q, i) => {
    fields.push({ tag: 'markdown', content: `**${safe(q.prompt)}**${q.input?.required === false ? (en ? ' (optional)' : '（选填）') : ''}` });
    if (q.input) {
      // number uses text transport intentionally: validate decimals server-side
      // without coercion/precision loss or inventing a platform-specific widget.
      fields.push({ tag: 'input', name: `q${i}`, input_type: q.input.type === 'number' ? 'text' : 'multiline_text',
        width: 'fill', required: q.input.required !== false, max_length: q.input.maxLength ?? 1000,
        placeholder: plain(q.input.placeholder ?? (q.input.type === 'number' ? (en ? 'Enter a number' : '请输入数值') : (en ? 'Enter your answer' : '请输入内容'))) });
    } else {
      fields.push({ tag: q.multiSelect ? 'multi_select_static' : 'select_static', name: `q${i}`, width: 'fill',
        required: !q.multiSelect, placeholder: plain(en ? 'Choose' : '请选择'),
        options: q.options.map(o => ({ text: plain(o.label), value: o.key })),
        ...(q.defaultSelectedKeys?.length ? q.multiSelect ? { selected_values: [...q.defaultSelectedKeys] }
          : { initial_option: q.defaultSelectedKeys[0] } : {}) });
    }
  });
  fields.push({ tag: 'button', name: 'ask_form_submit', type: 'primary', form_action_type: 'submit',
    text: plain(en ? 'Submit and continue' : '提交并继续'),
    behaviors: [{ type: 'callback', value: { action: 'ask_form_submit', ask_id: ask.askId, nonce: ask.nonce } }] });
  elements.push({ tag: 'form', name: 'ask_form', elements: fields });
  elements.push({ tag: 'markdown', text_size: 'notation', content: en
    ? 'Submit choices and inputs together. A chat reply replaces the whole form; unsent defaults are not answers.'
    : '选项与输入一起提交。也可在话题里写完整答案替代整张表单；未提交的预选不算回答。' });
  return elements;
}
