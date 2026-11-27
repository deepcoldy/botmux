import type { AskOption, AskQuestion, AskResult, PendingAsk } from '../../core/ask-types.js';
import { isNativeAsyncAskOrigin } from '../../core/ask-types.js';
import { ASK_CUSTOM_MAX_LENGTH, supportsAskCustomInput } from '../../core/ask-custom-input.js';
import { hasAskForm } from '../../core/ask-form.js';
import { isHookPermissionAsk, permissionAnswerAllows } from '../../core/ask-hook/types.js';
import { t, type Locale } from '../../i18n/index.js';
import { parseLinkDestination } from 'markdown-it/lib/helpers/index.mjs';
import { capChars, escapeOptionText } from './ask-option-descriptions.js';

/**
 * The look shared by every Ask surface (standalone card, input form, Ask embedded in a reply card):
 * one grey block per question, one white row per option holding a checker, an optional "write your
 * own" input, one full-width submit button for the whole form, and a small grey footer. Ticking is
 * local in the client; the form is answered by one submit carrying every checker and input.
 */

type El = Record<string, any>;

/** Feishu Card JSON 2.0 accepts at most 200 elements or components per card (text objects count). */
export const ASK_CARD_ELEMENT_LIMIT = 200;

/** Custom colour `qblock` behind each question; the reply card adds it to its config when it embeds an Ask. */
export const ASK_CARD_COLORS = {
  qblock: { light_mode: 'rgba(242,243,245,1)', dark_mode: 'rgba(255,255,255,0.07)' },
} as const;

export function askCardConfig(): El {
  return { width_mode: 'fill', update_multi: true, style: { color: ASK_CARD_COLORS } };
}

/** Elements counted the conservative way: every object carrying a `tag`, text objects included. */
export function countCardElements(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const own = !Array.isArray(value) && typeof (value as El).tag === 'string' ? 1 : 0;
  return own + Object.values(value).reduce<number>((sum, child) => sum + countCardElements(child), 0);
}

/**
 * How much structure each option gets, from the approved look down to what still fits a very
 * large Ask under the element limit: `rows` (white row per option), `compact` (bare checker per
 * option), `dropdown` (one select per question, descriptions go to the attachment), `bare`
 * (dropdowns without the grey blocks and kind labels), and finally `list`: every question and
 * option as text in one block, answered by a chat reply (the existing whole-Ask text answer).
 */
export type AskDensity = 'rows' | 'compact' | 'dropdown' | 'bare' | 'list';
export const ASK_DENSITIES: readonly AskDensity[] = ['rows', 'compact', 'dropdown', 'bare', 'list'];

/**
 * Last-resort body for an Ask too large for any control: one Markdown block listing each
 * question and its options (with descriptions); the footer asks for a chat reply instead.
 */
export function buildAskListBody(ask: PendingAsk, options: { locale: Locale; prompt: (text: string) => string; descriptionCap: number }):
  { elements: El[]; descriptionsTruncated: boolean } {
  let descriptionsTruncated = false;
  const blocks = ask.questions.map((q, i) => {
    const lines = q.options.map(o => {
      const text = optionContent(q, o, options.locale, options.descriptionCap);
      descriptionsTruncated ||= text.truncated;
      return `• ${text.content.replace(/\n/g, '\n   ')}`;
    });
    const [first = '', ...rest] = options.prompt(q.prompt).trim().split('\n');
    return [`${ask.questions.length > 1 ? `${i + 1}\\. ` : ''}${first.trim()}`, ...rest, ...lines].join('\n');
  });
  return { descriptionsTruncated, elements: [{ tag: 'markdown', content: blocks.join('\n\n') }] };
}

/** Which control set an unsettled Ask gets. */
export type AskPresentation = 'input_form' | 'form' | 'quick' | 'text_reply';

/**
 * - `input_form`: explicit inputs (`question.input`), answered by `ask_form_submit`.
 * - `quick`: one single-choice question without own-answer input or defaults: a click answers.
 * - `text_reply`: a batch with a chat-only text question and no own-answer input: answered by a reply.
 * - `form`: everything else, one submit for all ticks and texts.
 */
export function askPresentation(ask: Pick<PendingAsk, 'originKind' | 'questions'>): AskPresentation {
  if (hasAskForm(ask.questions)) return 'input_form';
  if (supportsAskCustomInput(ask)) return 'form';
  if (ask.questions.some(q => q.inputMode === 'text')) return 'text_reply';
  const [only] = ask.questions;
  if (ask.questions.length === 1 && !only!.multiSelect && only!.defaultSelectedKeys === undefined) return 'quick';
  return 'form';
}

const RECOMMENDED_MARKER = /\s*[（(]\s*(?:推荐|recommended)\s*[）)]\s*$/i;

/** A trailing 「（推荐）」 / "(Recommended)" marker is shown as a tag instead; answers keep the original label. */
export function recommendedLabel(label: string): { label: string; recommended: boolean } {
  const stripped = label.replace(RECOMMENDED_MARKER, '');
  if (stripped === label) return { label, recommended: false };
  return { label: stripped.trim() ? stripped : label, recommended: true };
}

const plain = (content: string): El => ({ tag: 'plain_text', content });
const grey = (text: string) => `<font color='grey'>${text}</font>`;
const greyLines = (text: string) => text.split('\n').map(line => line.trim() ? grey(line) : line).join('\n');

/** Answerer-written text: shown literally, never as markup or a mention. */
export function escapeAnswerText(text: string): string {
  return text.replace(/[\\`*_~[\]]/g, c => `\\${c}`).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function isRecommended(q: AskQuestion, option: AskOption): boolean {
  return recommendedLabel(option.label || option.key).recommended || !!q.defaultSelectedKeys?.includes(option.key);
}

/** Regular-weight `label [推荐]` plus the description in grey; `descriptionCap` limits the description. */
export function optionContent(q: AskQuestion, option: AskOption, locale: Locale, descriptionCap = Infinity,
  options: { withDescription?: boolean } = {}): { content: string; truncated: boolean } {
  const label = escapeOptionText(recommendedLabel(option.label || option.key).label.trim() || option.key);
  const tag = isRecommended(q, option) ? ` <text_tag color='green'>${t('card.ask.recommended', undefined, locale)}</text_tag>` : '';
  const description = option.description ?? '';
  if (!description || options.withDescription === false) return { content: `${label}${tag}`, truncated: false };
  const truncated = description.length > descriptionCap;
  const shown = truncated ? (descriptionCap > 0 ? `${capChars(description, descriptionCap)}…` : '') : description;
  return { content: `${label}${tag}${shown ? `\n${greyLines(escapeOptionText(shown))}` : ''}`, truncated };
}

function kindOf(q: AskQuestion): { kind: string; color: 'blue' | 'orange' } {
  if (q.input) return { kind: q.input.type === 'number' ? 'card.ask.kind.input_number' : 'card.ask.kind.input_text', color: 'blue' };
  if (q.inputMode === 'text' || !q.options.length) return { kind: 'card.ask.kind.text', color: 'blue' };
  return q.multiSelect ? { kind: 'card.ask.kind.multi', color: 'orange' } : { kind: 'card.ask.kind.single', color: 'blue' };
}

/** Small coloured label above a question: its kind, and on an open card how to answer it. */
export function askEyebrow(q: AskQuestion, locale: Locale, how?: string): El {
  const { kind, color } = kindOf(q);
  const text = t(kind, undefined, locale);
  return { tag: 'markdown', text_size: 'notation',
    content: `<font color='${color}'>**${how ? `${text} · ${t(how, undefined, locale)}` : text}**</font>` };
}

/** The question in heading size without bold, numbered when the Ask has several; lines after the first stay normal size. */
export function questionHeading(prompt: string, index: number, total: number): El[] {
  const [first = '', ...rest] = prompt.trim().split('\n');
  // Keep the visible number literal now that it is no longer inside a bold span.
  const heading: El = { tag: 'markdown', text_size: 'heading', margin: '0px 0px -2px 0px',
    content: `${total > 1 ? `${index + 1}\\. ` : ''}${first.trim()}` };
  const more = rest.join('\n').trim();
  return more ? [heading, { tag: 'markdown', text_size: 'normal', content: more }] : [heading];
}

export function questionBlock(elements: El[]): El {
  return { tag: 'column_set', flex_mode: 'none', background_style: 'qblock', columns: [{
    tag: 'column', width: 'weighted', weight: 1, padding: '12px 8px 8px 8px', vertical_spacing: '6px', elements,
  }] };
}

export const checkerName = (questionIndex: number, optionIndex: number) => `opt_${questionIndex}_${optionIndex}`;
export const pickName = (questionIndex: number) => `pick_${questionIndex}`;

/** Option controls of one question at a density: checker rows, bare checkers, or one select. */
export function optionControls(q: AskQuestion, questionIndex: number, selected: ReadonlySet<string>, locale: Locale,
  density: AskDensity, descriptionCap: number): { elements: El[]; truncated: boolean } {
  if (density === 'dropdown' || density === 'bare') {
    const keys = q.options.filter(o => selected.has(o.key)).map(o => o.key);
    return { truncated: q.options.some(o => o.description), elements: [{
      tag: q.multiSelect ? 'multi_select_static' : 'select_static', name: pickName(questionIndex), width: 'fill',
      placeholder: plain(t('card.ask.pick_placeholder', undefined, locale)),
      options: q.options.map(o => {
        const shown = recommendedLabel(o.label || o.key).label.trim() || o.key;
        return { text: plain(isRecommended(q, o) ? `${shown} · ${t('card.ask.recommended', undefined, locale)}` : shown), value: o.key };
      }),
      ...(keys.length ? q.multiSelect ? { selected_values: keys } : { initial_option: keys[0] } : {}),
    }] };
  }
  let truncated = false;
  const elements = q.options.map((option, j) => {
    const text = optionContent(q, option, locale, descriptionCap);
    truncated ||= text.truncated;
    const checker = { tag: 'checker', name: checkerName(questionIndex, j), checked: selected.has(option.key),
      overall_checkable: true, text: { tag: 'lark_md', content: text.content } };
    return density === 'compact' ? checker : { tag: 'column_set', flex_mode: 'none', background_style: 'bg-white', columns: [{
      tag: 'column', width: 'weighted', weight: 1, padding: '8px 10px 8px 10px', elements: [checker],
    }] };
  });
  return { elements, truncated };
}

export function customInput(questionIndex: number, value: string, locale: Locale, textQuestion: boolean): El {
  return { tag: 'input', name: `custom_${questionIndex}`, width: 'fill', max_length: ASK_CUSTOM_MAX_LENGTH, default_value: value,
    placeholder: plain(t(textQuestion ? 'card.ask.text_placeholder' : 'card.ask.custom_placeholder', undefined, locale)) };
}

export function submitButton(name: string, label: string, value: Record<string, string>, danger = false): El {
  return { tag: 'button', name, type: danger ? 'danger_filled' : 'primary_filled', width: 'fill', text: plain(label),
    form_action_type: 'submit', behaviors: [{ type: 'callback', value }] };
}

export function askForm(ask: Pick<PendingAsk, 'askId'>, elements: El[]): El {
  return { tag: 'form', name: `ask_${ask.askId.replace(/[^a-zA-Z0-9_]/g, '_')}`, vertical_spacing: '16px', elements };
}

/** A one-click option: the whole row answers with the existing select action. */
export function quickRow(content: string, value: Record<string, string>): El {
  return { tag: 'interactive_container', width: 'fill', height: 'auto', background_style: 'bg-white', has_border: true,
    border_color: 'grey', corner_radius: '8px', padding: '10px 12px 10px 12px',
    behaviors: [{ type: 'callback', value }], elements: [{ tag: 'markdown', content }] };
}

export function formatAskDeadline(deadlineAt: number, locale: Locale, createdAt?: number): string {
  if (deadlineAt === 0) return t('card.ask.footer.no_deadline', undefined, locale);
  const withYear = createdAt !== undefined && new Date(createdAt).getFullYear() !== new Date(deadlineAt).getFullYear();
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    ...(withYear ? { year: 'numeric' } : {}), month: locale === 'en' ? 'short' : 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(deadlineAt);
}

/** Who may answer: plain footer text, or a designated answerer's mention (kept out of the grey font). */
function answerable(ask: Pick<PendingAsk, 'answererOpenId' | 'ownerAnswererOpenId' | 'originKind'>, locale: Locale): { text: string } | { mention: string } {
  if (!ask.answererOpenId) return { text: t('card.ask.footer.talk_members', undefined, locale) };
  if (ask.ownerAnswererOpenId && ask.ownerAnswererOpenId !== ask.answererOpenId) {
    return { text: t('card.ask.footer.designated_or_owner', undefined, locale) };
  }
  // XPI can resolve this id from union_id in another app. It is valid for the broker's callback
  // authorization, but embedding it as an at resource can make Lark reject the card with 230099.
  if (ask.originKind?.startsWith('host_cross_principal_')) return { text: t('card.ask.footer.designated', undefined, locale) };
  return { mention: `<at id=${ask.answererOpenId}></at>` };
}

/** The last element: deadline and who may answer (or who submitted), then any hint lines, in small grey text. */
export function askFooter(first: string, extraLines: string[] = []): El {
  return { tag: 'markdown', text_size: 'notation', content: [first, ...extraLines.filter(Boolean).map(greyLines)].join('\n') };
}

/** 「截止 … · 本群可对话成员可答」, or 「截止 … · @someone 可答」 for a designated answerer. */
export function deadlineLine(ask: Pick<PendingAsk, 'deadlineAt' | 'createdAt' | 'answererOpenId' | 'ownerAnswererOpenId' | 'originKind'>, locale: Locale): string {
  const who = answerable(ask, locale);
  return 'text' in who ? grey(`${deadlineText(ask, locale)} · ${who.text}`)
    : `${grey(`${deadlineText(ask, locale)} · `)}${who.mention}${grey(t('card.ask.footer.may_answer', undefined, locale))}`;
}

/** 「截止 11月24日 03:21」, or the no-deadline wording for a deadline of 0. */
export function deadlineText(ask: Pick<PendingAsk, 'deadlineAt' | 'createdAt'>, locale: Locale): string {
  const formatted = formatAskDeadline(ask.deadlineAt, locale, ask.createdAt);
  return ask.deadlineAt === 0 ? formatted : t('card.ask.footer.deadline', { deadline: formatted }, locale);
}

export function settledHeader(ask: PendingAsk, result: AskResult, locale: Locale, permissionHeadline?: string): El {
  if (result.kind === 'answered' && isHookPermissionAsk(ask)) {
    return permissionAnswerAllows(result) ? askHeader(t('card.ask.header.permission_allowed', undefined, locale), 'green')
      : askHeader(t('card.ask.header.permission_denied', undefined, locale), 'grey');
  }
  const title = result.kind === 'answered' ? t('card.ask.header.answered', undefined, locale)
    : permissionHeadline ?? t(result.kind === 'timedOut' ? 'card.ask.header.timed_out' : 'card.ask.header.invalidated', undefined, locale);
  return askHeader(title, result.kind === 'answered' ? 'green' : 'grey');
}

export function pendingHeader(ask: PendingAsk, locale: Locale, presentation: AskPresentation): El {
  const n = ask.questions.length;
  const title = t(n === 1 ? 'card.ask.header.pending_one' : 'card.ask.header.pending_many', { n }, locale);
  const subtitle = presentation === 'quick' ? undefined
    : t(presentation === 'text_reply' ? 'card.ask.header.subtitle_text_reply'
      : presentation === 'input_form' ? 'card.ask.header.subtitle_input' : 'card.ask.header.subtitle_form', undefined, locale);
  return askHeader(title, 'blue', subtitle);
}

function askHeader(title: string, template: string, subtitle?: string): El {
  return { title: plain(title), ...(subtitle ? { subtitle: plain(subtitle) } : {}), template, padding: '12px 12px 12px 12px' };
}

export interface AskBodyOptions {
  locale: Locale;
  density: AskDensity;
  /** Formats (escapes and caps) one question prompt for display. */
  prompt: (text: string) => string;
  descriptionCap: number;
  confirmEmptyArmed?: boolean;
  /** Tags each leaf with its role (the reply card gives them element IDs for the shared-context projection). */
  stamp?: (role: AskElementRole, element: El) => El;
}

/** `question`: the asked text; `options`: what can be chosen; `control`: kind labels, inputs, buttons, notes. */
export type AskElementRole = 'question' | 'options' | 'control';

/**
 * Body of an unsettled choice Ask (presentations `form`, `quick`, `text_reply`), without header,
 * mention or footer. A quick Ask too large for one-click rows falls back to the form.
 */
export function buildAskChoiceBody(ask: PendingAsk, options: AskBodyOptions): { elements: El[]; descriptionsTruncated: boolean } {
  const { locale, density } = options;
  const stamp = options.stamp ?? ((_role: AskElementRole, element: El) => element);
  const presentation = askPresentation(ask);
  const total = ask.questions.length;
  let descriptionsTruncated = false;
  const wrap = (children: El[]) => density === 'bare' ? children : [questionBlock(children)];
  const head = (q: AskQuestion, i: number, how?: string) => [
    ...(density === 'bare' ? [] : [stamp('control', askEyebrow(q, locale, how))]),
    ...questionHeading(options.prompt(q.prompt), i, total).map(element => stamp('question', element)),
  ];

  if (presentation === 'text_reply') {
    return { descriptionsTruncated: false, elements: ask.questions.flatMap((q, i) => {
      const lines = q.options.map(o => `• ${optionContent(q, o, locale, options.descriptionCap).content.replace(/\n/g, '\n   ')}`);
      if (q.options.some(o => (o.description?.length ?? 0) > options.descriptionCap)) descriptionsTruncated = true;
      return wrap([...head(q, i, 'card.ask.how.reply'),
        ...(lines.length ? [stamp('options', { tag: 'markdown', content: lines.join('\n') })] : [])]);
    }) };
  }

  if (presentation === 'quick' && (density === 'rows' || density === 'compact')) {
    const q = ask.questions[0]!;
    const rows = q.options.map(o => {
      const text = optionContent(q, o, locale, options.descriptionCap);
      descriptionsTruncated ||= text.truncated;
      return stamp('options', quickRow(text.content, { action: 'ask_select', ask_id: ask.askId, nonce: ask.nonce, key: o.key }));
    });
    return { elements: wrap([...head(q, 0, 'card.ask.how.quick'), ...rows]), descriptionsTruncated };
  }

  const ownAnswer = supportsAskCustomInput(ask);
  const selections = ask.selections ?? ask.questions.map(() => []);
  const blocks = ask.questions.flatMap((q, i) => {
    const textQuestion = q.inputMode === 'text' || !q.options.length;
    const how = textQuestion ? 'card.ask.how.text' : q.multiSelect ? 'card.ask.how.multi' : 'card.ask.how.single';
    // A stored own answer replaces this question's options (as on the v1 form), so none shows ticked.
    const ticked = new Set(ask.customAnswers?.[i] != null ? [] : selections[i] ?? []);
    const controls = textQuestion ? { elements: [], truncated: false }
      : optionControls(q, i, ticked, locale, density, options.descriptionCap);
    descriptionsTruncated ||= controls.truncated;
    const input = ownAnswer && q.allowCustom !== false
      ? [stamp('control', customInput(i, ask.customAnswers?.[i] ?? '', locale, textQuestion))] : [];
    return wrap([...head(q, i, how), ...controls.elements.map(element => stamp('options', element)), ...input]);
  });
  const armed = !!options.confirmEmptyArmed;
  const submit = submitButton('ask_submit', t(armed ? 'card.ask.submit_confirm_empty' : 'card.ask.submit', undefined, locale), {
    action: 'ask_choice_submit', ask_id: ask.askId, nonce: ask.nonce,
    ...(ownAnswer ? { revision: String(ask.customRevision ?? 0) } : {}),
    ...(armed ? { confirm_empty: 'true' } : {}),
  }, armed);
  return { descriptionsTruncated, elements: [askForm(ask, [
    ...blocks,
    ...(armed ? [stamp('control', { tag: 'markdown', content: t('card.ask.empty_warning', undefined, locale) })] : []),
    stamp('control', submit),
  ])] };
}

/** Footer hint for an unsettled Ask, if it has one: how to answer in text instead of on the card. */
export function askReplyHint(ask: PendingAsk, locale: Locale): string | undefined {
  if (ask.deliveryTarget) return t('card.ask.document_reply_hint', undefined, locale);
  if (isNativeAsyncAskOrigin(ask.originKind)) return t('card.ask.async_reply_hint', undefined, locale);
  const presentation = askPresentation(ask);
  if (presentation === 'text_reply') return t('card.ask.text_reply_hint', undefined, locale);
  if (presentation === 'quick' && isHookPermissionAsk(ask)) return t('card.ask.permission_reply_hint', undefined, locale);
  if (presentation === 'quick' || (presentation === 'form' && !supportsAskCustomInput(ask))) {
    return t('card.ask.custom_reply_hint', undefined, locale);
  }
  return undefined;
}

/**
 * Body of a settled Ask: each question keeps its block with the kind, the question and what was
 * answered (`✓ label` with its description, the written text, or the input value), so an approver
 * can still see what was asked and answered. Detail lines (a whole-Ask text reply, why it ended)
 * follow the blocks. Densities `bare` and `list` (a very large Ask) drop the blocks and kind labels;
 * `list` puts every question in one Markdown element.
 */
export function buildAskSettledBody(ask: PendingAsk, result: AskResult, options: {
  locale: Locale; prompt: (text: string) => string; descriptionCap: number; valueCap?: number; detail?: string;
  density?: AskDensity;
}): { elements: El[]; descriptionsTruncated: boolean } {
  const flat = options.density === 'bare' || options.density === 'list';
  const { locale } = options;
  const total = ask.questions.length;
  let descriptionsTruncated = false;
  const value = (text: string) => {
    const cap = options.valueCap ?? Infinity;
    if (text.length <= cap) return escapeAnswerText(text);
    return `${escapeAnswerText(capChars(text, cap))}${t('card.ask.value_truncated', undefined, locale)}`;
  };
  const blocks: El[][] = ask.questions.map((q, i) => {
    const children: El[] = [...(flat ? [] : [askEyebrow(q, locale)]), ...questionHeading(options.prompt(q.prompt), i, total)];
    if (result.kind === 'answered') {
      const custom = result.customAnswers?.[i] ?? result.inputs?.[i];
      let lines: string[];
      if (custom) lines = [`✓ ${value(custom)}`];
      else {
        lines = (result.answers[i] ?? []).map(key => {
          const option = q.options.find(o => o.key === key);
          if (!option) return `✓ ${escapeAnswerText(key)}`;
          const text = optionContent(q, option, locale, options.descriptionCap);
          descriptionsTruncated ||= text.truncated;
          return `✓ ${text.content}`;
        });
      }
      if (!lines.length && !result.comment) lines = [grey(t('card.ask.answer.none', undefined, locale))];
      // A note written next to the ticked options follows them.
      const note = result.notes?.[i];
      if (note && !custom) lines.push(t('card.ask.note_line', { note: value(note) }, locale));
      if (lines.length) children.push({ tag: 'markdown', content: lines.join('\n') });
    }
    return children;
  });
  const elements: El[] = options.density === 'list'
    ? [{ tag: 'markdown', content: blocks.map(children => children.map(child => child.content).join('\n')).join('\n\n') }]
    : flat ? blocks.flat() : blocks.map(questionBlock);
  if (result.kind === 'answered' && result.comment) {
    const onlyComment = result.answers.every(keys => !keys.length) && !result.customAnswers?.some(Boolean) && !result.inputs?.some(Boolean);
    elements.push({ tag: 'markdown', content: onlyComment
      ? `**${t('card.ask.custom_reply', undefined, locale)}**\n${value(result.comment)}`
      : t('card.ask.supplement', { comment: value(result.comment) }, locale) });
  }
  if (options.detail) elements.push({ tag: 'markdown', content: options.detail });
  return { elements, descriptionsTruncated };
}

/**
 * 「由 <who> 提交 · 截止 …」. A Feishu user id is shown as the person's name through the
 * display-only `<person>` tag (Feishu documents it as never notifying, unlike `<at>`, and an id it
 * cannot resolve shows as an unknown user instead of failing the card); any other actor
 * (Dashboard answers, …) as plain text.
 */
export function submittedByLine(by: string, ask: Pick<PendingAsk, 'deadlineAt' | 'createdAt'>, locale: Locale): string {
  const deadline = deadlineText(ask, locale);
  if (/^ou_[A-Za-z0-9_-]+$/.test(by)) {
    const [before = '', after = ''] = t('card.ask.footer.submitted_by', { by: '\u0000' }, locale).split('\u0000');
    return `${before ? grey(before) : ''}<person id='${by}' show_name=true show_avatar=false style='normal'></person>${grey(`${after} · ${deadline}`)}`;
  }
  const who = escapeAnswerText(by.length > 28 ? `${by.slice(0, 28)}…` : by);
  return grey(`${t('card.ask.footer.submitted_by', { by: who }, locale)} · ${deadline}`);
}

/** Keep labelled web links usable without enabling arbitrary question markup. */
export function escapeQuestion(s: string): string {
  let cursor = 0;
  let rendered = '';
  for (const match of s.matchAll(/\[([^\]\r\n]+)\]\(/g)) {
    const start = match.index!;
    if (start < cursor || s[start - 1] === '!') continue;
    const escapes = s.slice(0, start).match(/\\+$/)?.[0].length ?? 0;
    if (escapes % 2) continue;
    const destination = parseLinkDestination(s, start + match[0].length, s.length);
    if (!destination.ok || s[destination.pos] !== ')') continue;
    let url: URL;
    try { url = new URL(destination.str); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    // Parentheses are legal URL characters but must not terminate a Markdown link.
    const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
    rendered += escapeMd(s.slice(cursor, start)) + `[${escapeMd(match[1]!)}](${href})`;
    cursor = destination.pos + 1;
  }
  return rendered + escapeMd(s.slice(cursor));
}

export function escapeMd(s: string): string {
  // A mention is structured Lark markup: escaping the underscore in its ID
  // makes the entire card invalid. Keep complete user/bot mentions atomic.
  return s.replace(/<at\s+id=(?:"ou_[\w-]+"|'ou_[\w-]+'|ou_[\w-]+)\s*><\/at>|[*_~`\[\]\\]/g,
    (token) => token.startsWith('<at') ? token : `\\${token}`);
}
