/**
 * Session credential handoff for trigger-user CLI authentication.
 *
 * The daemon knows who sent the current message; the CLI process does not. This
 * module is the channel between them: the daemon writes a small env-format file
 * per session, and a wrapper on `PATH` sources it just before exec'ing the real
 * tool.
 *
 * ## Why a file and not an environment variable
 *
 * A session is one long-lived CLI process (often a tmux pane). Its environment
 * is fixed by the kernel at spawn: the daemon cannot change it later, and a
 * child cannot rewrite its parent's. So env-injected credentials would freeze
 * whoever started the session — every later turn, by anyone, would keep running
 * as that first person.
 *
 * Identity snapshots are prepared per turn. Each invocation reads the worker's
 * active-turn record and selects that turn's snapshot, so queued messages keep
 * their credentials separate from the executing task.
 *
 * ## Trust direction
 *
 * The daemon writes; the wrapper reads. The CLI process must never be able to
 * write these files — that would let an agent choose its own identity. They live
 * under the session's own data dir and are rewritten (not appended) each turn.
 *
 * ## Why `.env` and not JSON
 *
 * The wrapper is `/bin/sh` and runs on every invocation. `.` (source) is a shell
 * builtin; parsing JSON would mean spawning `jq` — measured at ~20ms extra per
 * call for zero benefit, since these files hold exactly a couple of opaque
 * values.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { clearLarkToolDelegations } from './lark-tool-delegation.js';
import { isCliIdentityPath } from '../utils/child-env.js';
import { resolveEntrySpawn } from './self-spawn.js';
import type { IdentityStorageModel } from './lark-tool-binding.js';
import type { TriggerUserAuthConfig, TriggerUserAuthTool } from '../services/trigger-user-auth.js';

export type { IdentityStorageModel };

/** Where a session's identity files live, under its own data dir. */
export function sessionIdentityDir(sessionDataDir: string): string {
  return join(sessionDataDir, 'cli-identity');
}

/**
 * Proven-model identity contents live ONLY here, in daemon memory, keyed by
 * session then turn then tool. The current-execution proof route serves these
 * contents to a wrapper whose process lineage it has verified; nothing holding
 * a token is ever written to disk in that model, so the same-uid CLI process
 * can neither enumerate queued people's credentials nor redirect its own
 * selection at them. Keyed on realpath so data-dir aliases cannot split the
 * store for one session.
 */
const provenIdentityContents = new Map<
  string,
  Map<string, Partial<Record<IdentityTool, string>>>
>();

function provenSessionKey(sessionDataDir: string, sessionId: string): string {
  let canonical: string;
  try { canonical = realpathSync(sessionDataDir); } catch { canonical = resolve(sessionDataDir); }
  return JSON.stringify([canonical, assertSafeSegment(sessionId)]);
}

function provenSessionMap(key: string, create: boolean) {
  let turns = provenIdentityContents.get(key);
  if (!turns && create) {
    turns = new Map();
    provenIdentityContents.set(key, turns);
  }
  return turns;
}

/** Store one proven identity env body. Called at the same publication points
 *  that used to write a per-turn snapshot file. */
export function rememberProvenIdentityContent(
  sessionDataDir: string,
  sessionId: string,
  turnId: string,
  tool: IdentityTool,
  body: string,
): void {
  const key = provenSessionKey(sessionDataDir, sessionId);
  const turns = provenSessionMap(key, true)!;
  const tools = turns.get(turnId) ?? {};
  tools[tool] = body;
  turns.set(turnId, tools);
}

/** Recall one proven identity env body, or undefined when that turn/tool was
 *  never published or has since been collected. */
export function recallProvenIdentityContent(
  sessionDataDir: string,
  sessionId: string,
  turnId: string,
  tool: IdentityTool,
): string | undefined {
  return provenSessionMap(provenSessionKey(sessionDataDir, sessionId), false)?.get(turnId)?.[tool];
}

/** Forget one turn/tool, one whole turn, or everything the session holds. */
export function forgetProvenIdentityContent(
  sessionDataDir: string,
  sessionId: string,
  turnId?: string,
  tool?: IdentityTool,
): void {
  const turns = provenSessionMap(provenSessionKey(sessionDataDir, sessionId), false);
  if (!turns) return;
  if (!turnId) { turns.clear(); return; }
  if (!tool) { turns.delete(turnId); return; }
  const tools = turns.get(turnId);
  if (tools) {
    delete tools[tool];
    if (Object.keys(tools).length === 0) turns.delete(turnId);
  }
}

/**
 * Terminal GC for proven contents: forget every turn outside `retainTurnIds`.
 * The retention set is computed by the daemon from live state (current
 * execution, dispatched queue, schedule/recovery continuations, pending auth
 * requests, delegations), never from CLI-writable files. Returns the removed
 * turn ids. Failures bias toward retention.
 */
export function collectProvenIdentityContents(
  sessionDataDir: string,
  sessionId: string,
  retainTurnIds: Iterable<string>,
): string[] {
  const turns = provenSessionMap(provenSessionKey(sessionDataDir, sessionId), false);
  if (!turns) return [];
  const retain = new Set(retainTurnIds);
  const removed: string[] = [];
  for (const turnId of turns.keys()) {
    if (!retain.has(turnId)) { turns.delete(turnId); removed.push(turnId); }
  }
  return removed;
}

/**
 * Mutable identity data for one session.
 *
 * Keep the env and active-turn files below the existing per-session wrapper
 * directory instead of binding either file into the sandbox directly. Atomic
 * writes replace a file inode; a long-lived bubblewrap single-file bind would
 * otherwise keep reading the inode captured at spawn. Reusing the directory
 * already mounted for wrappers also lets sessions created before an upgrade see
 * this layout without rebuilding their persistent pane.
 */
export function sessionIdentityDataDir(sessionDataDir: string, sessionId: string): string {
  return join(sessionIdentityBinDir(sessionDataDir, sessionId), '.data');
}

/**
 * Records which identity publication model a session's on-disk directory was
 * initialized for. The proven model keeps no token files; the single model
 * keeps one per-tool file. A session must never reuse the other model's
 * leftovers: when the marker is absent or names a different model, identity
 * artifacts are cleared once and the directory recreated for the current one.
 */
const IDENTITY_LAYOUT_FILE = 'identity-layout';

function identityLayoutMarkerPath(sessionDataDir: string, sessionId: string): string {
  return join(sessionIdentityDataDir(sessionDataDir, sessionId), IDENTITY_LAYOUT_FILE);
}

function readIdentityLayout(sessionDataDir: string, sessionId: string): IdentityStorageModel | undefined {
  try {
    const value = readFileSync(identityLayoutMarkerPath(sessionDataDir, sessionId), 'utf8').trim();
    return value === 'proven-v1' || value === 'single-v1'
      ? (value.slice(0, -3) as IdentityStorageModel)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remove every identity artifact (files and per-turn dirs), keeping the
 *  wrapper binaries, login-shell shims and the lark-tool binding config. Also
 *  forgets proven in-memory contents for the session: the other model must not
 *  reuse them. */
function resetIdentityArtifacts(sessionDataDir: string, sessionId: string): void {
  forgetProvenIdentityContent(sessionDataDir, sessionId);
  const dir = sessionIdentityDataDir(sessionDataDir, sessionId);
  for (const tool of Object.keys(IDENTITY_ENV_KEYS) as TriggerUserAuthTool[]) {
    try { rmSync(join(dir, `${tool}.env`), { force: true }); }
    catch { /* best-effort: absence is the desired state */ }
  }
  try { rmSync(join(dir, 'turns'), { recursive: true, force: true }); }
  catch { /* best-effort: absence is the desired state */ }
  for (const name of ['turn', 'turn.json']) {
    try { rmSync(join(dir, name), { force: true }); }
    catch { /* best-effort: absence is the desired state */ }
  }
}

/** Remove the R3-era per-turn snapshot directory only. R3 (the pre-marker
 *  layout) left live tokens under turns/<sha>/*.env with no identity-layout
 *  marker. A first SINGLE init must clear those, but must NOT touch the root
 *  <tool>.env files: the daemon publishes the opening turn into the root file
 *  at accept time, BEFORE the worker fork initializes this directory, and
 *  wiping it there made the very first turn 77. */
function resetLegacyTurnSnapshots(sessionDataDir: string, sessionId: string): void {
  try { rmSync(join(sessionIdentityDataDir(sessionDataDir, sessionId), 'turns'), { recursive: true, force: true }); }
  catch { /* best-effort: absence is the desired state */ }
}

/** Remove the single-model root snapshot files (one per governed tool) while
 *  leaving the marker, the live turn marker and proven memory untouched. Used
 *  by the daemon when the worker's report flips the session to proven: any
 *  plaintext the daemon wrote before the report (cold start / restart window)
 *  must leave disk BEFORE the proven body is served from memory. */
export function clearSingleIdentityArtifacts(sessionDataDir: string, sessionId: string): void {
  const dir = sessionIdentityDataDir(sessionDataDir, sessionId);
  for (const tool of Object.keys(IDENTITY_ENV_KEYS) as TriggerUserAuthTool[]) {
    try { rmSync(join(dir, `${tool}.env`), { force: true }); }
    catch { /* best-effort: absence is the desired state */ }
  }
}

/**
 * Identity file for one tool and optional prepared turn in a session.
 */
export function sessionIdentityPath(
  sessionDataDir: string,
  sessionId: string,
  tool: IdentityTool,
  turnId?: string,
): string {
  const dir = sessionIdentityDataDir(sessionDataDir, sessionId);
  return turnId
    ? join(dir, 'turns', identityTurnKey(turnId), `${tool}.env`)
    : join(dir, `${tool}.env`);
}

function identityTurnKey(turnId: string): string {
  return createHash('sha256').update(turnId).digest('hex');
}

/**
 * The turn the CLI is executing RIGHT NOW, as published by the worker.
 *
 * Separate from the identity file because the two have different writers and
 * different lifetimes: the daemon writes the identity when a message is
 * *accepted*, the worker writes this when a turn actually *starts*. The gap
 * between those is the whole problem — see {@link renderIdentityWrapper}.
 *
 * Plain text, four lines: turn, caller, sha256(identity turn), identity turn.
 * The single-model wrapper reads the record once in `/bin/sh` on every
 * invocation (the first two lines plus the file); the proven-model wrapper
 * selects no identity from disk and does not read it. Daemon refresh checks
 * use line 4 as a liveness gate.
 */
export function sessionActiveTurnPath(sessionDataDir: string, sessionId: string): string {
  return join(sessionIdentityDataDir(sessionDataDir, sessionId), 'turn');
}

/**
 * Machine-readable companion to {@link sessionActiveTurnPath}:
 * `{"turnId":…,"dispatchAttempt":…}` (one JSON object, 0600).
 *
 * The shell file stays a bare record because a `/bin/sh` identity wrapper in
 * the single-snapshot model sources it per tool call; this one exists for a
 * JSON consumer that must freeze the (turn, dispatch generation) pair it is
 * reporting on. The dsh-tui wrapper plugin reads it synchronously inside the
 * `agent/status` callback (BOTMUX_TURN_IDLE_COMMAND) and carries the pair
 * end-to-end, because a later read can already name the NEXT dispatch — see
 * src/utils/turn-idle-report.ts. Its path layout is therefore mirrored in the
 * generated snippet (src/adapters/dsh-question-bridge.ts): keep the two in
 * sync.
 */
export function sessionActiveTurnIdentityPath(sessionDataDir: string, sessionId: string): string {
  return join(sessionIdentityDataDir(sessionDataDir, sessionId), 'turn.json');
}

/**
 * Publish the turn now executing. Called by the worker at the point it hands a
 * queued input to the CLI, which is later than the daemon's acceptance of that
 * message and possibly much later.
 *
 * Best-effort: a failure here can only cost a refused command, never a wrong
 * identity, because the wrapper treats an unreadable turn file as a mismatch.
 */
export function publishActiveTurn(
  sessionDataDir: string,
  sessionId: string,
  turnId: string | undefined,
  dispatchAttempt?: number,
  callerOpenId?: string,
  identityTurnId: string | undefined = turnId,
): void {
  const dir = sessionIdentityDataDir(sessionDataDir, sessionId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // turn, caller, identity key and identity turn live in ONE file so readers
    // get all four in a single open: separate files cannot be updated
    // atomically together, and a reader landing between writes would see a
    // turn from one generation with a caller from another (a cross-principal
    // misattribution).
    atomicWriteFileSync(
      sessionActiveTurnPath(sessionDataDir, sessionId),
      `${turnId ?? ''}\n${callerOpenId ?? ''}\n${identityTurnId ? identityTurnKey(identityTurnId) : ''}\n${identityTurnId ?? ''}\n`,
      { mode: 0o600 },
    );
  } catch { /* best-effort: a stale/absent turn file refuses, never misattributes */ }
  try {
    atomicWriteFileSync(
      sessionActiveTurnIdentityPath(sessionDataDir, sessionId),
      `${JSON.stringify({
        turnId: turnId ?? null,
        dispatchAttempt: dispatchAttempt ?? null,
        ...(callerOpenId ? { callerOpenId } : {}),
        identityTurnId: identityTurnId ?? null,
      })}\n`,
      { mode: 0o600 },
    );
  } catch { /* best-effort: the reader stays silent without a frozen identity */ }
}

/** Session ids reach here from IPC; they are concatenated into a path, so a
 *  `../` shaped id must not be able to redirect a credential write. */
function assertSafeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value) || /^\.+$/.test(value)) {
    throw new Error(`[cli-identity] unsafe session id used as path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Env vars each tool reads to act as a specific person.
 *
 * `lark-cli` needs the app id alongside the token: given only
 * `LARKSUITE_CLI_USER_ACCESS_TOKEN` it refuses outright with `blocked by env:
 * LARKSUITE_CLI_USER_ACCESS_TOKEN is set but LARKSUITE_CLI_APP_ID is missing`.
 *
 * Note we do NOT use `LARKSUITE_CLI_CONFIG_DIR`: lark-cli keeps tokens under
 * `~/Library/Application Support/lark-cli/<appId>_<openId>.enc`, which does not
 * move with that variable — pointing it elsewhere isolates config but not
 * credentials. Injecting the token directly also sidesteps the macOS Keychain
 * (whose master key a sandboxed process cannot read).
 */
/**
 * Tools that get an identity file + wrapper. The policy names `lark-cli` and
 * `bytedcli`; `codebase` (the Codebase CLI) is a COMPANION of bytedcli — its
 * credential is the Codebase JWT bytedcli mints, so it is never authorized on
 * its own: whenever bytedcli's identity is published, codebase's is derived
 * and published alongside, and whenever bytedcli is governed, codebase is
 * wrapped too. Keeping it out of the policy type means no config, schedule
 * scope or dashboard surface has to learn a third name.
 */
export const CODEBASE_COMPANION_TOOL = 'codebase' as const;
export type IdentityTool = TriggerUserAuthTool | typeof CODEBASE_COMPANION_TOOL;

export const IDENTITY_ENV_KEYS: Record<IdentityTool, readonly string[]> = {
  // APP_SECRET appears only in bot mode; in user mode it is absent from the
  // file, and `export` on an unset name puts nothing in the child's env.
  'lark-cli': ['LARKSUITE_CLI_APP_ID', 'LARKSUITE_CLI_APP_SECRET', 'LARKSUITE_CLI_USER_ACCESS_TOKEN'],
  // ByteCloud JWT and the Codebase JWT derived from it. The latter is what git
  // pushes authenticate with, so attribution of a commit follows from it.
  bytedcli: ['BYTEDCLI_USER_CLOUD_JWT', 'BYTEDCLI_USER_CODE_JWT'],
  // The Codebase CLI reads the same Codebase JWT from its own variable
  // (`codebase auth login --help`: CI usage without persisting credentials).
  codebase: ['CODEBASE_CLI_USER_JWT'],
};

/** The identity tools a policy actually governs (policy tools + companions). */
export function identityToolsFor(tools: readonly TriggerUserAuthTool[]): IdentityTool[] {
  const out = new Set<IdentityTool>(tools);
  if (out.has('bytedcli')) out.add(CODEBASE_COMPANION_TOOL);
  return [...out];
}

/** Common to every variant: the turn these credentials were published FOR.
 *  The wrapper refuses to use them during any other turn. Absent ⇒ no binding
 *  (the pre-turn-binding paths, and tests that do not exercise it). */
interface TurnBound {
  turnId?: string;
}

export interface LarkCliIdentity extends TurnBound {
  tool: 'lark-cli';
  appId: string;
  userAccessToken: string;
  /** Open id this token acts for. Lets the wrapper keep a turn-mismatched but
   *  same-principal credential usable — a person's own follow-up turn must not
   *  be denied while their previous turn is still draining. */
  openId?: string;
}

/**
 * Run lark-cli as a person by pointing HOME at their own lark-cli HOME.
 *
 * The device-code (QR) identity: the person scanned once, lark-cli stored their
 * token under this HOME, and the wrapper only exports HOME for the call. No
 * token passes through the environment — unlike {@link LarkCliIdentity}, which
 * injects a token the daemon obtained. The exported HOME is scoped to this one
 * exec, so the parent CLI and every other tool keep the machine's HOME.
 */
export interface LarkCliHomeIdentity extends TurnBound {
  tool: 'lark-cli';
  mode: 'user-home';
  /** Absolute per-person HOME the child lark-cli sees. */
  home: string;
  /** See {@link LarkCliIdentity.openId}. */
  openId?: string;
}

export interface BytedCliIdentity extends TurnBound {
  tool: 'bytedcli';
  cloudJwt: string;
  /** Optional: only present once a Codebase JWT has been minted for this person. */
  codeJwt?: string;
  /** See {@link LarkCliIdentity.openId}. */
  openId?: string;
}

/**
 * Run as the bot, explicitly.
 *
 * Publishing *nothing* does not achieve this. Measured on lark-cli 2026-09:
 * with no identity env at all it resolves `identity: user` from the operator's
 * on-disk login (`~/Library/Application Support/lark-cli/<appId>_<openId>.enc`)
 * and acts as that person. Supplying `LARKSUITE_CLI_APP_ID` +
 * `LARKSUITE_CLI_APP_SECRET` instead resolves `identity: bot` even while that
 * login exists, and `--as user` on top of it then fails `token_missing` rather
 * than reaching back to the disk credentials — so the bot identity is a real
 * floor, not a default the agent can step out of.
 */
export interface BotIdentity extends TurnBound {
  tool: 'lark-cli';
  mode: 'bot';
  appId: string;
  appSecret: string;
}

/**
 * No identity, and the command must not run.
 *
 * Carries the text the wrapper prints, so the person reading a failed command
 * learns whose authorization is missing and how to supply it. Composed in TS
 * because that is where the locale lives.
 */
export interface DeniedIdentity extends TurnBound {
  tool: IdentityTool;
  mode: 'denied';
  message: string;
}

/**
 * Codebase CLI as a person: derived from the bytedcli identity's Codebase JWT.
 * Never resolved on its own — see {@link CODEBASE_COMPANION_TOOL}.
 */
export interface CodebaseCliIdentity extends TurnBound {
  tool: typeof CODEBASE_COMPANION_TOOL;
  codeJwt: string;
  /** See {@link LarkCliIdentity.openId}. */
  openId?: string;
}

export type CliIdentity = LarkCliIdentity | LarkCliHomeIdentity | BytedCliIdentity | CodebaseCliIdentity | BotIdentity | DeniedIdentity;

/** Exit code for a command refused for want of authorization. Distinct from the
 *  tool's own failures so callers can tell "not allowed" from "did not work".
 *  77 is the conventional EX_NOPERM. */
export const IDENTITY_DENIED_EXIT_CODE = 77;

/** Marker the wrapper dispatches on. Absent or unrecognized ⇒ denied, so a
 *  truncated, empty, or never-written file can never mean "run unrestricted". */
const MODE_VAR = 'BOTMUX_IDENTITY_MODE';
const DENY_MSG_VAR = 'BOTMUX_IDENTITY_DENY_MSG';
/** The turn these credentials belong to; compared against the worker's live
 *  turn file before they may be used. */
const TURN_VAR = 'BOTMUX_IDENTITY_TURN';
/** Open id these credentials act for. Compared with the worker's live-turn
 *  caller when the turn ids disagree: equal principals keep the credential. */
const OPEN_ID_VAR = 'BOTMUX_IDENTITY_OPEN_ID';
/** Per-person HOME for the device-code lark-cli identity. Scoped to the child
 *  exec only — the wrapper sets it inline, never inheriting a parent value. */
const HOME_VAR = 'BOTMUX_IDENTITY_HOME';

/**
 * Values must survive `.` (source) in `/bin/sh` unchanged.
 *
 * A single-quoted shell word is fully literal apart from the quote itself, so
 * escaping `'` is the whole job. Newlines and `$` are safe inside it. We reject
 * rather than sanitize: a credential we had to alter to make safe is a
 * credential that will not work, and a silent truncation would surface much
 * later as a baffling auth failure.
 */
function shellSingleQuote(value: string): string {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error('[cli-identity] credential value contains a line break or NUL');
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Render the `.env` body a wrapper will source. */
export function renderIdentityEnv(identity: CliIdentity): string {
  const pairs: Array<[string, string]> = [];
  if ('mode' in identity && identity.mode === 'denied') {
    pairs.push([MODE_VAR, 'denied'], [DENY_MSG_VAR, identity.message]);
  } else if ('mode' in identity && identity.mode === 'bot') {
    pairs.push(
      [MODE_VAR, 'bot'],
      ['LARKSUITE_CLI_APP_ID', identity.appId],
      ['LARKSUITE_CLI_APP_SECRET', identity.appSecret],
    );
  } else if ('mode' in identity && identity.mode === 'user-home') {
    // Device-code identity: the child lark-cli resolves config/creds from this
    // HOME. HOME is exported (not APP_ID/TOKEN), so no credential text is in the
    // identity file at all.
    pairs.push([MODE_VAR, 'user-home'], [HOME_VAR, identity.home]);
  } else if (identity.tool === 'lark-cli') {
    pairs.push(
      [MODE_VAR, 'user'],
      ['LARKSUITE_CLI_APP_ID', identity.appId],
      ['LARKSUITE_CLI_USER_ACCESS_TOKEN', identity.userAccessToken],
    );
  } else if (identity.tool === CODEBASE_COMPANION_TOOL) {
    pairs.push([MODE_VAR, 'user'], ['CODEBASE_CLI_USER_JWT', identity.codeJwt]);
  } else {
    pairs.push([MODE_VAR, 'user'], ['BYTEDCLI_USER_CLOUD_JWT', identity.cloudJwt]);
    if (identity.codeJwt) pairs.push(['BYTEDCLI_USER_CODE_JWT', identity.codeJwt]);
  }
  if (identity.turnId) pairs.push([TURN_VAR, identity.turnId]);
  if ('openId' in identity && identity.openId) pairs.push([OPEN_ID_VAR, identity.openId]);
  const header = '# botmux trigger-user identity — rewritten each turn, do not edit\n';
  return header + pairs.map(([k, v]) => `${k}=${quoteFor(k, v)}`).join('\n') + '\n';
}

/** The deny message is prose and legitimately spans lines; a credential never
 *  does, and one containing a newline means something upstream is wrong. */
function quoteFor(key: string, value: string): string {
  return key === DENY_MSG_VAR ? shellSingleQuoteMultiline(value) : shellSingleQuote(value);
}

function shellSingleQuoteMultiline(value: string): string {
  if (value.includes('\0')) throw new Error('[cli-identity] message contains NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Publish the identity in force for a turn.
 *
 * In the proven model the rendered env body stays in daemon memory (see
 * {@link rememberProvenIdentityContent}); no token touches disk. In the
 * single-snapshot model it is written to the one per-tool file and atomically
 * replaces whatever the previous turn left there.
 *
 * 0600 because the file holds a live token, and the containing dir is 0700.
 * Written atomically: a CLI invocation that lands mid-write must read either the
 * previous identity or the new one, never a half-written token that would fail
 * with a confusing error.
 */
export function writeSessionIdentity(
  sessionDataDir: string,
  sessionId: string,
  identity: CliIdentity,
  model: IdentityStorageModel,
): string {
  const body = renderIdentityEnv(identity);
  const path = sessionIdentityPath(sessionDataDir, sessionId, identity.tool, identity.turnId);
  if (model === 'proven') {
    if (!identity.turnId) throw new Error('[cli-identity] proven identity requires a turn id');
    rememberProvenIdentityContent(sessionDataDir, sessionId, identity.turnId, identity.tool, body);
    // Companion mirror for the Codebase CLI: keep memory and disk branches in
    // agreement whenever bytedcli publishes, so the two never disagree.
    if (identity.tool === 'bytedcli') {
      const companion = codebaseCompanionOf(identity);
      rememberProvenIdentityContent(sessionDataDir, sessionId, identity.turnId, companion.tool,
        renderIdentityEnv(companion));
    }
    return path;
  }
  const singlePath = join(sessionIdentityDataDir(sessionDataDir, sessionId), `${identity.tool}.env`);
  mkdirSync(dirname(singlePath), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(singlePath, body, { mode: 0o600 });
  // Companion: every bytedcli publication (grant OR refusal) is mirrored for
  // the Codebase CLI, so the two can never disagree about whose turn it is.
  // Two files cannot be committed atomically; if the mirror fails, take the
  // bytedcli file down with it rather than leave a granted bytedcli next to a
  // stale codebase identity (an absent file is a refusal for both wrappers).
  if (identity.tool === 'bytedcli') {
    const companion = codebaseCompanionOf(identity);
    try {
      atomicWriteFileSync(
        sessionIdentityPath(sessionDataDir, sessionId, companion.tool),
        renderIdentityEnv(companion),
        { mode: 0o600 },
      );
    } catch (e) {
      try { rmSync(singlePath, { force: true }); } catch { /* best-effort */ }
      throw e;
    }
  }
  return singlePath;
}

/** Whether a published identity for the turn/tool still exists, in the model's
 *  store. Distinguishes "material missing" (a terminal condition for an auth
 *  poll) from "live turn not active yet" (which keeps the poll pending). */
export function sessionIdentityMaterialPresent(
  sessionDataDir: string,
  sessionId: string,
  tool: IdentityTool,
  turnId: string,
  model: IdentityStorageModel,
): boolean {
  if (model === 'proven') return recallProvenIdentityContent(sessionDataDir, sessionId, turnId, tool) !== undefined;
  return existsSync(join(sessionIdentityDataDir(sessionDataDir, sessionId), `${tool}.env`));
}

function isDeniedIdentity(identity: CliIdentity): identity is DeniedIdentity {
  return 'mode' in identity && identity.mode === 'denied';
}

/** The codebase identity implied by a bytedcli one. A bytedcli grant without a
 *  Codebase JWT (the mint is best-effort) refuses codebase rather than letting
 *  it fall back to the machine's own Codebase login. */
export function codebaseCompanionOf(identity: BytedCliIdentity | DeniedIdentity): CodebaseCliIdentity | DeniedIdentity {
  const turn = identity.turnId ? { turnId: identity.turnId } : {};
  if (isDeniedIdentity(identity)) {
    return { tool: CODEBASE_COMPANION_TOOL, mode: 'denied', message: identity.message, ...turn };
  }
  if (!identity.codeJwt) {
    return {
      tool: CODEBASE_COMPANION_TOOL,
      mode: 'denied',
      ...turn,
      message: 'botmux: ByteCloud 已授权，但本轮未能换取 Codebase 身份（Codebase JWT），codebase 命令未执行；请稍后重试，不会改用机器自己的 Codebase 登录。',
    };
  }
  return {
    tool: CODEBASE_COMPANION_TOOL,
    codeJwt: identity.codeJwt,
    ...turn,
    ...(identity.openId ? { openId: identity.openId } : {}),
  };
}

export function refreshSessionIdentity(
  sessionDataDir: string,
  sessionId: string,
  identity: CliIdentity & { turnId: string },
  model: IdentityStorageModel,
): boolean {
  const turnLine = `${TURN_VAR}=${quoteFor(TURN_VAR, identity.turnId)}`;
  const openId = 'openId' in identity ? identity.openId : undefined;
  try {
    // Match the TURN line by line, not by suffix: renderIdentityEnv appends the
    // OPEN_ID line after TURN for every principal-stamped identity, so
    // `endsWith(TURN=…)` is false for exactly the files this feature produces.
    const previous = model === 'proven'
      ? recallProvenIdentityContent(sessionDataDir, sessionId, identity.turnId, identity.tool)
      : readFileSync(join(sessionIdentityDataDir(sessionDataDir, sessionId), `${identity.tool}.env`), 'utf8');
    if (previous === undefined) return false;
    const lines = previous.split('\n');
    if (!lines.includes(turnLine)) return false;
    // Incidental consistency: a file already stamped for one principal must not
    // be refreshed into another principal's token. An UNSTAMPED file (the
    // first-authorization denial, or a pre-binding credential) is not evidence
    // of a mismatch and is allowed through — that is the path that just
    // completed the device grant.
    const stamped = lines.find(line => line.startsWith(`${OPEN_ID_VAR}=`));
    if (stamped && stamped !== `${OPEN_ID_VAR}=${quoteFor(OPEN_ID_VAR, openId ?? '')}`) return false;
    // Proven content is addressed by execution proof, so the live turn marker
    // only has to still name this identity turn. The single-snapshot model
    // compares its first line (envelope turn), as before.
    const active = readFileSync(sessionActiveTurnPath(sessionDataDir, sessionId), 'utf8').split('\n');
    if (model === 'proven') {
      if ((active[3] ?? active[0]) !== identity.turnId) return false;
    } else if ((active[0] ?? '').trim() !== identity.turnId) {
      return false;
    }
  } catch {
    return false;
  }
  writeSessionIdentity(sessionDataDir, sessionId, identity, model);
  return true;
}

/**
 * Remove one turn's tool identity, or every snapshot for that tool at teardown.
 */
export function clearSessionIdentity(
  sessionDataDir: string,
  sessionId: string,
  tool: IdentityTool,
  turnId: string | undefined,
  model: IdentityStorageModel,
): void {
  if (model === 'proven') {
    forgetProvenIdentityContent(sessionDataDir, sessionId, turnId, tool);
    // The companion lives and dies with bytedcli's in-memory identity.
    if (tool === 'bytedcli') forgetProvenIdentityContent(sessionDataDir, sessionId, turnId, CODEBASE_COMPANION_TOOL);
    return;
  }
  try { rmSync(join(sessionIdentityDataDir(sessionDataDir, sessionId), `${tool}.env`), { force: true }); }
  catch { /* best-effort: absence is the desired state */ }
  // The companion lives and dies with bytedcli's on-disk identity.
  if (tool === 'bytedcli') clearSessionIdentity(sessionDataDir, sessionId, CODEBASE_COMPANION_TOOL, turnId, model);
  if (turnId) return;
  const turnsDir = join(sessionIdentityDataDir(sessionDataDir, sessionId), 'turns');
  try {
    for (const entry of readdirSync(turnsDir)) {
      rmSync(join(turnsDir, entry, `${tool}.env`), { force: true });
    }
  } catch { /* best-effort: absence is the desired state */ }
  // Before #1543 identities lived directly under cli-identity/. Upgraded
  // sessions no longer read or overwrite those files, so remove the exact
  // legacy path as well instead of leaving a live token behind indefinitely.
  try {
    rmSync(
      join(sessionIdentityDir(sessionDataDir), `${assertSafeSegment(sessionId)}.${tool}.env`),
      { force: true },
    );
  } catch { /* best-effort: absence is the desired state */ }
}

/** Drop every identity for a session (teardown). Proven contents are memory
 *  only; single-snapshot files and any on-disk leftovers from an older layout
 *  are removed as well. */
export function clearAllSessionIdentities(sessionDataDir: string, sessionId: string): void {
  clearLarkToolDelegations(sessionDataDir, sessionId);
  forgetProvenIdentityContent(sessionDataDir, sessionId);
  for (const tool of Object.keys(IDENTITY_ENV_KEYS) as TriggerUserAuthTool[]) {
    try { rmSync(join(sessionIdentityDataDir(sessionDataDir, sessionId), `${tool}.env`), { force: true }); }
    catch { /* best-effort: absence is the desired state */ }
    try {
      rmSync(
        join(sessionIdentityDir(sessionDataDir), `${assertSafeSegment(sessionId)}.${tool}.env`),
        { force: true },
      );
    } catch { /* best-effort: absence is the desired state */ }
  }
  try { rmSync(join(sessionIdentityDataDir(sessionDataDir, sessionId), 'turns'), { recursive: true, force: true }); }
  catch { /* best-effort: absence is the desired state */ }
  for (const name of ['turn', 'turn.json', IDENTITY_LAYOUT_FILE]) {
    try { rmSync(join(sessionIdentityDataDir(sessionDataDir, sessionId), name), { force: true }); }
    catch { /* best-effort: absence is the desired state */ }
  }
  try {
    rmSync(
      join(sessionIdentityDir(sessionDataDir), `${assertSafeSegment(sessionId)}.turn`),
      { force: true },
    );
  } catch { /* best-effort: absence is the desired state */ }
}

/**
 * The wrapper script for one tool.
 *
 * Design constraints, each learned the hard way elsewhere in this codebase:
 *
 *  - `exec` so signals and the exit code pass straight through.
 *  - Absolute path to the real binary: the wrapper shadows the tool's own name
 *    on `PATH`, so resolving by name again would re-enter this script forever.
 *  - `BOTMUX_SESSION_ID` / `SESSION_DATA_DIR` come from the session env the
 *    worker already injects; the wrapper is identical for every session, so
 *    nothing needs rewriting when sessions come and go.
 *  - **A missing or unrecognized identity denies the command.** The earlier
 *    version exec'd the tool anyway, on the belief that no env means "run as
 *    the bot". It does not: lark-cli then resolves the operator's on-disk
 *    login and acts as *that person* — the machine account this whole feature
 *    exists to stop. So absence is refusal, and running as the bot is
 *    something the daemon must ask for explicitly (`mode=bot`).
 *
 * Two identity models (see {@link IdentityStorageModel}):
 *
 *  - `proven`: a helper process proves THIS process tree belongs to the turn
 *    now executing over the daemon loopback channel, and prints the identity
 *    env assignments themselves. The wrapper `eval`s them directly — no
 *    identity file is read or selected, so a same-uid agent cannot redirect
 *    the choice at another queued turn and no token rests on disk to read.
 *  - `single` (paths without that channel): the legacy layout — one per-tool
 *    file the daemon overwrites (or removes) on every turn, plus the live
 *    turn marker used for the tail-of-turn mismatch refusal.
 */
export function renderIdentityWrapper(
  tool: IdentityTool,
  realBinaryPath: string,
  model: IdentityStorageModel,
  identityResolver?: readonly string[],
): string {
  const exportKeys = IDENTITY_ENV_KEYS[tool].join(' ');
  const resolveBlock = model === 'proven' ? [
    // The runner proves this process tree over the daemon loopback channel and
    // prints the identity env ASSIGNMENTS, never a path. eval consumes that
    // body straight from the pipe: nothing in the session directory can select
    // or alter the identity, and no token rests on disk to be read.
    `__botmux_cred_body=$(${[...identityResolver!, tool].map(shellSingleQuote).join(' ')}) || exit ${IDENTITY_DENIED_EXIT_CODE}`,
    // An empty body is a missing/empty response (no mode assignment below),
    // never silent permission to run: deny it like a failed proof.
    `[ -n "$__botmux_cred_body" ] || exit ${IDENTITY_DENIED_EXIT_CODE}`,
    `eval "$__botmux_cred_body" || exit ${IDENTITY_DENIED_EXIT_CODE}`,
    // Defense in depth: the served body must name the mode we know how to
    // dispatch. The daemon already whitelists these keys, but a wrapper must
    // not eval a body that hands it an unrecognized mode either.
    `case "$BOTMUX_IDENTITY_MODE" in user|bot|user-home|turn-mismatch|denied) ;; *) exit ${IDENTITY_DENIED_EXIT_CODE} ;; esac`,
    'unset __botmux_cred_body',
  ] : [
    'if [ -n "$SESSION_DATA_DIR" ] && [ -n "$BOTMUX_SESSION_ID" ]; then',
    '  __botmux_d="$SESSION_DATA_DIR/cli-identity/$BOTMUX_SESSION_ID.bin/.data"',
    `  __botmux_cred="$__botmux_d/${tool}.env"`,
    '  if [ -f "$__botmux_cred" ]; then',
    '    . "$__botmux_cred"',
    '  fi',
    '  if [ -f "$__botmux_d/turn" ]; then',
    '    { read -r __botmux_live; read -r __botmux_live_caller; } < "$__botmux_d/turn" || true',
    '  fi',
    '  unset __botmux_d __botmux_cred',
    'fi',
    // Only enforced when both sides state a turn. An identity published without
    // one predates turn binding; a session with no live turn file has nothing to
    // contradict. Neither is evidence of a mismatch, so neither refuses here.
    `if [ -n "$${TURN_VAR}" ] && [ -n "$__botmux_live" ] \\`,
    `   && [ "$${TURN_VAR}" != "$__botmux_live" ]; then`,
    `  __botmux_published_mode=$${MODE_VAR}`,
    `  ${MODE_VAR}=turn-mismatch`,
    // Same human across consecutive turns (their follow-up was accepted while
    // the previous turn is still draining): the credential acts for exactly the
    // person the worker is now executing, so keep it. Only a NAMED match on both
    // sides relaxes; anything missing stays a refusal. Restore the published
    // mode (user/user-home/bot) so the case dispatch below runs normally.
    `  if [ -n "$${OPEN_ID_VAR}" ] && [ -n "$__botmux_live_caller" ] \\`,
    `     && [ "$${OPEN_ID_VAR}" = "$__botmux_live_caller" ]; then`,
    `    ${MODE_VAR}=$__botmux_published_mode`,
    '  fi',
    'fi',
    'unset __botmux_live __botmux_live_caller __botmux_published_mode',
  ];
  return [
    '#!/bin/sh',
    '# botmux trigger-user identity wrapper — generated, do not edit.',
    '# Loads the identity the daemon holds for the CURRENT turn, then execs the',
    '# real tool. Re-resolved on every invocation, which is what lets the acting',
    '# identity change without restarting the session.',
    '#',
    '# No usable identity => the command does not run. Exec\'ing the tool bare',
    '# would hand it the machine account\'s login, not the bot\'s.',
    `${MODE_VAR}=`,
    `${DENY_MSG_VAR}=`,
    // Clear inherited copies before loading: a parent process that exports a
    // forged OPEN_ID/TURN could otherwise flip a cross-principal refusal into
    // the same-principal allowance. The values are re-set below from the
    // daemon-provided identity when it carries them.
    `${TURN_VAR}=`,
    `${OPEN_ID_VAR}=`,
    '__botmux_live=',
    '__botmux_live_caller=',
    ...resolveBlock,
    '',
    `case "$${MODE_VAR}" in`,
    '  user|bot)',
    `    export ${exportKeys}`,
    '    ;;',
    '  user-home)',
    // Device-code identity. HOME is scoped to THIS exec only: assign it inline
    // to the lark-cli process rather than `export`-ing, so a sibling command or
    // a later exec in the same shell keeps the machine HOME. The directory is
    // validated: an empty/missing HOME would make lark-cli fall back to the
    // operator's on-disk login, which is precisely the wrong person.
    `    if [ -z "$${HOME_VAR}" ] || [ ! -d "$${HOME_VAR}" ]; then`,
    `      printf '%s\\n' 'botmux: ${tool} 的按人身份目录缺失，命令未执行。请重新发送 /login 完成授权后重试。' >&2`,
    `      exit ${IDENTITY_DENIED_EXIT_CODE}`,
    '    fi',
    `    unset ${MODE_VAR} ${DENY_MSG_VAR} ${TURN_VAR} ${OPEN_ID_VAR}`,
    `    HOME="$${HOME_VAR}" exec ${shellSingleQuote(realBinaryPath)} "$@"`,
    '    ;;',
    '  turn-mismatch)',
    `    printf '%s\\n' 'botmux: 当前执行的身份材料缺失或与执行主体不匹配，命令未执行。请检查任务执行状态后重试。' >&2`,
    `    exit ${IDENTITY_DENIED_EXIT_CODE}`,
    '    ;;',
    '  *)',
    // Guidance, not just refusal: whoever reads this needs to know it was a
    // permission decision and what to do next, or they retry the same command.
    `    if [ -n "$${DENY_MSG_VAR}" ]; then`,
    `      printf '%s\\n' "$${DENY_MSG_VAR}" >&2`,
    '    else',
    `      printf '%s\\n' 'botmux: ${tool} 需要发起人本人的授权，当前会话没有可用凭证，命令未执行。请发送 /login 完成授权后重试。' >&2`,
    '    fi',
    `    exit ${IDENTITY_DENIED_EXIT_CODE}`,
    '    ;;',
    'esac',
    `unset ${MODE_VAR} ${DENY_MSG_VAR} ${TURN_VAR} ${OPEN_ID_VAR} ${HOME_VAR}`,
    `exec ${shellSingleQuote(realBinaryPath)} "$@"`,
    '',
  ].join('\n');
}

/**
 * Initialize the per-session identity directory for one storage model before
 * sandbox spawn so a sandboxed session can read the bound directory later.
 *
 * The file sandbox existence-filters its allow list: a path that does not exist
 * at spawn is dropped. Binding the directory (rather than its files) is also
 * what makes later atomic rename updates visible to a persistent sandbox.
 *
 * Empty is the right initial content. No identity exists until the first turn
 * resolves one, and both the wrapper and a `.`-source treat an empty file the
 * same as an absent one.
 *
 * When the directory was initialized for the OTHER model (or predates this
 * layout), identity artifacts are reset once first: a session must not reuse
 * the other model's snapshots. Never truncates an existing file of the current
 * model: a restart mid-session must not discard the identity already in force.
 */
export function ensureSessionIdentityStorage(
  sessionDataDir: string,
  sessionId: string,
  tools: readonly IdentityTool[],
  model: IdentityStorageModel,
): void {
  const dir = sessionIdentityDataDir(sessionDataDir, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const current = readIdentityLayout(sessionDataDir, sessionId);
  if (current !== model) {
    if (current === undefined && model === 'single') {
      // No marker, first SINGLE init: remove ONLY R3 per-turn leftovers. The
      // root files are the live accept→fork publication channel — the daemon
      // writes the opening turn before this worker spawned, and deleting it
      // would deny the first turn (N1). A PROVEN init below still wipes
      // everything, including root files, because proven keeps no disk token.
      resetLegacyTurnSnapshots(sessionDataDir, sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      // Explicit model switch, or a markerless first PROVEN init: wipe every
      // artifact of the other layout (and any older build's leftovers).
      resetIdentityArtifacts(sessionDataDir, sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    atomicWriteFileSync(identityLayoutMarkerPath(sessionDataDir, sessionId), `${model}-v1\n`, { mode: 0o600 });
  }
  const paths = [
    sessionActiveTurnPath(sessionDataDir, sessionId),
    // The single model sources these root files on every invocation; the
    // proven model keeps no token files, so only the turn marker is needed.
    ...(model === 'single'
      ? tools.map(tool => join(dir, `${tool}.env`))
      : []),
  ];
  for (const path of paths) {
    if (existsSync(path)) continue;
    atomicWriteFileSync(path, '', { mode: 0o600 });
  }
}

/** Whether the wrapper for `tool` is currently installed in `binDir`. */
export function identityWrapperInstalled(binDir: string, tool: IdentityTool): boolean {
  return existsSync(join(binDir, tool));
}

/**
 * Where a session's identity wrappers live.
 *
 * Deliberately NOT the shared `~/.botmux/bin`: a wrapper there would shadow
 * `lark-cli` for every bot on the machine, including ones that never enabled
 * this feature — and for the operator's own shell too, since that dir is on
 * their PATH. Keeping it per session means the shadowing is exactly as narrow
 * as the policy that asked for it.
 */
export function sessionIdentityBinDir(sessionDataDir: string, sessionId: string): string {
  return join(sessionIdentityDir(sessionDataDir), `${assertSafeSegment(sessionId)}.bin`);
}

/**
 * Keep the wrapper dir first even after a LOGIN shell rebuilds PATH.
 *
 * Prepending to the child's PATH is not enough. The agent's tool calls run
 * through a login shell (`bash -lc` / `zsh -lc`), which sources /etc/zprofile,
 * which runs `/usr/libexec/path_helper`. That helper REBUILDS PATH from
 * /etc/paths + /etc/paths.d and appends whatever was already there — measured
 * on macOS 15: the wrapper dir goes from position 1 to position 12, while
 * /opt/homebrew/bin (owned by /etc/paths.d/homebrew) lands at 10. So the real
 * lark-cli wins and every governed call silently runs unwrapped.
 *
 * The fix is a startup file of our own that re-prepends AFTER path_helper has
 * had its say:
 *   - zsh reads $ZDOTDIR/.zprofile then $ZDOTDIR/.zshrc for a login shell;
 *   - bash reads $BASH_ENV for a non-interactive shell.
 * Both are per-process env vars, so nothing is written to the user's dotfiles
 * and no other shell on the machine is affected. Each shim sources the user's
 * real startup file afterwards, so their own PATH edits still apply — ours just
 * goes back in front once they are done.
 *
 * Verified against the real binaries: with the shim, `zsh -lc 'command -v
 * lark-cli'` and the bash equivalent both resolve to the wrapper; without it,
 * both resolve to /opt/homebrew/bin/lark-cli.
 */
export function installLoginShellPathShim(binDir: string): { zdotdir: string; bashEnv: string } {
  const zdotdir = join(binDir, 'shell');
  mkdirSync(zdotdir, { recursive: true, mode: 0o700 });
  // `BOTMUX_IDENTITY_BIN` rather than the literal path: one shim text for every
  // session, and a shell that inherits it without the variable is a no-op
  // instead of prepending some other session's wrapper dir.
  const reprepend = [
    '# botmux trigger-user identity — generated, do not edit.',
    '# Re-prepend the wrapper dir AFTER path_helper has rebuilt PATH.',
    'if [ -n "$BOTMUX_IDENTITY_BIN" ]; then',
    '  case ":$PATH:" in',
    '    "$BOTMUX_IDENTITY_BIN":*) ;;',
    '    *) PATH="$BOTMUX_IDENTITY_BIN${PATH:+:$PATH}"; export PATH ;;',
    '  esac',
    'fi',
    '',
  ].join('\n');
  // zsh: source the user's own file FIRST, then put ourselves back in front —
  // their `export PATH=...:$PATH` would otherwise jump ahead of the wrapper.
  const zshShim = (userFile: string) => [
    `[ -r "$HOME/${userFile}" ] && . "$HOME/${userFile}"`,
    reprepend,
  ].join('\n');
  atomicWriteFileSync(join(zdotdir, '.zprofile'), zshShim('.zprofile'), { mode: 0o600 });
  atomicWriteFileSync(join(zdotdir, '.zshrc'), zshShim('.zshrc'), { mode: 0o600 });
  atomicWriteFileSync(join(zdotdir, '.zshenv'), zshShim('.zshenv'), { mode: 0o600 });
  const bashEnv = join(zdotdir, 'bash_env.sh');
  atomicWriteFileSync(bashEnv, reprepend, { mode: 0o600 });
  return { zdotdir, bashEnv };
}

/**
 * Install the wrapper for `tool` into `binDir`.
 *
 * `binDir` must be prepended to the session PATH by the caller, so the wrapper
 * shadows the tool for that session only.
 *
 * Returns the wrapper path, or null when the real tool is not installed (nothing
 * to wrap, and a wrapper pointing at a missing binary would turn "tool not
 * installed" into a confusing wrapper error).
 */
export function installIdentityWrapper(
  binDir: string,
  tool: IdentityTool,
  realBinaryPath: string | null | undefined,
  model: IdentityStorageModel,
  identityResolver?: readonly string[],
): string | null {
  if (!realBinaryPath) return null;
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, tool);
  atomicWriteFileSync(path, renderIdentityWrapper(tool, realBinaryPath, model, identityResolver), { mode: 0o755 });
  return path;
}

/**
 * Git credential helper, so a push is attributed to the person who asked for it.
 *
 * `git` over HTTPS to a Codebase host authenticates with a Codebase JWT, which
 * is derived from the acting ByteCloud identity. It does not read any of the env
 * vars above, so without this a commit pushed on someone's behalf would carry
 * the machine's identity — and "who opened this MR" is exactly the attribution
 * this feature exists to fix.
 *
 * The script asks the WRAPPED `bytedcli` for the token, which means it inherits
 * the per-turn identity for free: no second credential path to keep in sync, and
 * nothing here needs to know whose turn it is.
 *
 * `GIT_ASKPASS` is called once for the username and once for the password, with
 * the prompt text as $1 — matching on "Username" is git's own contract.
 *
 * `exchangeUrl` is an optional second source for the token, used only when
 * bytedcli cannot produce one (not installed, broken, mid-upgrade). It is passed
 * in rather than hardcoded: the endpoint is deployment-specific, and this
 * repository deliberately keeps private hostnames out of source.
 *
 * Deliberately: the JWT is fetched fresh per invocation and never written to
 * disk, never placed in a URL, and never logged. A JWT embedded in a remote URL
 * would persist in `.git/config` and in any error message git prints.
 */
export function renderGitAskpassScript(bytedcliPath: string, exchangeUrl?: string): string {
  const fallback = exchangeUrl
    ? [
        // Second source: exchange the ByteCloud JWT the wrapper already exported
        // for a Codebase JWT over HTTP. Without it a bytedcli that is missing or
        // mid-upgrade turns every push into an unexplained auth failure.
        '  if [ -z "$__botmux_token" ] && [ -n "$BYTEDCLI_USER_CLOUD_JWT" ]; then',
        `    __botmux_token="$(curl -fsS --max-time 10 -X POST ${shellSingleQuote(exchangeUrl)} \\`,
        '      -H "Content-Type: application/json" -H "domain: tenant;v1" \\',
        '      -H "x-jwt-token: $BYTEDCLI_USER_CLOUD_JWT" \\',
        '      --data-binary "$(printf \'{"jwt_token":"%s"}\' "$BYTEDCLI_USER_CLOUD_JWT")" 2>/dev/null \\',
        '      | sed -n \'s/.*"code_base_token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\')"',
        '  fi',
      ]
    : [];
  return [
    '#!/bin/sh',
    '# botmux trigger-user git credential helper — generated, do not edit.',
    '# Answers git\'s username/password prompts with a Codebase JWT minted for the',
    '# CURRENT acting identity, so a push is attributed to the person who asked.',
    'case "$1" in',
    '  *Username*) printf %s x-access-token ;;',
    '  *)',
    // GIT_CONFIG_COUNT=0 / GIT_SSH_COMMAND=false while calling bytedcli: this
    // helper is itself reached FROM git, and bytedcli shells out to git for repo
    // context. Without the reset that inner git re-reads the very credential
    // config that invoked us and can recurse, or quietly take an SSH path that
    // authenticates as the machine instead of the person.
    //
    // -j keeps the output machine-readable. The response shape is
    // `{"status":…,"data":{"jwt":"…"}}` (verified against bytedcli 0.x), and the
    // token goes straight to git on stdout without touching disk.
    `  __botmux_token="$(GIT_CONFIG_COUNT=0 GIT_SSH_COMMAND=false ${shellSingleQuote(bytedcliPath)} \\`,
    '    -j auth get-codebase-jwt-token 2>/dev/null \\',
    '    | sed -n \'s/.*"jwt"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\')"',
    ...fallback,
    // Empty output makes git report an auth failure, which is the honest
    // outcome; a shell error here would look like a botmux bug instead.
    '  printf %s "$__botmux_token"',
    '  ;;',
    'esac',
    '',
  ].join('\n');
}

/** Filename of the git askpass helper inside a session's wrapper dir. */
export const GIT_ASKPASS_BASENAME = 'botmux-git-askpass';

/**
 * Install the git askpass helper next to the tool wrappers.
 *
 * Points at the WRAPPED bytedcli (inside `binDir`) rather than the real binary,
 * so the identity file is consulted on every git operation just as it is for a
 * direct `bytedcli` call.
 *
 * Returns the helper path, or null when bytedcli is not wrapped for this session
 * — without it there is no way to mint a JWT, and a helper that always failed
 * would turn "no credentials" into an opaque git error.
 */
export function installGitAskpass(
  binDir: string,
  wrappedBytedcliInstalled: boolean,
  exchangeUrl?: string,
): string | null {
  if (!wrappedBytedcliInstalled) return null;
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, GIT_ASKPASS_BASENAME);
  atomicWriteFileSync(
    path,
    renderGitAskpassScript(join(binDir, 'bytedcli'), exchangeUrl),
    { mode: 0o755 },
  );
  return path;
}

/**
 * Git config that forces an identity-bearing HTTPS path for `host`.
 *
 * Returned as `GIT_CONFIG_*` env entries rather than written to a config file:
 * they apply to this session's git only, leave the user's own `~/.gitconfig`
 * untouched, and vanish with the process.
 *
 * Two settings, for two different escapes:
 *  - `credential.https://<host>.helper` binds the helper to that host alone, so
 *    it never answers prompts for unrelated remotes.
 *  - `url.https://<host>/.insteadOf ssh://git@<host>/` rewrites SSH remotes to
 *    HTTPS. Without it a repo cloned over SSH keeps authenticating with the
 *    machine's key — the push lands under the host's identity and the whole
 *    attribution chain silently breaks.
 */
export function gitIdentityConfigEnv(
  askpassPath: string,
  host: string,
): Record<string, string> {
  const entries: Array<[string, string]> = [
    [`credential.https://${host}.helper`, `!f() { "${askpassPath}" "$@"; }; f`],
    [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`],
    [`url.https://${host}/.insteadOf`, `git@${host}:`],
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Locate the real tool binary, skipping any botmux wrapper.
 *
 * `which` would happily return our own wrapper once it is on PATH, producing a
 * script that execs itself forever. Scanning the caller-supplied PATH while
 * excluding the wrapper dir keeps that impossible by construction.
 */
export function findRealToolBinary(
  tool: IdentityTool,
  pathValue: string | undefined,
  excludeDirs: readonly string[] = [],
): string | null {
  const excluded = new Set(excludeDirs.filter(Boolean));
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir || excluded.has(dir) || isCliIdentityPath(dir)) continue;
    const candidate = join(dir, tool);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here, keep looking */ }
  }
  return null;
}

/** Install identity interception on the process that actually executes tools.
 * Used before both native CLI and RPC app-server startup. In the proven model
 * no token is copied into the process environment or disk: the wrapper fetches
 * the current turn's identity from the daemon over the proven loopback channel
 * on each call; the single model keeps one daemon-written, turn-checked file. */
export function prepareTriggerUserCliEnv(
  childEnv: NodeJS.ProcessEnv, sessionDataDir: string | undefined, sessionId: string,
  policy: TriggerUserAuthConfig | undefined, log: (message: string) => void,
  model: IdentityStorageModel,
  execution?: { appId: string; ipcPort?: number },
): void {
  if (!policy?.enabled || !policy.tools.length || !sessionDataDir) return;
  childEnv.SESSION_DATA_DIR = sessionDataDir;
  childEnv.BOTMUX_SESSION_ID = sessionId;
  const wrapperDir = sessionIdentityBinDir(sessionDataDir, sessionId);
  let identityResolver: string[] | undefined;
  if (model === 'proven' && process.platform === 'linux' && execution) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const sourceExecArgs = process.execArgv.map((arg, index, args) =>
      args[index - 1] === '--import' && arg === 'tsx' ? createRequire(import.meta.url).resolve('tsx') : arg);
    const runner = moduleDir.endsWith('/src/core')
      ? { command: process.execPath, args: [...sourceExecArgs, resolve(moduleDir, '../cli-identity-runner.ts')] }
      : resolveEntrySpawn('cli-identity-runner', resolve(moduleDir, '..'));
    identityResolver = [runner.command, ...runner.args,
      '--data-dir', sessionDataDir, '--session-id', sessionId, '--app-id', execution.appId,
      '--ipc-port', String(execution.ipcPort), '--tool'];
  }
  // Initialize the directory for THIS model before sandbox spawn so its bound
  // directory survives the existence-filter and leftovers from the other model
  // (or an older layout) are cleared rather than reused. Expand the governed
  // tool list to include the Codebase companion exactly as publication does.
  const identityTools = identityToolsFor(policy.tools);
  try {
    ensureSessionIdentityStorage(
      sessionDataDir,
      sessionId,
      identityTools,
      model,
    );
  } catch (e) {
    log(`[trigger-user-auth] WARN could not initialize identity storage: ${(e as Error).message}`);
  }
  let installedAny = false;
  for (const tool of identityTools) {
    try {
      const real = findRealToolBinary(tool, childEnv.PATH, [wrapperDir]);
      if (!real) {
        log(`[trigger-user-auth] ${tool} is not installed; no wrapper written`);
        continue;
      }
      installIdentityWrapper(wrapperDir, tool, real, model, identityResolver);
      installedAny = true;
      log(`[trigger-user-auth] wrapping ${tool} -> ${real}`);
    } catch (e) {
      // A missing wrapper means the tool keeps its previous behavior; it must
      // not stop the session from starting.
      log(`[trigger-user-auth] WARN could not wrap ${tool}: ${(e as Error).message}`);
    }
  }
  // Every governed tool failed to wrap, yet the policy is on. The session
  // then runs completely unprotected while the operator believes otherwise —
  // the failure mode observed in production, where the agent cheerfully
  // reported `identity: user` (the machine account) as "normal". Absence of a
  // wrapper is invisible by nature, so it has to be said out loud.
  if (!installedAny) {
    log('[trigger-user-auth] WARN no tool wrapper installed — this session is NOT running under '
      + 'trigger-user identity; calls will use whatever credentials the machine has');
  }
  if (installedAny) {
    childEnv.PATH = [wrapperDir, ...(childEnv.PATH ?? '').split(delimiter).filter(p => p !== wrapperDir)].join(delimiter);
    // A prepend alone loses to path_helper in the login shell the agent's
    // tool calls run through — see installLoginShellPathShim. These three
    // vars put the wrapper dir back in front after the system startup files
    // have run, without touching the user's dotfiles.
    try {
      const { zdotdir, bashEnv } = installLoginShellPathShim(wrapperDir);
      childEnv.BOTMUX_IDENTITY_BIN = wrapperDir;
      childEnv.ZDOTDIR = zdotdir;
      childEnv.BASH_ENV = bashEnv;
    } catch (e) {
      // Without the shim a login shell resolves the REAL tool, which is the
      // silent-bypass this feature exists to prevent. Say so loudly rather
      // than letting the session look protected while it is not.
      log(`[trigger-user-auth] WARN login-shell PATH shim not installed (${(e as Error).message}); `
        + `tool calls made through a login shell may bypass the identity wrapper`);
    }
  }
  // Git attribution: a push over HTTPS to Codebase authenticates with a
  // Codebase JWT, which git mints via GIT_ASKPASS and which reads none of the
  // env vars above. Without this, work pushed on someone's behalf carries the
  // machine's identity — and "who opened this MR" is exactly what this feature
  // exists to fix. The helper asks the WRAPPED bytedcli, so it inherits the
  // per-turn identity with no second credential path to keep in sync.
  if (policy.tools.includes('bytedcli')
      && identityWrapperInstalled(wrapperDir, 'bytedcli')) {
    try {
      const askpass = installGitAskpass(
        wrapperDir,
        true,
        policy.gitTokenExchangeUrl,
      );
      if (askpass) {
        childEnv.GIT_ASKPASS = askpass;
        // Bind the helper to the configured code host and rewrite SSH remotes
        // to HTTPS for it. Without the rewrite, a repo cloned over SSH keeps
        // authenticating with the machine's key and the attribution chain
        // breaks silently. Scoped via GIT_CONFIG_* env so the operator's own
        // ~/.gitconfig is never touched.
        if (policy.gitHost) {
          Object.assign(childEnv, gitIdentityConfigEnv(askpass, policy.gitHost));
          log(`[trigger-user-auth] git pushes to ${policy.gitHost} authenticate as the acting user`);
        } else {
          log('[trigger-user-auth] git askpass installed; set triggerUserAuth.gitHost to also force HTTPS for a code host');
        }
      }
    } catch (e) {
      log(`[trigger-user-auth] WARN could not install the git credential helper: ${(e as Error).message}`);
    }
  }
}
