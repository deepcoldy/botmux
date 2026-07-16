// Dashboard「创建会话」的纯逻辑层：请求校验、列/模式归一化、lead 编排前言与
// 协作提示的 prompt 组装、会话标题推导。与 DOM / Lark API / 进程管理解耦，便于
// 单测。daemon 侧 /api/sessions/spawn 与 session-manager 的 spawn/activate 复用。
import { t, type Locale } from '../i18n/index.js';
import type { CliTurnPayload } from '../types.js';

/** 协作模式：
 *  - 'all'  「一起开工」——每个被选 bot 各起一条会话、拿同一份内容。
 *  - 'lead' 「Lead 分配」——只有 lead bot 起会话，内容带编排上下文，由它决定何时
 *           在群里 @ 拉起 sub bot。 */
export const CREATE_SESSION_MODES = ['all', 'lead'] as const;
export type CreateSessionMode = (typeof CREATE_SESSION_MODES)[number];

/** 入列：建完后会话落在看板哪一列。
 *  - 'in_progress' 直接开跑（立即 forkWorker）。
 *  - 'backlog'     入待办池（parked，不起 CLI，等激活）。 */
export const CREATE_SESSION_COLUMNS = ['in_progress', 'backlog'] as const;
export type CreateSessionColumn = (typeof CREATE_SESSION_COLUMNS)[number];

/** 单个 bot 在新群里扮演的角色，决定它的首轮 prompt 怎么包：
 *  - 'solo'   只有它一个 worker（单 bot，或 lead 模式下的 lead 且没 sub）。
 *  - 'lead'   lead 分配模式的 lead，prompt 前置编排上下文（列出 sub bot）。
 *  - 'collab' 一起开工模式的并列 worker，prompt 前置一句「还有谁在一起干」。 */
export type SpawnRole = 'solo' | 'lead' | 'collab';
export const SPAWN_ROLES: readonly SpawnRole[] = ['solo', 'lead', 'collab'];

const TITLE_MAX = 50;

export interface Coworker {
  name: string;
  openId?: string;
}

export function normalizeCreateMode(value: unknown): CreateSessionMode | null {
  return typeof value === 'string' && (CREATE_SESSION_MODES as readonly string[]).includes(value)
    ? (value as CreateSessionMode)
    : null;
}

export function normalizeCreateColumn(value: unknown): CreateSessionColumn | null {
  return typeof value === 'string' && (CREATE_SESSION_COLUMNS as readonly string[]).includes(value)
    ? (value as CreateSessionColumn)
    : null;
}

function normalizeSpawnRole(value: unknown): SpawnRole | null {
  return typeof value === 'string' && (SPAWN_ROLES as readonly string[]).includes(value)
    ? (value as SpawnRole)
    : null;
}

/** 会话标题：取内容首个非空行，压空白、限长。空内容回退占位。 */
export function deriveSessionTitleFromContent(content: string): string {
  const firstLine = content.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
  if (!firstLine) return t('cmd.createSession.untitled');
  return firstLine.length > TITLE_MAX ? firstLine.slice(0, TITLE_MAX) + '…' : firstLine;
}

function coworkerListBlock(coworkers: Coworker[]): string {
  return coworkers
    .map(c => c.openId ? `- ${c.name} (open_id: ${c.openId})` : `- ${c.name}`)
    .join('\n');
}

/** Lead 分配模式下，prepend 到用户内容前的编排上下文块。列出群里可协作的 sub
 *  bot（名字 + open_id，便于 @），并交代「你是 lead、自行决定何时拉起谁」。 */
export function buildLeadDispatchPreamble(coworkers: Coworker[], locale?: Locale): string {
  const intro = t('cmd.createSession.lead_preamble_intro', undefined, locale);
  const outro = t('cmd.createSession.lead_preamble_outro', undefined, locale);
  const list = coworkers.length > 0
    ? coworkerListBlock(coworkers)
    : t('cmd.createSession.lead_preamble_no_subs', undefined, locale);
  return `<botmux_lead_dispatch>\n${intro}\n${list}\n${outro}\n</botmux_lead_dispatch>`;
}

/** 一起开工模式下，prepend 一句「本群还有谁在并行干同一任务」的轻量提示。
 *  没有其他 coworker 时返回空串（退化成 solo）。 */
export function buildCollabNote(coworkers: Coworker[], locale?: Locale): string {
  const others = coworkers.filter(c => c.name);
  if (others.length === 0) return '';
  const names = others.map(c => c.name).join('、');
  return `<botmux_collab>${t('cmd.createSession.collab_note', { peers: names }, locale)}</botmux_collab>`;
}

/** System-generated dashboard role context kept separate from the human task
 * for Codex App clean-input materialization. Legacy CLIs still receive the
 * concatenated string from composeSpawnUserContent(). */
export function composeSpawnCodexAppContext(args: {
  role: SpawnRole;
  coworkers?: Coworker[];
  locale?: Locale;
}): string | undefined {
  const coworkers = args.coworkers ?? [];
  if (args.role === 'lead') return buildLeadDispatchPreamble(coworkers, args.locale);
  if (args.role === 'collab') return buildCollabNote(coworkers, args.locale) || undefined;
  return undefined;
}

/** 组装喂给 buildNewTopicPrompt 的「用户内容」——按角色在原始 content 前拼上
 *  lead 编排前言 / 协作提示。solo 原样返回。 */
export function composeSpawnUserContent(args: {
  content: string;
  role: SpawnRole;
  coworkers?: Coworker[];
  locale?: Locale;
}): string {
  const context = composeSpawnCodexAppContext(args);
  return context ? `${context}\n\n${args.content}` : args.content;
}

/** Merge a parked dashboard task with the first message that activates it.
 * The legacy prompt combines queuedPrompt + current wrapped prompt elsewhere;
 * this helper independently combines only raw user texts and metadata-only
 * contexts so the visible Codex App turn neither drops nor duplicates the
 * original dashboard task. */
export function mergeQueuedCodexAppTurn(args: {
  queued: boolean;
  queuedText?: string;
  queuedMessageContext?: string;
  currentText: string;
  currentMessageContext?: string;
}): { text: string; messageContext?: string } {
  if (!args.queued) {
    return {
      text: args.currentText,
      ...(args.currentMessageContext ? { messageContext: args.currentMessageContext } : {}),
    };
  }
  const text = [args.queuedText, args.currentText].filter(Boolean).join('\n\n') || args.currentText;
  const messageContext = [args.queuedMessageContext, args.currentMessageContext].filter(Boolean).join('\n\n');
  return { text, ...(messageContext ? { messageContext } : {}) };
}

/** Final compatibility gate for a queued dashboard task activated by a topic
 * reply. Sessions parked before clean-input was introduced have queuedPrompt
 * but no queuedCodexAppText. Their legacy content already contains both the
 * queued task and the current reply, while the newly-built structured sidecar
 * can only contain the current reply. Remove that incomplete sidecar so Codex
 * App consumes the complete legacy prompt instead.
 *
 * A valid string field (including an explicitly stored empty string) identifies
 * the new schema. Missing, null, or malformed persisted values fail closed to
 * legacy content. Non-Codex payloads have no sidecar and remain unchanged. */
export function applyQueuedCodexAppLegacyFallback(
  payload: CliTurnPayload,
  args: { queued: boolean; queuedText?: unknown },
): CliTurnPayload {
  if (!args.queued || typeof args.queuedText === 'string' || !payload.codexAppInput) return payload;
  return { content: payload.content };
}

export interface SpawnRequest {
  chatId: string;
  content: string;
  column: CreateSessionColumn;
  role: SpawnRole;
  coworkers: Coworker[];
  ownerOpenId?: string;
  ownerUnionId?: string;
  title?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseCoworkers(value: unknown): Coworker[] {
  if (!Array.isArray(value)) return [];
  const out: Coworker[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as any).name;
    const openId = (item as any).openId;
    if (typeof name !== 'string' || !name.trim()) continue;
    out.push({
      name: name.trim(),
      openId: typeof openId === 'string' && openId.trim() ? openId.trim() : undefined,
    });
  }
  return out;
}

/** 校验 daemon /api/sessions/spawn 的请求体。content 去尾空白后不能为空、限长；
 *  chatId 必须是飞书群 id（oc_ 前缀）；column/role 必须合法。 */
export function parseSpawnRequest(body: unknown): ParseResult<SpawnRequest> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_request' };
  const b = body as Record<string, unknown>;
  const chatId = typeof b.chatId === 'string' ? b.chatId.trim() : '';
  if (!chatId.startsWith('oc_')) return { ok: false, error: 'bad_chat_id' };
  const rawContent = typeof b.content === 'string' ? b.content : '';
  const content = rawContent.replace(/\s+$/u, '');
  if (!content.trim()) return { ok: false, error: 'empty_content' };
  const column = normalizeCreateColumn(b.column);
  if (!column) return { ok: false, error: 'bad_column' };
  const role = normalizeSpawnRole(b.role);
  if (!role) return { ok: false, error: 'bad_role' };
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : undefined;
  return {
    ok: true,
    value: {
      chatId,
      content,
      column,
      role,
      coworkers: parseCoworkers(b.coworkers),
      ownerOpenId: typeof b.ownerOpenId === 'string' && b.ownerOpenId.trim() ? b.ownerOpenId.trim() : undefined,
      ownerUnionId: typeof b.ownerUnionId === 'string' && b.ownerUnionId.trim() ? b.ownerUnionId.trim() : undefined,
      title,
    },
  };
}
