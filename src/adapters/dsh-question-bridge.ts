import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { hookCommandParts } from './hook-command.js';

const BRIDGE_VERSION = 1;
const BRIDGE_ROOT_DIR = '.botmux/dsh-question-bridge';
const DEFAULT_DSH_TUI_PROFILE = 'dsh-tui';

type DshBridgeCliId = 'dsh' | 'dsh-tui';

export interface DshQuestionBridgePatch {
  readonly patchPath: string;
  readonly readonlyRoot: string;
  readonly pluginPath: string;
}

interface HookCommandParts {
  readonly cmd: string;
  readonly args: readonly string[];
}

export interface EnsureDshQuestionBridgePatchOptions {
  readonly cliId: DshBridgeCliId;
  /** Test/packaging override. Defaults to os.homedir(). */
  readonly homeDir?: string;
  /** Profile directory used only for dsh-tui wrapper original-module resolution. */
  readonly dshTuiProfileDir?: string;
  /** Test override; production uses hookCommandParts(cliId). */
  readonly hookCommand?: HookCommandParts;
  /** Extra salt so different checkout/build identities cannot overwrite each other. */
  readonly buildSalt?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function jsonLiteral(value: unknown): string {
  return (JSON.stringify(value) ?? 'undefined').replace(/<\//g, '<\\/');
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function dshConfigHome(homeDir: string): string {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? canonicalPath(resolve(configured)) : join(homeDir, '.dsh');
}

function defaultDshTuiProfileDir(homeDir: string): string {
  return join(dshConfigHome(homeDir), 'profiles', DEFAULT_DSH_TUI_PROFILE);
}

function findPackageRootFromEntry(entry: string): string | null {
  let dir = dirname(entry);
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolvePackageExportEntry(pkgRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    const exportsField = pkg.exports;
    if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
      const dot = (exportsField as Record<string, unknown>)['.'];
      if (dot && typeof dot === 'object' && !Array.isArray(dot)) {
        const imp = (dot as Record<string, unknown>).import ?? (dot as Record<string, unknown>).default;
        if (typeof imp === 'string' && imp) return imp;
      }
      if (typeof dot === 'string' && dot) return dot;
    }
    if (typeof pkg.module === 'string' && pkg.module) return pkg.module;
    if (typeof pkg.main === 'string' && pkg.main) return pkg.main;
  } catch { /* fall back below */ }
  return 'lib/types/index.js';
}

export function resolveOriginalDshTuiEntryUrl(
  profileDir: string = defaultDshTuiProfileDir(homedir()),
): string | null {
  try {
    const directPkgPath = join(profileDir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json');
    if (existsSync(directPkgPath)) {
      const entry = resolve(dirname(directPkgPath), resolvePackageExportEntry(dirname(directPkgPath)));
      return existsSync(entry) ? pathToFileURL(canonicalPath(entry)).href : null;
    }
    const requireFromProfile = createRequire(join(profileDir, 'package.json'));
    const publicEntry = requireFromProfile.resolve('@deepseek-harness-tui/dsh-tui');
    const pkgRoot = findPackageRootFromEntry(publicEntry);
    if (!pkgRoot) return existsSync(publicEntry) ? pathToFileURL(canonicalPath(publicEntry)).href : null;
    const entry = resolve(pkgRoot, resolvePackageExportEntry(pkgRoot));
    if (!existsSync(entry)) return null;
    return pathToFileURL(canonicalPath(entry)).href;
  } catch {
    return null;
  }
}

function buildRuntimeBridgeSnippet(parts: HookCommandParts, runtime: DshBridgeCliId): string {
  return `
const CMD = ${jsonLiteral(parts.cmd)};
const ARGS = ${jsonLiteral([...parts.args])};
const RUNTIME = ${jsonLiteral(runtime === 'dsh-tui' ? 'tui' : 'official')};
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_LABEL_LENGTH = 200;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBotmuxSessionEnv(env) {
  return !!(env.BOTMUX_SESSION_ID && env.BOTMUX_CHAT_ID && env.BOTMUX_LARK_APP_ID);
}

function bridgeError(code, message) {
  const err = new Error(message);
  err.name = 'UserQuestionError';
  err.code = code;
  return err;
}

function timeoutMs() {
  const raw = process.env.BOTMUX_DSH_ASK_TIMEOUT_MS || process.env.BOTMUX_ASK_TIMEOUT_MS || '3600000';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3600000;
}

function runHook(payload, signal) {
  return new Promise((resolve) => {
    let input;
    try { input = JSON.stringify(payload); }
    catch (error) {
      resolve({ ok: false, reason: 'payload-serialize-error', detail: String(error && error.message || error) });
      return;
    }
    let settled = false;
    let out = '';
    let child;
    let timer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { signal && signal.removeEventListener && signal.removeEventListener('abort', onAbort); } catch {}
      resolve(result);
    };
    const onAbort = () => {
      try { child && child.kill(); } catch {}
      done({ ok: false, reason: 'aborted', detail: 'ask_user_question was aborted' });
    };
    try {
      child = spawn(CMD, ARGS, {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, BOTMUX_ASK_TIMEOUT_MS: String(timeoutMs()) },
      });
    } catch (error) {
      done({ ok: false, reason: 'spawn-error', detail: String(error && error.message || error) });
      return;
    }
    if (signal && signal.aborted) return onAbort();
    try { signal && signal.addEventListener && signal.addEventListener('abort', onAbort, { once: true }); } catch {}
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, reason: 'timeout', detail: 'botmux hook timed out' });
    }, timeoutMs() + 100);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
      if (Buffer.byteLength(out, 'utf8') > MAX_STDOUT_BYTES) {
        try { child.kill(); } catch {}
        done({ ok: false, reason: 'stdout-overflow', detail: 'botmux hook stdout exceeded 1MiB' });
      }
    });
    child.on('error', (error) => done({ ok: false, reason: 'child-error', detail: String(error && error.message || error) }));
    child.on('close', (code) => {
      if (code !== 0) done({ ok: false, reason: 'nonzero-exit', detail: 'botmux hook exited ' + code });
      else if (!out.trim()) done({ ok: false, reason: 'passthrough', detail: 'botmux hook returned empty stdout' });
      else done({ ok: true, text: out.trim() });
    });
    try { child.stdin.end(input); }
    catch (error) {
      try { child.kill(); } catch {}
      done({ ok: false, reason: 'stdin-error', detail: String(error && error.message || error) });
    }
  });
}

function handleBridgeFailure(result, next) {
  if (RUNTIME === 'tui') return next();
  if (result.reason === 'aborted') {
    throw bridgeError('ASK_ABORTED', result.detail || 'ask_user_question was aborted');
  }
  throw bridgeError('BOTMUX_ASK_BRIDGE_UNAVAILABLE', 'botmux question bridge failed: ' + result.reason + (result.detail ? ' (' + result.detail + ')' : ''));
}

function isValidLabel(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_LABEL_LENGTH
    && !value.includes(String.fromCharCode(10))
    && !value.includes(String.fromCharCode(13));
}

function classifyRequest(request) {
  if (!isRecord(request) || !Array.isArray(request.questions) || request.questions.length === 0) {
    return { ok: false, reason: 'missing questions' };
  }
  for (let i = 0; i < request.questions.length; i++) {
    const q = request.questions[i];
    if (!isRecord(q)) return { ok: false, reason: 'question ' + (i + 1) + ' is malformed' };
    if (typeof q.id !== 'string' || !q.id.trim()) return { ok: false, reason: 'question ' + (i + 1) + ' has invalid id' };
    if (typeof q.question !== 'string' || !q.question.trim()) return { ok: false, reason: 'question ' + (i + 1) + ' has invalid text' };
    if (isRecord(q.intent) && q.intent.kind === 'plan-review') return { ok: false, reason: 'plan-review is not supported by botmux bridge' };
    if (!Array.isArray(q.options) || q.options.length < 2) return { ok: false, reason: 'question ' + (i + 1) + ' has fewer than two options' };
    const labels = new Set();
    for (const opt of q.options) {
      if (!isRecord(opt) || !isValidLabel(opt.label)) return { ok: false, reason: 'question ' + (i + 1) + ' has invalid option label' };
      if (labels.has(opt.label)) return { ok: false, reason: 'question ' + (i + 1) + ' has duplicate option label' };
      labels.add(opt.label);
    }
  }
  return { ok: true };
}

function sanitizedQuestions(request) {
  return request.questions.map((q) => ({
    id: q.id,
    question: q.question,
    ...(typeof q.header === 'string' ? { header: q.header } : {}),
    ...(typeof q.detail === 'string' ? { detail: q.detail } : {}),
    options: q.options.map((opt) => ({
      label: opt.label,
      ...(typeof opt.description === 'string' ? { description: opt.description } : {}),
    })),
    ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {}),
    ...(typeof q.multi_select === 'boolean' ? { multi_select: q.multi_select } : {}),
  }));
}

function validateAnswer(value, request) {
  if (!isRecord(value) || !Array.isArray(value.answers)) throw new Error('answer must contain answers[]');
  if (value.answers.length !== request.questions.length) throw new Error('answer count does not match question count');
  const answers = [];
  for (let i = 0; i < request.questions.length; i++) {
    const q = request.questions[i];
    const answer = value.answers[i];
    if (!isRecord(answer)) throw new Error('answer ' + (i + 1) + ' is malformed');
    if (answer.id !== q.id) throw new Error('answer ' + (i + 1) + ' id mismatch');
    if (!Array.isArray(answer.selected) || !answer.selected.every((item) => typeof item === 'string')) {
      throw new Error('answer ' + (i + 1) + ' selected must be string[]');
    }
    const allowed = new Set(q.options.map((opt) => opt.label));
    for (const selected of answer.selected) {
      if (!allowed.has(selected)) throw new Error('answer ' + (i + 1) + ' selected unknown option');
    }
    if (answer.custom !== undefined && typeof answer.custom !== 'string') throw new Error('answer ' + (i + 1) + ' custom must be string');
    answers.push({ id: answer.id, selected: [...answer.selected], ...(answer.custom !== undefined ? { custom: answer.custom } : {}) });
  }
  return { answers };
}

async function bridgeAsk(request, next) {
  const classified = classifyRequest(request);
  if (!classified.ok) return handleBridgeFailure({ reason: 'unsupported', detail: classified.reason }, next);
  const safeRequest = { questions: sanitizedQuestions(request) };
  const result = await runHook({ hook_event_name: 'user-questions/request', tool_input: safeRequest }, request && request.signal);
  if (!result.ok) return handleBridgeFailure(result, next);
  try { return validateAnswer(JSON.parse(result.text), request); }
  catch (error) { return handleBridgeFailure({ reason: 'malformed-answer', detail: String(error && error.message || error) }, next); }
}

function installWaterfallBridge(ctx) {
  if (typeof ctx.on !== 'function') return undefined;
  return ctx.on('user-questions/request', (request, next) => bridgeAsk(request, next), { prepend: true });
}

function installLegacyOfficialProvider(ctx, service) {
  if (service.provider !== undefined) return undefined;
  try {
    const dispose = service.registerProvider({ ask: request => bridgeAsk(request, () => Promise.reject(bridgeError('BOTMUX_ASK_BRIDGE_UNAVAILABLE', 'botmux question bridge declined request'))) });
    try { ctx.effect(() => dispose, 'botmux-dsh-question-bridge.legacy-provider'); } catch {}
    return dispose;
  } catch (error) {
    if (error && error.code === 'DUPLICATE_PROVIDER') return undefined;
    throw error;
  }
}
`;
}

function buildOrdinaryBridgePlugin(parts: HookCommandParts): string {
  return `// botmux generated DSH question bridge v${BRIDGE_VERSION}
import { spawn } from 'node:child_process';
${buildRuntimeBridgeSnippet(parts, 'dsh')}
export const name = 'botmux-dsh-question-bridge';
export function apply(ctx) {
  if (!isBotmuxSessionEnv(process.env) || process.env.BOTMUX_DSH_ASK_BRIDGE === '0') return;
  const service = ctx.get && ctx.get('userQuestions');
  if (service && typeof service.registerProvider === 'function') {
    installLegacyOfficialProvider(ctx, service);
    return;
  }
  installWaterfallBridge(ctx);
}
`;
}

/**
 * Structured readiness / turn-idle reporting for the dsh-tui wrapper plugin.
 *
 * WHY this exists: dsh-tui repaints a blinking cursor cell several times a
 * second even while completely idle. The worker's IdleDetector Strategy 2
 * requires `QUIESCENCE_MS` of PTY silence and re-arms on every feed, so a
 * dsh-tui session NEVER satisfies it → `markPromptReady()` is never called →
 * the first queued prompt is only written by the 90s hard timeout, and every
 * later turn end has no idle edge either.
 *
 * READINESS. The TUI hands us a precise in-process signal. Its
 * `openInjectChannel()` runs immediately after `await render(tree)` (first
 * frame flushed, composer mounted) and publishes
 * `~/.dsh-tui/inject/servers.json` with `{pid, sessionId, cwd, socketPath,
 * startedAt}` — the same record `dsh.nvim` discovers. Matching our own
 * `process.pid` there is the earliest trustworthy "UI is ready" evidence, so
 * the plugin fires `BOTMUX_READY_COMMAND` exactly once, and keeps the matched
 * session id as this process's own identity for the turn-idle channel below.
 *
 * TURN IDLE. `agent/status` is deliberately NOT the readiness trigger:
 * dsh-agent-loop only emits on a status CHANGE and the loop starts out idle,
 * so a fresh boot emits nothing at all. At the END of a turn the same property
 * makes it the perfect edge — one event per finished turn, never a synthetic
 * one at boot — so `status === 'idle'` fires `BOTMUX_TURN_IDLE_COMMAND`, which
 * the worker turns into `idleDetector.fireIdle()`.
 *
 * Everything here is fail-quiet: a missing env var, an unreadable discovery
 * file, or a failed spawn must never break the TUI boot. The worker keeps its
 * own fallback timeout, so a lost readiness signal degrades to the previous
 * behaviour (and strictly improves on it: READY_SIGNAL_TIMEOUT_MS is 45s < the
 * 90s hard cap); a lost turn-idle just leaves that turn to the existing paths.
 *
 * The inject path is resolved at RUNTIME through `homedir()` — the same way
 * dsh-tui itself computes `~/.dsh-tui` (utils/paths.js: `join(homedir(),
 * '.dsh-tui')`) — so it follows the session's HOME inside a sandbox instead of
 * pinning the worker's home.
 */
function buildDshTuiStatusSnippet(): string {
  return `
const BOTMUX_READY_POLL_MS = 250;
const BOTMUX_STATUS_SIGNAL_TIMEOUT_MS = 15_000;
// Bounded: the worker's own ready-gate fallback is 45s, so polling much past
// that only keeps a timer alive for a signal nobody is waiting for anymore.
const BOTMUX_READY_POLL_LIMIT_MS = 120_000;

let botmuxReadySignalled = false;
let botmuxReadyPollTimer;
let botmuxInjectSessionId;
let botmuxIdleSeq = 0;

function botmuxStatusCommand(envKey) {
  const raw = process.env[envKey];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

/** The TUI process's own inject-channel record, or undefined while it has not
 *  published one yet (i.e. before its first frame). */
function readBotmuxInjectRecord() {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), '.dsh-tui', 'inject', 'servers.json'), 'utf8'));
    if (!Array.isArray(parsed)) return undefined;
    return parsed.find((entry) => entry && entry.pid === process.pid && typeof entry.sessionId === 'string');
  } catch {
    // Absent/corrupt discovery file, or the TUI has not rendered yet.
    return undefined;
  }
}

/** Fire-and-forget "botmux <status>" subcommand. Never awaited, never blocks
 *  the TUI, never surfaces an error into the render loop. */
function spawnBotmuxStatusCommand(command, payload) {
  let child;
  try {
    child = spawn(command, { shell: true, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {
    return;
  }
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, BOTMUX_STATUS_SIGNAL_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  child.on('error', () => clearTimeout(timer));
  child.on('exit', () => clearTimeout(timer));
  try { child.stdin.end(JSON.stringify(payload)); }
  catch { try { child.kill(); } catch {} }
  try { child.unref(); } catch {}
}

function stopBotmuxReadyPoll() {
  if (!botmuxReadyPollTimer) return;
  clearInterval(botmuxReadyPollTimer);
  botmuxReadyPollTimer = undefined;
}

/** Exactly one exec per process: the ready edge is a one-shot startup event and
 *  a second "session_ready" would only re-open an already-released gate. */
function publishBotmuxReady() {
  if (botmuxReadySignalled) return;
  botmuxReadySignalled = true;
  stopBotmuxReadyPoll();
  const command = botmuxStatusCommand('BOTMUX_READY_COMMAND');
  if (command) spawnBotmuxStatusCommand(command, {});
}

function pollBotmuxReady(startedAt) {
  if (botmuxReadySignalled) return;
  const record = readBotmuxInjectRecord();
  if (record) {
    botmuxInjectSessionId = record.sessionId;
    publishBotmuxReady();
    return;
  }
  if (Date.now() - startedAt >= BOTMUX_READY_POLL_LIMIT_MS) stopBotmuxReadyPoll();
}

/** Structured end-of-turn idle edge for BOTMUX_TURN_IDLE_COMMAND. */
function reportBotmuxTurnIdle() {
  const command = botmuxStatusCommand('BOTMUX_TURN_IDLE_COMMAND');
  // No inject binding means this process never published its discovery record,
  // so we cannot prove which session it owns. Stay silent: a mis-attributed
  // idle would settle a turn that is still running (never early).
  if (!command || !botmuxInjectSessionId) return;
  botmuxIdleSeq += 1;
  spawnBotmuxStatusCommand(command, { seq: botmuxIdleSeq, pid: process.pid });
}

function installBotmuxStatusChannel(ctx) {
  const startedAt = Date.now();
  pollBotmuxReady(startedAt);
  if (!botmuxReadySignalled) {
    botmuxReadyPollTimer = setInterval(() => pollBotmuxReady(startedAt), BOTMUX_READY_POLL_MS);
    if (typeof botmuxReadyPollTimer.unref === 'function') botmuxReadyPollTimer.unref();
    if (typeof ctx.effect === 'function') {
      try { ctx.effect(() => stopBotmuxReadyPoll, 'botmux-dsh-tui-status-channel'); } catch {}
    }
  }
  if (typeof ctx.on !== 'function') return;
  let previousStatus;
  try {
    ctx.on('agent/status', ({ agent, status } = {}) => {
      const wasIdle = previousStatus === 'idle';
      previousStatus = status;
      // dsh-agent-loop emits only when the status actually changed, so this is
      // exactly one report per finished turn (the loop starts out idle and
      // emits nothing at boot).
      if (status !== 'idle' || wasIdle) return;
      const agentSessionId = agent && agent.session && agent.session.id;
      // Bind to the agent that owns THIS process's TUI: a sibling session
      // mounted in the same process must not settle our turn.
      if (!agentSessionId || agentSessionId !== botmuxInjectSessionId) return;
      reportBotmuxTurnIdle();
    });
  } catch {
    // Event registration is best-effort; readiness keeps working without it.
  }
}
`;
}

function buildDshTuiWrapperPlugin(parts: HookCommandParts, originalDshTuiUrl: string): string {
  return `// botmux generated dsh-tui question wrapper v${BRIDGE_VERSION}
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as original from ${jsonLiteral(originalDshTuiUrl)};
${buildRuntimeBridgeSnippet(parts, 'dsh-tui')}
${buildDshTuiStatusSnippet()}
export const name = original.name;
export const inject = original.inject;
export const Config = original.Config;
function rawService(service) {
  return service && service[Symbol.for('cordis.original')] || service;
}
function isJsExpression(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.__jsExpr === 'string';
}
function isConfigObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function evaluateJsExpression(ctx, value) {
  return Function('ctx', 'with (ctx) { return eval(' + JSON.stringify(value.__jsExpr) + '); }')(ctx);
}
function resolveDshTuiConfigExpressions(ctx, value) {
  if (!isJsExpression(value)) return value;
  return evaluateJsExpression(ctx, value);
}
function materializeDshTuiConfig(ctx, config) {
  if (!isConfigObject(config)) return config;
  const workspace = resolveDshTuiConfigExpressions(ctx, config.workspace);
  const preset = resolveDshTuiConfigExpressions(ctx, config.preset);
  const sessionId = resolveDshTuiConfigExpressions(ctx, config.sessionId);
  if (Object.is(workspace, config.workspace) && Object.is(preset, config.preset) && Object.is(sessionId, config.sessionId)) {
    return config;
  }
  return { ...config, workspace, preset, sessionId };
}
function originalDshTuiConfig(ctx, wrapperConfig) {
  let originalConfig;
  try {
    const entry = [...ctx.loader.entries()].find((candidate) => candidate.options && candidate.options.id === 'dsh-tui');
    if (entry && entry.options && entry.options.config !== undefined) originalConfig = entry.options.config;
  } catch {}
  if (originalConfig !== undefined) return materializeDshTuiConfig(ctx, originalConfig);
  if (isConfigObject(wrapperConfig) && Object.keys(wrapperConfig).length > 0) return materializeDshTuiConfig(ctx, wrapperConfig);
  throw new Error('botmux dsh-tui wrapper could not find original dsh-tui config');
}
function wrapLegacyProvider(service) {
  const target = rawService(service);
  if (!target || typeof target.registerProvider !== 'function') return () => {};
  const own = Object.getOwnPropertyDescriptor(target, 'registerProvider');
  const originalRegister = target.registerProvider.bind(target);
  let used = false;
  const restore = () => {
    try {
      if (own) Object.defineProperty(target, 'registerProvider', own);
      else delete target.registerProvider;
    } catch {}
  };
  target.registerProvider = (nativeProvider) => {
    if (used) return originalRegister(nativeProvider);
    used = true;
    const composite = {
      ask: async (request) => {
        try { return await bridgeAsk(request, () => nativeProvider.ask(request)); }
        catch (error) { throw error; }
      },
    };
    return originalRegister(composite);
  };
  return restore;
}
export async function apply(ctx, config) {
  const effectiveConfig = originalDshTuiConfig(ctx, config);
  const botmuxSession = isBotmuxSessionEnv(process.env);
  // Readiness / turn-idle reporting is independent of the question-bridge kill
  // switch: disabling the bridge must not silently restore the 90s stall.
  if (botmuxSession) installBotmuxStatusChannel(ctx);
  if (!botmuxSession || process.env.BOTMUX_DSH_ASK_BRIDGE === '0') return original.apply(ctx, effectiveConfig);
  const service = ctx.get && ctx.get('userQuestions');
  const legacyRestore = service && typeof service.registerProvider === 'function'
    ? wrapLegacyProvider(service)
    : undefined;
  if (legacyRestore && typeof ctx.effect === 'function') {
    try { ctx.effect(() => () => legacyRestore(), 'botmux-dsh-tui-question-bridge.legacy-wrap'); } catch {}
  }
  if (!legacyRestore) installWaterfallBridge(ctx);
  try { return await original.apply(ctx, effectiveConfig); }
  finally { try { legacyRestore && legacyRestore(); } catch {} }
}
`;
}

function buildOrdinaryBridgePatch(pluginUrl: string, hash: string): string {
  return [
    '- insert:',
    `    - id: botmux-dsh-question-bridge-${hash}`,
    `      name: ${yamlSingleQuoted(pluginUrl)}`,
    '      inject:',
    '        - userQuestions',
    '',
  ].join('\n');
}

function buildDshTuiWrapperPatch(pluginUrl: string, hash: string): string {
  return [
    '- id: dsh-tui',
    '  disabled: true',
    '- insert:',
    `    - id: botmux-dsh-tui-wrapper-${hash}`,
    `      name: ${yamlSingleQuoted(pluginUrl)}`,
    '      inject:',
    '        - workspaceRegistry',
    '        - agents',
    '        - tuiWorkspaces',
    '        - tuiScenes',
    '        - tuiDialogs',
    '        - tuiStatus',
    '        - tuiShortcuts',
    '        - tuiRenderers',
    '        - tuiThemes',
    '        - userQuestions',
    '',
  ].join('\n');
}

export function ensureDshQuestionBridgePatch(
  opts: EnsureDshQuestionBridgePatchOptions,
): DshQuestionBridgePatch | null {
  if (process.env.BOTMUX_DSH_ASK_BRIDGE === '0') return null;
  const hook = opts.hookCommand ?? hookCommandParts(opts.cliId);
  const runtime = opts.cliId === 'dsh-tui' ? 'tui' : 'official';
  const originalDshTuiUrl = runtime === 'tui'
    ? resolveOriginalDshTuiEntryUrl(opts.dshTuiProfileDir ?? defaultDshTuiProfileDir(opts.homeDir ?? homedir()))
    : undefined;
  if (runtime === 'tui' && !originalDshTuiUrl) return null;
  const content = runtime === 'tui'
    ? buildDshTuiWrapperPlugin(hook, originalDshTuiUrl!)
    : buildOrdinaryBridgePlugin(hook);
  const salt = opts.buildSalt ?? '';
  const hash = sha256(JSON.stringify({ version: BRIDGE_VERSION, cliId: opts.cliId, hook, originalDshTuiUrl, salt, content })).slice(0, 16);
  const bridgeHome = canonicalPath(opts.homeDir ?? homedir());
  const root = join(bridgeHome, BRIDGE_ROOT_DIR, hash);
  const pluginPath = join(root, runtime === 'tui' ? 'dsh-tui-wrapper.mjs' : 'bridge.mjs');
  const pluginUrl = pathToFileURL(pluginPath).href;
  if (runtime === 'tui' && originalDshTuiUrl === pluginUrl) return null;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const patchPath = join(root, 'cordis.patch.yml');
  atomicWriteFileSync(pluginPath, content, { mode: 0o600 });
  const patch = runtime === 'tui'
    ? buildDshTuiWrapperPatch(pluginUrl, hash)
    : buildOrdinaryBridgePatch(pluginUrl, hash);
  atomicWriteFileSync(patchPath, patch, { mode: 0o600 });
  return { patchPath, readonlyRoot: root, pluginPath };
}
