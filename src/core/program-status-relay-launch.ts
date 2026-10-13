import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStandaloneBinary, resolveEntrySpawn } from './self-spawn.js';

/**
 * Launch plan for `program-status-relay` (see src/program-status-relay.ts).
 *
 * The wrapped command travels base64-encoded in ONE argv slot rather than as
 * `-- <bin> <args…>`: discovery (`cliIdFromCommArgv`) scans the argv of
 * interpreter-named processes (`node`, `bun`) for a CLI basename, and a bun-run
 * relay keeps comm `bun` (process.title does not rename it there). A plain
 * `claude` token in the relay's argv would make /adopt and the pid resolvers
 * mistake the relay for Claude itself.
 */
export interface ProgramStatusRelayPlan { bin: string; args: string[] }

const RELAY_TOKEN = '__program-status-relay';
const RELAY_SCRIPT = 'program-status-relay.js';
const RELAY_SOURCE = 'program-status-relay.ts';

/**
 * Wrap `bin args` in the relay, or return null when the relay entry cannot be
 * executed from here. That is the case when the worker runs from source:
 * resolveEntrySpawn points at `src/program-status-relay.js`, which does not
 * exist, and under Node a `.ts` would also need a loader the pane (different
 * cwd, possibly a strict env) cannot resolve. Bun runs the `.ts` natively.
 * Callers then launch the CLI directly — the pre-relay behaviour.
 */
export function programStatusRelayLaunch(bin: string, args: string[]): { bin: string; args: string[] } | null {
  const entry = resolveEntrySpawn('program-status-relay', join(dirname(fileURLToPath(import.meta.url)), '..'));
  let entryArgs = entry.args;
  if (!isStandaloneBinary() && !existsSync(entryArgs[0])) {
    const tsEntry = entryArgs[0].replace(/\.js$/, '.ts');
    if (!process.versions.bun || !existsSync(tsEntry)) return null;
    entryArgs = [tsEntry];
  }
  const plan: ProgramStatusRelayPlan = { bin, args };
  return { bin: entry.command, args: [...entryArgs, Buffer.from(JSON.stringify(plan)).toString('base64')] };
}

export function decodeProgramStatusRelayPlan(encoded: string | undefined): ProgramStatusRelayPlan {
  if (!encoded) throw new Error('program-status-relay: missing launch plan');
  const plan = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Partial<ProgramStatusRelayPlan>;
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
