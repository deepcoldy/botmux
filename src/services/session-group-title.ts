/**
 * Async AI title for session groups (p2pMode='group', naming.mode='ai-summary').
 *
 * Two-phase naming: the group is created instantly with a truncated
 * placeholder name; this module then runs ONE headless single-turn call
 * through the bot's own CLI to produce a short title and renames the chat
 * when it lands. Fire-and-forget — every failure path simply keeps the
 * placeholder, never blocks or breaks the conversation.
 *
 * The one-shot command is a small per-cliId argv template (print/exec modes
 * of the CLIs botmux already drives). CLIs without a known print mode
 * degrade to the placeholder silently.
 */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { getBot } from '../bot-registry.js';
import { updateChatName } from './groups-store.js';
import { getSessionGroup, markSessionGroupTitled, touchSessionGroup } from './session-groups-store.js';
import * as sessionStore from './session-store.js';
import { updateSessionTitle } from '../core/session-title.js';
import { localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';

const TITLE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LEN = 12;

/** Per-cliId one-shot print-mode argv template. `argv[0]` is replaced by
 *  `cliPathOverride` when configured. Prompt is appended as the last arg. */
const ONE_SHOT_ARGV: Record<string, string[]> = {
  'claude-code': ['claude', '-p'],
  codex: ['codex', 'exec', '--skip-git-repo-check'],
  opencode: ['opencode', 'run'],
  gemini: ['gemini', '-p'],
};

export function buildTitlePrompt(text: string, maxLen: number, locale: string): string {
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (locale === 'en') {
    return `Summarize the following request as a conversation title of at most ${maxLen} characters. Output ONLY the title itself — no quotes, no trailing period, no explanation:\n\n${excerpt}`;
  }
  return `用不超过${maxLen}个字总结下面这条请求，作为会话标题。只输出标题本身，不要引号、句号或任何解释：\n\n${excerpt}`;
}

/** Extract a plausible title from one-shot CLI stdout: last non-empty line
 *  (codex/opencode prepend progress logs; claude/gemini print the bare
 *  answer), stripped of quotes/markdown and length-capped. */
export function sanitizeTitleOutput(stdout: string, maxLen: number): string | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    // codex exec progress lines look like "[2026-08-05T…] tokens used: 123" —
    // drop bracketed/log-ish lines so the answer line survives as the last one.
    .filter(l => !/^\[.*\]/.test(l) && !/^(tokens used|thinking|codex$|user$)/i.test(l));
  const raw = lines.length ? lines[lines.length - 1] : '';
  const cleaned = raw
    .replace(/^["'“”‘’`#*\s]+/, '')
    // Trailing quotes/backticks and sentence punctuation interleave (e.g.
    // `标题"。`) — strip them as one class so the order can't matter.
    .replace(/["'“”‘’`。.!！?？\s]+$/, '')
    .trim();
  if (!cleaned) return null;
  // Hard cap: maxLen is advisory to the model; enforce a generous ceiling so
  // a slightly-long but good title still beats the placeholder.
  const capped = Array.from(cleaned).slice(0, Math.max(maxLen * 2, 16)).join('');
  return capped || null;
}

/** Fire-and-forget: generate an AI title for a freshly-born session group and
 *  rename the chat (+ session record) when it lands. */
export function scheduleSessionGroupTitle(opts: {
  larkAppId: string;
  chatId: string;
  userText: string;
}): void {
  const { larkAppId, chatId, userText } = opts;
  void (async () => {
    try {
      const cfg = getBot(larkAppId).config;
      const sg = cfg.sessionGroup ?? {};
      if ((sg.naming?.mode ?? 'ai-summary') !== 'ai-summary') return;
      if (!userText.trim()) return;
      const maxLen = sg.naming?.maxLen && sg.naming.maxLen > 0 ? sg.naming.maxLen : DEFAULT_MAX_LEN;

      const template = ONE_SHOT_ARGV[cfg.cliId];
      if (!template) {
        logger.info(`[session-group] no one-shot template for cliId=${cfg.cliId}; keeping placeholder title`);
        return;
      }
      const argv = [...template];
      if (cfg.cliPathOverride?.trim()) argv[0] = cfg.cliPathOverride.trim();
      const prompt = buildTitlePrompt(userText, maxLen, localeForBot(larkAppId));

      const stdout = await new Promise<string>((resolve, reject) => {
        const env = { ...process.env };
        delete env.BOTMUX_SESSION_ID; // never let the one-shot inherit a session identity
        execFile(argv[0], [...argv.slice(1), prompt], {
          timeout: TITLE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          cwd: tmpdir(),
          env,
        }, (err, out) => {
          if (err && !out) return reject(err);
          resolve(String(out ?? ''));
        });
      });

      const title = sanitizeTitleOutput(stdout, maxLen);
      if (!title) {
        logger.info(`[session-group] AI title empty for chat=${chatId.substring(0, 12)}; keeping placeholder`);
        return;
      }
      const prefix = sg.namePrefix ?? '';
      const finalName = `${prefix}${title}`;
      const r = await updateChatName(larkAppId, chatId, finalName);
      if (!r.ok) {
        logger.warn(`[session-group] rename chat=${chatId.substring(0, 12)} failed: ${r.error}`);
        return;
      }
      markSessionGroupTitled(chatId);
      // Best-effort: keep the botmux session title in sync so `botmux list` /
      // dashboard show the same name as the chat (same path as /rename).
      const entry = getSessionGroup(chatId);
      if (entry?.lastSessionId) {
        const session = sessionStore.getSession(entry.lastSessionId);
        if (session) updateSessionTitle(session, title);
        touchSessionGroup(chatId);
      }
      logger.info(`[session-group] titled chat=${chatId.substring(0, 12)} "${finalName}"`);
    } catch (err) {
      logger.info(`[session-group] AI title failed for chat=${chatId.substring(0, 12)} (placeholder kept): ${err}`);
    }
  })();
}
