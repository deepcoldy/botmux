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
 */
export interface ProgramStatusRelayPlan { bin: string; args: string[] }

const RELAY_TOKEN = '__program-status-relay';
const RELAY_SCRIPT = 'program-status-relay.js';
const RELAY_SOURCE = 'program-status-relay.ts';
const PLAN_FILE = 'plan.json';
const PLAN_DIR_PREFIX = 'botmux-psr-';

/** Interpreter startup options a bot may configure for its CLI. The relay runs
 *  OUTSIDE any sandbox/credential wrapper, so a `--require`/`--import` preload
 *  in them must not execute there: the launch shim parks them under a private
 *  name before exec'ing the relay, and the relay restores them for the CLI. */
const LOADER_ENV_KEYS = ['NODE_OPTIONS', 'BUN_OPTIONS'] as const;
const PARKED_PREFIX = '__BOTMUX_PSR_';
const PARK_LOADER_ENV_SCRIPT = LOADER_ENV_KEYS
  .map(k => `if [ -n "\${${k}+x}" ]; then ${PARKED_PREFIX}${k}=\$${k}; export ${PARKED_PREFIX}${k}; unset ${k}; fi`)
  .join('; ') + '; exec "$@"';

/** Child env for the CLI: parked loader options restored, parking names removed. */
export function restoreRelayLoaderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of LOADER_ENV_KEYS) {
    const parked = PARKED_PREFIX + key;
    if (parked in out) {
      out[key] = out[parked];
      delete out[parked];
    }
  }
  return out;
}

/** Resolve the relay entry, or null when it cannot be executed from here. That
 *  is the case when the worker runs from source: resolveEntrySpawn points at
 *  `src/program-status-relay.js`, which does not exist, and under Node a `.ts`
 *  would also need a loader the pane (different cwd, possibly a strict env)
 *  cannot resolve. Bun runs the `.ts` natively. */
function resolveRelayEntry(): { command: string; args: string[] } | null {
  const entry = resolveEntrySpawn('program-status-relay', join(dirname(fileURLToPath(import.meta.url)), '..'));
  if (isStandaloneBinary() || existsSync(entry.args[0])) return entry;
  const tsEntry = entry.args[0].replace(/\.js$/, '.ts');
  if (!process.versions.bun || !existsSync(tsEntry)) return null;
  return { command: entry.command, args: [tsEntry] };
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
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  return {
    bin: '/bin/sh',
    args: ['-c', PARK_LOADER_ENV_SCRIPT, 'botmux-program-status-relay', entry.command, ...entry.args, planPath],
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Read and delete the plan file written by {@link programStatusRelayLaunch}. */
export function consumeProgramStatusRelayPlan(planPath: string | undefined): ProgramStatusRelayPlan {
  if (!planPath) throw new Error('program-status-relay: missing launch plan');
  let raw: string;
  try {
    raw = readFileSync(planPath, 'utf8');
  } finally {
    const dir = dirname(planPath);
    if (basename(planPath) === PLAN_FILE && basename(dir).startsWith(PLAN_DIR_PREFIX)) rmSync(dir, { recursive: true, force: true });
  }
  const plan = JSON.parse(raw) as Partial<ProgramStatusRelayPlan>;
  if (typeof plan.bin !== 'string' || !plan.bin || !Array.isArray(plan.args) || !plan.args.every(a => typeof a === 'string')) {
    throw new Error('program-status-relay: malformed launch plan');
  }
  return { bin: plan.bin, args: plan.args };
}

/** True when a process argv (`/proc/<pid>/cmdline`) is a program-status relay.
 *  Node: `<node> …/program-status-relay.js <plan>`; compiled: `<binary> __program-status-relay <plan>`. */
export function isProgramStatusRelayArgv(argv: readonly string[]): boolean {
  return argv.slice(0, 3).some(a => a === RELAY_TOKEN || basename(a) === RELAY_SCRIPT || basename(a) === RELAY_SOURCE);
}
