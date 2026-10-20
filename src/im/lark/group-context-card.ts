import { REPLY_CARD_FOOTER_ELEMENT_ID, REPLY_CARD_FOOTER_MARKER } from './reply-card-footer-signature.js';

export const GROUP_CONTEXT_CARD_CONTENT_VERSION = 1;
export type GroupContextCardPurpose = 'runtime' | 'message' | 'turn-message';
export type GroupContextCardProjection = { kind: 'runtime' }
  | { kind: 'conversation'; content: string; turnReply: boolean }
  | { kind: 'unresolved' };

type CardNode = Record<string, any>;

// Version 1 reserves runs of 12, 13, and 14 of the existing footer carrier.
// Runs 15–17 carry the same purposes inside media, so a flattened table's
// final row can be distinguished from a signed footer paragraph.
// Lark retains U+2063 when flattening B into A, unlike arbitrary JSON metadata
// or hidden Markdown links. The original four-character footer signature is
// a prefix, so normal history/quoted parsing keeps stripping the whole footer.
const PURPOSE_LENGTH: Record<GroupContextCardPurpose, number> = { runtime: 12, message: 13, 'turn-message': 14 };
const PURPOSE_BY_LENGTH = new Map(Object.entries(PURPOSE_LENGTH).flatMap(([purpose, length]) =>
  [[length, purpose as GroupContextCardPurpose], [length + 3, purpose as GroupContextCardPurpose]]));
const CHART_PURPOSE_BY_ID = new Map(Object.keys(PURPOSE_LENGTH).map(purpose =>
  [`botmux_group_context_chart_${purpose.replace('-', '_')}`, purpose as GroupContextCardPurpose]));
const CARRIER = /\u2063{4,}/g;
const TRAILING_PURPOSE_CARRIER = /(?<!\u2063)\u2063{12,17}$/;
const TRAILING_MEDIA_CARRIER = /(?<!\u2063)\u2063{15,17}$/;

function nodes(value: unknown, visibleOnly = false): CardNode[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(child => nodes(child, visibleOnly));
  return [value as CardNode, ...Object.entries(value)
    .filter(([key]) => !visibleOnly || !['behaviors', 'value', 'callback', '__botmux_card_text__'].includes(key))
    .flatMap(([, child]) => nodes(child, visibleOnly))];
}

function elements(card: CardNode): any[] | undefined {
  return Array.isArray(card.body?.elements) ? card.body.elements : Array.isArray(card.elements) ? card.elements : undefined;
}

function renderedText(value: any): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(renderedText).join('');
  if (typeof value.content === 'string') return value.content;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.text?.content === 'string') return value.text.content;
  if (typeof value.property?.content === 'string') return value.property.content;
  return renderedText(value.property?.elements ?? value.elements);
}

/** Remove only the reserved trailing purpose carrier, not ordinary U+2063 text. */
export function stripTrailingGroupContextCardPurposeMarker(value: string): string {
  return value.replace(TRAILING_PURPOSE_CARRIER, '');
}

export function hasTrailingGroupContextMediaPurposeMarker(value: string): boolean {
  return TRAILING_MEDIA_CARRIER.test(value);
}

function inlinePurposeCarrier(root: any[], marker: string): boolean {
  // Prefer the first authored Markdown block. A signed visible footer is
  // always the final paragraph after Lark's B→A flattening; putting the inline
  // carrier first lets the Format A parser distinguish body text from that
  // footer without relying on a particular brand string.
  for (let index = 0; index < root.length; index++) {
    const node = root[index];
    if (node?.tag !== 'markdown' || node.element_id === REPLY_CARD_FOOTER_ELEMENT_ID
      || RUNTIME_ID.test(node.element_id ?? '') || typeof node.content !== 'string') continue;
    node.content = TRAILING_PURPOSE_CARRIER.test(node.content)
      ? node.content.replace(TRAILING_PURPOSE_CARRIER, marker)
      : `${node.content}${marker}`;
    return true;
  }
  return false;
}

/** Reuse an existing media/table text field instead of allocating a blank row. */
function inlineMediaPurposeCarrier(value: any, marker: string, kind: 'table' | 'img'): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(child => inlineMediaPurposeCarrier(child, marker, kind));
  if (RUNTIME_ID.test(value.element_id ?? '')) return false;
  if (kind === 'img' && value.tag === 'img') {
    const alt = typeof value.alt === 'string' ? value.alt : value.alt?.content;
    value.alt = { tag: 'plain_text', content: `${stripTrailingGroupContextCardPurposeMarker(typeof alt === 'string' ? alt : '')}${marker}` };
    return true;
  }
  if (kind === 'table' && value.tag === 'table' && Array.isArray(value.columns)) {
    // The last text cell also stays at the end when a table is flattened.
    const textColumns = value.columns.filter((column: CardNode) => column?.data_type === 'lark_md');
    for (const row of [...(Array.isArray(value.rows) ? value.rows : [])].reverse()) {
      for (const column of [...textColumns].reverse()) {
        if (!row || typeof row[column.name] !== 'string') continue;
        row[column.name] = `${stripTrailingGroupContextCardPurposeMarker(row[column.name])}${marker}`;
        return true;
      }
    }
    const column = [...value.columns].reverse().find((column: CardNode) => typeof column?.display_name === 'string');
    if (column) {
      column.display_name = `${stripTrailingGroupContextCardPurposeMarker(column.display_name)}${marker}`;
      return true;
    }
  }
  return ['elements', 'columns'].some(key => inlineMediaPurposeCarrier(value[key], marker, kind));
}

/** Native charts support element IDs; never modify categories, values or titles. */
function chartPurposeCarrier(value: any, purpose: GroupContextCardPurpose): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(child => chartPurposeCarrier(child, purpose));
  if (RUNTIME_ID.test(value.element_id ?? '')) return false;
  if (value.tag === 'chart' && !value.element_id) {
    value.element_id = `botmux_group_context_chart_${purpose.replace('-', '_')}`;
    return true;
  }
  return ['elements', 'columns'].some(key => chartPurposeCarrier(value[key], purpose));
}

/** Stamp an outgoing structured card without mutating the caller's object. */
export function markGroupContextCardPurpose<T extends Record<string, any>>(card: T, purpose: GroupContextCardPurpose): T;
export function markGroupContextCardPurpose(card: string, purpose: GroupContextCardPurpose): string;
export function markGroupContextCardPurpose(card: string | Record<string, any>, purpose: GroupContextCardPurpose): any {
  let clone: CardNode;
  try { clone = typeof card === 'string' ? JSON.parse(card) : structuredClone(card); }
  catch { return card; }
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) return card;
  const root = elements(clone);
  if (!root) return card;
  // A saved card may carry an older purpose in image alt. Remove it before
  // choosing a different carrier, otherwise re-stamping creates a conflict.
  for (const node of nodes(root, true)) {
    if (node.tag === 'chart' && CHART_PURPOSE_BY_ID.has(node.element_id)) delete node.element_id;
    for (const key of node.tag === 'img' ? ['alt'] : node.tag === 'table' ? ['rows', 'columns'] : []) {
      if (node[key] !== undefined) node[key] = stripMediaPurposeText(node[key]);
    }
  }
  const marker = '\u2063'.repeat(PURPOSE_LENGTH[purpose]);
  const mediaMarker = '\u2063'.repeat(PURPOSE_LENGTH[purpose] + 3);
  const footer = nodes(root).find(node => node.element_id === REPLY_CARD_FOOTER_ELEMENT_ID && typeof node.content === 'string');
  if (footer) {
    if (footer.content.includes(REPLY_CARD_FOOTER_MARKER)) footer.content = footer.content.replace(CARRIER, marker);
    else footer.content = footer.content.replace(/(?=<\/font>\s*$)|$/, marker);
  } else if (!inlinePurposeCarrier(root, marker)
    && !inlineMediaPurposeCarrier(root, mediaMarker, 'table')
    && !chartPurposeCarrier(root, purpose)
    && !inlineMediaPurposeCarrier(root, mediaMarker, 'img')) {
    // Unsupported custom shapes retain the compatibility carrier.
    root.push({ tag: 'markdown', element_id: REPLY_CARD_FOOTER_ELEMENT_ID, text_size: 'notation',
      content: `<font color='grey'>${marker}</font>` });
  }
  return typeof card === 'string' ? JSON.stringify(clone) : clone;
}

function purposeOf(card: CardNode): GroupContextCardPurpose | 'conflict' | undefined {
  const purposes = new Set<GroupContextCardPurpose>();
  for (const node of nodes(card, true)) {
    if (node.tag === 'chart') {
      const chartPurpose = CHART_PURPOSE_BY_ID.get(node.element_id);
      if (chartPurpose) purposes.add(chartPurpose);
    }
    // Read only rendered text carriers, never a callback value or premerged text.
    const texts = [node.content, node.text];
    if (node.tag === 'table' && Array.isArray(node.columns)) {
      texts.push(...node.columns.map((column: CardNode) => column?.display_name));
      for (const row of Array.isArray(node.rows) ? node.rows : []) {
        for (const column of node.columns) {
          if (column?.data_type === 'lark_md') texts.push(row?.[column.name]);
        }
      }
    }
    for (const text of texts) {
      if (typeof text !== 'string') continue;
      for (const run of text.matchAll(CARRIER)) {
        const purpose = PURPOSE_BY_LENGTH.get(run[0].length);
        if (purpose) purposes.add(purpose);
      }
    }
  }
  return purposes.size > 1 ? 'conflict' : purposes.values().next().value;
}

function callbackValue(node: CardNode): CardNode | undefined {
  return (Array.isArray(node.behaviors) ? node.behaviors.find((behavior: CardNode | null) => behavior?.type === 'callback')?.value : undefined) ?? node.value;
}

function optionButtons(node: CardNode): CardNode[] {
  return nodes(node).filter(child => child.tag === 'button'
    && ['ask_select', 'ask_toggle'].includes(callbackValue(child)?.action));
}

const RUNTIME_ID = /^(?:botmux_turn_(?:status|usage|process|thinking|tools|control)(?:_\d+|_ask_\d+)?|botmux_turn_progress_\d+|botmux_feedback|botmux_oncall_group|botmux_reply_footer)$/;

function buttonLink(node: CardNode): string | undefined {
  const destinations = [node.url, node.multi_url?.url, node.multi_url?.pc_url, node.multi_url?.android_url, node.multi_url?.ios_url];
  if (Array.isArray(node.behaviors)) for (const behavior of node.behaviors) {
    if (behavior?.type === 'open_url') destinations.push(behavior.default_url, behavior.pc_url, behavior.url, behavior.android_url, behavior.ios_url);
  }
  const url = destinations.find(value => typeof value === 'string' && value.trim());
  const label = renderedText(node.text);
  return url ? label ? `[${label}](${url})` : url : undefined;
}

function projectNode(value: any, legacy = false, apiFormat = false): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(child => projectNode(child, legacy, apiFormat)).filter(child => child !== undefined);
  if (RUNTIME_ID.test(value.element_id ?? '')) return undefined;
  if (legacy && isLegacyProcess(value)) return undefined;
  if (value.tag === 'chart') {
    const chartData = projectChartData(value.chart_spec);
    if (chartData) return chartData;
  }
  if (/^botmux_turn_options_\d+$/.test(value.element_id ?? '')) {
    return { tag: 'markdown', content: nodes(value).filter(node => node.tag === 'button').map(button => renderedText(button.text)).filter(Boolean).join('\n') };
  }
  if (value.tag === 'button') {
    const link = buttonLink(value);
    return link ? apiFormat ? { tag: 'text', text: link } : { tag: 'markdown', content: link } : undefined;
  }
  const result: CardNode = {};
  for (const [key, child] of Object.entries(value)) {
    // Never let the generic parser short-circuit on unprojected A+B text.
    if (key === '__botmux_card_text__' || key === 'behaviors' || key === 'callback') continue;
    const mediaText = value.tag === 'img' && key === 'alt'
      || value.tag === 'table' && (key === 'rows' || key === 'columns');
    const projected = projectNode(mediaText ? stripMediaPurposeText(child) : child, legacy, apiFormat);
    if (projected !== undefined) result[key] = projected;
  }
  if (['markdown', 'div', 'plain_text'].includes(result.tag) && Array.isArray(result.property?.elements)
    && typeof result.content !== 'string' && typeof result.text?.content !== 'string') {
    // CardKit's normalized B has the same element IDs but moves visible text
    // into a rendered property tree. Keep IDs/layout and give generic parsers
    // their usual content field after the runtime subtrees have been removed.
    result.content = renderedText(result.property.elements);
  }
  return result;
}

/** Context readers need chart facts even when detail B has no image snapshot.
 * This projection is never sent back to Lark; the published chart is unchanged. */
function projectChartData(spec: any): CardNode | undefined {
  const rows = spec?.data?.values;
  if (!Array.isArray(rows) || !rows.length || !rows.every(row => row && typeof row === 'object' && !Array.isArray(row))) return undefined;
  const fields = [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (!fields.length) return undefined;
  const title = typeof spec.title?.text === 'string' ? spec.title.text : '';
  return { tag: 'div', elements: [
    ...(title ? [{ tag: 'plain_text', content: title }] : []),
    { tag: 'table', columns: fields.map((field, index) => ({ name: `c${index}`, display_name: field, data_type: 'text' })),
      rows: rows.map(row => Object.fromEntries(fields.map((field, index) => [`c${index}`, row[field] ?? '']))) },
  ] };
}

function stripMediaPurposeText(value: any): any {
  if (typeof value === 'string') return stripTrailingGroupContextCardPurposeMarker(value);
  if (Array.isArray(value)) return value.map(stripMediaPurposeText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, stripMediaPurposeText(child)]));
  }
  return value;
}

function isLegacyProcess(node: CardNode): boolean {
  const title = renderedText(node.header?.title);
  return node.tag === 'collapsible_panel'
    && /^(?:📋 (?:执行过程|本轮记录|Activity|Turn record))(?: ?[（(].*[）)])?$/.test(title);
}

function hasLegacyFinalFooter(root: any[]): boolean {
  return nodes(root).some(node => {
    if (node.element_id !== REPLY_CARD_FOOTER_ELEMENT_ID || node.tag !== 'markdown') return false;
    const text = renderedText(node);
    // Normalized B keeps the reserved footer ID but may render its font tag
    // away. Legacy no-final cards never emitted this footer in either shape.
    const footerShape = /^<font\s+color=['"]?grey['"]?>[\s\S]*<\/font>$/.test(text)
      || Array.isArray(node.property?.elements);
    return footerShape && text.replace(/<[^>]*>/g, '').replace(CARRIER, '').trim().length > 0;
  });
}

const LEGACY_STATUS = /^(?:⏳ \*\*(?:Queued|等待执行|Waiting for a response|等待响应)|💭 \*\*(?:Working|处理中)|⏹ \*\*(?:Stopping|正在停止|Stopped|已停止)|✅ \*\*(?:Completed|已完成)|❌ \*\*(?:Failed|执行失败)|⚠️ \*\*(?:Interrupted|执行状态待确认)|🙋 \*\*(?:Waiting for your response|等待你确认))(?: · \d+\.\d+s)?\*\*$/;

/** Legacy ask UI has no role IDs. Validate its producer-specific prefix,
 * then rebuild just the public questions. Unrecognized shapes stay unresolved. */
function legacyQuestions(root: any[]): { publicElements: CardNode[]; end: number } | undefined {
  let index = 1;
  let question = 0;
  let identity: string | undefined;
  const publicElements: CardNode[] = [];
  while (root[index]?.tag === 'markdown' && optionButtons(root[index + 1] ?? {}).length) {
    const prompt = root[index++];
    if (typeof prompt.content !== 'string' || !prompt.content.trim()) return undefined;
    const labels: string[] = [];
    while (root[index]?.tag === 'column_set' && optionButtons(root[index]).length) {
      const buttons = nodes(root[index]).filter(node => node.tag === 'button');
      for (const button of buttons) {
        const value = callbackValue(button);
        if (!value || !['ask_select', 'ask_toggle'].includes(value.action)
          || typeof value.ask_id !== 'string' || !value.ask_id || typeof value.nonce !== 'string' || !value.nonce
          || typeof value.key !== 'string' || !value.key || value.question_index !== String(question)
          || typeof button.text?.content !== 'string' || !button.text.content.trim()) return undefined;
        const nextIdentity = JSON.stringify([value.ask_id, value.nonce]);
        if (identity !== undefined && identity !== nextIdentity) return undefined;
        identity = nextIdentity;
        labels.push(button.text.content);
      }
      index++;
    }
    if (labels.length < 2) return undefined;
    publicElements.push({ tag: 'markdown', content: prompt.content }, { tag: 'markdown', content: labels.join('\n') });
    question++;
  }
  if (!question) return undefined;
  const isSubmit = (node: CardNode | undefined) => node?.tag === 'column_set'
    && nodes(node).some(child => child.tag === 'button' && callbackValue(child)?.action === 'ask_submit');
  if (root[index]?.tag === 'markdown' && isSubmit(root[index + 1])) index++;
  if (isSubmit(root[index])) index++;
  const hint = root[index];
  if (hint?.tag !== 'markdown' || hint.text_size !== 'notation' || typeof hint.content !== 'string'
    || !/(?:^|\n)(?:截止|Deadline): /.test(hint.content)) return undefined;
  return { publicElements, end: index + 1 };
}

function conversation(card: CardNode, turnReply: boolean, legacy = false): GroupContextCardProjection {
  return { kind: 'conversation', content: JSON.stringify(projectNode(card, legacy, elements(card)?.some(Array.isArray))), turnReply };
}

/** A shared-only structural projection. Ordinary history parsing stays intact. */
export function projectGroupContextCard(
  rawContent: string,
  options: { botmuxSender?: boolean } = {},
): GroupContextCardProjection | undefined {
  let card: CardNode;
  try { card = JSON.parse(rawContent); } catch { return undefined; }
  if (!card || typeof card !== 'object' || Array.isArray(card)) return undefined;
  if (typeof card.user_dsl === 'string') {
    try {
      const inner = JSON.parse(card.user_dsl);
      if (inner && typeof inner === 'object' && !Array.isArray(inner) && (inner.body || inner.elements || inner.header)) card = inner;
    } catch { /* Keep the outer representation if the optional wrapper is invalid. */ }
  }
  const purpose = purposeOf(card);
  if (purpose === 'runtime') return { kind: 'runtime' };
  if (purpose === 'conflict') return { kind: 'unresolved' };
  const root = elements(card);
  if (purpose === 'message') return conversation(card, false);
  const status = root?.find(node => node?.element_id === 'botmux_turn_status');
  if (purpose === 'turn-message') {
    // Format A has lost the region IDs: even a rendered answer can contain
    // process output. Ask the caller for authoritative structured B first.
    if (!status || root?.some(Array.isArray)) return { kind: 'unresolved' };
    return conversation(card, true);
  }
  if (!status) {
    // Format A drops image alt text. Rehydrate the structured card before
    // deciding whether an image-only bot message is runtime or conversation.
    // Unmarked structured cards still follow the ordinary parsing path.
    const imageOnlyApiCard = root?.length && root.every(paragraph => Array.isArray(paragraph)
      && paragraph.length > 0 && paragraph.every(node => node?.tag === 'img'
        || node?.tag === 'text' && typeof node.text === 'string' && !node.text.trim()));
    return options.botmuxSender === true && imageOnlyApiCard ? { kind: 'unresolved' } : undefined;
  }
  const statusText = renderedText(status);
  // The rendered property tree can omit Markdown's bold delimiters. Rebuild
  // only that wrapper, then retain the exact icon/label/duration allowlist.
  const statusMatches = LEGACY_STATUS.test(statusText) || Array.isArray(status.property?.elements)
    && LEGACY_STATUS.test(statusText.replace(/^(\S+) (.+)$/, '$1 **$2**'));
  if (!root || root[0] !== status || status.tag !== 'markdown' || !statusMatches) return { kind: 'unresolved' };
  const final = hasLegacyFinalFooter(root);
  if (statusText.startsWith('🙋')) {
    const questions = legacyQuestions(root);
    if (!questions) return { kind: 'unresolved' };
    const projected: CardNode = { ...card, body: { ...card.body, elements: [
      ...questions.publicElements, ...(final ? root.slice(questions.end) : []),
    ] } };
    delete projected.elements;
    return conversation(projected, true, true);
  }
  if (final) return conversation(card, true, true);
  return { kind: 'unresolved' };
}
