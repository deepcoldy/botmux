import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { shellQuote } from '../../core/cli-launch-mode.js';
import { getChildPids } from '../../core/session-discovery.js';
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

function configuredNcaHome(): string | undefined {
  const home = process.env.NCA_DATA_HOME?.trim();
  return home ? resolve(home) : undefined;
}

function isThreadId(id: string | undefined): id is string {
  return id !== undefined && THREAD_ID.test(id);
}

/** Find the writers owned by the NCA TUI's private host. The npm launcher
 *  adds a process layer before the TUI, so the host can be two hops away. */
function findOwnedNcaTranscripts(pid: number): Array<{ id: string; path: string }> {
  let pids = [pid];
  for (let depth = 0; depth <= 2 && pids.length; depth++) {
    const owned = new Map<string, { id: string; path: string }>();
    for (const processId of pids) {
      for (const file of listProcessOpenFiles(processId, { skipDeleted: true }) ?? []) {
        const id = WRITER_LOCK.exec(file)?.[1];
        if (isThreadId(id)) {
          const path = join(dirname(file), 'session.jsonl');
          owned.set(path, { id, path });
        }
      }
    }
    if (owned.size > 0) return [...owned.values()];
    if (depth < 2) pids = pids.flatMap(getChildPids);
  }
  return [];
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
      const home = ncaHomeArg() ?? configuredNcaHome() ?? join(homedir(), '.nca', 'harness');
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
  return {
    id: 'nca',
    bridgeSpec: ncaBridgeSpec,
    get resolvedBin() { return (resolvedBin ??= resolveCommand(pathOverride ?? 'nca')); },

    buildArgs({ resume, resumeSessionId, workingDir, model, extraArgs, env }) {
      const args = ['--server-target', 'owned'];
      const home = configuredNcaHome();
      const explicitHome = ncaHomeArg(extraArgs);
      if (explicitHome !== undefined && !isAbsolute(explicitHome)) {
        throw new Error('NCA --home must be an absolute path');
      }
      // The bridge and the closed-session command run outside the NCA child.
      // A child-only home would make completed turns invisible to both.
      const childHome = env?.NCA_DATA_HOME?.trim();
      if (!explicitHome && childHome && (!home || resolve(childHome) !== home)) {
        throw new Error('Set NCA_DATA_HOME in the BotMux daemon environment or pass an absolute --home in CLI_EXTRA_ARGS');
      }
      // The worker appends CLI_EXTRA_ARGS to this argv.
      if (home && explicitHome === undefined) args.push('--home', home);
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
      const home = ncaHomeArg() ?? configuredNcaHome();
      if (home && !isAbsolute(home)) return null;
      return `nca${home ? ` --home ${shellQuote(home)}` : ''} --resume ${cliSessionId}`;
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
