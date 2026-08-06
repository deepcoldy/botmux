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

// Generous: one-shot CLIs pay cold-start + API latency (codex regularly
// exceeds 15s); the rename is async so a slow title costs nothing visible.
const TITLE_TIMEOUT_MS = 45_000;
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

/** Strip decoration from a candidate title line. */
function cleanTitleLine(raw: string): string {
  return raw
    .replace(/^["'“”‘’`#*\s]+/, '')
    // Trailing quotes/backticks and sentence punctuation interleave (e.g.
    // `标题"。`) — strip them as one class so the order can't matter.
    .replace(/["'“”‘’`。.!！?？\s]+$/, '')
    .trim();
}

/** Extract a plausible title from one-shot CLI stdout: last non-empty line
 *  (codex/opencode prepend progress logs; claude/gemini print the bare
 *  answer), stripped of quotes/markdown and length-capped. Two passes: a
 *  strict pass drops known log-line shapes; if that filters EVERYTHING (an
 *  output shape we didn't predict), a lenient pass takes the last line that
 *  still looks like prose — never let over-filtering blank a real answer. */
export function sanitizeTitleOutput(stdout: string, maxLen: number): string | null {
  const all = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  // Obvious non-answers in ANY pass: dividers, bare numbers, hook chatter,
  // lines with no letter/digit at all.
  const junk = (l: string) =>
    !/[\p{L}\p{N}]/u.test(l) || /^[-=—_\s]+$/.test(l) || /^\d[\d,.\s]*$/.test(l) || /^hook:/i.test(l);
  const strict = all
    // codex exec progress lines look like "[2026-08-05T…] tokens used: 123" —
    // drop bracketed/log-ish lines so the answer line survives as the last one.
    .filter(l => !junk(l) && !/^\[.*\]/.test(l) && !/^(tokens used|thinking|codex$|user$)/i.test(l));
  // Lenient fallback: keep anything prose-like, including bracket-prefixed
  // lines the strict pass dropped (unpredicted "[ts] answer" shapes).
  const lenient = all.filter(l => !junk(l));
  const raw = strict.length ? strict[strict.length - 1]
    // The lenient pick may still carry a bracketed log prefix — strip it so a
    // "[ts] answer" line yields the answer, not the timestamp.
    : lenient.length ? lenient[lenient.length - 1].replace(/^\[[^\]]*\]\s*/, '') : '';
  const cleaned = cleanTitleLine(raw);
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

      const runOnce = () => new Promise<string>((resolve, reject) => {
        const env = { ...process.env };
        delete env.BOTMUX_SESSION_ID; // never let the one-shot inherit a session identity
        execFile(argv[0], [...argv.slice(1), prompt], {
          timeout: TITLE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          cwd: tmpdir(),
          env,
        }, (err, out, errOut) => {
          if (err && !out) {
            // Surface stderr — execFile's bare "Command failed: …" hides the
            // actual CLI error (API failures, auth, rate limits).
            const detail = String(errOut ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 200);
            return reject(new Error(`${err.message.split('\n')[0]}${detail ? ` | stderr: ${detail}` : ''}`));
          }
          resolve(String(out ?? ''));
        });
      });
      // One-shot CLI calls fail transiently (API hiccups, cold start races) —
      // a single spaced retry recovers most of them without delaying much.
      let stdout: string;
      try {
        stdout = await runOnce();
      } catch (firstErr) {
        logger.info(`[session-group] AI title attempt 1 failed for chat=${chatId.substring(0, 12)} (retrying): ${firstErr}`);
        await new Promise(r => setTimeout(r, 3000));
        stdout = await runOnce();
      }

      const title = sanitizeTitleOutput(stdout, maxLen);
      if (!title) {
        // Log the raw head — an unpredicted output shape is invisible otherwise.
        const rawHead = stdout.replace(/\s+/g, ' ').trim().slice(0, 200);
        logger.info(`[session-group] AI title empty for chat=${chatId.substring(0, 12)}; keeping placeholder (raw: "${rawHead}")`);
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
