import { execFile } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { wrapBracketedPaste } from './tui-input.js';
import type { CliAdapter, PtyHandle, StructuredBridgeSpec } from './types.js';
import { doubaoTrajectoryPathForSession, drainDoubaoTranscript } from '../../services/doubao-transcript.js';

import { delay } from '../../utils/timing.js';

/** Doubao session ids are decimal snowflakes (`38450922917357570`). `--resume`
 *  with anything else fails at the IM layer (`Invalid request parameters` /
 *  `IM request failed`), so only this shape is ever passed through. */
const DOUBAO_SESSION_ID = /^\d{10,24}$/;

/** `--effort` values accepted by doubao 2.31 (`none|minimal|low|medium|high|xhigh|max`).
 *  botmux's `ultra` has no equivalent and is dropped rather than failing the launch. */
const DOUBAO_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Busy footer drawn directly above the composer while a turn runs:
 * `✦ Responding… (3s • esc to interrupt)` / `◈ Running tool… (8s • esc to interrupt)`.
 * The leading glyph animates and the counter ticks every second, so only the
 * static `esc to interrupt)` tail is anchored. It disappears when the turn ends
 * (replaced by `Worked for Ns` in the transcript). Verified on doubao 2.31.0.
 */
export const DOUBAO_BUSY_FOOTER = /esc to interrupt\)/;

/**
 * Composer evidence. The `❯  Ask Doubao to do anything` placeholder and the
 * `Enter send · Ctrl+J newline` hint row are rendered once the TUI accepts
 * input. Both also stay visible while busy (the composer is never hidden), so
 * this only gates quiescence; the per-second busy footer redraw is what keeps
 * a running turn from going quiet, and `busyPattern` covers reattached panes.
 */
export const DOUBAO_READY_PATTERN = /Ask Doubao to do anything|Enter send · Ctrl\+J newline/;

/** Root holding doubao's per-account agent workspaces. Mirrors the npm
 *  launcher's `appRoot()` parent (scripts/runtime.cjs): the native runtime lives
 *  in `<root>/app`, sessions in `<root>/agent_mode/<uid>/workspace/.sessions`. */
export function doubaoDataRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const home = env.HOME || homedir();
  let parent: string | undefined;
  if (platform === 'darwin') parent = join(home, 'Library', 'Application Support');
  else if (platform === 'win32') parent = env.LOCALAPPDATA;
  else parent = env.XDG_DATA_HOME || (home ? join(home, '.local', 'share') : undefined);
  return parent && isAbsolute(parent) ? join(parent, 'doubao_cli') : undefined;
}

/** Every `.sessions` directory under the data root (one per logged-in account). */
export function doubaoSessionRoots(dataRoot: string | undefined = doubaoDataRoot()): string[] {
  if (!dataRoot) return [];
  const agentMode = join(dataRoot, 'agent_mode');
  let accounts: string[];
  try { accounts = readdirSync(agentMode); } catch { return []; }
  return accounts
    .map(uid => join(agentMode, uid, 'workspace', '.sessions'))
    .filter(dir => { try { return statSync(dir).isDirectory(); } catch { return false; } });
}

function readTail(path: string, maxBytes: number, size: number): string {
  const length = Math.min(size, maxBytes);
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, length, size - length); } finally { closeSync(fd); }
  return buf.toString('utf-8');
}

/** Last non-empty line of a submitted prompt — the fingerprint looked up in the
 *  native per-turn log. Bounded so a huge envelope stays a cheap substring test. */
export function doubaoSubmitFingerprint(content: string): string | undefined {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  return last ? last.slice(-200) : undefined;
}

/**
 * Find the native session that just received `content`.
 *
 * Each TUI turn is appended verbatim to
 * `<sessions>/<sessionId>/agents/<agentId>/system/assignment.md` (heading
 * `## [<ts>] 需求` followed by the prompt) at submit time, including large
 * bracketed pastes the composer collapsed into `[Pasted text #n]`. The shared
 * `.sessions` root also holds every other doubao/Doubao-desktop session of the
 * account, so a candidate must both be written after `sinceMs` AND contain this
 * prompt's fingerprint. Ambiguity (two matches) yields undefined rather than a
 * guess: a wrong id would later `--resume` a sibling conversation.
 */
export function findDoubaoSessionForSubmit(
  content: string,
  sinceMs: number,
  roots: readonly string[] = doubaoSessionRoots(),
): string | undefined {
  const fingerprint = doubaoSubmitFingerprint(content);
  if (!fingerprint) return undefined;
  const window = Buffer.byteLength(content, 'utf-8') * 2 + 4096;
  const matches = new Set<string>();
  for (const root of roots) {
    let sessions: string[];
    try { sessions = readdirSync(root); } catch { continue; }
    for (const sid of sessions) {
      if (!DOUBAO_SESSION_ID.test(sid)) continue;
      const agentsDir = join(root, sid, 'agents');
      let agents: string[];
      try {
        // Cheap pre-filter: the session dir's own mtime is not bumped by the
        // nested append, so stat the agents dir entries instead.
        agents = readdirSync(agentsDir);
      } catch { continue; }
      for (const agent of agents) {
        const assignment = join(agentsDir, agent, 'system', 'assignment.md');
        try {
          const st = statSync(assignment);
          if (st.mtimeMs < sinceMs) continue;
          if (readTail(assignment, window, st.size).includes(fingerprint)) matches.add(sid);
        } catch { /* missing / racing writer */ }
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

/**
 * How long writeInput keeps looking for the native session id after Enter.
 *
 * assignment.md is appended only once doubao has accepted the turn, and on a
 * cold first turn that includes bringing up the account-wide `--type=service`
 * process: observed 4 s with a warm service and 7–8 s right after it was
 * (re)started. The previous 5 s budget missed the cold case, so the first
 * turn's reply was never collected (the bridge has no transcript to bind to
 * until the id is known) and the caller waited out its full timeout. The
 * budget must stay below the structured queue's submit-verification grace
 * (STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS): that grace covers this in-band
 * poll, and the head is pruned as soon as it lapses. The poll returns as soon
 * as it matches, so warm turns are not slowed down.
 */
export const DOUBAO_SUBMIT_CAPTURE_BUDGET_MS = 20_000;
export const DOUBAO_SUBMIT_CAPTURE_INTERVAL_MS = 250;

/** Poll `find` until it yields a session id or the budget runs out. Split out
 *  of writeInput so the cold-start timing is testable without a real TUI. */
export async function pollDoubaoSessionForSubmit(
  find: () => string | undefined,
  opts: {
    budgetMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string | undefined> {
  const budgetMs = opts.budgetMs ?? DOUBAO_SUBMIT_CAPTURE_BUDGET_MS;
  const intervalMs = opts.intervalMs ?? DOUBAO_SUBMIT_CAPTURE_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? delay;
  const deadline = now() + budgetMs;
  for (;;) {
    const sid = find();
    if (sid) return sid;
    if (now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/** True when the session directory exists locally; undefined when no session
 *  root is readable (cannot tell — let the worker's secondary guard decide). */
export function doubaoSessionExists(sessionId: string, roots: readonly string[] = doubaoSessionRoots()): boolean | undefined {
  if (roots.length === 0) return undefined;
  return roots.some(root => { try { return statSync(join(root, sessionId)).isDirectory(); } catch { return false; } });
}

/** Parse the model list doubao prints for an unsupported `--model` value:
 *  `Error: Unsupported --model value. Available models: Auto, Doubao 2.1 Pro, … . Start doubao …` */
export function parseDoubaoAvailableModels(output: string): string[] | null {
  const m = /Available models:\s*(.+?)\.\s*(?:Start\b|$)/s.exec(output);
  if (!m) return null;
  const models = m[1]!.split(',').map(s => s.trim()).filter(Boolean);
  return models.length > 0 ? models : null;
}

/** Doubao CLI (`@bytedance-dev/doubao-cli` / `@bytedance/doubao-cli`).
 *
 *  Interactive TUI (alternate screen). Session ids are server-assigned and never
 *  shown in the TUI, so the first submit is matched against the native per-turn
 *  log to learn the id that `--resume` needs; without it a restart starts fresh
 *  instead of guessing (there is no "latest" resume that is safe to share). */
/** Structured transcript bridge: doubao has no CLI-native machine-readable
 *  reply channel (the generic `botmux send` stays executable, but under the
 *  account-wide resident service it misattributes — see
 *  defaultReplyDeliveryFor), so the final answer is harvested from its own
 *  trajectory.jsonl (and the user prompts from assignment.md). */
export const doubaoBridgeSpec: StructuredBridgeSpec = {
  stateCommit: 'drain',
  drain: (path, offset, ctx) => drainDoubaoTranscript(path, offset, {
    state: ctx.state,
    openTurns: ctx.openTurns,
  }),
  locate: {
    bySessionId: sessionId => doubaoTrajectoryPathForSession(sessionId),
  },
};

export function createDoubaoAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'doubao';
  let cachedBin: string | undefined;
  // A fresh spawn learns its native id from the first submit that lands.
  let capturePending = false;
  return {
    id: 'doubao',
    bridgeSpec: doubaoBridgeSpec,
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    // The npm launcher asks `Update now? [Y/N]` on an interactive start when a
    // newer version exists; botmux's first prompt would be eaten as the answer.
    spawnEnv: { DOUBAO_CLI_NO_UPDATE_CHECK: '1' },
    // Login state (`~/.doubao-cli`, Linux data root). Kept writable inside the
    // file sandbox so token refresh persists; not yet verified end-to-end there.
    authPaths: ['~/.doubao-cli', '~/.local/share/doubao_cli'],

    buildArgs({ resume, resumeSessionId, model, reasoningEffort, disableCliBypass }) {
      const preciseResume = resume && !!resumeSessionId && DOUBAO_SESSION_ID.test(resumeSessionId);
      capturePending = !preciseResume;
      const args: string[] = [];
      // `always_allow` = act without per-tool approval (the TUI's dialog is not
      // reachable from Lark). `--dangerously-bypass-approvals-and-sandbox` would
      // additionally drop doubao's own sandbox; not needed for parity.
      if (!disableCliBypass) args.push('--permission-mode', 'always_allow');
      if (model && model.trim()) args.push('--model', model.trim());
      if (reasoningEffort && DOUBAO_EFFORTS.has(reasoningEffort)) args.push('--effort', reasoningEffort);
      if (preciseResume) args.push('--resume', resumeSessionId!);
      return args;
    },

    buildResumeCommand({ cliSessionId }) {
      if (!cliSessionId || !DOUBAO_SESSION_ID.test(cliSessionId)) return null;
      return `doubao --resume ${cliSessionId}`;
    },

    // Resume without a captured id must not fall back to anything implicit.
    resumeRequiresCliSessionId: true,

    checkResumeTargetExists({ cliSessionId }) {
      if (!cliSessionId) return undefined;
      // A malformed id makes `doubao --resume` exit 1 immediately.
      if (!DOUBAO_SESSION_ID.test(cliSessionId)) return false;
      return doubaoSessionExists(cliSessionId);
    },

    async writeInput(pty: PtyHandle, content: string) {
      const startedAt = Date.now();
      // Bracketed paste: the composer inserts the whole multi-line envelope as
      // content (large pastes collapse to `[Pasted text #n +N lines]` and are
      // expanded verbatim on submit); only the following Enter submits.
      // Per-line send-keys would turn each embedded newline into Enter.
      if (pty.pasteText && pty.sendSpecialKeys) {
        pty.pasteText(content);
        await delay(300);
        if (pty.sendSpecialKeys('Enter') === false) return { submitted: false };
      } else {
        if (pty.write(wrapBracketedPaste(content)) === false) return { submitted: false };
        await delay(1000);
        if (pty.write('\r') === false) return { submitted: false };
      }
      if (!capturePending) return;
      // assignment.md is appended once doubao accepts the turn (later on a cold
      // service start, see DOUBAO_SUBMIT_CAPTURE_BUDGET_MS). A miss stays armed
      // for the next input instead of costing the session its resume id, and is
      // reported as "unverified" (void) — never as a failed submit.
      const sid = await pollDoubaoSessionForSubmit(
        () => findDoubaoSessionForSubmit(content, startedAt - 2000),
      );
      if (sid) {
        capturePending = false;
        return { submitted: true, cliSessionId: sid };
      }
    },

    completionPattern: undefined,
    readyPattern: DOUBAO_READY_PATTERN,
    busyPattern: DOUBAO_BUSY_FOOTER,
    // Esc is the advertised interrupt (`esc to interrupt`); verified to stop the
    // running tool and return to the composer without exiting the CLI.
    interruptKey: 'esc',
    // A not-logged-in start shows a login QR before the composer exists.
    deferFirstPromptTimeoutUntilReady: true,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    // Doubao loads user skills from ~/Doubao/skills (shared with the desktop app).
    skillsDir: '~/Doubao/skills',
    modelChoices: CLI_MODEL_CHOICES['doubao'],

    async detectModels() {
      // Models are account-dependent display names. An unsupported --model makes
      // doubao print the authoritative list and exit 1 before any session or
      // model call is created.
      const bin = cachedBin ??= resolveCommand(rawBin);
      return new Promise<readonly string[] | null>(resolve => {
        execFile(bin, ['--model', '__botmux_model_probe__', '-p', 'probe'], {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          env: { ...process.env, DOUBAO_CLI_NO_UPDATE_CHECK: '1' },
        }, (_err, stdout, stderr) => {
          try { resolve(parseDoubaoAvailableModels(`${stdout ?? ''}\n${stderr ?? ''}`)); } catch { resolve(null); }
        });
      });
    },
  };
}
