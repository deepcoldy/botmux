import { normalizeSessionTitle } from './session-board.js';
import { stripBotmuxDisplayBlocks } from '../utils/prompt-display-strip.js';

export function stripLeadingKnownTitleMentions(raw: string, mentions?: readonly { name: string }[]): string {
  let content = raw.trimStart();
  const names = (mentions ?? []).map(m => m.name.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  let matched = true;
  while (matched) {
    matched = false;
    for (const name of names) {
      const prefix = content.match(/^@+/)?.[0];
      if (prefix && content.slice(prefix.length).startsWith(name)) {
        content = content.slice(prefix.length + name.length).trimStart(); matched = true; break;
      }
    }
  }
  return content;
}

function normalizedInput(raw: unknown, mentions?: readonly { name: string }[]): string {
  if (typeof raw !== 'string') return '';
  const text = raw.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/)?.[1] ?? stripBotmuxDisplayBlocks(raw);
  return stripLeadingKnownTitleMentions(text.replace(/^\s*\[用户引用了消息[^\n]*\]\s*$/gm, '')
    .replace(/^\s*\[来自[^\n]*@mention[^\n]*\]\s*$/gm, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' '), mentions).trim();
}

/** Remove a configured bootstrap only from the title input, never from the task. */
export interface TitleBootstrapFingerprint { digest: string; length: number }

export function sessionTitleInput(raw: unknown, mentions?: readonly { name: string }[], bootstrapPrompts: readonly string[] = [], previous?: TitleBootstrapFingerprint, digest?: (text: string) => string) {
  let text = normalizedInput(raw, mentions);
  let bootstrapOnly = false;
  if (previous && digest && Number.isInteger(previous.length) && previous.length > 0
    && text.length >= previous.length && digest(text.slice(0, previous.length)) === previous.digest) {
    text = text.slice(previous.length).replace(/^[\s:：;；]+/, '').trim();
    return { text, bootstrapOnly: !text };
  }
  const seeds = bootstrapPrompts.map(seed => normalizedInput(seed, mentions)).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const seed of seeds) {
    if (text === seed) { text = ''; bootstrapOnly = true; break; }
    if (text.startsWith(seed)) { text = text.slice(seed.length).replace(/^[\s:：;；]+/, '').trim(); break; }
  }
  return { text, bootstrapOnly };
}

export interface AutomaticTitleState {
  title: string;
  nativeSessionTitleUserDefined?: boolean;
  titleSource?: string;
  titleUpdatedAt?: string;
}

export function hasManualSessionTitle(state: Pick<AutomaticTitleState, 'nativeSessionTitleUserDefined' | 'titleSource'>): boolean {
  return state.nativeSessionTitleUserDefined === true || ['user', 'dashboard', 'agent'].includes(state.titleSource ?? '');
}

/** A canonical title written by automatic naming ('initial' from content, 'cli' from a native semantic
 * result). Entry points (topic text, schedule, trigger, …) create sessions with the source unset; those
 * creation titles are not automatic and are never replaced by a late semantic result. */
export function hasAutomaticSessionTitle(state: Pick<AutomaticTitleState, 'nativeSessionTitleUserDefined' | 'titleSource'>): boolean {
  return !hasManualSessionTitle(state) && (state.titleSource === 'initial' || state.titleSource === 'cli');
}

/** A pure state change: the owner persists the complete native/canonical update once. */
export function applyAutomaticSessionTitle(state: AutomaticTitleState, raw: unknown, source: 'initial' | 'cli', updatedAt: string): boolean {
  if (hasManualSessionTitle(state)) return false;
  const title = normalizeSessionTitle(typeof raw === 'string' ? raw.replace(/^\[BotMux·Lark\]\s*/, '') : raw);
  if (!title || (state.title === title && state.titleSource === source)) return false;
  state.title = title; state.titleSource = source; state.titleUpdatedAt = updatedAt;
  return true;
}

/** Existing initial titles may contain a truncated oncall join prompt. */
export function isBootstrapDisplayTitle(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.replace(/^\[BotMux·Lark\]\s*/, '').replace(/\s+/g, ' ');
  return /^你是本群的\s*oncall\s*协同助手/.test(text) && text.includes('入群后先阅读群内可见的最近消息');
}
