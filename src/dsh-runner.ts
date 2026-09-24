#!/usr/bin/env node
/**
 * dsh-runner: botmux runner for deepseek-harness (dsh).
 *
 * botmux spawns this with node (see adapters/cli/dsh.ts). It bridges two
 * protocols:
 *
 *   botmux side (stdin/stdout):
 *     - input frames:  `::botmux-dsh:<base64(JSON)>\n` one per user message
 *     - output:        display lines + OSC control frames
 *                      (`\x1b]777;botmux:<kind>:<base64>\x07`, see
 *                      adapters/cli/runner-control-channel.ts)
 *
 *   dsh side (child `dsh --profile <name>` process, newline-delimited JSON-RPC):
 *     - requests:  initialize / session/prompt / shutdown
 *     - notifications: session.event (full event stream), session.status,
 *                      subagent.started, subagent.finished
 *
 * One runner process owns one dsh session (a fixed sessionId reused across
 * prompts, so the connection stays multi-turn). Turn completion is driven by
 * `session.status: idle`. The agent's final text is accumulated from
 * assistant/message events and delivered to botmux as a `final` control
 * frame; tool calls render as progress lines.
 *
 * The SDK protocol has no cancel: a wedged turn is reaped by the turn
 * watchdog, which kills the child and exits so botmux restarts the runner
 * (the in-memory session is lost; sessions persist on disk under
 * DSH_SESSION_ROOT but cross-process resume is not wired up yet).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';

const DSH_MARKER = '::botmux-dsh:';
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
// Node's setTimeout delay is a 32-bit signed int of ms; a larger value wraps to
// ~1ms and warns. Upstream config/IPC/UI already clamp to this bound, but the
// runner re-validates its own argv so a hand-crafted invocation can't arm an
// overflowing (effectively ~1ms) turn timeout. Mirrors MAX_TURN_TIMEOUT_MS.
const MAX_TURN_TIMEOUT_MS = 2_147_483_647;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const PROMPT_ACK_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 49152;

/** Default dsh profile name used when none is specified. The profile lives
 *  under ~/.dsh/profiles/<name>/ and follows the standard dsh profile layout:
 *  cordis.yml (empty) + cordis.patch.yml (the full plugin composition). */
const DEFAULT_DSH_PROFILE = 'botmux';
const DSH_SDK_JSONRPC_SERVER_PACKAGE = '@deepseek-ai/dsh-sdk-jsonrpc-server';
const DSH_TOOL_ASK_USER_PACKAGE = '@deepseek-ai/dsh-tool-ask-user';
const DSH_SDK_JSONRPC_SERVER_DEP = '^0.1.1-rc.1';
const DSH_TOOL_ASK_USER_DEP = '^0.1.1-rc.1';

interface Args {
  sessionId: string;
  dshBin: string;
  cwd?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
  model?: string;
  dshProfile?: string;
  bridgePatch?: string;
  turnTimeoutMs: number;
}

interface PendingTurn {
  resolve: () => void;
  reject: (err: Error) => void;
  startedAtMs: number;
  textBuffer: string;
  usage?: DshUsage;
  toolNames: Map<string, string>;
  timer: NodeJS.Timeout;
  /** Set from the session/prompt ACK; the turn only owns events at/after
   *  the matching agent/inbox/spliced receipt. */
  messageId?: string;
  /** Notifications buffered until the spliced receipt for messageId arrives. */
  pending: Array<{ method: string; params: Record<string, unknown> }>;
  receiptReceived: boolean;
  /** Set from a turn/end event whose reason is an error, so a failed turn
   *  surfaces in the reply instead of completing with an empty final. */
  turnError?: string;
}

interface DshUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

const output = new RunnerControlWriter();

function parseArgs(argv: string[]): Args {
  const out: Args = { sessionId: '', dshBin: '', turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--dsh-bin' && val !== undefined) { out.dshBin = val; i++; }
    else if (key === '--cwd' && val !== undefined) { out.cwd = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
    else if (key === '--model' && val !== undefined) { out.model = val; i++; }
    else if (key === '--dsh-profile' && val !== undefined) { out.dshProfile = val; i++; }
    else if (key === '--bridge-patch' && val !== undefined) { out.bridgePatch = val; i++; }
    else if (key === '--turn-timeout-ms' && val !== undefined) {
      const n = Number(val);
      // Accept only a positive integer within the arm-able bound; anything else
      // (≤0, non-integer, over-bound) is ignored → falls back to the default.
      if (Number.isInteger(n) && n > 0 && n <= MAX_TURN_TIMEOUT_MS) out.turnTimeoutMs = n;
      i++;
    }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  if (!out.dshBin) throw new Error('--dsh-bin is required');
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseYamlDocument(input: string): unknown {
  return parseYaml(input);
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isGeneratedBotmuxProfile(name: string, pkgJson: string, cordisPatchYml: string): boolean {
  if (name !== DEFAULT_DSH_PROFILE) return false;
  const pkg = readJsonRecord(pkgJson);
  if (!pkg || pkg.name !== `dsh-profile-${name}`) return false;
  try {
    const patch = readFileSync(cordisPatchYml, 'utf8');
    return patch.includes('Auto-generated by botmux') && patch.includes('id: sdk-jsonrpc-server');
  } catch {
    return false;
  }
}

function packageJsonPathFor(packageName: string, profileDir: string): string {
  return join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json');
}

function migrateGeneratedBotmuxProfile(name: string, pkgJson: string, cordisPatchYml: string): boolean {
  if (!isGeneratedBotmuxProfile(name, pkgJson, cordisPatchYml)) return false;
  let changed = false;
  const pkg = readJsonRecord(pkgJson);
  if (pkg) {
    const deps = isRecord(pkg.dependencies) ? { ...pkg.dependencies } : {};
    if (deps[DSH_TOOL_ASK_USER_PACKAGE] !== DSH_TOOL_ASK_USER_DEP) {
      deps[DSH_TOOL_ASK_USER_PACKAGE] = DSH_TOOL_ASK_USER_DEP;
      pkg.dependencies = deps;
      writeFileSync(pkgJson, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      changed = true;
    }
  }
  const patch = readFileSync(cordisPatchYml, 'utf8');
  if (!patch.includes('id: tool-ask-user')) {
    const oldSnippet = [
      `- insert:`,
      `    - id: sdk-jsonrpc-server`,
      `      name: '${DSH_SDK_JSONRPC_SERVER_PACKAGE}'`,
    ].join('\n');
    const newSnippet = [
      `- insert:`,
      `    - id: tool-ask-user`,
      `      name: '${DSH_TOOL_ASK_USER_PACKAGE}'`,
      `    - id: sdk-jsonrpc-server`,
      `      name: '${DSH_SDK_JSONRPC_SERVER_PACKAGE}'`,
    ].join('\n');
    if (patch.includes(oldSnippet)) {
      writeFileSync(cordisPatchYml, patch.replace(oldSnippet, newSnippet), 'utf8');
      changed = true;
    }
  }
  return changed;
}

/** Keep the wire checks aligned with the official dsh SDK client. A successful
 *  JSON-RPC envelope with a malformed result is still a protocol failure. */
function parseInitializeResult(result: unknown): { serverInfo: { name: string; version: string } } {
  if (!isRecord(result)
    || !isRecord(result.serverInfo)
    || typeof result.serverInfo.name !== 'string'
    || typeof result.serverInfo.version !== 'string') {
    throw new Error(`dsh protocol error: initialize returned no server identity: ${JSON.stringify(result)}`);
  }
  return { serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version } };
}

function parsePromptMessageId(result: unknown): string {
  if (!isRecord(result) || typeof result.messageId !== 'string') {
    throw new Error(`dsh protocol error: session/prompt returned no message id: ${JSON.stringify(result)}`);
  }
  return result.messageId;
}

function emitMarker(kind: string, payload: unknown): void {
  output.marker(kind, payload);
}

function writeLine(text = ''): void {
  output.line(text);
}

function prompt(): void {
  output.display('› ');
}

/** Native dsh config resolved from ~/.dsh (profile + settings.yaml + .credentials.yaml).
 *  The runner spawns `dsh --profile <name>`; the dsh CLI composes the full plugin tree
 *  from dsh-base bundles + the profile's cordis.patch.yml. */
interface NativeDshConfig {
  /** Profile name under ~/.dsh/profiles/ (passed to `dsh --profile`). */
  profileName: string;
  /** Provider route for SDK initialize. */
  provider: string;
  /** Model for SDK initialize (argv --model > settings.yaml > default). */
  model: string;
  /** Credentials injected into the runtime's environment (env wins on conflict). */
  credentials: Record<string, string>;
}

function dshHomeDir(): string {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.dsh');
}

/** Seed a minimal dsh profile under ~/.dsh/profiles/<name> so `dsh --profile <name>`
 *  can start. dsh judges a profile's existence by its package.json (not the
 *  directory or cordis.yml), and non-shipped profiles (only "web" / "headless"
 *  are shipped) are not auto-created by the CLI.
 *
 *  We create a minimal skeleton: package.json (dsh-base bundle + SDK deps),
 *  cordis.yml (empty), and cordis.patch.yml (disable Web GUI + insert the
 *  JSON-RPC server). For the default botmux profile only, also install and
 *  insert the model-facing ask_user_question tool, since that is the profile
 *  where botmux auto-injects its question bridge. dsh-base already provides
 *  agent, llm, bash, fs, sessions, sandbox, subagent, subprocess, and 50+ other
 *  plugins — they must NOT be restated here. Community plugins (traex-bridge,
 *  openviking, genui, etc.) are added by the user with
 *  `dsh plugin --profile <name> add <pkg>`.
 *
 *  After writing the skeleton we call `dsh plugin --profile <name> add` to
 *  install the dependencies into node_modules — without this, dsh can't load
 *  the profile. dsh packages are prerelease (0.1.1-rc.x), so the version range
 *  must be ^0.1.1-rc.1 (plain ^0.1.1 doesn't match prereleases).
 *
 *  If the profile already exists, this is a no-op except for a narrow migration
 *  of the default botmux-generated profile that predated the ask_user_question
 *  tool row. */
function ensureProfileDir(name: string, dshBin: string): string {
  const dir = join(dshHomeDir(), 'profiles', name);
  mkdirSync(dir, { recursive: true });

  const pkgJson = join(dir, 'package.json');
  const isNewSkeleton = !existsSync(pkgJson);
  const managesAskTool = name === DEFAULT_DSH_PROFILE;
  if (isNewSkeleton) {
    const dependencies: Record<string, string> = {
      [DSH_SDK_JSONRPC_SERVER_PACKAGE]: DSH_SDK_JSONRPC_SERVER_DEP,
      // dsh-sdk-protocol is a peer dep of sdk-jsonrpc-server; pnpm does not
      // auto-install peer deps, so we declare it explicitly.
      '@deepseek-ai/dsh-sdk-protocol': DSH_SDK_JSONRPC_SERVER_DEP,
    };
    if (managesAskTool) dependencies[DSH_TOOL_ASK_USER_PACKAGE] = DSH_TOOL_ASK_USER_DEP;
    const pkg = {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    };
    writeFileSync(pkgJson, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }

  const cordisYml = join(dir, 'cordis.yml');
  if (!existsSync(cordisYml)) {
    writeFileSync(cordisYml, '# dsh profile root — edit cordis.patch.yml, not this file.\n[]\n', 'utf8');
  }

  const cordisPatchYml = join(dir, 'cordis.patch.yml');
  if (!existsSync(cordisPatchYml)) {
    // Minimal headless SDK profile. dsh-base provides the full plugin tree
    // (agent, llm-deepseek, llm-pi-ai, tool-bash, tool-fs, sessions, sandbox,
    // subagent, subprocess, session-checkpoints, etc.). This layer only:
    //   1. Disables Web GUI plugins (they block loader.await() in headless mode)
    //   2. Inserts the ask_user_question tool and SDK JSON-RPC server
    //      (the server is not in dsh-base and has no dsh.bundle).
    // Community plugins are added by the user with `dsh plugin add`.
    const insertRows = [
      ...(managesAskTool ? [
        `    - id: tool-ask-user`,
        `      name: '${DSH_TOOL_ASK_USER_PACKAGE}'`,
      ] : []),
      `    - id: sdk-jsonrpc-server`,
      `      name: '${DSH_SDK_JSONRPC_SERVER_PACKAGE}'`,
    ];
    const patch = [
      `# DSH profile: ${name} (headless JSON-RPC server)`,
      `# Auto-generated by botmux. dsh-base provides the full plugin tree;`,
      `# this layer only disables the Web GUI and inserts the SDK server.`,
      `# Add community plugins with: dsh plugin --profile ${name} add <pkg>`,
      ``,
      `- id: hmr`,
      `  disabled: true`,
      `- id: web`,
      `  disabled: true`,
      `- id: web-search-deepseek`,
      `  disabled: true`,
      `- id: tool-web`,
      `  disabled: true`,
      ``,
      `- insert:`,
      ...insertRows,
      ``,
    ].join('\n');
    writeFileSync(cordisPatchYml, patch, 'utf8');
  }

  migrateGeneratedBotmuxProfile(name, pkgJson, cordisPatchYml);
  const managesGeneratedAskTool = isGeneratedBotmuxProfile(name, pkgJson, cordisPatchYml);

  // Install profile dependencies. Keyed on installed package presence, not just
  // node_modules existence — old generated profiles may already have node_modules
  // from the SDK server but lack the later ask_user_question tool. We warn but
  // don't throw here: the runner is a subprocess, and the dsh binary will fail
  // with a clear "Cannot find package" error if installation did not complete.
  const nodeModules = join(dir, 'node_modules');
  const missingNodeModules = !existsSync(nodeModules);
  const missingSdkServer = !existsSync(packageJsonPathFor(DSH_SDK_JSONRPC_SERVER_PACKAGE, dir));
  const missingAskTool = managesGeneratedAskTool && !existsSync(packageJsonPathFor(DSH_TOOL_ASK_USER_PACKAGE, dir));
  const packagesToInstall = [
    ...(missingNodeModules || missingSdkServer ? [`${DSH_SDK_JSONRPC_SERVER_PACKAGE}@next`] : []),
    ...(missingAskTool ? [`${DSH_TOOL_ASK_USER_PACKAGE}@${DSH_TOOL_ASK_USER_DEP}`] : []),
  ];
  if (packagesToInstall.length > 0) {
    const result = spawnSync(dshBin, [
      'plugin', '--profile', name, 'add',
      ...packagesToInstall,
    ], {
      stdio: 'pipe',
      timeout: 120_000,
    });
    if (result.status !== 0 || result.error) {
      const stderr = result.stderr?.toString().trim() || '';
      process.stderr.write(`[botmux:dsh] install deps failed for profile "${name}" (exit ${result.status ?? 'error'}): ${stderr || result.error?.message || 'unknown error'}\n`);
      // Don't throw — the runner is a subprocess. The dsh binary will fail
      // to start with a clear "Cannot find package" error, and the worker
      // will surface that to the user.
    }
  }

  return dir;
}

/** Load credential references from ~/.dsh/.credentials.yaml as an env map.
 *  Current DSH writes `{ version: 1, refs: { KEY: value } }`; retain support
 *  for the pre-release flat `KEY: value` layout used by older installations.
 *  Missing file → empty (the runtime then falls back to ambient environment). */
function loadCredentials(): Record<string, string> {
  const credPath = join(dshHomeDir(), '.credentials.yaml');
  if (!existsSync(credPath)) return {};
  const parsed = parseYamlDocument(readFileSync(credPath, 'utf8')) as unknown;
  const source = isRecord(parsed) && parsed.version === 1 && isRecord(parsed.refs)
    ? parsed.refs
    : parsed;
  const out: Record<string, string> = {};
  if (isRecord(source)) {
    for (const [k, v] of Object.entries(source)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
  }
  return out;
}

/** Resolve the profile name, provider, model, and credentials.
 *
 *  Precedence:
 *  1. --dsh-profile (default "botmux") — profile name under ~/.dsh/profiles/.
 *  2. Provider & model from ~/.dsh/settings.yaml for the initialize RPC.
 *  3. Credentials from ~/.dsh/.credentials.yaml. */
function resolveNativeDshConfig(): NativeDshConfig {
  const profileName = args.dshProfile?.trim() || DEFAULT_DSH_PROFILE;

  // Ensure the profile directory exists and dependencies are installed.
  ensureProfileDir(profileName, args.dshBin);

  // Resolve provider & model from ~/.dsh/settings.yaml for the initialize RPC.
  //    The plugin composition is managed entirely by the profile's cordis.patch.yml.
  const settingsPath = join(dshHomeDir(), 'settings.yaml');
  let provider = 'deepseek-official';
  let settingsModel = '';
  if (existsSync(settingsPath)) {
    const settings = parseYamlDocument(readFileSync(settingsPath, 'utf8')) as unknown;
    const s = isRecord(settings) ? settings : {};
    const defaultModel = isRecord(s['agent-default-model']) ? s['agent-default-model'] : {};
    provider = typeof defaultModel.provider === 'string' && defaultModel.provider
      ? defaultModel.provider
      : provider;
    settingsModel = typeof defaultModel.model === 'string' ? defaultModel.model : '';
  }

  return {
    profileName,
    provider,
    model: args.model?.trim() || settingsModel || DEFAULT_MODEL,
    credentials: loadCredentials(),
  };
}

/** Map dsh's per-model-call usage onto botmux's four-bucket final usage.
 *  dsh reports cacheWriteTokens where botmux says cacheCreateTokens. The
 *  worker drops the whole usage unless every bucket is a non-negative
 *  integer, so missing buckets default to 0. */
function normalizeUsage(raw: unknown): DshUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
  const inputTokens = num(r.inputTokens);
  const outputTokens = num(r.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: num(r.cacheReadTokens) ?? 0,
    cacheCreateTokens: num(r.cacheWriteTokens) ?? 0,
  };
}

/** Accumulate per-step usage into a turn total (dsh meters each model call,
 *  not the whole turn). */
function addUsage(a: DshUsage, b: DshUsage): DshUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreateTokens: a.cacheCreateTokens + b.cacheCreateTokens,
  };
}

/** Minimal JSON-RPC client over the dsh runtime's stdio transport. */
class DshJsonRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private stdoutBuffer = '';
  private exited = false;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (code: number | null, signal: string | null) => void;

  constructor(
    private readonly dshBin: string,
    private readonly profileName: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
  ) {}

  start(): void {
    const dshArgs = ['--profile', this.profileName];
    if (args.bridgePatch) dshArgs.push(`--patch=${args.bridgePatch}`);
    this.child = spawn(this.dshBin, dshArgs, {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.handleStdout(String(chunk)));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => output.error(`[dsh] ${String(chunk)}`));
    this.child.on('error', err => this.failAll(err));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.failAll(new Error(`dsh process exited (code=${code}, signal=${signal})`));
      this.onExit?.(code, signal);
    });
  }

  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.child || this.exited) {
      return Promise.reject(new Error('dsh child is not running'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dsh request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: result => resolve(result as T),
        reject,
        timer,
      });
      this.child!.stdin.write(payload);
    });
  }

  kill(): void {
    try { this.child?.kill('SIGTERM'); } catch { /* already gone */ }
  }

  /** Best-effort shutdown: ask nicely, then kill after the grace period. */
  async shutdown(): Promise<void> {
    if (!this.child || this.exited) return;
    try {
      await this.request('shutdown', {}, SHUTDOWN_GRACE_MS);
    } catch { /* runtime may exit on its own; SIGTERM below is the backstop */ }
    this.kill();
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const idx = this.stdoutBuffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        output.error(`[dsh] non-JSON stdout line: ${truncate(line, 200)}`);
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(`dsh error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        } else {
          entry.resolve(msg.result);
        }
      } else if (msg.method) {
        this.onNotification?.(msg.method, msg.params);
      }
    }
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Runner state
// ---------------------------------------------------------------------------

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  output.error(`${errorMessage(err)}\n`);
  process.exit(2);
}

const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
// One runner process owns one dsh session. The id is random per runner: the
// dsh SDK server has no create-or-resume, and its persistence layer rejects
// creating a session whose id already has a log on disk. Cross-restart resume
// therefore stays a limitation (a restarted runner starts a fresh session).
const dshSessionId = `session-${randomUUID()}`;
let client: DshJsonRpcClient;
let activeTurn: PendingTurn | undefined;
let shuttingDown = false;
let firstTurn = true;

const queue: string[] = [];
let inputBuffer = '';
let processing = false;

function buildPreamble(): string {
  const name = args.botName?.trim() || 'bot';
  const locale = args.locale?.trim() || 'zh';
  return [
    '<botmux_identity>',
    `你是飞书群机器人「${name}」，通过 deepseek-harness 运行。`,
    '- 你的最终回复文本会被自动捕获并发送到群里，不要执行 botmux send 或任何发消息命令。',
    `- 工作目录：${cwd}。语言：${locale}。`,
    '</botmux_identity>',
    '',
  ].join('\n');
}

/** Whether a session event is the durable enqueue receipt for `messageId`
 *  (same correlation as the official SDK client's isInboxReceipt). */
function isInboxReceipt(event: unknown, messageId: string): boolean {
  if (!event || typeof event !== 'object') return false;
  const ev = event as { type?: string; data?: { inserted?: unknown } };
  if (ev.type !== 'agent/inbox/spliced' || !ev.data || !Array.isArray(ev.data.inserted)) return false;
  return ev.data.inserted.some(m =>
    m && typeof m === 'object' && (m as { id?: unknown }).id === messageId);
}

/** Claim the turn's receipt boundary: once messageId is known, scan buffered
 *  notifications for its agent/inbox/spliced and replay only what follows.
 *  Notifications before the receipt belong to a previous turn and are dropped. */
function tryClaimReceipt(turn: PendingTurn): void {
  if (turn.receiptReceived || !turn.messageId) return;
  const idx = turn.pending.findIndex(item =>
    item.method === 'session.event' && isInboxReceipt(item.params.event, turn.messageId!));
  if (idx < 0) return;
  turn.receiptReceived = true;
  const queued = turn.pending.splice(idx + 1);
  turn.pending.length = 0;
  for (const item of queued) processTurnNotification(turn, item.method, item.params);
}

function handleSessionEvent(turn: PendingTurn, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as { type?: string; data?: Record<string, unknown> };
  switch (ev.type) {
    case 'tool/call': {
      const name = String(ev.data?.name ?? 'tool');
      const callId = String(ev.data?.callId ?? '');
      if (callId) turn.toolNames.set(callId, name);
      const argsText = typeof ev.data?.arguments === 'string' ? ev.data.arguments : '';
      writeLine(`🔧 ${name} ${truncate(argsText, 200)}`);
      break;
    }
    case 'tool/result': {
      const message = ev.data?.message as { source?: { callId?: string }; content?: Array<{ isError?: boolean }> } | undefined;
      const callId = String(message?.source?.callId ?? '');
      const name = turn.toolNames.get(callId) ?? 'tool';
      const isError = Array.isArray(message?.content) && message.content.some(c => c?.isError === true);
      writeLine(`${isError ? '✗' : '✓'} ${name}`);
      break;
    }
    case 'turn/end': {
      const reason = ev.data?.reason as { kind?: string; error?: { message?: string } } | undefined;
      if (reason?.kind === 'error') {
        turn.turnError = reason.error?.message || `turn failed (${reason.kind})`;
      }
      break;
    }
    case 'assistant/message': {
      const message = ev.data?.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const blocks = message?.content;
      if (Array.isArray(blocks)) {
        // dsh emits one assistant/message per step. The turn's final response
        // is the LAST assistant message's text (same semantics as the SDK's
        // finalResponse): replace, don't append, so intermediate step chatter
        // never leaks into the reply. Multiple text blocks in one message
        // concatenate with no separator (official SDK behavior).
        const parts = blocks
          .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
          .map(b => b.text);
        turn.textBuffer = parts.join('');
      }
      // usage is per model call; accumulate across steps for a turn total.
      const usage = normalizeUsage(ev.data?.usage);
      if (usage) turn.usage = turn.usage ? addUsage(turn.usage, usage) : usage;
      break;
    }
    default:
      break;
  }
}

function processTurnNotification(turn: PendingTurn, method: string, p: Record<string, unknown>): void {
  if (method === 'session.event') {
    handleSessionEvent(turn, p.event);
    return;
  }
  if (method === 'session.status' && p.status === 'idle' && activeTurn === turn) {
    activeTurn = undefined;
    clearTimeout(turn.timer);
    lastTurnText = turn.textBuffer;
    lastTurnUsage = turn.usage;
    lastTurnError = turn.turnError;
    turn.resolve();
  }
}

function handleNotification(method: string, params: unknown): void {
  if (!params || typeof params !== 'object') return;
  const p = params as Record<string, unknown>;
  if (method === 'session.event' || method === 'session.status') {
    if (p.sessionId !== dshSessionId) return;
    const turn = activeTurn;
    if (!turn) return;
    // Buffer until the spliced receipt for our messageId: stale notifications
    // from a previous turn (notably a late idle) must not settle this one.
    if (!turn.receiptReceived) {
      turn.pending.push({ method, params: p });
      tryClaimReceipt(turn);
      return;
    }
    processTurnNotification(turn, method, p);
    return;
  }
  switch (method) {
    case 'subagent.started':
      writeLine('↳ 子任务开始');
      break;
    case 'subagent.finished':
      writeLine(`↳ 子任务${p.status === 'ok' ? '完成' : '失败'}`);
      break;
    default:
      break;
  }
}

// The idle handler clears activeTurn; stash the completed turn's payload here
// so runTurn can build the final marker after the promise resolves.
let lastTurnText = '';
let lastTurnUsage: DshUsage | undefined;
let lastTurnError: string | undefined;

async function runTurn(content: string): Promise<void> {
  const startedAtMs = Date.now();
  writeLine();
  writeLine('[user]');
  writeLine(content);
  writeLine();
  writeLine('[dsh] thinking...');

  const promptContent = firstTurn ? `${buildPreamble()}${content}` : content;

  const turnPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (activeTurn?.timer === timer) activeTurn = undefined;
      reject(new Error(`dsh turn timed out after ${args.turnTimeoutMs}ms`));
    }, args.turnTimeoutMs);
    activeTurn = {
      resolve,
      reject,
      startedAtMs,
      textBuffer: '',
      toolNames: new Map(),
      pending: [],
      receiptReceived: false,
      timer,
    };
  });

  try {
    const ack = await client.request<unknown>('session/prompt', {
      sessionId: dshSessionId,
      contentBlocks: [{ type: 'text', text: promptContent }],
    }, PROMPT_ACK_TIMEOUT_MS);
    const messageId = parsePromptMessageId(ack);
    // The ACK's messageId correlates this turn's events: notifications may
    // already be buffered (they can precede the response), and a late idle
    // from the previous turn must not settle this one.
    if (activeTurn) {
      activeTurn.messageId = messageId;
      tryClaimReceipt(activeTurn);
    }
    // Commit firstTurn only after the prompt was accepted: a rejected first
    // prompt must keep the identity preamble for the retry (double-send guard).
    firstTurn = false;
  } catch (err) {
    if (activeTurn) {
      clearTimeout(activeTurn.timer);
      activeTurn = undefined;
    }
    throw err;
  }

  await turnPromise;

  const completedAtMs = Date.now();
  const finalText = lastTurnText
    || (lastTurnError ? `dsh 执行出错：${lastTurnError}` : '');
  const finalUsage = lastTurnUsage;
  emitMarker('final', {
    content: finalText,
    ...(finalUsage ? { usage: finalUsage } : {}),
    startedAtMs,
    completedAtMs,
  });
  if (!finalText.trim()) writeLine('[dsh] completed without text output.');
}

function isFatalRunnerError(err: unknown): boolean {
  const msg = errorMessage(err);
  return msg.includes('timed out')
    || msg.includes('exited')
    || msg.includes('not running');
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        await runTurn(next);
      } catch (err) {
        const now = Date.now();
        const message = `dsh runner error: ${errorMessage(err)}`;
        writeLine(message);
        emitMarker('final', { content: message, startedAtMs: now, completedAtMs: now });
        if (isFatalRunnerError(err)) {
          // The child is wedged or gone: recycle the runner so botmux starts a
          // fresh one (and a fresh dsh session) for the next turn.
          client.kill();
          setTimeout(() => process.exit(1), 100);
          return;
        }
      }
      prompt();
    }
  } finally {
    processing = false;
  }
}

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!trimmed.startsWith(DSH_MARKER)) {
    writeLine('[dsh] ignoring non-frame input');
    return;
  }
  const encoded = trimmed.slice(DSH_MARKER.length);
  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
      type?: string;
      content?: unknown;
      replyTurnId?: unknown;
    };
    if (decoded?.type === 'message' && typeof decoded.content === 'string') {
      queue.push(decoded.content);
      void drainQueue();
    }
  } catch (err) {
    writeLine(`[dsh] bad botmux input: ${errorMessage(err)}`);
  }
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    if (ch === '\u0003') {
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (ch === '\u007f' || ch === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  const native = resolveNativeDshConfig();
  // Sessions live under the native dsh home (~/.dsh/sessions/botmux/<id>),
  // not ~/.botmux — the adapter binds ~/.dsh into the sandbox.
  const sessionRoot = join(dshHomeDir(), 'sessions', 'botmux', args.sessionId);
  mkdirSync(sessionRoot, { recursive: true });

  // Credentials from ~/.dsh/.credentials.yaml fill gaps; the ambient
  // environment (bots.json env) wins on conflict, and the runner's
  // session/cwd always win.
  client = new DshJsonRpcClient(args.dshBin, native.profileName, {
    ...native.credentials,
    ...process.env,
    DSH_SESSION_ROOT: sessionRoot,
    DSH_CWD: cwd,
    BOTMUX_DSH_ASK_TIMEOUT_MS: String(Math.max(1000, args.turnTimeoutMs - 5000)),
  }, cwd);
  client.onNotification = handleNotification;
  client.onExit = (code, signal) => {
    if (shuttingDown) return;
    const message = `dsh process exited unexpectedly (code=${code}, signal=${signal})`;
    writeLine(message);
    if (activeTurn) {
      const turn = activeTurn;
      activeTurn = undefined;
      clearTimeout(turn.timer);
      turn.reject(new Error(message));
    }
    setTimeout(() => process.exit(1), 100);
  };
  client.start();

  const initializeResult = await client.request<unknown>(
    'initialize',
    { cwd, provider: native.provider, model: native.model, maxTokens: DEFAULT_MAX_TOKENS },
    HANDSHAKE_TIMEOUT_MS,
  );
  const { serverInfo } = parseInitializeResult(initializeResult);
  writeLine(`dsh connected (${serverInfo.name} ${serverInfo.version}).`);

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  process.stdin.on('end', () => {
    shuttingDown = true;
    void client.shutdown().finally(() => process.exit(0));
  });
  prompt();
}

process.on('SIGTERM', () => process.exit(0));

main().catch(err => {
  output.error(`dsh runner failed: ${errorMessage(err)}\n`);
  process.exit(1);
});
