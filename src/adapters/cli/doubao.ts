import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readdirSync, readSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { wrapBracketedPaste } from './tui-input.js';
import type { CliAdapter, PtyHandle, StructuredBridgeSpec } from './types.js';
import { doubaoTrajectoryPathForSession, drainDoubaoTranscript } from '../../services/doubao-transcript.js';

import { delay } from '../../utils/timing.js';
import { DOUBAO_REASONING_EFFORTS } from '../../services/codex-reasoning-effort.js';

/** Doubao session ids are decimal snowflakes (`38450922917357570`). `--resume`
 *  with anything else fails at the IM layer (`Invalid request parameters` /
 *  `IM request failed`), so only this shape is ever passed through. */
const DOUBAO_SESSION_ID = /^\d{10,24}$/;

/** `--effort` values accepted by doubao 2.36 (`none|minimal|low|medium|high|xhigh|max`).
 *  botmux's `ultra` has no equivalent and is dropped rather than failing the launch. */
const DOUBAO_EFFORTS = new Set(DOUBAO_REASONING_EFFORTS);

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

/** A path that definitively holds no session: it does not exist, or one of its
 *  components is a plain file where a directory belongs (e.g. Finder's
 *  `.DS_Store` in `agent_mode/` or `agents/`). Unlike EACCES / EIO, neither can
 *  hide a peer session, so neither makes the capture inventory incomplete. */
function isAbsentPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Every `.sessions` directory under the data root (one per logged-in account). */
export function doubaoSessionRoots(dataRoot: string | undefined = doubaoDataRoot()): string[] {
  if (!dataRoot) return [];
  const agentMode = join(dataRoot, 'agent_mode');
  let accounts: string[];
  try { accounts = readdirSync(agentMode); } catch { return []; }
  return accounts
    .map(uid => join(agentMode, uid, 'workspace', '.sessions'))
    .filter(dir => {
      try { return statSync(dir).isDirectory(); }
      catch (error) {
        // Retain unreadable candidates so the assignment scan can refuse an
        // incomplete inventory, while genuinely absent account stores stay out.
        return !isAbsentPathError(error);
      }
    });
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

/** Ownership is a standalone envelope line, before per-turn context or user
 *  payload. Inline examples of the tag in routing instructions are not owners. */
const SESSION_ID_MARKER_RE = /^[\t \ufeff]*<session_id>([^<\s]+)<\/session_id>[\t ]*\r?$/m;
const SESSION_PAYLOAD_START_RE = /^[\t \ufeff]*<(?:role|summary_memory|whiteboard|chat_context_policy|chat_context|botmux_group_join|user_message)(?=[\s>])/m;

/** Owning botmux session id parsed from a submitted prompt envelope, or
 *  undefined for an envelope-less (zero-injection) submit. */
export function doubaoSessionMarkerFromContent(content: string): string | undefined {
  const match = SESSION_ID_MARKER_RE.exec(content);
  if (match) {
    const prefix = content.slice(0, match.index);
    if (SESSION_PAYLOAD_START_RE.test(prefix)) return undefined;
    // assignment.md appends turns. Only the first request's envelope can
    // establish ownership; a later turn may merely quote another session.
    if ((prefix.match(/^## \[[^\]\r\n]+\] /gm)?.length ?? 0) > 1) return undefined;
  }
  return match?.[1]?.trim() || undefined;
}

const DOUBAO_INPUT_ID_RE = /^botmux_input_id: ([0-9a-f]{32})[\t ]*\r?$/gm;

function doubaoInputIdFromContent(content: string): string | undefined {
  // The adapter appends its id after the original envelope, so the last id is
  // authoritative even if the user payload already contained an example.
  return [...content.matchAll(DOUBAO_INPUT_ID_RE)].at(-1)?.[1];
}

/** Correlate every submit from one adapter launch generation without changing
 *  envelope-less (zero-injection) input. The id is reused across inputs until
 *  capture succeeds, so a later input can still recover an earlier assignment. */
export function doubaoContentWithCaptureId(content: string, captureId: string): string {
  if (!doubaoSessionMarkerFromContent(content)) return content;
  return `${content}\n\n<botmux_routing>\nbotmux_input_id: ${captureId}\n</botmux_routing>`;
}

function hasDoubaoInputId(content: string, captureId: string): boolean {
  return new RegExp(`^botmux_input_id: ${captureId}[\\t ]*\\r?$`, 'm').test(content);
}

/** Minimum initial-turn read for short envelopes. The full correlated
 *  submission expands this window without scanning resumed assignment history. */
const SESSION_MARKER_HEAD_BYTES = 8192;

function readHead(path: string, maxBytes: number, size: number): string {
  const length = Math.min(size, maxBytes);
  if (length === 0) return '';
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, length, 0); } finally { closeSync(fd); }
  return buf.toString('utf-8');
}

/** Walk every account's `.sessions`, visiting assignment.md files modified at
 *  or after `sinceMs`. The session dir's own mtime is not bumped by the nested
 *  append, so freshness is checked on the assignment file itself. */
function forEachDoubaoAssignment(
  roots: readonly string[],
  sinceMs: number,
  visit: (sid: string, assignment: string, st: Stats) => void,
): boolean {
  let complete = true;
  for (const root of roots) {
    let sessions: string[];
    try { sessions = readdirSync(root); } catch (error) {
      if (!isAbsentPathError(error)) complete = false;
      continue;
    }
    for (const sid of sessions) {
      if (!DOUBAO_SESSION_ID.test(sid)) continue;
      const agentsDir = join(root, sid, 'agents');
      let agents: string[];
      try {
        agents = readdirSync(agentsDir);
      } catch (error) {
        if (!isAbsentPathError(error)) complete = false;
        continue;
      }
      for (const agent of agents) {
        const assignment = join(agentsDir, agent, 'system', 'assignment.md');
        try {
          const st = statSync(assignment);
          if (st.mtimeMs < sinceMs) continue;
          visit(sid, assignment, st);
        } catch (error) {
          // Missing / racing writers are retried by the poll; unreadable peers
          // prevent proving uniqueness and must not narrow the inventory.
          if (!isAbsentPathError(error)) complete = false;
        }
      }
    }
  }
  return complete;
}

/**
 * Find the native session that just received `content`.
 *
 * Each TUI turn is appended verbatim to
 * `<sessions>/<sessionId>/agents/<agentId>/system/assignment.md` (heading
 * `## [<ts>] 需求` followed by the prompt) at submit time, including large
 * bracketed pastes the composer collapsed into `[Pasted text #n]`. The shared
 * `.sessions` root also holds every other doubao/Doubao-desktop session of the
 * account.
 *
 * Two tiers, because concurrent cold starts in one account can submit prompts
 * whose last-line fingerprints are byte-identical (a fixed routing suffix):
 *   1. When the prompt envelope embeds `<session_id>{botmux id}</session_id>`,
 *      the adapter also appends a fresh `botmux_input_id` for this launch
 *      generation. Match that id at the assignment HEAD or in the latest turn;
 *      unlike a session marker or payload, it cannot name an older generation.
 *   2. A zero-injection submit carries no envelope, so fall back to the legacy
 *      tail fingerprint.
 * Either way, ambiguity (not exactly one match) yields undefined rather than a
 * guess: a wrong id would later `--resume` a sibling conversation.
 */
export function findDoubaoSessionForSubmit(
  content: string,
  sinceMs: number,
  roots: readonly string[] = doubaoSessionRoots(),
  windowBytes?: number,
): string | undefined {
  const marker = doubaoSessionMarkerFromContent(content);
  const window = Math.max(Buffer.byteLength(content, 'utf-8') * 2 + 4096, windowBytes ?? 0);
  if (marker) {
    const captureId = doubaoInputIdFromContent(content);
    // Marker-only text is not generation evidence. The adapter must correlate
    // its submissions; an old assignment can share both marker and payload.
    if (!captureId) return undefined;
    const headBytes = Math.max(SESSION_MARKER_HEAD_BYTES, window);
    const matches = new Set<string>();
    const complete = forEachDoubaoAssignment(roots, sinceMs, (sid, assignment, st) => {
      // The per-launch id is the ownership proof, so it may appear in a later
      // turn too. Check both the initial-turn window and the latest appended
      // window; no file-growth or predicted-reattach assumption is involved.
      if (hasDoubaoInputId(readHead(assignment, headBytes, st.size), captureId)
        || hasDoubaoInputId(readTail(assignment, window, st.size), captureId)) {
        matches.add(sid);
      }
    });
    return complete && matches.size === 1 ? [...matches][0] : undefined;
  }
  const fingerprint = doubaoSubmitFingerprint(content);
  if (!fingerprint) return undefined;
  const matches = new Set<string>();
  const complete = forEachDoubaoAssignment(roots, sinceMs, (sid, assignment, st) => {
    if (readTail(assignment, window, st.size).includes(fingerprint)) matches.add(sid);
  });
  return complete && matches.size === 1 ? [...matches][0] : undefined;
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
 *  root is readable (cannot tell — let the worker's secondary guard decide).
 *  A definite ENOENT/ENOTDIR on every root means "absent" (false); any other
 *  stat failure (EACCES/EIO) means "unknown" (undefined), so a temporarily
 *  unreadable account store cannot demote a valid `--resume` to a fresh spawn. */
export function doubaoSessionExists(sessionId: string, roots: readonly string[] = doubaoSessionRoots()): boolean | undefined {
  if (roots.length === 0) return undefined;
  let indeterminate = false;
  for (const root of roots) {
    try {
      if (statSync(join(root, sessionId)).isDirectory()) return true;
    } catch (error) {
      if (!isAbsentPathError(error)) indeterminate = true;
    }
  }
  return indeterminate ? undefined : false;
}

/** Parse the model list doubao prints for an unsupported `--model` value:
 *  `Error: Unsupported --model value. Available models: Auto, Doubao 2.1 Pro, … . Start doubao …` */
export function parseDoubaoAvailableModels(output: string): string[] | null {
  const m = /Available models:\s*(.+?)\.\s*(?:Start\b|$)/s.exec(output);
  if (!m) return null;
  const models = m[1]!.split(',').map(s => s.trim()).filter(Boolean);
  return models.length > 0 ? models : null;
}

const DOUBAO_MODEL_LIST_MIN_VERSION: readonly [number, number, number] = [2, 37, 1];
const DOUBAO_DETECT_TIMEOUT_MS = 10_000;

/** Parse `major.minor.patch` from `doubao --version` output (e.g. `doubao 2.37.1`). */
export function parseDoubaoVersion(output: string): [number, number, number] | null {
  const cleaned = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const m = /(?:^|[^.\d])v?(\d+)\.(\d+)\.(\d+)(?![.\d])/.exec(cleaned);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return [major, minor, patch];
}

function isDoubaoVersionAtLeast(
  version: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== min[i]!) return version[i]! > min[i]!;
  }
  return true;
}

/** Parse `doubao model list --json` stdout (`result.models[]`, doubao >= 2.37.1).
 *  Uses `id` as the authoritative `--model` launch value (`doubao --model`
 *  matches `id` first and rejects duplicate `name`s as ambiguous); falls back to
 *  `name` only when an entry omits `id` and that `name` is unique and does not
 *  collide with any `id` in the list. */
export function parseDoubaoModelListJson(stdout: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as { is_error?: unknown; result?: unknown };
  if (envelope.is_error) return null;
  if (typeof envelope.result !== 'object' || envelope.result === null) return null;
  const models = (envelope.result as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;

  const ids = new Set<string>();
  const nameCounts = new Map<string, number>();
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { id?: unknown; name?: unknown };
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (id) ids.add(id);
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { id?: unknown; name?: unknown };
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const candidate = id || (name && !ids.has(name) && nameCounts.get(name) === 1 ? name : '');
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    values.push(candidate);
  }
  return values.length > 0 ? values : null;
}

function execDoubaoProbe(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBuffer = 64 * 1024,
): Promise<{ err: Error | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    try {
      execFile(bin, [...args], {
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
        env,
      }, (err, stdout, stderr) => {
        resolve({
          err: err ?? null,
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        });
      });
    } catch (err) {
      resolve({ err: err instanceof Error ? err : new Error(String(err)), stdout: '', stderr: '' });
    }
  });
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

export function createDoubaoAdapter(pathOverride?: string, deps: { now?: () => number } = {}): CliAdapter {
  const rawBin = pathOverride ?? 'doubao';
  const now = deps.now ?? (() => Date.now());
  let cachedBin: string | undefined;
  // A fresh spawn learns its native id from the first submit that lands.
  // Each launch owns an immutable identity; per-input state lives on this
  // object so an old poll can never clear a replacement launch's capture.
  let captureState: { id: string; sinceMs?: number; windowBytes: number } | undefined;
  return {
    id: 'doubao',
    bridgeSpec: doubaoBridgeSpec,
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    // The npm launcher asks `Update now? [Y/N]` on an interactive start when a
    // newer version exists; botmux's first prompt would be eaten as the answer.
    // Also listed in BOTMUX_INJECTED_ENV_KEYS: tmux/zellij/zmx panes only see
    // adapter env that is on that allowlist.
    spawnEnv: { DOUBAO_CLI_NO_UPDATE_CHECK: '1' },
    // Login state (`~/.doubao-cli`, Linux data root). Kept writable inside the
    // file sandbox so token refresh persists; not yet verified end-to-end there.
    authPaths: ['~/.doubao-cli', '~/.local/share/doubao_cli'],

    buildArgs({ resume, resumeSessionId, model, reasoningEffort, disableCliBypass }) {
      const preciseResume = resume && !!resumeSessionId && DOUBAO_SESSION_ID.test(resumeSessionId);
      // Replace the whole capture object for every launch, including a
      // predicted reattach that a backend later turns into a fresh spawn.
      // Inputs from one launch share the id so delayed turns remain recoverable.
      captureState = preciseResume ? undefined : {
        id: randomBytes(16).toString('hex'),
        sinceMs: undefined,
        windowBytes: 0,
      };
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
      const launchCapture = captureState;
      const submittedContent = launchCapture
        ? doubaoContentWithCaptureId(content, launchCapture.id)
        : content;
      const startedAt = Date.now();
      if (launchCapture) {
        // A later input must still be able to recover an earlier, longer turn
        // from this same launch generation.
        launchCapture.sinceMs ??= startedAt - 2000;
        launchCapture.windowBytes = Math.max(launchCapture.windowBytes, Buffer.byteLength(submittedContent, 'utf-8') * 2 + 4096);
      }
      // Bracketed paste: the composer inserts the whole multi-line envelope as
      // content (large pastes collapse to `[Pasted text #n +N lines]` and are
      // expanded verbatim on submit); only the following Enter submits.
      // Per-line send-keys would turn each embedded newline into Enter.
      if (pty.pasteText && pty.sendSpecialKeys) {
        pty.pasteText(submittedContent);
        await delay(300);
        if (pty.sendSpecialKeys('Enter') === false) return { submitted: false };
      } else {
        if (pty.write(wrapBracketedPaste(submittedContent)) === false) return { submitted: false };
        await delay(1000);
        if (pty.write('\r') === false) return { submitted: false };
      }
      if (!launchCapture) return;
      // assignment.md is appended once doubao accepts the turn (later on a cold
      // service start, see DOUBAO_SUBMIT_CAPTURE_BUDGET_MS). A miss stays armed
      // for the next input instead of costing the session its resume id, and is
      // reported as "unverified" (void) — never as a failed submit.
      const sid = await pollDoubaoSessionForSubmit(
        () => findDoubaoSessionForSubmit(
          submittedContent,
          launchCapture.sinceMs ?? startedAt - 2000,
          undefined,
          launchCapture.windowBytes,
        ),
      );
      if (sid) {
        // A stale write may still return its own SID for the worker's
        // generation fence, but it must not disarm the replacement launch.
        if (captureState === launchCapture) captureState = undefined;
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

    async detectModels(options) {
      // Doubao CLI 2.37.1+ adds read-only `doubao model list --json`
      // (`result.models[].id` / `.name`) and localizes its invalid `--model`
      // diagnostic into Chinese, so the legacy English error probe resolves
      // null on 2.37.1+. Check `doubao --version` asynchronously on demand first
      // (never on adapter construction or session startup), sharing a single 10s
      // deadline across both probes: >= 2.37.1 uses `model list --json`; older
      // versions keep the unsupported `--model` probe unchanged.
      try {
        const bin = cachedBin ??= resolveCommand(rawBin);
        const env: NodeJS.ProcessEnv = {
          ...(options?.env ?? process.env),
          DOUBAO_CLI_NO_UPDATE_CHECK: '1',
        };
        const deadline = now() + DOUBAO_DETECT_TIMEOUT_MS;
        const remainingTimeoutMs = (): number | null => {
          const remaining = Math.floor(deadline - now());
          // Avoid passing <= 0 to execFile, where timeout: 0 disables timeouts.
          return remaining >= 1 ? remaining : null;
        };
        const versionTimeout = remainingTimeoutMs();
        if (versionTimeout === null) return null;
        const versionRes = await execDoubaoProbe(bin, ['--version'], env, versionTimeout);
        if (versionRes.err) return null;
        const version = parseDoubaoVersion(versionRes.stdout || versionRes.stderr);
        if (!version) return null;
        const probeTimeout = remainingTimeoutMs();
        if (probeTimeout === null) return null;
        if (isDoubaoVersionAtLeast(version, DOUBAO_MODEL_LIST_MIN_VERSION)) {
          const listRes = await execDoubaoProbe(bin, ['model', 'list', '--json'], env, probeTimeout, 1024 * 1024);
          if (listRes.err) return null;
          return parseDoubaoModelListJson(listRes.stdout);
        }
        const probeRes = await execDoubaoProbe(bin, ['--model', '__botmux_model_probe__', '-p', 'probe'], env, probeTimeout);
        return parseDoubaoAvailableModels(`${probeRes.stdout}\n${probeRes.stderr}`);
      } catch {
        return null;
      }
    },
  };
}
