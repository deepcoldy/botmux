import type { Session } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import { normalizeSessionTitle } from './session-board.js';
import { sessionTitleInput, stripLeadingKnownTitleMentions, hasManualSessionTitle, isBootstrapDisplayTitle, type TitleBootstrapFingerprint } from './session-title-content.js';
import { createHash } from 'node:crypto';

export type SessionTitleSource = 'initial' | 'user' | 'agent' | 'cli' | 'dashboard' | 'system';

export type SessionTitleUpdateResult =
  | { ok: true; title: string; updatedAt: string; source: SessionTitleSource }
  | { ok: false; error: 'bad_title' };

const BOTMUX_LARK_TITLE_PREFIX = '[BotMux·Lark]';
const BOTMUX_LARK_TITLE_MAX = 200;
const BOTMUX_LARK_TITLE_PROMPT_MAX = 2_000;

/** 从 Botmux 首轮输入中提取供语义标题模型使用的用户原文。 */
export function extractBotmuxLarkNativeSessionTitlePrompt(
  rawContent: unknown,
  mentions?: readonly { name: string }[],
  bootstrapPrompts: readonly string[] = [],
  previousBootstrap?: TitleBootstrapFingerprint,
): string | undefined {
  if (typeof rawContent !== 'string') return undefined;
  // 非 bare 路径取 <user_message> 内文（格式块在壳外，天然排除）；bare
  // （transcript + solo）续轮没有壳、走 rawContent 兜底，先整块剥掉追加在
  // 正文后的 <botmux_formatting>（连标签带块体），不能让它进语义标题。
  const content = sessionTitleInput(rawContent, mentions, bootstrapPrompts, previousBootstrap, titleBootstrapDigest).text;
  if (!content) return undefined;
  return Array.from(content).slice(0, BOTMUX_LARK_TITLE_PROMPT_MAX).join('');
}

function titleBootstrapDigest(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export function captureTitleBootstrap(raw: unknown, mentions?: readonly { name: string }[]): TitleBootstrapFingerprint {
  const text = sessionTitleInput(raw, mentions).text;
  return { digest: titleBootstrapDigest(text), length: text.length };
}

export interface AutomaticSessionTitlePlan {
  title: string;
  source: 'initial' | 'cli';
  /** Whether `title`/`source` replace the canonical list title; native fields apply either way. */
  canonical: boolean;
  awaitingContent: boolean;
  nativeTitle?: string;
  nativePrompt?: string;
  bootstrap?: TitleBootstrapFingerprint;
  expectedTitle: string;
  expectedSource?: string;
  expectedAwaiting?: boolean;
}

/** Prepare a naming decision without consuming an input that may still be rejected. */
export function prepareAutomaticSessionTitle(
  session: Pick<Session, 'title' | 'titleSource' | 'nativeSessionTitleUserDefined' | 'nativeSessionTitleAwaitingContent' | 'automaticTitleBootstrap'>,
  raw: unknown,
  options: { native: boolean; fresh?: boolean; groupName?: string; mentions?: readonly { name: string }[]; bootstrapPrompts: readonly string[] },
): AutomaticSessionTitlePlan | undefined {
  if (hasManualSessionTitle(session)) return undefined;
  const input = sessionTitleInput(raw, options.mentions, options.bootstrapPrompts, session.automaticTitleBootstrap, titleBootstrapDigest);
  // Awaiting content: a join session (marked at birth), a mention-only native opening, or a legacy
  // bootstrap title. Only then is the canonical title replaced; an ordinary opening keeps the title
  // its entry point created (topic text, schedule, trigger, …) and native-title CLIs still get their
  // launch title from its content.
  const waiting = !!session.nativeSessionTitleAwaitingContent || isBootstrapDisplayTitle(session.title);
  const canonical = waiting;
  if (!waiting && !options.fresh) return undefined;
  if (!waiting && !options.native) return undefined;
  if (!input.text && !options.fresh) return undefined;
  const prompt = input.text ? Array.from(input.text).slice(0, BOTMUX_LARK_TITLE_PROMPT_MAX).join('') : undefined;
  const nativeTitle = buildBotmuxLarkNativeSessionTitle(prompt, undefined, options.groupName || '新话题');
  return {
    // Content-derived titles stay 'initial': 'cli' publishes to session-group naming, which renames a
    // chat only once and must keep waiting for the native semantic result (session-title mode).
    title: nativeTitle.replace(/^\[BotMux·Lark\]\s*/, ''), source: 'initial', canonical,
    awaitingContent: !prompt,
    ...(options.native ? { nativeTitle, ...(prompt ? { nativePrompt: prompt } : {}) } : {}),
    ...(input.bootstrapOnly ? { bootstrap: captureTitleBootstrap(raw, options.mentions) } : {}),
    expectedTitle: session.title, expectedSource: session.titleSource,
    expectedAwaiting: session.nativeSessionTitleAwaitingContent,
  };
}

/** 用首次话题内容生成 Codex 原生会话标题，不依赖 Lark SDK 类型。 */
export function buildBotmuxLarkNativeSessionTitle(
  rawContent: unknown,
  mentions?: readonly { name: string }[],
  emptyContentFallback?: unknown,
): string {
  const content = stripLeadingKnownTitleMentions(
    typeof rawContent === 'string' ? rawContent : '',
    mentions,
  );

  const normalized = normalizeSessionTitle(content)
    ?? normalizeSessionTitle(emptyContentFallback)
    ?? '新话题';
  const maxContentLength = BOTMUX_LARK_TITLE_MAX - Array.from(BOTMUX_LARK_TITLE_PREFIX).length - 1;
  const chars = Array.from(normalized);
  const displayContent = chars.length > maxContentLength
    ? `${chars.slice(0, maxContentLength - 1).join('').trimEnd()}…`
    : normalized;
  return `${BOTMUX_LARK_TITLE_PREFIX} ${displayContent}`;
}

export function normalizeSessionTitleSource(value: unknown, fallback: SessionTitleSource): SessionTitleSource {
  if (
    value === 'initial' ||
    value === 'user' ||
    value === 'agent' ||
    value === 'cli' ||
    value === 'dashboard' ||
    value === 'system'
  ) {
    return value;
  }
  return fallback;
}

/** Persist a display-title change and keep dashboard subscribers in sync. */
export function updateSessionTitle(
  session: Session,
  rawTitle: unknown,
  source: SessionTitleSource,
): SessionTitleUpdateResult {
  const title = normalizeSessionTitle(rawTitle);
  if (!title) return { ok: false, error: 'bad_title' };

  const updatedAt = new Date().toISOString();
  session.title = title;
  session.nativeSessionTitle = title;
  session.nativeSessionTitleUserDefined = true;
  session.nativeSessionTitleAwaitingContent = undefined;
  session.titleUpdatedAt = updatedAt;
  session.titleSource = source;
  sessionStore.updateSession(session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: session.sessionId,
      patch: { title, titleUpdatedAt: updatedAt, titleSource: source },
    },
  });
  return { ok: true, title, updatedAt, source };
}
