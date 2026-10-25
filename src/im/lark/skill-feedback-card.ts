import { createHash } from 'node:crypto';
import { normalizeCardActionData } from './card-action-data.js';
import { resolveCardOperatorUnionId } from './card-handler.js';
import type { FeedbackPolicy } from '../../services/feedback-policy.js';
import type { SkillFeedbackStore } from '../../services/skill-feedback-store.js';
import { buildOncallGroupColumn } from './oncall-group.js';
import { logger } from '../../utils/logger.js';

export interface FeedbackCardState { feedbackId?: string; result?: string; reasonKey?: string; comment?: string }

function versionedValue(state: FeedbackCardState, value: Record<string, unknown>): Record<string, unknown> {
  return state.feedbackId ? { ...value, expected_feedback_id: state.feedbackId } : value;
}

function button(text: string, style: string, value: Record<string, unknown>, disabled = false): Record<string, unknown> {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type: style, disabled, behaviors: [{ type: 'callback', value }] };
}

export function buildFeedbackElement(policy: FeedbackPolicy, state: FeedbackCardState = {}): Record<string, unknown> {
  const locked = !!state.result && !policy.allowReselect;
  return {
    tag: 'column_set', element_id: 'botmux_feedback', flex_mode: 'none', horizontal_spacing: 'small',
    columns: policy.buttons.map(option => ({
      tag: 'column', width: 'auto', elements: [
        button(option.label, option.style, versionedValue(state, { action: 'feedback_submit', result: option.key }), locked),
      ],
    })),
  };
}

function feedbackStateElements(policy: FeedbackPolicy, state: FeedbackCardState): Record<string, unknown>[] {
  if (!state.result) return [buildFeedbackElement(policy)];
  const selected = policy.buttons.find(option => option.key === state.result);
  const elements: Record<string, unknown>[] = [buildFeedbackElement(policy, state)];
  elements.push({ tag: 'markdown', element_id: 'botmux_feedback_status', content: `已选择：**${selected?.label ?? state.result}**` });
  if (!selected || selected.semantic !== 'negative') {
    return elements;
  }
  if (policy.negativeFollowup.reasons.length > 0) {
    elements.push({
      tag: 'column_set', element_id: 'botmux_feedback_reasons', flex_mode: 'none', horizontal_spacing: 'small',
      columns: policy.negativeFollowup.reasons.map(reason => ({ tag: 'column', width: 'auto', elements: [button(state.reasonKey === reason.key ? `✓ ${reason.label}` : reason.label, state.reasonKey === reason.key ? 'primary' : 'default', versionedValue(state, { action: 'feedback_reason', reason_key: reason.key }))] })),
    });
  }
  if (policy.negativeFollowup.comment.enabled) {
    if (state.comment !== undefined) elements.push({ tag: 'markdown', element_id: 'botmux_feedback_comment_done', content: '已补充说明' });
    else elements.push({
      tag: 'form', name: 'feedback_comment_form', element_id: 'botmux_feedback_comment', elements: [
        { tag: 'input', name: 'comment', input_type: 'multiline_text', rows: 3, max_rows: 8, auto_resize: true, width: 'fill', required: policy.negativeFollowup.comment.required, placeholder: { tag: 'plain_text', content: policy.negativeFollowup.comment.placeholder } },
        { tag: 'button', name: 'feedback_comment_submit', text: { tag: 'plain_text', content: '提交补充' }, type: 'primary', action_type: 'form_submit', value: versionedValue(state, { action: 'feedback_comment' }) },
      ],
    });
  }
  if (!policy.negativeFollowup.comment.enabled && policy.negativeFollowup.reasons.length === 0) return elements;
  return elements;
}

const FEEDBACK_ELEMENT_IDS = new Set([
  'botmux_feedback',
  'botmux_feedback_status',
  'botmux_feedback_reasons',
  'botmux_feedback_comment',
  'botmux_feedback_comment_done',
]);

function escapeRenderedMarkdown(content: string): string {
  return content.replace(/([\\`*_[\]<>!~&])/g, '\\$1');
}

function readbackCellText(value: unknown, markdown: boolean, protectStyleBoundary: boolean | { start: boolean; end: boolean } = false): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const runs: unknown[] = [];
    for (const part of value) {
      const previous = runs[runs.length - 1] as Record<string, any> | undefined;
      const current = part as Record<string, any> | null;
      const previousAttributes = previous?.property?.textStyle?.attributes;
      const currentAttributes = current?.property?.textStyle?.attributes;
      if (markdown && previous?.tag === 'plain_text' && current?.tag === 'plain_text'
        && typeof previous.property?.content === 'string' && typeof current.property?.content === 'string'
        && Array.isArray(previousAttributes) && Array.isArray(currentAttributes)
        && previousAttributes.includes('bold') === currentAttributes.includes('bold')
        && previousAttributes.includes('italic') === currentAttributes.includes('italic')) {
        runs[runs.length - 1] = { ...previous, property: {
          ...previous.property, content: previous.property.content + current.property.content,
        } };
      } else runs.push(part);
    }
    const hasAdjacentStyles = markdown && runs.length > 1 && runs.some(part => {
      const node = part as Record<string, any> | null;
      const attributes = node?.property?.textStyle?.attributes;
      return node?.tag === 'plain_text' && Array.isArray(attributes)
        && attributes.includes('bold') && attributes.includes('italic');
    });
    const parts = runs.map(part => readbackCellText(part, markdown, hasAdjacentStyles));
    if (parts.some(part => part === undefined)) return undefined;
    if (markdown && !hasAdjacentStyles) {
      const protectedRuns = new Map<number, { start: boolean; end: boolean }>();
      const protectRun = (index: number, direction: number) => {
        const protection = protectedRuns.get(index) ?? { start: false, end: false };
        if (direction < 0) protection.start = true;
        else protection.end = true;
        protectedRuns.set(index, protection);
      };
      let changed = true;
      while (changed) {
        changed = false;
        for (const [index, part] of runs.entries()) {
          const node = part as Record<string, any> | null;
          const attributes = node?.property?.textStyle?.attributes;
          if (node?.tag !== 'plain_text' || !Array.isArray(attributes)
            || !attributes.some(attribute => attribute === 'bold' || attribute === 'italic')
            || typeof node.property.content !== 'string') continue;
          const content: string = node.property.content;
          const characters = Array.from(content);
          const protection = protectedRuns.get(index);
          for (const direction of [-1, 1]) {
            const protectedEdge = characters.length === 1
              ? protection?.start || protection?.end : direction < 0 ? protection?.start : protection?.end;
            const edge = direction < 0 ? characters[0] : characters[characters.length - 1];
            if (!edge || (!protectedEdge && !/[\p{P}\p{S}]/u.test(edge))) continue;
            let neighbor = index + direction;
            while (neighbor >= 0 && neighbor < parts.length && !parts[neighbor]) neighbor += direction;
            const adjacentNode = runs[neighbor] as Record<string, any> | null;
            const adjacentContent: string = adjacentNode?.tag === 'plain_text'
              ? adjacentNode.property?.content ?? '' : parts[neighbor] ?? '';
            const adjacent = Array.from(adjacentContent);
            const adjacentProtection = protectedRuns.get(neighbor);
            const protectedOutside = adjacent.length === 1
              ? adjacentProtection?.start || adjacentProtection?.end
              : direction < 0 ? adjacentProtection?.end : adjacentProtection?.start;
            const outside = direction < 0 ? adjacent[adjacent.length - 1] : adjacent[0];
            if (protectedOutside || !outside || /[\s\p{P}\p{S}]/u.test(outside)) continue;
            protectRun(index, direction);
            protectRun(neighbor, -direction);
            changed = true;
          }
        }
      }
      for (const [index, protection] of protectedRuns) parts[index] = readbackCellText(runs[index], markdown, protection);
    }
    return parts.reduce<string>((content, part, index) => {
      const current = runs[index] as Record<string, any> | null;
      const previous = runs[index - 1] as Record<string, any> | null;
      const blockBoundary = current?.tag === 'list' || previous?.tag === 'list';
      const separator = content && part && blockBoundary ? '\n\n' : '';
      return content + separator + part;
    }, '');
  }
  if (!value || typeof value !== 'object') return undefined;
  const node = value as Record<string, any>;
  if (node.tag === 'list' && Array.isArray(node.property?.items)) {
    const items: string[] = [];
    const ancestors: Array<{ level: number; contentColumn: number }> = [];
    for (const item of node.property.items) {
      if (!item || typeof item !== 'object' || !Array.isArray(item.elements)) return undefined;
      const content = readbackCellText(item.elements, markdown);
      if (content === undefined || (item.type !== 'ol' && item.type !== 'ul')) return undefined;
      const level = Number.isInteger(item.level) && item.level >= 0 ? item.level : 0;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= level) ancestors.pop();
      const indentWidth = ancestors[ancestors.length - 1]?.contentColumn ?? 0;
      const indent = ' '.repeat(indentWidth);
      const marker = item.type === 'ol' ? `${Number.isInteger(item.order) && item.order > 0 ? item.order : 1}. ` : '- ';
      ancestors.push({ level, contentColumn: indentWidth + Math.max(4, marker.length) });
      const continuation = indent + ' '.repeat(marker.length);
      items.push(`${indent}${marker}${content.replace(/\n/g, `\n${continuation}`)}`);
    }
    return items.join('\n');
  }
  let content: string | undefined;
  let direct = false;
  for (const candidate of [node.content, node.text?.content, node.property?.content, node.text]) {
    if (typeof candidate === 'string') {
      content = candidate;
      direct = true;
      break;
    }
  }
  if (content === undefined) {
    for (const children of [node.property?.elements, node.elements, node.property?.markdownElements, node.markdownElements]) {
      if (!Array.isArray(children) || children.length === 0) continue;
      content = readbackCellText(children, markdown && !['a', 'link', 'code_span'].includes(node.tag));
      if (content !== undefined) break;
    }
  }
  if (content === undefined && node.tag === 'markdown' && Array.isArray(node.property?.elements)
    && node.property.elements.length === 0) return '';
  if (node.tag === 'br') return '\n';
  if (content === undefined) return undefined;
  if (!markdown) return content;
  if (node.tag === 'code_span') {
    const fence = '`'.repeat(Math.max(1, ...(content.match(/`+/g) ?? []).map(run => run.length + 1)));
    const padding = /^[` ]|[` ]$/.test(content) ? ' ' : '';
    return `${fence}${padding}${content}${padding}${fence}`;
  }
  if (node.tag === 'a' || node.tag === 'link') {
    const href = node.tag === 'link'
      ? node.property?.url?.url ?? node.property?.url ?? node.property?.href
      : node.href ?? node.property?.href ?? node.url ?? node.property?.url;
    if (typeof href === 'string') {
      const destination = href.replace(/[()<>\s\\]/g, character =>
        character === '(' ? '%28' : character === ')' ? '%29' : encodeURIComponent(character))
        .replace(/&/g, '\\&');
      return `[${escapeRenderedMarkdown(content)}](${destination})`;
    }
  }
  if (direct && node.tag === 'plain_text') {
    const rawParts = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
    const characters = Array.from(rawParts[2]);
    const reference = (character: string) => `&#${character.codePointAt(0)!};`;
    const escaped = protectStyleBoundary && characters.length > 0
      ? rawParts[1] + characters.map((character, index) =>
        (index === 0 && (protectStyleBoundary === true || protectStyleBoundary.start))
          || (index === characters.length - 1 && (protectStyleBoundary === true || protectStyleBoundary.end))
          ? reference(character) : escapeRenderedMarkdown(character)).join('') + rawParts[3]
      : escapeRenderedMarkdown(content);
    const attributes = node.property?.textStyle?.attributes;
    if (!Array.isArray(attributes)) return escaped;
    const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(escaped)!;
    if (!parts[2]) return escaped;
    let styled = parts[2];
    if (attributes.includes('bold')) styled = `**${styled}**`;
    if (attributes.includes('italic')) {
      const delimiter = attributes.includes('bold') ? '_' : '*';
      styled = `${delimiter}${styled}${delimiter}`;
    }
    return parts[1] + styled + parts[3];
  }
  return content;
}

function normalizeReadbackTables(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(normalizeReadbackTables);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, any>;
  if (node.tag === 'table' && Array.isArray(node.columns) && Array.isArray(node.rows)) {
    const columns = node.columns.filter((column: any) =>
      typeof column?.name === 'string' && ['text', 'lark_md', 'markdown'].includes(column.data_type ?? 'text'));
    for (const row of node.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      for (const column of columns) {
        const cell = row[column.name];
        if (!cell || typeof cell !== 'object') continue;
        const content = readbackCellText(cell, column.data_type === 'lark_md' || column.data_type === 'markdown');
        if (content !== undefined) row[column.name] = content;
        else {
          const tag = typeof cell.tag === 'string' ? cell.tag.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : 'unknown';
          logger.warn(`[feedback-card] unrecognized text table cell tag=${tag}`);
        }
      }
    }
  }
  for (const key of ['body', 'elements', 'columns']) {
    normalizeReadbackTables(node[key]);
  }
}

export function renderFeedbackCard(baseCard: Record<string, any>, policy: FeedbackPolicy, state: FeedbackCardState = {}): Record<string, unknown> {
  const card = structuredClone(baseCard);
  normalizeReadbackTables(card);
  const elements: Record<string, unknown>[] = card.body?.elements ?? [];
  const feedbackIndex = elements.findIndex((element: any) => element.element_id === 'botmux_feedback');
  if (feedbackIndex < 0) return card;
  let end = feedbackIndex + 1;
  while (end < elements.length && FEEDBACK_ELEMENT_IDS.has(String((elements[end] as any)?.element_id ?? ''))) end++;
  const updated = feedbackStateElements(policy, state);
  const oncall = (elements[feedbackIndex] as any).columns?.find((column: any) => column.element_id === 'botmux_oncall_group_column');
  // Lark's message read API omits behaviors, so restore the callback definition.
  if (oncall) { (updated[0] as any).columns.push(buildOncallGroupColumn()); updated[0].flex_mode = 'flow'; }
  elements.splice(feedbackIndex, end - feedbackIndex, ...updated);
  card.body.elements = elements;
  return card;
}

function callbackKey(input: Record<string, unknown>): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }

export async function handleSkillFeedbackCardAction(input: unknown, larkAppId: string, deps: {
  store: SkillFeedbackStore;
  loadBaseCard?: (platformMessageId: string) => Promise<Record<string, unknown> | undefined>;
}): Promise<any> {
  const data = normalizeCardActionData(input);
  const platformMessageId = data.context?.open_message_id;
  const verifiedOperator = await resolveCardOperatorUnionId(data, larkAppId);
  const operatorOpenId = verifiedOperator.openId?.startsWith('ou_') ? verifiedOperator.openId : undefined;
  const action = data.action?.value?.action;
  if (!platformMessageId || !action) return { toast: { type: 'error', content: '无法验证反馈来源，请重试' } };
  const delivery = deps.store.findDeliveryByPlatformMessage('lark', larkAppId, platformMessageId);
  if (!delivery?.policy || !delivery.baseCard) return { toast: { type: 'error', content: '反馈目标不存在或已失效' } };
  let baseCard = delivery.baseCard;
  try { baseCard = await deps.loadBaseCard?.(platformMessageId) ?? baseCard; }
  catch { /* platform fetch is best-effort; the content-free template remains usable */ }
  // Identity gate. `reviewers` matches the platform-verified operator against
  // the delivery's frozen allowlist (a per-delivery snapshot of already-resolved
  // ids, so later config changes never re-gate an old card and no network call
  // happens here); `everyone` accepts any operator whose id the platform
  // verified; `requester` keeps the original "only the addressed human"
  // contract. All fail closed when no verifiable identity exists — a bot sender
  // exposes no listed/verifiable human id.
  let operatorSubjectId: string | undefined;
  if (delivery.policy.audience === 'reviewers') {
    const reviewers = new Set(delivery.policy.reviewers);
    operatorSubjectId = [operatorOpenId, verifiedOperator.unionId]
      .find((id): id is string => !!id && reviewers.has(id));
    if (!operatorSubjectId) return { toast: { type: 'error', content: '仅指定的反馈人可反馈' } };
  } else if (delivery.policy.audience === 'everyone') {
    // Anyone may click, but we still key the feedback on a verified id so the
    // record has a real subject and a bot cannot forge one. Prefer the
    // cross-app union_id; fall back to the app-scoped open_id.
    operatorSubjectId = verifiedOperator.unionId ?? operatorOpenId;
    if (!operatorSubjectId) return { toast: { type: 'error', content: '无法验证反馈来源，请重试' } };
  } else {
    if (!delivery.requesterSubjectId) {
      return { toast: { type: 'error', content: '无法验证本次提问者，无法提交反馈' } };
    }
    operatorSubjectId = delivery.requesterSubjectId === operatorOpenId
      ? operatorOpenId
      : verifiedOperator.unionId ?? (data.operator?.union_id === undefined ? operatorOpenId : undefined);
    if (!operatorSubjectId) return { toast: { type: 'error', content: '无法验证反馈来源，请重试' } };
    if (delivery.requesterSubjectId && delivery.requesterSubjectId !== operatorSubjectId && delivery.requesterSubjectId !== operatorOpenId) return { toast: { type: 'error', content: '仅本次提问者可反馈' } };
  }

  const previous = deps.store.getLatestFeedback(delivery.deliveryId, operatorSubjectId);
  if (previous && !delivery.policy.allowReselect && action === 'feedback_submit') {
    return { card: { type: 'raw', data: renderFeedbackCard(baseCard, delivery.policy, previous) } };
  }
  let result: string;
  let reasonKey: string | undefined;
  let comment: string | undefined;
  if (action === 'feedback_submit') {
    result = data.action?.value?.result ?? '';
    if (!delivery.policy.buttons.some(item => item.key === result)) return { toast: { type: 'error', content: '反馈选项无效，请重试' } };
  } else if (action === 'feedback_reason') {
    if (!previous) return { toast: { type: 'error', content: '请先选择反馈' } };
    const selected = delivery.policy.buttons.find(item => item.key === previous.result);
    if (selected?.semantic !== 'negative') return { toast: { type: 'error', content: '当前反馈不支持补充原因' } };
    reasonKey = data.action?.value?.reason_key;
    if (!reasonKey || !delivery.policy.negativeFollowup.reasons.some(reason => reason.key === reasonKey)) return { toast: { type: 'error', content: '反馈原因无效，请重试' } };
    result = previous.result;
    comment = previous.comment;
  } else if (action === 'feedback_comment') {
    if (!previous) return { toast: { type: 'error', content: '请先选择反馈' } };
    const selected = delivery.policy.buttons.find(item => item.key === previous.result);
    const config = delivery.policy.negativeFollowup.comment;
    if (selected?.semantic !== 'negative' || !config.enabled) return { toast: { type: 'error', content: '当前反馈不支持补充说明' } };
    const raw = data.action?.form_value?.comment;
    if (raw !== undefined && typeof raw !== 'string') return { toast: { type: 'warning', content: '补充说明格式无效' } };
    comment = (raw ?? '').trim();
    if (config.required && !comment) return { toast: { type: 'warning', content: '请填写补充说明' } };
    if (comment.length > config.maxLength) return { toast: { type: 'warning', content: `补充说明不能超过 ${config.maxLength} 字` } };
    result = previous.result;
    reasonKey = previous.reasonKey;
  } else {
    return { toast: { type: 'error', content: '反馈操作无效，请重试' } };
  }
  const selectedButton = delivery.policy.buttons.find(item => item.key === result);
  const expectedFeedbackId = data.action?.value?.expected_feedback_id;
  if (expectedFeedbackId !== undefined && (typeof expectedFeedbackId !== 'string' || !expectedFeedbackId)) {
    return { toast: { type: 'error', content: '反馈状态无效，请刷新后重试' } };
  }
  let recorded: ReturnType<SkillFeedbackStore['recordFeedback']>;
  try {
    recorded = deps.store.recordFeedback({
      platform: 'lark', platformAppId: larkAppId, platformMessageId, operatorSubjectId, result, semantic: selectedButton?.semantic, reasonKey, comment,
      expectedFeedbackId,
      callbackKey: callbackKey({
        platformMessageId, operatorSubjectId, action, result, reasonKey, comment,
        expectedFeedbackId,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'feedback_version_mismatch') {
      return { toast: { type: 'error', content: '反馈状态已失效，请刷新后重试' } };
    }
    throw error;
  }
  const renderedCard = renderFeedbackCard(baseCard, delivery.policy, recorded.feedback);
  const toast = recorded.status === 'stale'
    ? { type: 'warning', content: '反馈状态已更新，请基于最新卡片重试' }
    : undefined;
  const renderedSemantic = delivery.policy.buttons.find(item => item.key === recorded.feedback.result)?.semantic;
  if (action === 'feedback_submit' && renderedSemantic === 'negative') {
    return { ...(toast ? { toast } : {}), deferredCard: { type: 'raw', data: renderedCard } };
  }
  return { ...(toast ? { toast } : {}), card: { type: 'raw', data: renderedCard } };
}
