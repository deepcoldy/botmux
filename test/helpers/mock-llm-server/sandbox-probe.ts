/**
 * Sandbox probe for the Feishu live sandbox lane. A prompt
 * `e2e-<tag> SANDBOX_PROBE 请立刻调用 …` makes the synthetic model run one
 * `botmux send` whose reply line carries what the sandboxed shell could see:
 *
 *   ACK-<tag> SBX pid1=isolated home=HIDDEN bots=HIDDEN state=HIDDEN outside=BLOCKED workdir=OK
 *
 * Every check is a fixed shell fragment built here; only the tag (letters,
 * digits, `_`, `-`) and paths this process knows are interpolated, never
 * message text. The mock runs on the same machine as the daemon and the test,
 * so host paths match:
 *
 * - pid1: /proc/1/comm differs from the host's (bwrap's own PID namespace).
 * - home: a canary file under the host home (the test writes it) is not readable.
 * - bots / state: the test bots config and the Feishu login state, both inside
 *   the checkout, are not readable. The sandbox mounts the botmux checkout
 *   read-only, so scripts/run-e2e.ts denies them for sandboxed bots.
 * - outside: writing next to the canary fails.
 * - workdir: writing into the working directory succeeds (the test checks the
 *   file reached the host).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { normalizeSandboxMode } from '../../../src/adapters/cli/sandbox-mode.js';
import { currentTurnTexts } from './marker-extractor.js';

export const SANDBOX_PROBE_TOKEN = 'SANDBOX_PROBE';

/** The checks a sandboxed session must pass, as they appear in the reply line. */
export const SANDBOX_PROBE_EXPECTED = 'pid1=isolated home=HIDDEN bots=HIDDEN state=HIDDEN outside=BLOCKED workdir=OK';

export function sandboxCanaryDir(home = homedir()): string {
  return path.join(home, 'botmux-sbx-canary');
}

/** Files the sandbox must not read: the bots config and the Feishu login state. */
export function sandboxSecretPaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): { bots: string; state: string } {
  return {
    bots: path.resolve(cwd, env.BOTS_CONFIG || 'test-bots.json'),
    state: path.resolve(cwd, 'storageState.json'),
  };
}

const PROBE = /(e2e-[A-Za-z0-9_-]+?-\d{10,})\s+SANDBOX_PROBE\b/;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function hostPid1(): string {
  try {
    return readFileSync('/proc/1/comm', 'utf8').trim();
  } catch {
    return '';
  }
}

/** The shell command answering a sandbox probe in the latest turn, or null. */
export function sandboxProbeCommand(messages: unknown[]): string | null {
  if (!Array.isArray(messages)) return null;
  const tag = currentTurnTexts(messages)
    .map((text) => PROBE.exec(text)?.[1])
    .find(Boolean);
  if (!tag) return null;
  const canary = sandboxCanaryDir();
  const { bots, state } = sandboxSecretPaths();
  const checks = [
    `pid1=$([ "$(cat /proc/1/comm 2>/dev/null)" = ${quote(hostPid1())} ] && echo host || echo isolated)`,
    `home=$(cat ${quote(path.join(canary, 'secret.txt'))} >/dev/null 2>&1 && echo READ || echo HIDDEN)`,
    `bots=$([ -r ${quote(bots)} ] && echo READ || echo HIDDEN)`,
    `state=$([ -r ${quote(state)} ] && echo READ || echo HIDDEN)`,
    `outside=$( (echo x > ${quote(path.join(canary, `w-${tag}`))}) 2>/dev/null && echo WROTE || echo BLOCKED)`,
    `workdir=$( (echo ok > ${quote(`./sbx-${tag}`)}) 2>/dev/null && echo OK || echo FAIL)`,
  ];
  return `botmux send --mention-back "ACK-${tag} SBX ${checks.join(' ')}"`;
}

/** Sandbox-relevant shape of one test bot config entry. */
export interface SandboxTestBot {
  sandbox?: unknown;
  workingDir?: string;
  /** Multi-dir form; bot-registry resolves the session dir from workingDirs[0]
   *  with precedence over workingDir, so it must be replaced as a whole. */
  workingDirs?: string[];
  /** Layer-4 pin (effectiveDefaultWorkingDir): outranks workingDir for every
   *  new session, including p2p chats, so it must point at the temp dir too. */
  defaultWorkingDir?: string;
  defaultOncall?: { enabled?: boolean; workingDir?: string };
  sandboxPaths?: { readWrite?: string[]; readOnly?: string[]; deny?: string[] };
}

/** What run-e2e.ts must apply to one bot entry. */
export interface SandboxBotConfigPlan {
  /** Set as the bot's workingDir when defined; otherwise leave it. */
  workingDir?: string;
  /** Replace the whole workingDirs list when defined (sandboxed bots only). */
  workingDirs?: string[];
  /** Replace defaultWorkingDir when the entry sets one (sandboxed bots only). */
  defaultWorkingDir?: string;
  /** Replace defaultOncall.workingDir when set, keeping the rest of the object. */
  defaultOncallWorkingDir?: string;
  /** Replace sandboxPaths with this when defined (sandboxed bots only). */
  sandboxPaths?: { deny: string[] };
}

/**
 * The sandbox part of the run-e2e.ts test-config rewrite, as one pure decision
 * (fs checks and temp-dir creation injected):
 *
 * - A sandboxed bot ALWAYS gets a freshly minted temp working directory, even
 *   when its config already names an existing one (often "."). Keeping that
 *   dir would leave the sandboxed CLI read-write in the checkout — which holds
 *   the test bots config and the Feishu login state — while the lane reported
 *   success. The whole workingDirs list is replaced too: bot-registry takes
 *   workingDirs[0] with precedence over workingDir, and sessions iterate every
 *   entry. defaultWorkingDir and defaultOncall.workingDir (the layer-4 pin,
 *   effective even in p2p chats) are redirected when present.
 * - The checkout is mounted into the sandbox read-only (fs-policy's
 *   botmuxInstallRoot), so the bots config, login state and .env are denied
 *   explicitly for the files that exist.
 * - Sandbox detection reuses the daemon's own normalizeSandboxMode: `null` is
 *   off and an unknown mode string throws instead of silently running the bot
 *   without isolation.
 */
export function planSandboxBotConfig(
  bot: SandboxTestBot,
  deps: {
    existsSync: (file: string) => boolean;
    makeTempWorkDir: () => string;
    cwd: string;
    joinPath: (dir: string, file: string) => string;
    secretPaths: { bots: string; state: string };
  },
): SandboxBotConfigPlan {
  const sandboxed = normalizeSandboxMode(bot.sandbox) !== 'off';
  if (!sandboxed) {
    // Non-sandboxed bots only inherit the missing-workingDir default.
    return !bot.workingDir || !deps.existsSync(bot.workingDir) ? { workingDir: '.' } : {};
  }
  const workingDir = deps.makeTempWorkDir();
  const deny = new Set<string>(bot.sandboxPaths?.deny ?? []);
  for (const secret of [deps.secretPaths.bots, deps.secretPaths.state, deps.joinPath(deps.cwd, '.env')]) {
    if (deps.existsSync(secret)) deny.add(secret);
  }
  // Replace the whole multi-dir list, or an existing entry (often the checkout)
  // would keep precedence over the minted workingDir. The layer-4 pins are
  // redirected only when present — never add config the entry did not have.
  const plan: SandboxBotConfigPlan = { workingDir, workingDirs: [workingDir], sandboxPaths: { deny: [...deny] } };
  if (bot.defaultWorkingDir !== undefined) plan.defaultWorkingDir = workingDir;
  if (bot.defaultOncall?.workingDir !== undefined) plan.defaultOncallWorkingDir = workingDir;
  return plan;
}
