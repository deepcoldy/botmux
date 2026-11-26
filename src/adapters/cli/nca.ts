import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { shellQuote } from '../../core/cli-launch-mode.js';
import { snapshotChildPids } from '../../core/session-discovery.js';
import { drainNcaTranscript } from '../../services/nca-transcript.js';
import { listProcessOpenFiles } from '../../utils/process-open-files.js';
import { delay } from '../../utils/timing.js';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { wrapBracketedPaste } from './tui-input.js';
import type { CliAdapter, PtyHandle, StructuredBridgeSpec } from './types.js';

const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WRITER_LOCK = /\/v3\/sessions\/([^/]+)\/writer\.lock$/;

function ncaHomeArg(args: readonly string[] = (process.env.CLI_EXTRA_ARGS ?? '').trim().split(/\s+/)): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === '--') break;
    if (arg === '--home') return args[index + 1];
    if (arg.startsWith('--home=')) return arg.slice('--home='.length);
  }
  return undefined;
}

/** NCA_DATA_HOME is NCA's user-data root; the native harness lives one level
 *  below it. In contrast, --home points DIRECTLY at the harness root. */
function configuredNcaDataHome(): string | undefined {
  const home = process.env.NCA_DATA_HOME?.trim();
  return home ? resolve(home) : undefined;
}

function configuredNcaHarnessHome(): string | undefined {
  const home = configuredNcaDataHome();
  return home ? join(home, 'harness') : undefined;
}

function ncaHarnessHome(args?: readonly string[]): string {
  return ncaHomeArg(args) ?? configuredNcaHarnessHome() ?? join(homedir(), '.nca', 'harness');
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalExisting(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** A data/harness root that resolves to the filesystem root can never be
 *  bind-mounted (ncaAuthPaths filters it out), so letting it launch would select
 *  transcript delivery with no host-visible state and no `send` fallback.
 *  realpath catches a symlink to `/`; resolve catches lexical `..` escapes. */
function isFilesystemRoot(path: string): boolean {
  const canonical = canonicalExisting(path);
  return canonical === sep || resolve(canonical) === sep;
}

function ncaAuthPaths(): readonly string[] {
  const dataHome = configuredNcaDataHome();
  const userHome = canonicalExisting(dataHome ?? join(homedir(), '.nca'));
  const paths: string[] = dataHome ? [userHome] : ['~/.nca'];
  const harness = canonicalExisting(ncaHarnessHome());
  // The native user-data root contains auth/config/plugins; the default
  // harness/history lives there too. An explicit --home carries its own
  // history and needs a separate bind outside that root. Never bind a
  // filesystem root, including one reached through a symlink.
  if (isAbsolute(harness) && dirname(harness) !== harness && !pathIsWithin(userHome, harness)) paths.push(harness);
  return paths.filter(path => !isAbsolute(path) || dirname(path) !== path);
}

interface NcaInstallLayout {
  readonlyRoots: readonly string[];
  executables: readonly string[];
}

function ncaPackageName(packageRoot: string): string | undefined {
  try {
    const name = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the files the npm launcher and its owned native host need inside a
 *  fresh-root file sandbox. Refuse unrecognized single-file/wrapper layouts
 *  instead of exposing their parent directories. The launcher scope preserves
 *  pnpm's sibling-package symlink; the native realpath is exposed separately
 *  when it lives outside that scope. */
function ncaInstallLayout(bin: string): NcaInstallLayout {
  const canonical = realpathSync(bin);
  const packageRoot = dirname(dirname(canonical));
  const platformPackage = process.platform === 'linux' && process.arch === 'x64'
    ? 'nca-linux-x64'
    : process.platform === 'darwin' && process.arch === 'arm64'
      ? 'nca-darwin-arm64'
      : undefined;
  if (basename(canonical) !== 'nca.cjs') {
    if (!platformPackage || ncaPackageName(packageRoot) !== `@bytedance-dev/${platformPackage}`) {
      throw new Error('NCA file sandbox requires the native NCA package; an unpackaged cliPathOverride is not supported');
    }
    return { readonlyRoots: [packageRoot], executables: [canonical] };
  }
  if (ncaPackageName(packageRoot) !== '@bytedance-dev/nca') {
    throw new Error('NCA file sandbox requires the @bytedance-dev/nca npm launcher; an unpackaged cliPathOverride is not supported');
  }
  const launcherScope = dirname(packageRoot);
  if (!platformPackage) return { readonlyRoots: [launcherScope], executables: [] };
  const nativeRoot = realpathSync(join(packageRoot, '..', platformPackage));
  if (ncaPackageName(nativeRoot) !== `@bytedance-dev/${platformPackage}`) {
    throw new Error('NCA file sandbox requires matching NCA launcher and native packages');
  }
  const readonlyRoots = [launcherScope];
  if (!pathIsWithin(launcherScope, nativeRoot)) readonlyRoots.push(nativeRoot);
  const executables = ['nca', 'nca-next', 'nca-next-shell-supervisor', 'nca-next-browser-supervisor']
    .map(name => join(nativeRoot, 'bin', name));
  return { readonlyRoots, executables };
}

function isThreadId(id: string | undefined): id is string {
  return id !== undefined && THREAD_ID.test(id);
}

/** Find every writer in the NCA process tree. The npm launcher adds a layer,
 *  while bwrap can add several more. /new can also leave an old writer open in
 *  an ancestor, so never stop at the first depth that has a writer. Bound the
 *  walk by process count rather than assuming a particular launch shape. */
function findOwnedNcaTranscripts(pid: number): Array<{ id: string; path: string }> {
  const owned = new Map<string, { id: string; path: string }>();
  const visited = new Set<number>();
  const childrenOf = snapshotChildPids();
  let pids = [pid];
  while (pids.length && visited.size < 64) {
    const children: number[] = [];
    for (const processId of pids) {
      if (visited.has(processId) || visited.size >= 64) continue;
      visited.add(processId);
      for (const file of listProcessOpenFiles(processId, { skipDeleted: true }) ?? []) {
        const id = WRITER_LOCK.exec(file)?.[1];
        if (isThreadId(id)) {
          const path = join(dirname(file), 'session.jsonl');
          owned.set(path, { id, path });
        }
      }
      children.push(...childrenOf(processId));
    }
    pids = children.filter(processId => !visited.has(processId));
  }
  return [...owned.values()];
}

async function writeNcaInput(pty: PtyHandle, content: string): ReturnType<CliAdapter['writeInput']> {
  // One paste frame keeps Markdown and pasted multiline input in one turn.
  // A literal ESC or C1 character in the message must not become a TUI key.
  const text = content.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');
  const submittedText = text.trim();
  if (!submittedText) return { submitted: false };
  const pid = pty.cliPid;
  const offsets = new Map<string, number>();
  if (pid) {
    for (const { path } of findOwnedNcaTranscripts(pid)) {
      offsets.set(path, statSync(path, { throwIfNoEntry: false })?.size ?? 0);
    }
  }
  const pasted = pty.sendBracketedPaste
    ? pty.sendBracketedPaste(text)
    : (pty.sendText ?? pty.write).call(pty, wrapBracketedPaste(text));
  if (pasted === false) return { submitted: false };

  await delay(200);
  const submittedAt = Date.now();
  const submitted = pty.sendSpecialKeys ? pty.sendSpecialKeys('Enter') : pty.write('\r');
  if (submitted === false) return { submitted: false };

  if (!pid) return;
  // NCA keeps the previous writer open after /new. Only a newly admitted
  // copy of this input identifies the writer that actually received it.
  const recheck = (): false | { submitted: true; cliSessionId: string } => {
    const matches = findOwnedNcaTranscripts(pid).filter(({ path }) =>
      drainNcaTranscript(path, offsets.get(path) ?? 0).events.some(event =>
        event.kind === 'user' && event.timestampMs >= submittedAt && event.text.trim() === submittedText));
    return matches.length === 1 ? { submitted: true, cliSessionId: matches[0].id } : false;
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = recheck();
    if (result) return result;
    if (attempt < 4) await delay(250);
  }
  return { submitted: false, recheck };
}

export const ncaBridgeSpec: StructuredBridgeSpec = {
  drain: (path, offset, context) => drainNcaTranscript(
    path, offset, context.state as Parameters<typeof drainNcaTranscript>[2],
  ),
  stateCommit: 'drain',
  locate: {
    bySessionId(id) {
      if (!isThreadId(id)) return undefined;
      // The npm TUI keeps the owned app server under ~/.nca/harness.
      const home = ncaHarnessHome();
      if (!isAbsolute(home)) return undefined;
      const path = join(home, 'v3', 'sessions', id, 'session.jsonl');
      return existsSync(path) ? path : undefined;
    },
    byPid(pid) {
      const owned = findOwnedNcaTranscripts(pid);
      return owned.length === 1 ? owned[0].path : undefined;
    },
  },
  spawn: { sessionId: 'cli', baseline: 'resume-aware' },
};

export function createNcaAdapter(pathOverride?: string): CliAdapter {
  let resolvedBin: string | undefined;
  let installLayout: NcaInstallLayout | undefined;
  const layout = () => (installLayout ??= ncaInstallLayout(resolvedBin ??= resolveCommand(pathOverride ?? 'nca')));
  return {
    id: 'nca',
    bridgeSpec: ncaBridgeSpec,
    // turn-ended is a durable completed/failed/cancelled boundary. Drain it
    // before exit/restart can claim an ambiguous terminal for the same turn.
    reliableTurnTerminal: true,
    get resolvedBin() { return (resolvedBin ??= resolveCommand(pathOverride ?? 'nca')); },
    get authPaths() { return ncaAuthPaths(); },
    sandboxReadonlyPaths() { return layout().readonlyRoots; },
    sandboxExtraExecPaths() { return layout().executables; },

    buildArgs({ resume, resumeSessionId, workingDir, model, extraArgs, env }) {
      const args = ['--server-target', 'owned'];
      const dataHome = configuredNcaDataHome();
      const harnessHome = configuredNcaHarnessHome();
      const explicitHome = ncaHomeArg(extraArgs);
      if (dataHome && isFilesystemRoot(dataHome)) {
        throw new Error('NCA_DATA_HOME must not resolve to the filesystem root');
      }
      if (explicitHome !== undefined && !isAbsolute(explicitHome)) {
        throw new Error('NCA --home must be an absolute path');
      }
      if (explicitHome !== undefined && isFilesystemRoot(explicitHome)) {
        throw new Error('NCA --home must not resolve to the filesystem root');
      }
      // The bridge and the closed-session command run outside the NCA child.
      // A child-only home would make completed turns invisible to both.
      const childHome = env?.NCA_DATA_HOME?.trim();
      if (childHome && (!dataHome || resolve(childHome) !== dataHome)) {
        throw new Error('NCA_DATA_HOME must match the BotMux daemon environment (an absolute --home does not replace it)');
      }
      // bwrap can only bind existing sources, and its generic authPaths
      // pre-creation cannot tell a dotted DIRECTORY from a file. Create the
      // actual native roots here so cold custom homes survive keepExisting.
      mkdirSync(dataHome ?? join(homedir(), '.nca'), { recursive: true });
      mkdirSync(explicitHome ?? harnessHome ?? join(homedir(), '.nca', 'harness'), { recursive: true });
      // The worker appends CLI_EXTRA_ARGS to this argv. Pin the harness to the
      // same <NCA_DATA_HOME>/harness root that native NCA would choose.
      if (harnessHome && explicitHome === undefined) args.push('--home', harnessHome);
      if (workingDir) args.push('--cwd', workingDir);
      if (model) args.push('--model', model);
      if (resume && isThreadId(resumeSessionId)) {
        args.push('--resume', resumeSessionId);
      }
      return args;
    },

    resumeRequiresCliSessionId: true,
    checkResumeTargetExists: ({ cliSessionId }) => isThreadId(cliSessionId) ? undefined : false,
    buildResumeCommand({ cliSessionId }) {
      if (!isThreadId(cliSessionId)) return null;
      const dataHome = configuredNcaDataHome();
      const home = ncaHomeArg() ?? configuredNcaHarnessHome();
      if (home && !isAbsolute(home)) return null;
      const envPrefix = dataHome ? `NCA_DATA_HOME=${shellQuote(dataHome)} ` : '';
      return `${envPrefix}nca${home ? ` --home ${shellQuote(home)}` : ''} --resume ${cliSessionId}`;
    },

    writeInput: writeNcaInput,
    // The TUI positions individual words with CUP sequences, so the
    // stripped PTY stream can omit whitespace that is visible on screen.
    readyPattern: /Ask\s*NCA\s*to\s*do\s*anything/,
    deferFirstPromptTimeoutUntilReady: true,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
  };
}
