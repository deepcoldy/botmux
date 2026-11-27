import type { PendingAsk, AskResult } from '../../core/ask-types.js';
import { t, type Locale } from '../../i18n/index.js';
import {
  askEyebrow, askFooter, askForm, buildAskSettledBody, deadlineText, optionControls, questionBlock, questionHeading,
  submitButton, submittedByLine, type AskDensity,
} from './ask-card-look.js';

// Shared by standalone and inline cards. Choice changes stay client-side inside
// ONE Card 2.0 form: no toggle callback/repaint may discard an unfinished input.
const safe = (s: string) => s.replace(/[\\`*_[\]<>!~&]/g, c => `\\${c}`);
const plain = (content: string) => ({ tag: 'plain_text', content });
const grey = (text: string) => `<font color='grey'>${text}</font>`;

export interface AskFormOptions {
  /** A ready `<at>` tag, drawn only while unsettled. */
  mention?: string;
  /** Limits each option description (the standalone card's byte budget). */
  descriptionCap?: number;
  density?: AskDensity;
}

/**
 * Body of an input form Ask (`question.input`), without header: the questions in one form
 * (inputs, and checker rows for choice questions), one submit, and the footer. Settled: each
 * question with its submitted value.
 */
export function renderAskFormBody(ask: PendingAsk, locale: Locale, result?: AskResult, valueCap = 300,
  extras: AskFormOptions = {}): { elements: Array<Record<string, any>>; descriptionsTruncated: boolean } {
  const en = locale === 'en';
  const descriptionCap = extras.descriptionCap ?? Infinity;
  const total = ask.questions.length;
  const ownerMayAnswer = ask.ownerAnswererOpenId && ask.ownerAnswererOpenId !== ask.answererOpenId;
  const who = ask.answererOpenId ? ownerMayAnswer
    ? t('card.ask.footer.designated_or_owner', undefined, locale)
    : (en ? 'Only the designated respondent may submit' : '仅指定答题人可提交')
    : (en ? 'Members allowed to talk to this bot may answer; this does not grant business approval' : '本会话可对话成员可作答；不代表具备业务批准权');
  if (result) {
    const detail = result.kind === 'timedOut' ? (en ? 'Timed out — no approval was given.' : '等待已超时，未获得确认。')
      : result.kind === 'invalidated' ? `${en ? 'Invalidated' : '已失效'}：${safe(result.reason.length > valueCap ? `${result.reason.slice(0, valueCap)}…` : result.reason)}`
        : undefined;
    const body = buildAskSettledBody(ask, result, { locale, prompt: safe, descriptionCap, valueCap, detail, density: extras.density });
    return { descriptionsTruncated: body.descriptionsTruncated, elements: [...body.elements, askFooter(result.kind === 'answered'
      ? submittedByLine(result.by, ask, locale) : grey(`${deadlineText(ask, locale)} · ${who}`))] };
  }
  const density = extras.density ?? 'rows';
  let descriptionsTruncated = false;
  const blocks = ask.questions.flatMap((q, i) => {
    const children: Array<Record<string, any>> = [];
    if (q.input) {
      children.push(askEyebrow(q, locale, q.input.required === false ? 'card.ask.how.optional' : 'card.ask.how.required'));
      children.push(...questionHeading(safe(q.prompt), i, total));
      // number uses text transport intentionally: validate decimals server-side
      // without coercion/precision loss or inventing a platform-specific widget.
      children.push({ tag: 'input', name: `q${i}`, input_type: q.input.type === 'number' ? 'text' : 'multiline_text',
        width: 'fill', required: q.input.required !== false, max_length: q.input.maxLength ?? 1000,
        placeholder: plain(q.input.placeholder ?? (q.input.type === 'number' ? (en ? 'Enter a number' : '请输入数值') : (en ? 'Enter your answer' : '请输入内容'))) });
    } else {
      children.push(askEyebrow(q, locale, q.multiSelect ? 'card.ask.how.multi' : 'card.ask.how.single'));
      children.push(...questionHeading(safe(q.prompt), i, total));
      const selected = new Set(ask.selections?.[i] ?? q.defaultSelectedKeys ?? []);
      const controls = optionControls(q, i, selected, locale, density, descriptionCap);
      descriptionsTruncated ||= controls.truncated;
      children.push(...controls.elements);
    }
    return density === 'bare' ? children.filter(child => child.text_size !== 'notation') : [questionBlock(children)];
  });
  const submit = submitButton('ask_form_submit', t('card.ask.submit', undefined, locale),
    { action: 'ask_form_submit', ask_id: ask.askId, nonce: ask.nonce });
  return { descriptionsTruncated, elements: [
    ...(extras.mention ? [{ tag: 'markdown', content: extras.mention }] : []),
    askForm(ask, [...blocks, submit]),
    askFooter(grey(`${deadlineText(ask, locale)} · ${who}`), [
      en ? 'Submit choices and inputs together. A chat reply replaces the whole form; unsent defaults are not answers.'
        : '选项与输入一起提交。也可在话题里写完整答案替代整张表单；未提交的预选不算回答。',
      descriptionsTruncated ? t('card.ask.descriptions_truncated', undefined, locale) : '',
    ]),
  ] };
}

export function buildAskFormElements(ask: PendingAsk, locale: Locale, result?: AskResult, valueCap = 300,
  extras: AskFormOptions = {}): Array<Record<string, any>> {
  return renderAskFormBody(ask, locale, result, valueCap, extras).elements;
}
