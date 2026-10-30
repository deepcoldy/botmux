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
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { clearLarkToolDelegations } from './lark-tool-delegation.js';
import { GIT_CONFIG_PAIR_ENV_KEY, isCliIdentityPath } from '../utils/child-env.js';
import { resolveEntrySpawn } from './self-spawn.js';
import type { IdentityStorageModel } from './lark-tool-binding.js';
import type { TriggerUserAuthConfig, TriggerUserAuthTool } from '../services/trigger-user-auth.js';
import { isUsableOpenId } from '../utils/user-token.js';
import { logger } from '../utils/logger.js';
import { ensureSessionTempLayout, sessionTempDir, sessionTempDirWithoutAlias } from './session-temp.js';

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

function identityOpenIdLine(openId: string): string {
  return `${OPEN_ID_VAR}=${shellSingleQuote(openId)}`;
}

function stampedOpenId(body: string): string | undefined {
  const prefix = `${OPEN_ID_VAR}=`;
  for (const line of body.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const quoted = line.slice(prefix.length);
    if (quoted.length < 2 || !quoted.startsWith("'") || !quoted.endsWith("'")) return undefined;
    return quoted.slice(1, -1).replaceAll("'\\''", "'");
  }
  return undefined;
}

function identityMatchesOpenId(body: string, openId: string): boolean {
  return body.split('\n').includes(identityOpenIdLine(openId));
}

function dropMatchingEnvFiles(dir: string, openId: string): number {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let dropped = 0;
  const bytedcliRemoved = new Set<string>();
  for (const ent of entries) {
    // A symlink can point outside this session tree. Never follow one.
    if (ent.isSymbolicLink()) continue;
    const path = join(dir, ent.name);
    if (ent.isDirectory()) {
      dropped += dropMatchingEnvFiles(path, openId);
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith('.env')) continue;
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    if (!identityMatchesOpenId(text, openId)) continue;
    try {
      rmSync(path, { force: true });
      dropped += 1;
      if (ent.name === 'bytedcli.env') bytedcliRemoved.add(dir);
    } catch { /* best-effort */ }
  }
  for (const parent of bytedcliRemoved) {
    const companion = join(parent, `${CODEBASE_COMPANION_TOOL}.env`);
    try {
      const text = readFileSync(companion, 'utf8');
      const stamped = stampedOpenId(text);
      if (stamped !== undefined && stamped !== openId) continue;
      rmSync(companion, { force: true });
      dropped += 1;
    } catch { /* already removed, or it names someone else and we kept it */ }
  }
  return dropped;
}

/**
 * Drop published trigger-user identities stamped for `openId`.
 *
 * The same-principal wrapper keeps a credential when `BOTMUX_IDENTITY_OPEN_ID`
 * still matches the live caller, so deleting the token store is not enough
 * until the next publish overwrites the snapshot. Proven bodies live in this
 * process; single-snapshot `.env` files live under the session data dir.
 * Denial files have no open-id line and are left alone, except a codebase
 * companion whose bytedcli body was just removed and which does not name a
 * different person.
 */
export function dropPublishedIdentitiesForOpenId(sessionDataDir: string, openId: string): number {
  if (!isUsableOpenId(openId)) return 0;
  const wanted = new Set<string>();
  try { wanted.add(realpathSync(sessionDataDir)); } catch { /* dir may be missing */ }
  wanted.add(resolve(sessionDataDir));

  let dropped = 0;
  for (const key of [...provenIdentityContents.keys()]) {
    let parsed: unknown;
    try { parsed = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || !wanted.has(parsed[0])) continue;
    const turns = provenIdentityContents.get(key);
    if (!turns) continue;
    for (const turnId of [...turns.keys()]) {
      const tools = turns.get(turnId);
      if (!tools) continue;
      let removedBytedcli = false;
      for (const tool of Object.keys(tools) as IdentityTool[]) {
        const body = tools[tool];
        if (typeof body !== 'string' || !identityMatchesOpenId(body, openId)) continue;
        delete tools[tool];
        dropped += 1;
        if (tool === 'bytedcli') removedBytedcli = true;
      }
      if (removedBytedcli && typeof tools[CODEBASE_COMPANION_TOOL] === 'string') {
        const stamped = stampedOpenId(tools[CODEBASE_COMPANION_TOOL]);
        if (stamped === undefined || stamped === openId) {
          delete tools[CODEBASE_COMPANION_TOOL];
          dropped += 1;
        }
      }
      if (Object.keys(tools).length === 0) turns.delete(turnId);
    }
    if (turns.size === 0) provenIdentityContents.delete(key);
  }
  dropped += dropMatchingEnvFiles(sessionIdentityDir(sessionDataDir), openId);
  return dropped;
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
  /**
   * HOME the wrapper gives this one bytedcli exec. bytedcli keeps its state
   * under `$HOME/.local/share/bytedcli` even when it runs on injected JWTs
   * (measured on 0.76.0: `userinfo.json` with the acting person's profile,
   * per-person Codebase repo caches, command traces). Left on the machine HOME
   * those land in a directory every person's turns share. Filled in by
   * {@link writeSessionIdentity}; see {@link bytedcliTurnHome}.
   */
  home?: string;
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
    // Same variable the lark-cli device-code identity uses: the wrapper scopes
    // HOME to this exec only (see renderIdentityWrapper).
    if (identity.home) pairs.push([HOME_VAR, identity.home]);
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
 * Per-person bytedcli HOME for one session: `<session temp>/identity-home/
 * bytedcli/<hash>`. The session temp dir is already the CLI's writable scratch
 * and is removed when the session closes, so nothing outlives the session and
 * no long-lived login is exposed — the daemon-side `bytedcli-home/<open_id>`
 * holding the person's login stays where the sandbox cannot see it.
 *
 * Named by realpath: a sandbox binds the scratch by its canonical path and
 * does not recreate a symlinked home (`/home/u` -> `/data00/home/u`). A lexical
 * path there resolves into the sandbox's private tmpfs root, where `mkdir -p`
 * succeeds and every write silently vanishes with the namespace. Outside a
 * sandbox the canonical form names the same directory.
 *
 * What the per-person split is, and is not: it decides which directory one
 * exec writes into and lets the session's cleanup take it all away. It is NOT
 * a boundary between people within a session — the directories share the
 * session's uid and the CLI can read and write the whole scratch. Keep
 * long-lived or secret credentials out of it.
 *
 * Without an open_id (not expected for a granted identity) the session itself
 * keys the directory, so it stays one stable directory instead of one per turn.
 * Such a directory name no longer says whose it is; that is intended for a
 * fallback that cannot tell people apart anyway, not a bug to "fix" back.
 *
 * Both publication paths (writeSessionIdentity and refreshSessionIdentity,
 * which re-enters it) compute the path here, so they always agree.
 *
 * The path is spelled through the short alias when that layout is in place and
 * through the cache root when it is not; see {@link bytedcliHomeRoot}.
 *
 * This function is a pure path computation on purpose — it is exported and read
 * by callers that must not create directories (tests, the identity readers).
 * Installing the layout and choosing the fallback are the publisher's job.
 */
export function bytedcliTurnHome(
  sessionDataDir: string,
  sessionId: string,
  identity: Pick<BytedCliIdentity, 'openId'>,
): string {
  return bytedcliHomeFromBase(sessionTempDir(sessionDataDir, sessionId), sessionId, identity);
}

/**
 * The per-person HOME under a given session scratch `base`.
 *
 * The single place the layout `<base>/identity-home/bytedcli/<digest>` is
 * spelled. `base` is the only thing the two callers disagree about —
 * {@link bytedcliTurnHome} passes the plain scratch, {@link withBytedcliHome}
 * passes whatever {@link bytedcliHomeRoot} settled on — so keeping the join in
 * one function is what stops the published path from drifting away from the one
 * the tests pin. That drift would be a security regression, not a cosmetic one:
 * this is the boundary between the short alias and the cache root.
 */
function bytedcliHomeFromBase(
  base: string,
  sessionId: string,
  identity: Pick<BytedCliIdentity, 'openId'>,
): string {
  return canonicalPathNearest(join(base, 'identity-home', 'bytedcli', bytedcliHomeDigest(sessionId, identity)));
}

/** Directory name for one person (or the session fallback) within a scratch. */
function bytedcliHomeDigest(sessionId: string, identity: Pick<BytedCliIdentity, 'openId'>): string {
  const key = identity.openId ? `open_id:${identity.openId}` : `session:${sessionId}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * The session-scratch base a published bytedcli HOME is placed under, after
 * putting the short alias in place.
 *
 * Failing to install the layout does NOT fail the publication. The alias is a
 * path-length optimisation, not a prerequisite for the identity being applied;
 * refusing to publish someone's credential because a scratch alias could not be
 * installed would turn a cosmetic problem into "this person cannot run the CLI
 * at all".
 *
 * The fallback is the CACHE-ROOT spelling, never the lexical `<hub>/...` one. A
 * failed layout means an ancestor is a link this code did not create (a hub
 * symlinked at `/tmp/bm<uid>` pointing into a directory someone else controls);
 * the executor then runs `mkdir -p` on whatever is published, and `mkdir -p`
 * follows links. Publishing the lexical hub path would therefore create and fill
 * that foreign tree — measured: the wrapper exited 0 and left 7 entries in it.
 * Going through the cache root cannot lead there: it is under the user's HOME.
 */
function bytedcliHomeRoot(sessionDataDir: string, sessionId: string): string {
  try {
    ensureSessionTempLayout();
    return sessionTempDir(sessionDataDir, sessionId);
  } catch (error) {
    // Only reachable when the hub is not ours to fix (foreign owner, a symlink
    // planted at it); the session's exec reports it on its own terms.
    logger.warn(`[cli-identity] session temp layout unavailable, publishing the cache-root HOME: ${
      error instanceof Error ? error.message : String(error)}`);
    return sessionTempDirWithoutAlias(sessionDataDir, sessionId);
  }
}

/** Path only: the wrapper creates the directory at exec time, inside the
 *  session scratch the worker has already created and the sandbox binds.
 *
 *  This is the enrichment point that touches the filesystem: it installs the
 *  short-alias layout (or falls back to the cache-root spelling) and only then
 *  computes the path, so the published HOME is the short one and the executor is
 *  never the first writer of the layout. See {@link bytedcliHomeRoot}. */
function withBytedcliHome(sessionDataDir: string, sessionId: string, identity: CliIdentity): CliIdentity {
  if (identity.tool !== 'bytedcli' || 'mode' in identity || identity.home) return identity;
  const base = bytedcliHomeRoot(sessionDataDir, sessionId);
  return { ...identity, home: bytedcliHomeFromBase(base, sessionId, identity) };
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
  published: CliIdentity,
  model: IdentityStorageModel,
): string {
  const identity = withBytedcliHome(sessionDataDir, sessionId, published);
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

/** Second line of every wrapper {@link renderIdentityWrapper} writes. Also what
 *  marks a file in the bin dir as ours to remove. */
const IDENTITY_WRAPPER_MARKER = '# botmux trigger-user identity wrapper — generated, do not edit.';
/** Every identity tool, derived from the exhaustive map so a new tool cannot be
 *  left out of stale-wrapper cleanup. */
const ALL_IDENTITY_TOOLS = Object.keys(IDENTITY_ENV_KEYS) as IdentityTool[];

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
/**
 * `bytedcli auth login` writes its login store under the XDG data dir. Inside a
 * session sandbox the MACHINE HOME's data dir is read-only, so without a
 * writable target the tool dies with a bare "read-only file system"; say what
 * to do instead.
 *
 * The check runs AFTER identity resolution, not before, and probes the HOME the
 * exec is actually about to use: a trigger-user bytedcli identity carries a
 * per-person HOME under the writable session scratch (#2550,
 * BOTMUX_IDENTITY_HOME), so probing the machine HOME there both blocks a login
 * that would succeed AND names the wrong directory. No identity means the
 * wrapper refuses at the mode dispatch anyway (exit 77, points at /login), so
 * the guard never needs to run for that case. Other commands exec unchanged.
 */
const BYTEDCLI_LOGIN_GUARD_FN: readonly string[] = [
  // Returns 0 (blocked) only when argv is a login form AND the login store's
  // nearest existing ancestor under the target HOME is not writable.
  // $1 = HOME the upcoming exec will use; remaining args = bytedcli argv.
  '__botmux_bd_login_blocked() {',
  '  __botmux_bd_target=$1; shift',
  // Detect the login subcommand PAST GLOBAL FLAGS. Looking only at $1/$2 let
  // `bytedcli -j auth login` through (the repo itself emits leading -j — see
  // renderGitAskpassScript), and a value-taking global flag
  // (`--profile name auth login`) would hide it as well. Skip every option
  // token to find the leading operands, and fail closed on any bare
  // auth→login operand pair, so no supported flag layout bypasses the check.
  '  __botmux_bd_w1=; __botmux_bd_w2=; __botmux_bd_prev=; __botmux_bd_hit=',
  '  for __botmux_bd_a in "$@"; do',
  '    case "$__botmux_bd_a" in',
  '      -*) ;;',
  '      *)',
  '        [ "$__botmux_bd_prev" = auth ] && [ "$__botmux_bd_a" = login ] && __botmux_bd_hit=1',
  '        if [ -z "$__botmux_bd_w1" ]; then __botmux_bd_w1=$__botmux_bd_a; elif [ -z "$__botmux_bd_w2" ]; then __botmux_bd_w2=$__botmux_bd_a; fi',
  '        __botmux_bd_prev=$__botmux_bd_a',
  '        ;;',
  '    esac',
  '  done',
  '  [ -n "$__botmux_bd_hit" ] || [ "$__botmux_bd_w1" = login ] || { [ "$__botmux_bd_w1" = auth ] && [ "$__botmux_bd_w2" = login ]; } || return 1',
  '  __botmux_bd_dir="${XDG_DATA_HOME:-$__botmux_bd_target/.local/share}/bytedcli"',
  // Nearest existing ancestor decides: login creates the store on first use.
  '  __botmux_bd_probe=$__botmux_bd_dir',
  '  while [ ! -e "$__botmux_bd_probe" ] && [ "$__botmux_bd_probe" != / ]; do __botmux_bd_probe=$(dirname "$__botmux_bd_probe"); done',
  '  if [ -w "$__botmux_bd_probe" ]; then return 1; fi',
  `    printf '%s\n' "botmux: bytedcli 登录需要写入 $__botmux_bd_dir，但这里不可写（会话沙盒内该目录只读）。沙盒内不能本地登录：请在会话里发送 /login 用授权链接完成授权，或在宿主终端执行 bytedcli auth login。" >&2`,
  '  return 0',
  '}',
];

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
    IDENTITY_WRAPPER_MARKER,
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
    // Same for the per-exec HOME: an inherited value must not redirect an
    // identity that does not carry one.
    `${HOME_VAR}=`,
    '__botmux_live=',
    '__botmux_live_caller=',
    // Function only; it runs AFTER identity resolution at each exec site, with
    // the HOME that exec will use (per-person scratch HOME or machine HOME).
    ...(tool === 'bytedcli' ? BYTEDCLI_LOGIN_GUARD_FN : []),
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
    // user|bot only past this point. HOME_VAR set (#2550 per-person scratch
    // HOME on a bytedcli user identity) is the exec's HOME; unset → machine
    // HOME. Probe whichever one a login would actually write into.
    ...(tool === 'bytedcli' ? [
      `if __botmux_bd_login_blocked "\${${HOME_VAR}:-$HOME}" "$@"; then exit 1; fi`,
    ] : []),
    // A person-scoped HOME published with a user identity (bytedcli): scoped to
    // this exec exactly like the user-home branch, so the parent shell and
    // every other tool keep the machine HOME. Created here, on first use: the
    // daemon publishes only the path. An unset value means the identity
    // carries no HOME and the machine HOME is kept.
    `if [ -n "$${HOME_VAR}" ]; then`,
    `  __botmux_home=$${HOME_VAR}`,
    // `mkdir -p -m 700` modes the LAST level only; every intermediate level is
    // created with plain `mkdir(2)` and so takes the process umask. The path
    // crosses `/tmp/bm<uid>` (the uid-wide short-alias hub, 0700 by design) and
    // the session scratch, so at the default umask 022 the hub would land 0755
    // and every later session on this host would fail its private-owner check
    // until someone fixed the mode by hand. Creating under its own umask 077
    // makes every level this creates private, and leaves existing ones alone.
    '  (umask 077; mkdir -p -m 700 "$__botmux_home") 2>/dev/null || true',
    '  if [ ! -d "$__botmux_home" ]; then',
    `    printf '%s\\n' 'botmux: ${tool} 的按人目录无法创建，命令未执行。' >&2`,
    `    exit ${IDENTITY_DENIED_EXIT_CODE}`,
    '  fi',
    `  unset ${MODE_VAR} ${DENY_MSG_VAR} ${TURN_VAR} ${OPEN_ID_VAR} ${HOME_VAR}`,
    `  HOME="$__botmux_home" exec ${shellSingleQuote(realBinaryPath)} "$@"`,
    'fi',
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
 * Remove this session's identity wrappers for every tool `policy` does not
 * govern, and report which were removed.
 *
 * The wrapper directory outlives the policy that created it: it is also the
 * lark-cli binding's bin dir, which every bound session puts first on PATH
 * whether or not trigger-user auth is on. A wrapper left there after the
 * operator turns the policy off (or drops a tool from it) keeps intercepting
 * the tool while the daemon, correctly, publishes nothing for it — so every
 * call is refused, human turns and scheduled ones alike, until the session is
 * closed. Off has to mean the tool runs exactly as it did before the policy.
 *
 * Called only when a worker spawns, like the install it undoes: a live
 * worker's wrappers follow the policy it was spawned with (next-session
 * semantics). Removing them mid-life would leave nothing to re-arm them if the
 * policy were turned back on before a respawn — the tool would then run with
 * the machine's own login while every turn still publishes an identity.
 *
 * Only files this module generated are touched (checked by content, not name):
 * the lark-cli binding's own entry and anything else in the directory stay.
 */
export function removeUngovernedIdentityWrappers(
  sessionDataDir: string,
  sessionId: string,
  policy: Pick<TriggerUserAuthConfig, 'enabled' | 'tools'> | null | undefined,
): IdentityTool[] {
  const governed = new Set(policy?.enabled ? identityToolsFor(policy.tools) : []);
  const binDir = sessionIdentityBinDir(sessionDataDir, sessionId);
  const removed: IdentityTool[] = [];
  for (const tool of ALL_IDENTITY_TOOLS) {
    if (governed.has(tool)) continue;
    const path = join(binDir, tool);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 64 * 1024) continue;
      if (readFileSync(path, 'utf8').split('\n', 2)[1] !== IDENTITY_WRAPPER_MARKER) continue;
      rmSync(path, { force: true });
      removed.push(tool);
    } catch { /* absent or unreadable: nothing of ours is in the way */ }
  }
  return removed;
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
 * The git `-c` content pairs that force an identity-bearing HTTPS path for
 * `host`: a host-scoped credential helper plus two URL rewrites.
 *
 * This array is the AUTHORITATIVE carrier of the turn's git identity: callers
 * that forward env into a shell-wrapped pane must pass exactly these pairs
 * (see SpawnOpts.gitConfigPairs) rather than scan the environment for numbered
 * `GIT_CONFIG_*` entries, which an ambient layer can push past the authored
 * set.
 *
 * Two settings, for two different escapes:
 *  - `credential.https://<host>.helper` binds the helper to that host alone, so
 *    it never answers prompts for unrelated remotes.
 *  - `url.https://<host>/.insteadOf ssh://git@<host>/` rewrites SSH remotes to
 *    HTTPS. Without it a repo cloned over SSH keeps authenticating with the
 *    machine's key — the push lands under the host's identity and the whole
 *    attribution chain silently breaks.
 */
export function gitIdentityConfigPairs(
  askpassPath: string,
  host: string,
): Array<[string, string]> {
  return [
    [`credential.https://${host}.helper`, `!f() { "${askpassPath}" "$@"; }; f`],
    [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`],
    [`url.https://${host}/.insteadOf`, `git@${host}:`],
  ];
}

/**
 * Encode {@link gitIdentityConfigPairs} as `GIT_CONFIG_*` env entries rather
 * than writing a config file: they apply to this session's git only, leave the
 * user's own `~/.gitconfig` untouched, and vanish with the process. Used by the
 * direct-exec backends (PTY, env -i strict panes), which receive the child
 * environment wholesale; the shell-wrapped backends instead rebuild the entries
 * from the pair carrier.
 */
export function gitIdentityConfigEnv(
  askpassPath: string,
  host: string,
): Record<string, string> {
  return encodeGitConfigPairs(gitIdentityConfigPairs(askpassPath, host));
}

/**
 * Encode turn-authored git `-c` pairs as the `GIT_CONFIG_*` env block
 * (`GIT_CONFIG_COUNT` + contiguous 0..n-1 KEY/VALUE entries). The inverse of
 * the pane-side rebuild in buildBotmuxEnvAssignments: direct-exec backends
 * (PTY, env -i strict panes) consume the child environment wholesale, so the
 * worker places exactly this encoded block there after wiping any ambient
 * numbered git config entries.
 */
export function encodeGitConfigPairs(
  pairs: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Reset the whole git command-line config channel in a child environment to
 * exactly the turn-authored `pairs`: every inherited
 * GIT_CONFIG_COUNT/GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> is deleted first
 * (nested CLIs and hooks share GIT_CONFIG_COUNT as an accumulator, so a
 * spawned child can carry a pushed-up count and arbitrary high-index pairs),
 * then the contiguous 0..n-1 block is published. With no authored pairs the
 * channel is left empty rather than carrying an ambient count.
 *
 * This is the direct-exec counterpart of the shell pane carrier rebuild:
 * PTY children and env -i strict panes inherit the environment wholesale, so
 * the reset has to happen here, in the worker-built env.
 */
export function applyTurnGitConfigEnv(
  env: NodeJS.ProcessEnv,
  pairs: ReadonlyArray<readonly [string, string]>,
): void {
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_COUNT' || GIT_CONFIG_PAIR_ENV_KEY.test(key)) delete env[key];
  }
  if (pairs.length) Object.assign(env, encodeGitConfigPairs(pairs));
}

/**
 * The single wiring seam every CLI/engine spawn site must call to install the
 * trigger-user identity: it prepares the wrapper env (PATH shim, askpass,
 * wrappers) AND resets the git command-line config channel to the authored
 * pair set in one step, returning that set so pane-style backends also carry
 * it via SpawnOpts.gitConfigPairs.
 *
 * Keeping prepare + reset in ONE function is load-bearing: calling only
 * prepareTriggerUserCliEnv leaves an inherited/pushed-up GIT_CONFIG_COUNT and
 * ambient high-index pairs in the env (the field failure — git aborts or a
 * foreign pair silently applies), which is what happened on the RPC
 * app-server engineEnv path before it used this seam. Native-pane spawns,
 * PTY, env -i strict panes and RPC app-servers all go through here.
 */
export function prepareTurnGitConfigEnv(
  env: NodeJS.ProcessEnv,
  sessionDataDir: string | undefined,
  sessionId: string,
  policy: TriggerUserAuthConfig | undefined,
  log: (message: string) => void,
  model: IdentityStorageModel,
  execution?: { appId: string; ipcPort?: number },
  options?: { canonicalPaths?: boolean },
): Array<[string, string]> {
  const pairs = prepareTriggerUserCliEnv(env, sessionDataDir, sessionId, policy, log, model, execution, options);
  applyTurnGitConfigEnv(env, pairs);
  return pairs;
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

/**
 * `realpath` that tolerates a not-yet-created tail: resolve the deepest existing
 * ancestor and re-append the rest. Used to name a path the way a fresh bwrap
 * root will see it. A relative path is returned as is: resolving it would
 * silently anchor it to this process's cwd.
 */
export function canonicalPathNearest(path: string): string {
  if (!path.startsWith('/')) return path;
  try { return realpathSync(path); } catch { /* fall through to the parent */ }
  const parent = dirname(path);
  return parent === path ? path : join(canonicalPathNearest(parent), basename(path));
}

/**
 * How a host path has to be written into a session's env or into a script the
 * session runs. A sandboxed session (`canonicalPaths`) lives in a fresh bwrap
 * root that only mounts canonical paths, so a symlinked home / data root
 * (`/home/u` -> `/data00/home/u`) has no alias there: absolute paths are named
 * by realpath. Everything else — unsandboxed sessions, relative paths, flags in
 * a runner argv — is returned unchanged.
 */
export function sessionVisiblePath(path: string, canonicalPaths: boolean | undefined): string {
  return canonicalPaths ? canonicalPathNearest(path) : path;
}

/** Install identity interception on the process that actually executes tools.
 * Used before both native CLI and RPC app-server startup. In the proven model
 * no token is copied into the process environment or disk: the wrapper fetches
 * the current turn's identity from the daemon over the proven loopback channel
 * on each call; the single model keeps one daemon-written, turn-checked file.
 *
 * Returns the git `-c` content pairs authored for THIS turn (empty when git
 * attribution is not installed). Shell-wrapped backends must forward exactly
 * that list via SpawnOpts.gitConfigPairs instead of reading GIT_CONFIG_* out
 * of the environment. */
export function prepareTriggerUserCliEnv(
  childEnv: NodeJS.ProcessEnv, sessionDataDir: string | undefined, sessionId: string,
  policy: TriggerUserAuthConfig | undefined, log: (message: string) => void,
  model: IdentityStorageModel,
  execution?: { appId: string; ipcPort?: number },
  /** `canonicalPaths`: the session runs in a fresh bwrap root that only mounts
   *  CANONICAL paths. A symlinked home / data root (`/home/u` -> `/data00/home/u`)
   *  has no alias there, so every path written into the session env or into a
   *  generated script must be the realpath or it is `not found` inside. Left
   *  off, nothing changes for unsandboxed sessions. */
  options?: { canonicalPaths?: boolean },
): Array<[string, string]> {
  // Before anything else, including the early return below: a policy that is
  // off now may have been on when this session last spawned.
  if (sessionDataDir) {
    try {
      const removed = removeUngovernedIdentityWrappers(sessionDataDir, sessionId, policy);
      if (removed.length) log(`[trigger-user-auth] removed wrappers no longer governed: ${removed.join(', ')}`);
    } catch (e) {
      log(`[trigger-user-auth] WARN could not remove ungoverned wrappers: ${(e as Error).message}`);
    }
  }
  if (!policy?.enabled || !policy.tools.length || !sessionDataDir) return [];
  const canonicalPaths = options?.canonicalPaths === true;
  sessionDataDir = sessionVisiblePath(sessionDataDir, canonicalPaths);
  childEnv.SESSION_DATA_DIR = sessionDataDir;
  childEnv.BOTMUX_SESSION_ID = sessionId;
  const wrapperDir = sessionIdentityBinDir(sessionDataDir, sessionId);
  // Turn-authored git -c pairs; returned to the caller for the pane carrier.
  let gitConfigPairs: Array<[string, string]> = [];
  let identityResolver: string[] | undefined;
  if (model === 'proven' && process.platform === 'linux' && execution) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const sourceExecArgs = process.execArgv.map((arg, index, args) =>
      args[index - 1] === '--import' && arg === 'tsx' ? createRequire(import.meta.url).resolve('tsx') : arg);
    const runner = moduleDir.endsWith('/src/core')
      ? { command: process.execPath, args: [...sourceExecArgs, resolve(moduleDir, '../cli-identity-runner.ts')] }
      : resolveEntrySpawn('cli-identity-runner', resolve(moduleDir, '..'));
    identityResolver = [...[runner.command, ...runner.args].map(p => sessionVisiblePath(p, canonicalPaths)),
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
      const realInSession = sessionVisiblePath(real, canonicalPaths);
      installIdentityWrapper(wrapperDir, tool, realInSession, model, identityResolver);
      installedAny = true;
      log(`[trigger-user-auth] wrapping ${tool} -> ${realInSession}`);
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
          gitConfigPairs = gitIdentityConfigPairs(askpass, policy.gitHost);
          // Direct-exec backends (PTY, env -i strict panes) receive childEnv
          // wholesale, so also publish the encoded entries there. The
          // shell-wrapped backends rebuild them from the returned carrier.
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
  return gitConfigPairs;
}
