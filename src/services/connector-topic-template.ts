import type { ConnectorDefinition, ConnectorTopicMessageExtractor } from './connector-store.js';
import { getJsonPathValue } from './webhook-lifecycle-extractors.js';

const TEMPLATE_TOKEN = /{{\s*(?:(mention)\s+)?([A-Za-z][A-Za-z0-9_.-]{0,63})\s*}}/g;
const MAX_TOPIC_MESSAGE_CODEPOINTS = 200;
const MAX_MENTION_VALUES = 20;
const MAX_MENTION_NAME_CODEPOINTS = 32;
const MAX_OPEN_ID_CODEPOINTS = 80;
const MAX_PROTECTED_POST_MENTION_CODEPOINTS = 16;
const VALID_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;

export type ResolveConnectorMentionIdentities = (
  botId: string,
  identities: string[],
) => Promise<Map<string, string>>;

interface MentionCandidate {
  identity: string;
  name: string;
}

interface TextRenderChunk {
  text: string;
  kind: 'static' | 'protected' | 'flexible';
}

interface MentionRenderChunk {
  kind: 'mention';
  name: string;
  openId?: string;
  separator?: string;
}

type RenderChunk = TextRenderChunk | MentionRenderChunk;

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Neutralize Lark-native tags originating in webhook data. Full-width
 *  punctuation keeps the visible information while making `<at>` inert. */
export function escapeConnectorTopicText(value: string): string {
  return value.replaceAll('&', '＆').replaceAll('<', '＜').replaceAll('>', '＞');
}

function mentionCandidates(
  value: unknown,
  extractor: ConnectorTopicMessageExtractor,
  limit: number,
): MentionCandidate[] {
  const values = Array.isArray(value) ? value : [value];
  const candidates: MentionCandidate[] = [];
  for (const item of values) {
    if (candidates.length >= limit) break;
    const identityValue = extractor.identityPath
      ? getJsonPathValue(item, extractor.identityPath)
      : item;
    const identity = scalarText(identityValue);
    if (!identity || Array.from(identity).length > 320 || /[<>\r\n]/.test(identity)) continue;
    const extractedName = extractor.namePath
      ? scalarText(getJsonPathValue(item, extractor.namePath))
      : undefined;
    candidates.push({ identity, name: extractedName ?? identity });
  }
  return candidates;
}

function codepointLength(value: string): number {
  return Array.from(value).length;
}

function truncateCodepoints(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join('');
}

function renderMention(chunk: MentionRenderChunk): string {
  const name = truncateCodepoints(chunk.name, MAX_MENTION_NAME_CODEPOINTS);
  if (!name) return '';
  const separator = chunk.separator ?? '';
  if (chunk.openId) {
    return `${separator}<at user_id="${chunk.openId}">${name}</at>`;
  }
  return `${separator}${name}`;
}

function appendStaticChunks(chunks: RenderChunk[], text: string, protectPostMention: boolean): void {
  if (!protectPostMention) {
    chunks.push({ text, kind: 'static' });
    return;
  }
  const protectedText = truncateCodepoints(text, MAX_PROTECTED_POST_MENTION_CODEPOINTS);
  if (protectedText) chunks.push({ text: protectedText, kind: 'protected' });
  const remainder = Array.from(text).slice(MAX_PROTECTED_POST_MENTION_CODEPOINTS).join('');
  if (remainder) chunks.push({ text: remainder, kind: 'static' });
}

function limitedTopicMessage(chunks: RenderChunk[]): string {
  const protectedLength = chunks
    .filter((chunk): chunk is TextRenderChunk => chunk.kind === 'protected')
    .reduce((total, chunk) => total + codepointLength(chunk.text), 0);
  let protectedBudget = Math.min(protectedLength, MAX_TOPIC_MESSAGE_CODEPOINTS);
  let remainingBudget = MAX_TOPIC_MESSAGE_CODEPOINTS - protectedBudget;

  const mentions = chunks.filter((chunk): chunk is MentionRenderChunk => chunk.kind === 'mention');
  const mentionText = new Map<MentionRenderChunk, string>();
  const desiredMentions = mentions.map(renderMention);
  const desiredMentionLength = desiredMentions.reduce((total, value) => total + codepointLength(value), 0);
  if (desiredMentionLength <= remainingBudget) {
    mentions.forEach((chunk, index) => mentionText.set(chunk, desiredMentions[index]));
    remainingBudget -= desiredMentionLength;
  } else {
    for (const [index, chunk] of mentions.entries()) {
      const rendered = desiredMentions[index];
      const renderedLength = codepointLength(rendered);
      if (renderedLength > remainingBudget) break;
      mentionText.set(chunk, rendered);
      remainingBudget -= renderedLength;
    }
  }

  const staticLength = chunks
    .filter((chunk): chunk is TextRenderChunk => chunk.kind === 'static')
    .reduce((total, chunk) => total + codepointLength(chunk.text), 0);
  let staticBudget = Math.min(staticLength, remainingBudget);
  remainingBudget -= staticBudget;
  let flexibleBudget = remainingBudget;
  const output: string[] = [];
  for (const chunk of chunks) {
    if (chunk.kind === 'mention') {
      const rendered = mentionText.get(chunk);
      if (rendered) output.push(rendered);
      continue;
    }
    const budget = chunk.kind === 'protected'
      ? protectedBudget
      : chunk.kind === 'static'
        ? staticBudget
        : flexibleBudget;
    const take = Math.min(budget, codepointLength(chunk.text));
    if (take > 0) output.push(truncateCodepoints(chunk.text, take));
    if (chunk.kind === 'protected') protectedBudget -= take;
    else if (chunk.kind === 'static') staticBudget -= take;
    else flexibleBudget -= take;
  }
  return output.join('').trim();
}

export async function renderConnectorTopicTemplate(
  connector: ConnectorDefinition,
  payload: unknown,
  resolveIdentities: ResolveConnectorMentionIdentities,
): Promise<string | undefined> {
  const topicMessage = connector.topicMessage;
  if (topicMessage?.mode !== 'template' || !topicMessage.text || !topicMessage.extractors) return undefined;

  const mentionValues = new Map<string, MentionCandidate[]>();
  const identities: string[] = [];
  let mentionCount = 0;
  const referencedMentionAliases = new Set(
    [...topicMessage.text.matchAll(TEMPLATE_TOKEN)]
      .filter(match => Boolean(match[1]))
      .map(match => match[2]),
  );
  for (const [alias, extractor] of Object.entries(topicMessage.extractors)) {
    if (extractor.kind !== 'mention' || !referencedMentionAliases.has(alias)) continue;
    const candidates = mentionCandidates(
      getJsonPathValue(payload, extractor.path),
      extractor,
      Math.max(0, MAX_MENTION_VALUES - mentionCount),
    );
    mentionValues.set(alias, candidates);
    mentionCount += candidates.length;
    for (const candidate of candidates) {
      if (!identities.includes(candidate.identity)) identities.push(candidate.identity);
    }
  }

  let resolved = new Map<string, string>();
  if (identities.length > 0) {
    try {
      resolved = await resolveIdentities(connector.target.botId, identities);
    } catch {
      // Identity lookup is best-effort. A contact outage must not discard the
      // whole authenticated webhook; unresolved entries fall back to safe text.
    }
  }

  const source = connector.promptEnvelope.sourceName || connector.name;
  const chunks: RenderChunk[] = [];
  let cursor = 0;
  let previousTokenWasMention = false;
  for (const match of topicMessage.text.matchAll(TEMPLATE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      appendStaticChunks(chunks, topicMessage.text.slice(cursor, index), previousTokenWasMention);
    }
    const mention = match[1];
    const alias = match[2];
    if (alias === 'source') {
      chunks.push({ text: escapeConnectorTopicText(source), kind: 'flexible' });
      cursor = index + match[0].length;
      previousTokenWasMention = false;
      continue;
    }
    const extractor = topicMessage.extractors?.[alias];
    if (!extractor) {
      cursor = index + match[0].length;
      previousTokenWasMention = false;
      continue;
    }
    if (!mention) {
      const value = scalarText(getJsonPathValue(payload, extractor.path));
      if (value) chunks.push({ text: escapeConnectorTopicText(value), kind: 'flexible' });
      cursor = index + match[0].length;
      previousTokenWasMention = false;
      continue;
    }
    const renderedMentions = (mentionValues.get(alias) ?? []).map<MentionRenderChunk>(candidate => {
      const openId = resolved.get(candidate.identity);
      const name = escapeConnectorTopicText(candidate.name);
      return {
        kind: 'mention',
        name,
        ...(openId
          && codepointLength(openId) <= MAX_OPEN_ID_CODEPOINTS
          && VALID_OPEN_ID.test(openId)
          ? { openId }
          : {}),
      };
    });
    renderedMentions.forEach((value, position) => chunks.push({
      ...value,
      ...(position > 0 ? { separator: ' ' } : {}),
    }));
    cursor = index + match[0].length;
    previousTokenWasMention = true;
  }
  if (cursor < topicMessage.text.length) {
    appendStaticChunks(chunks, topicMessage.text.slice(cursor), previousTokenWasMention);
  }
  return limitedTopicMessage(chunks) || undefined;
}
