import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStandaloneBinary, resolveEntrySpawn } from './self-spawn.js';

/**
 * Launch plan for `program-status-relay` (see src/program-status-relay.ts).
 *
 * The wrapped command travels in a private plan FILE; the relay's argv carries
 * only its path. Two reasons:
 *   - tmux rejects a `new-session` command around 16 KB ("command too long"),
 *     and the CLI argv already spends most of that budget on a first prompt
 *     (TMUX_INITIAL_PROMPT_ARG_BUDGET). Re-encoding it inline would push
 *     prompts that fit today over the limit; a path keeps the relay's
 *     overhead constant.
 *   - discovery (`cliIdFromCommArgv`) scans the argv of interpreter-named
 *     processes (`node`, `bun`) for a CLI basename, and a bun-run relay keeps
 *     comm `bun` (process.title does not rename it there). A plain `claude`
 *     token in the relay's argv would make /adopt and the pid resolvers
 *     mistake the relay for Claude itself.
 * The relay deletes the file as soon as it has read it.
 *
 * The file is NOT trusted on its own: it lives in a temp directory that other
 * (sandboxed) sessions running as the same OS user can write to, and the relay
 * executes its command OUTSIDE any sandbox. Its SHA-256 travels in argv (set
 * by the worker, outside the attacker's reach) and the relay refuses a plan
 * whose content does not match — a swapped plan cannot drop the confinement
 * wrapper or run a host command.
 */
export interface ProgramStatusRelayPlan { bin: string; args: string[] }

const RELAY_TOKEN = '__program-status-relay';
const RELAY_SCRIPT = 'program-status-relay.js';
const RELAY_SOURCE = 'program-status-relay.ts';
const PLAN_FILE = 'plan.json';
const PLAN_DIR_PREFIX = 'botmux-psr-';

/** The relay runs OUTSIDE any sandbox/credential wrapper, so nothing the bot
 *  or its working directory configures may execute code in it:
 *   - interpreter loader options (a `--require`/`--import` preload in
 *     NODE_OPTIONS/BUN_OPTIONS) are parked under a private name;
 *   - the relay starts in `/`, because Bun autoloads `.env*` and `bunfig.toml`
 *     (whose `preload` runs code) from the current directory.
 *  The relay hands the CLI its original options and working directory back. */
const LOADER_ENV_KEYS = ['NODE_OPTIONS', 'BUN_OPTIONS'] as const;
const PARKED_PREFIX = '__BOTMUX_PSR_';
const PARK_LOADER_ENV_SCRIPT = LOADER_ENV_KEYS
  .map(k => `if [ -n "\${${k}+x}" ]; then ${PARKED_PREFIX}${k}=\$${k}; export ${PARKED_PREFIX}${k}; unset ${k}; fi`)
  .join('; ') + `; ${PARKED_PREFIX}CWD=$PWD; export ${PARKED_PREFIX}CWD; cd / || exit 1; exec "$@"`;

/** The CLI's launch context: parked loader options restored, the original
 *  working directory (and PWD) back, parking names removed. Without a parked
 *  cwd (relay started directly, e.g. in tests) the relay's own cwd is used. */
export function relayChildLaunch(env: NodeJS.ProcessEnv, fallbackCwd: string): { env: NodeJS.ProcessEnv; cwd: string } {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of LOADER_ENV_KEYS) {
    const parked = PARKED_PREFIX + key;
    if (parked in out) {
      out[key] = out[parked];
      delete out[parked];
    }
  }
  const parkedCwd = out[`${PARKED_PREFIX}CWD`];
  delete out[`${PARKED_PREFIX}CWD`];
  if (!parkedCwd) return { env: out, cwd: fallbackCwd };
  out.PWD = parkedCwd;
  return { env: out, cwd: parkedCwd };
}

/** Resolve the relay entry, or null when it cannot be executed from here. That
 *  is the case when the worker runs from source: resolveEntrySpawn points at
 *  `src/program-status-relay.js`, which does not exist, and under Node a `.ts`
 *  would also need a loader the pane (different cwd, possibly a strict env)
 *  cannot resolve. Bun runs the `.ts` natively. */
function resolveRelayEntry(): { command: string; args: string[] } | null {
  const entry = resolveEntrySpawn('program-status-relay', join(dirname(fileURLToPath(import.meta.url)), '..'));
  if (isStandaloneBinary()) return entry;
  let script = entry.args[0];
  if (!existsSync(script)) {
    script = script.replace(/\.js$/, '.ts');
    if (!process.versions.bun || !existsSync(script)) return null;
  }
  // A bun interpreter would otherwise autoload `.env*` and bunfig (preload)
  // from the cwd/home. The shim's `cd /` already covers the cwd (and is all a
  // compiled binary, which takes no runtime flags, gets); be explicit here.
  const runtimeFlags = process.versions.bun ? ['--no-env-file', '--config=/dev/null'] : [];
  return { command: entry.command, args: [...runtimeFlags, script] };
}

/**
 * Wrap `bin args` in the relay, or return null (callers then launch the CLI
 * directly — the pre-relay behaviour). `cleanup` removes the plan file for a
 * launch that never reached the relay (spawn failure, reattach instead of a
 * fresh pane); it is a no-op once the relay has consumed it.
 */
export function programStatusRelayLaunch(
  bin: string,
  args: string[],
  planRoot: string = tmpdir(),
): { bin: string; args: string[]; cleanup: () => void } | null {
  const entry = resolveRelayEntry();
  if (!entry) return null;
  const dir = mkdtempSync(join(planRoot, PLAN_DIR_PREFIX));
  const planPath = join(dir, PLAN_FILE);
  const plan: ProgramStatusRelayPlan = { bin, args };
  const raw = JSON.stringify(plan);
  writeFileSync(planPath, raw, { mode: 0o600 });
  return {
    bin: '/bin/sh',
    args: ['-c', PARK_LOADER_ENV_SCRIPT, 'botmux-program-status-relay', entry.command, ...entry.args, planDigest(raw), planPath],
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

function planDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Read and delete the plan file written by {@link programStatusRelayLaunch},
 *  accepting it only if its content matches the digest passed alongside it. */
export function consumeProgramStatusRelayPlan(expectedDigest: string | undefined, planPath: string | undefined): ProgramStatusRelayPlan {
  if (!planPath || !expectedDigest) throw new Error('program-status-relay: missing launch plan');
  let raw: string;
  try {
    raw = readFileSync(planPath, 'utf8');
  } finally {
    const dir = dirname(planPath);
    if (basename(planPath) === PLAN_FILE && basename(dir).startsWith(PLAN_DIR_PREFIX)) rmSync(dir, { recursive: true, force: true });
  }
  if (!/^[0-9a-f]{64}$/.test(expectedDigest) || planDigest(raw) !== expectedDigest) {
    throw new Error('program-status-relay: launch plan does not match its digest (tampered?); refusing to run it');
  }
  const plan = JSON.parse(raw) as Partial<ProgramStatusRelayPlan>;
  if (typeof plan.bin !== 'string' || !plan.bin || !Array.isArray(plan.args) || !plan.args.every(a => typeof a === 'string')) {
    throw new Error('program-status-relay: malformed launch plan');
  }
  return { bin: plan.bin, args: plan.args };
}

const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Interpreters a relay can run under: this process's own executable (the
 *  worker relaunches through process.execPath — node, bun or the compiled
 *  botmux binary) plus any node/bun/botmux by basename, so a relay started by
 *  an earlier daemon is still recognised after a restart. */
function relayInterpreterPattern(execPath: string): string {
  return `(?:${escapeRegExp(execPath)}|(?:\\S*/)?(?:node|nodejs|bun|botmux[^/ ]*))`;
}

/** True when a process argv (`/proc/<pid>/cmdline`) is a program-status relay:
 *    <interpreter> [--no-env-file --config=/dev/null] <entry> <sha256> <plan>
 *  where <entry> is `__program-status-relay` (compiled) or the relay script.
 *  Anchored at BOTH ends: a launcher whose argv merely ends with the relay
 *  command (`systemd-run … -- <relay>`, the `/bin/sh -c` env shim) must not
 *  pass before it has exec'd, and neither may a CLI argument that names a file
 *  `program-status-relay.ts`. Matching the joined string keeps working when
 *  macOS readCmdline() falls back to `ps` and whitespace-splits paths that
 *  contain spaces (interpreter, script or a TMPDIR-based plan path). */
export function isProgramStatusRelayArgv(argv: readonly string[], execPath: string = process.execPath): boolean {
  const entry = `(?:${RELAY_TOKEN}|(?:\\S.*/)?(?:${escapeRegExp(RELAY_SCRIPT)}|${escapeRegExp(RELAY_SOURCE)}))`;
  const plan = `(?:\\S.*)?/${PLAN_DIR_PREFIX}[^/ ]+/${escapeRegExp(PLAN_FILE)}`;
  const pattern = new RegExp(`^${relayInterpreterPattern(execPath)} (?:--no-env-file --config=/dev/null )?${entry} [0-9a-f]{64} ${plan}$`);
  return pattern.test(argv.join(' '));
}
