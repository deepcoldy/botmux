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
 *
 * `generateOneShotTitle` is also the title source for unnamed `/g` groups
 * (see group-auto-title.ts), which keep their own registry and gating.
 */
import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getBot } from '../bot-registry.js';
import { credentialIsolationRequired, deviceCredentialIsolationMarkerPath } from '../adapters/cli/read-isolation.js';
import { resolveSandboxMode } from '../adapters/cli/sandbox-mode.js';
import { DEVICE_AUTHORITY_DIRECTORY, DEVICE_CREDENTIAL_FILE } from '../platform/device-paths.js';
import { cliConfigDirEnvKey } from '../core/cli-config-dir.js';
import { botOneShotEnv, type SessionEnvBotInput } from '../core/session-env-resolve.js';
import { buildWrappedLaunch, wrapperLaunchEnv } from '../setup/cli-selection.js';
import { renameChat } from './groups-store.js';
import {
  getSessionGroup,
  markSessionGroupTitleFailed,
  markSessionGroupTitled,
  touchSessionGroup,
} from './session-groups-store.js';
import * as sessionStore from './session-store.js';
import { updateSessionTitle } from '../core/session-title.js';
import { localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';

// Generous: one-shot CLIs pay cold-start + API latency (codex regularly
// exceeds 15s); the rename is async so a slow title costs nothing visible.
const TITLE_TIMEOUT_MS = 45_000;
export const DEFAULT_TITLE_MAX_LEN = 12;
export const MAX_SESSION_GROUP_TITLE_ROUNDS = 3;

/** Per-cliId one-shot print-mode argv template. `argv[0]` is replaced by
 *  `cliPathOverride` when configured. Prompt is appended as the last arg. */
export const ONE_SHOT_ARGV: Record<string, string[]> = {
  // Pin the permission mode: the bot's profile (oneShotProfileEnv →
  // CLAUDE_CONFIG_DIR) may set `permissions.defaultMode: "bypassPermissions"`,
  // which Claude Code refuses under root without IS_SANDBOX ("--dangerously-
  // skip-permissions cannot be used with root/sudo privileges"), failing every
  // title. A title call needs no tools, so never inherit bypass either way.
  'claude-code': ['claude', '-p', '--permission-mode', 'dontAsk'],
  codex: ['codex', 'exec', '--skip-git-repo-check'],
  // TRAE CLI is a codex fork — same exec surface and bare-answer stdout.
  traex: ['traex', 'exec', '--skip-git-repo-check'],
  opencode: ['opencode', 'run'],
  gemini: ['gemini', '-p'],
  antigravity: ['agy', '-p'],
  grok: ['grok', '-p'],
};

/** One in-flight title job per chat — birth and the heal-on-activity path
 *  (handleThreadReply) can otherwise race duplicate CLI calls. */
const inFlightTitles = new Set<string>();

/**
 * Child env for the one-shot title call — the SAME security boundary as every
 * other CLI child the daemon spawns (PR review P2): `redactChildEnv` strips
 * daemon-only secrets (LARK_APP_SECRET, GITHUB_TOKEN, tmux client vars, Claude
 * session markers) and `sanitizePerBotEnv(cfg.env)` layers the bot's own
 * provider environment (base URL / auth token) on top so multi-provider bots
 * title through their own account instead of the daemon's. Exported for the
 * env-boundary regression tests.
 */
/**
 * Resolve the one-shot launch with the SAME launcher semantics as the formal
 * CLI spawn path (PR review): `wrapperCli` goes through buildWrappedLaunch —
 * the shared builder that knows the gateway specifics (ttadk needs
 * `-m <model> --skip-check` or it opens an interactive model selector /
 * preflight and a non-TTY execFile hangs to timeout; aiden strips args it
 * rejects; cjadk rewrites codex config args) — plus wrapperLaunchEnv for the
 * wrapper's non-interactive env knobs (CJADK_INTERACTIVE=0). Without a
 * wrapper, `cliPathOverride` (registerBot enforces it as an exact shadow of
 * cliRuntime.executable, so runtime configs are covered transitively)
 * replaces the template bin; otherwise the template runs verbatim. Exported
 * for tests.
 */
export function resolveOneShotCommand(
  cfg: { wrapperCli?: string; cliPathOverride?: string; model?: string },
  template: readonly string[],
): { argv: string[]; env?: Record<string, string> } {
  const wrapper = cfg.wrapperCli?.trim();
  if (wrapper) {
    const { bin, args } = buildWrappedLaunch(wrapper, template.slice(1), b => b, { ttadkModel: cfg.model });
    return { argv: [bin, ...args], env: wrapperLaunchEnv(wrapper) };
  }
  const override = cfg.cliPathOverride?.trim();
  if (override) return { argv: [override, ...template.slice(1)] };
  return { argv: [...template] };
}

export function buildOneShotEnv(bot: SessionEnvBotInput = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = botOneShotEnv(process.env, bot);
  // Never let the one-shot inherit a botmux session identity (redundant with
  // the marker scrub above, kept as an explicit invariant).
  delete env.BOTMUX_SESSION_ID;
  return env;
}

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

/** Whether this CLI has a one-shot print mode the title generator can drive. */
export function supportsOneShotTitle(cliId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ONE_SHOT_ARGV, cliId);
}

/** Mandatory device-credential isolation on this host — the same marker /
 *  device-credential probe worker.ts runs before every local spawn. */
function hostRequiresCredentialIsolation(): boolean {
  const home = homedir();
  const exists = (path: string): boolean => {
    try { lstatSync(path); return true; } catch { return false; }
  };
  const roots = new Set([join(home, '.botmux')]);
  if (process.env.SESSION_DATA_DIR) roots.add(dirname(process.env.SESSION_DATA_DIR));
  return credentialIsolationRequired({
    markerExists: exists(deviceCredentialIsolationMarkerPath(home)),
    deviceCredentialExists: [...roots].some(root => exists(join(root, DEVICE_AUTHORITY_DIRECTORY, DEVICE_CREDENTIAL_FILE))
      || exists(join(root, DEVICE_CREDENTIAL_FILE))),
  });
}

/**
 * Whether `/g` may run a one-shot title call for this bot. The call is a bare
 * CLI process on the daemon host — no file sandbox or credential confinement,
 * tools and hooks left on, only the env / wrapper / profile this module
 * reproduces — so it is allowed only for a plain local launch it provably
 * matches. Anything else keeps the placeholder name: a sandboxed bot or an
 * enrolled host (mandatory credential isolation), the Forge launch mode, and a
 * private or pooled CODEX_HOME. Remote CLIs have no one-shot template at all.
 * Fails closed on an unresolvable sandbox mode.
 */
export function oneShotTitleAllowed(cfg: {
  cliId: string;
  sandbox?: unknown;
  readIsolation?: boolean;
  cliLaunchMode?: string;
  codexAuthSync?: string;
  codexInstancePool?: unknown;
}): boolean {
  if (!supportsOneShotTitle(cfg.cliId)) return false;
  if (cfg.cliLaunchMode || cfg.codexAuthSync === 'isolated' || cfg.codexInstancePool) return false;
  try {
    if (resolveSandboxMode({
      configSandbox: cfg.sandbox,
      readIsolation: cfg.readIsolation === true,
      envValue: process.env.BOTMUX_SANDBOX,
    }) !== 'off') return false;
    return !hostRequiresCredentialIsolation();
  } catch {
    return false;
  }
}

/**
 * The bot's CLI config profile (`cliConfigDir`) for the one-shot launch: the
 * same CLAUDE_CONFIG_DIR the worker spawns with (see claudeConfigProfileVariant).
 * Daemon boot scrubs inherited CLI-home pointers, so without it the call would
 * use the host's default settings and login instead of the bot's account.
 */
export function oneShotProfileEnv(cfg: { cliId: string; cliConfigDir?: string }): Record<string, string> {
  const key = cliConfigDirEnvKey(cfg.cliId);
  const dir = cfg.cliConfigDir?.trim();
  if (!key || !dir) return {};
  const expanded = dir === '~' ? homedir() : dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir;
  return { [key]: resolve(expanded) };
}

/**
 * Run ONE headless call through the bot's own CLI and extract a short title.
 * Shared by session groups and unnamed `/g` groups so both use the same
 * launcher, env boundary and output sanitizer.
 *
 * Resolves null when the CLI has no one-shot template or its output carried
 * no usable title; rejects when the CLI call failed twice (one spaced in-call
 * retry). `logTag` / `chatId` only label the log lines.
 */
export async function generateOneShotTitle(opts: {
  larkAppId: string;
  chatId: string;
  userText: string;
  maxLen: number;
  logTag: string;
}): Promise<string | null> {
  const { larkAppId, chatId, userText, maxLen, logTag } = opts;
  const cfg = getBot(larkAppId).config;
  const template = ONE_SHOT_ARGV[cfg.cliId];
  if (!template) {
    logger.info(`[${logTag}] no one-shot template for cliId=${cfg.cliId}; keeping placeholder title`);
    return null;
  }
  const { argv, env: wrapperEnv } = resolveOneShotCommand(cfg, template);
  const prompt = buildTitlePrompt(userText, maxLen, localeForBot(larkAppId));

  const runOnce = () => new Promise<string>((resolve, reject) => {
    const env = { ...buildOneShotEnv(cfg), ...wrapperEnv, ...oneShotProfileEnv(cfg) };
    const child = execFile(argv[0], [...argv.slice(1), prompt], {
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
    // CRITICAL: close stdin. codex-family CLIs (codex/traex) treat a piped
    // stdin as "additional input" and BLOCK reading it until EOF — with
    // execFile's default open pipe they hang to the timeout and get killed
    // ("Reading additional input from stdin..."). A TTY stdin (manual
    // testing) skips that path, which is why this only bites under the
    // daemon. Closing stdin is a no-op for CLIs that never read it.
    child.stdin?.end();
  });
  // One-shot CLI calls fail transiently (API hiccups, cold start races) —
  // a single spaced retry recovers most of them without delaying much.
  let stdout: string;
  try {
    stdout = await runOnce();
  } catch (firstErr) {
    logger.info(`[${logTag}] AI title attempt 1 failed for chat=${chatId.substring(0, 12)} (retrying): ${firstErr}`);
    await new Promise(r => setTimeout(r, 3000));
    stdout = await runOnce();
  }

  const title = sanitizeTitleOutput(stdout, maxLen);
  if (!title) {
    // Log the raw head — an unpredicted output shape is invisible otherwise.
    const rawHead = stdout.replace(/\s+/g, ' ').trim().slice(0, 200);
    logger.info(`[${logTag}] AI title empty for chat=${chatId.substring(0, 12)}; keeping placeholder (raw: "${rawHead}")`);
  }
  return title;
}

/** Fire-and-forget: generate an AI title for a freshly-born session group and
 *  rename the chat (+ session record) when it lands. */
export function scheduleSessionGroupTitle(opts: {
  larkAppId: string;
  chatId: string;
  userText: string;
}): void {
  const { larkAppId, chatId, userText } = opts;
  if (inFlightTitles.has(chatId)) return;
  // Bounded healing: a group whose title never lands must not let every later
  // message spawn another one-shot CLI. Rounds are capped and spaced by the
  // persisted backoff deadline (survives daemon restarts).
  const current = getSessionGroup(chatId);
  if (!current || current.titled) return;
  if ((current.titleAttempts ?? 0) >= MAX_SESSION_GROUP_TITLE_ROUNDS) return;
  if ((current.titleRetryAt ?? 0) > Date.now()) return;
  inFlightTitles.add(chatId);
  let succeeded = false;
  void (async () => {
    try {
      const cfg = getBot(larkAppId).config;
      const sg = cfg.sessionGroup ?? {};
      if ((sg.naming?.mode ?? 'ai-summary') !== 'ai-summary') return;
      if (!userText.trim()) return;
      const maxLen = sg.naming?.maxLen && sg.naming.maxLen > 0 ? sg.naming.maxLen : DEFAULT_TITLE_MAX_LEN;

      const title = await generateOneShotTitle({ larkAppId, chatId, userText, maxLen, logTag: 'session-group' });
      if (!title) return;
      const prefix = sg.namePrefix ?? '';
      const finalName = `${prefix}${title}`;
      // Reuse the shared renameChat wrapper (membership precheck + error
      // classification) instead of a bespoke chat.update call.
      const r = await renameChat(larkAppId, chatId, finalName);
      if (!r.ok) {
        logger.warn(`[session-group] rename chat=${chatId.substring(0, 12)} failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`);
        return;
      }
      markSessionGroupTitled(chatId);
      succeeded = true;
      // Best-effort: keep the botmux session title in sync so `botmux list` /
      // dashboard show the same name as the chat (same path as /rename).
      const entry = getSessionGroup(chatId);
      if (entry?.lastSessionId) {
        const session = sessionStore.getSession(entry.lastSessionId);
        if (session) updateSessionTitle(session, title, 'system');
        touchSessionGroup(chatId);
      }
      logger.info(`[session-group] titled chat=${chatId.substring(0, 12)} "${finalName}"`);
    } catch (err) {
      logger.info(`[session-group] AI title failed for chat=${chatId.substring(0, 12)} (placeholder kept): ${err}`);
    } finally {
      if (!succeeded) markSessionGroupTitleFailed(chatId);
      inFlightTitles.delete(chatId);
    }
  })();
}
