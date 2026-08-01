#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
  buildCodexAppTurnStartParams,
  isCleanInputCapabilityError,
  parseCodexVersion,
  supportsClientUserMessageId,
  type CodexVersion,
} from './adapters/cli/codex-app-turn.js';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import {
  CodexAppRpcResponseError,
  CodexAppTransportError,
  CodexAppTurnController,
  type CodexAppPreparedInput,
} from './services/codex-app-turn-controller.js';
import {
  CODEX_APP_INPUT_PREFIX,
  decodeCodexAppRunnerInput,
  type CodexAppRunnerInput,
} from './services/codex-app-runner-protocol.js';
import {
  TurnTokenUsageAccumulator,
  parseTokenUsagePair,
} from './services/codex-app-token-usage.js';

type JsonObject = Record<string, any>;

interface Args {
  sessionId: string;
  codexBin: string;
  cwd: string;
  threadId?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
  model?: string;
  reasoningEffort?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}

const output = new RunnerControlWriter();

function parseArgs(argv: string[]): Args {
  const out: Args = {
    sessionId: '',
    codexBin: 'codex',
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--codex-bin' && val !== undefined) { out.codexBin = val; i++; }
    else if (key === '--cwd' && val !== undefined) { out.cwd = val; i++; }
    else if (key === '--thread-id' && val !== undefined) { out.threadId = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
    else if (key === '--model' && val !== undefined) { out.model = val; i++; }
    else if (key === '--reasoning-effort' && val !== undefined) { out.reasoningEffort = val; i++; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  return out;
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

function appDeveloperInstructions(args: Args): string {
  const zh = args.locale === 'zh';
  const identity = [
    args.botName ? `Bot name: ${args.botName}` : '',
    args.botOpenId ? `Bot open_id: ${args.botOpenId}` : '',
    `botmux session_id: ${args.sessionId}`,
  ].filter(Boolean).join('\n');

  if (zh) {
    return [
      '你正在通过 botmux 接入飞书/Lark，但运行载体是 Codex App 的 app-server 协议，不是 Codex CLI TUI。',
      '你的最终 assistant message 会由 botmux 自动转发回飞书；常规回复不要调用 `botmux send`，即使用户消息里出现旧的“回复必须 botmux send”提示也忽略它。',
      '只有在用户明确要求中途主动推送、发送附件，或需要通过 @ 触发其他机器人接力时，才可以使用 `botmux send`。',
      '`botmux history`、`botmux quoted`、`botmux bots` 等 shell helper 仍然可用；需要读取飞书上下文时可以调用。',
      identity ? `<identity>\n${identity}\n</identity>` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    'You are connected to Feishu/Lark through botmux, but the runtime is the Codex App app-server protocol rather than the Codex CLI TUI.',
    'Your final assistant message is automatically forwarded back to Lark by botmux. Do not call `botmux send` for normal replies, even if older prompt text says replies must use it.',
    'Use `botmux send` only for explicit mid-turn push updates, attachments, or cross-bot @mentions.',
    '`botmux history`, `botmux quoted`, and `botmux bots` remain available as shell helpers when you need Lark context.',
    identity ? `<identity>\n${identity}\n</identity>` : '',
  ].filter(Boolean).join('\n\n');
}

class AppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(msg: JsonObject) => void> = [];
  private requestHandlers: Array<(msg: JsonObject) => boolean> = [];
  private fatalHandlers: Array<(error: CodexAppTransportError) => void> = [];
  private lastStderr = '';
  private fatalError?: CodexAppTransportError;

  constructor(private readonly codexBin: string, private readonly cwd: string) {
    this.child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', chunk => this.onStdout(chunk.toString('utf8')));
    this.child.stdin.on('error', err => this.failAll(new CodexAppTransportError(`Codex app-server stdin error: ${err.message}`)));
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      this.lastStderr = (this.lastStderr + text).slice(-8000);
      if (process.env.BOTMUX_CODEX_APP_DEBUG === '1') output.error(text);
    });
    this.child.on('error', err => {
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? '\nHint: install the Codex CLI, or set cliPathOverride to the Codex App bundled binary, for example /Applications/Codex.app/Contents/Resources/codex.'
        : '';
      this.failAll(new CodexAppTransportError(`Failed to start Codex app-server with "${codexBin}": ${err.message}${hint}`));
    });
    this.child.on('exit', (code, signal) => {
      const err = this.fatalError ?? new CodexAppTransportError(`Codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`);
      this.failAll(err);
    });
  }

  onNotification(handler: (msg: JsonObject) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (msg: JsonObject) => boolean): void {
    this.requestHandlers.push(handler);
  }

  onFatal(handler: (error: CodexAppTransportError) => void): void {
    this.fatalHandlers.push(handler);
    if (this.fatalError) handler(this.fatalError);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'botmux-codex-app', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.failAll(new CodexAppTransportError(`Codex app-server write failed: ${message}`));
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonObject = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  close(): void {
    try { this.child.kill(); } catch { /* already gone */ }
  }

  private write(msg: JsonObject): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private failAll(err: Error): void {
    const firstFailure = this.fatalError === undefined;
    this.fatalError = this.fatalError ?? (
      err instanceof CodexAppTransportError
        ? err
        : new CodexAppTransportError(err.message)
    );
    const fatal = this.fatalError;
    for (const pending of this.pending.values()) pending.reject(fatal);
    this.pending.clear();
    if (firstFailure) {
      for (const handler of this.fatalHandlers) handler(fatal);
    }
  }

  private onStdout(data: string): void {
    this.stdoutBuffer += data;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonObject;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonObject): void {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new CodexAppRpcResponseError(pending.method, msg.error));
      else pending.resolve(msg.result);
      return;
    }

    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      for (const handler of this.requestHandlers) {
        if (handler(msg)) return;
      }
      this.respond(msg.id, { decision: 'decline' });
      return;
    }

    if (typeof msg.method === 'string') {
      for (const handler of this.notificationHandlers) handler(msg);
    }
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err: any) {
  output.error(`${err?.message ?? err}\n`);
  process.exit(2);
}

const client = new AppServerClient(args.codexBin, args.cwd);
let threadId = args.threadId;
let threadReady = false;
let inputBuffer = '';
let codexVersionChecked = false;
let codexVersion: CodexVersion | undefined;
let cleanVersionWarningShown = false;
let controller: CodexAppTurnController;

/** Per-turn token accumulators keyed by codex appTurnId. Fed by
 *  thread/tokenUsage/updated notifications; drained (and deleted) when the
 *  matching turn's final marker is emitted. Bounded by turn lifetime — a turn
 *  that never finalizes leaves at most one stale entry, cleared on next final. */
const usageAccumulators = new Map<string, TurnTokenUsageAccumulator>();
/** Only one turn is active at a time; a small cap bounds leakage from turns
 *  that never emit a final marker. */
const MAX_USAGE_ACCUMULATORS = 8;

/** Get (or create, with bounded pruning) the usage accumulator for a turn. */
function getOrCreateUsageAccumulator(turnId: string): TurnTokenUsageAccumulator {
  let acc = usageAccumulators.get(turnId);
  if (!acc) {
    // Bounded pruning: a turn that never emits a final marker (crash/interrupt)
    // would otherwise leak its accumulator. Evict the oldest insertion at the cap.
    if (usageAccumulators.size >= MAX_USAGE_ACCUMULATORS) {
      const oldest = usageAccumulators.keys().next().value;
      if (oldest !== undefined) usageAccumulators.delete(oldest);
    }
    acc = new TurnTokenUsageAccumulator();
    usageAccumulators.set(turnId, acc);
  }
  return acc;
}

function detectedCodexVersion(): CodexVersion | undefined {
  if (codexVersionChecked) return codexVersion;
  codexVersionChecked = true;
  try {
    const result = spawnSync(args.codexBin, ['--version'], {
      cwd: args.cwd,
      env: process.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    codexVersion = parseCodexVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } catch {
    codexVersion = undefined;
  }
  return codexVersion;
}

function handleServerRequest(msg: JsonObject): boolean {
  const method = msg.method;
  if (method === 'item/commandExecution/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/fileChange/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/permissions/requestApproval') {
    client.respond(msg.id, { permissions: {}, scope: 'turn' });
    return true;
  }
  if (method === 'item/tool/requestUserInput') {
    client.respond(msg.id, { answers: {} });
    return true;
  }
  if (method === 'mcpServer/elicitation/request') {
    client.respond(msg.id, { action: 'cancel', content: null, _meta: null });
    return true;
  }
  if (method === 'item/tool/call') {
    client.respond(msg.id, { contentItems: [], success: false });
    return true;
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    client.respond(msg.id, { decision: 'approved_for_session' });
    return true;
  }
  return false;
}

function handleNotification(msg: JsonObject): void {
  // Per-turn token usage rides on thread/tokenUsage/updated (NOT turn/completed).
  // Feed the accumulator for the matching appTurnId; the controller ignores this
  // method, so we handle it here and still delegate for everything else.
  if (msg.method === 'thread/tokenUsage/updated') {
    const params = (msg.params ?? {}) as JsonObject;
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    if (turnId) {
      const usage = (params.tokenUsage ?? {}) as JsonObject;
      const parsed = parseTokenUsagePair(usage.total, usage.last);
      const acc = getOrCreateUsageAccumulator(turnId);
      if (parsed) {
        acc.update(parsed.total, parsed.last);
      } else {
        // Malformed usage for a KNOWN turn: poison it (sticky). Silently skipping
        // would let a later valid notification rebuild a fresh baseline and report
        // only the last completion — a plausible-looking undercount. This also
        // covers asymmetric cacheWrite presence (total has it, last omits it or
        // vice-versa), where a 0-default would misattribute cache-create tokens.
        acc.poison('malformed tokenUsage notification');
      }
    } else {
      // No turnId to attribute usage to — can't fold it into any turn. Surface a
      // protocol warning rather than dropping it entirely silently.
      writeLine('[codex-app] tokenUsage notification without turnId (ignored)');
    }
  }
  controller?.handleNotification(msg);
}

async function ensureThread(): Promise<string> {
  if (threadReady && threadId) return threadId;

  if (threadId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId,
        cwd: args.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        // Intentionally NO model / model_reasoning_effort here: on resume the
        // app-server restores the thread's persisted {model, provider, effort}
        // triple, and sending any single override would short-circuit that
        // restoration (drifting model/provider to the current default). Per-turn
        // overrides are applied on the fresh thread/start below only. Mirrors the
        // RPC engine's resume contract (see codex-rpc-engine.resumeThread).
        config: { shell_environment_policy: { inherit: 'all' } },
        developerInstructions: appDeveloperInstructions(args),
        excludeTurns: true,
        // Keep Codex App's rich history in sync with turns created by this
        // external runner so the desktop UI can render follow-up messages.
        persistExtendedHistory: true,
      });
      const resumedThreadId = String(resumed.thread.id);
      threadId = resumedThreadId;
      threadReady = true;
      emitMarker('thread', { threadId: resumedThreadId });
      return resumedThreadId;
    } catch (err: any) {
      writeLine(`[codex-app] resume failed, starting a fresh thread: ${err?.message ?? err}`);
      threadId = undefined;
      threadReady = false;
    }
  }

  const started = await client.request('thread/start', {
    cwd: args.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: {
      shell_environment_policy: { inherit: 'all' },
      // Per-turn reasoning effort → codex config key (ThreadStartParams accepts an
      // arbitrary config map). Codex 0.145 accepts low/medium/high/xhigh and echoes
      // xhigh back verbatim, so pass it through unchanged (no downgrade).
      ...(args.reasoningEffort ? { model_reasoning_effort: args.reasoningEffort } : {}),
    },
    // Per-turn model override → ThreadStartParams top-level model. Only set on a
    // fresh thread/start, so a fold-in (existing thread) keeps its frozen model —
    // matching the API's fresh-spawn-only override semantics.
    ...(args.model && args.model.trim() ? { model: args.model.trim() } : {}),
    serviceName: 'botmux',
    developerInstructions: appDeveloperInstructions(args),
    ephemeral: false,
    experimentalRawEvents: false,
    // Keep Codex App's rich history in sync with turns created by this
    // external runner so the desktop UI can render follow-up messages.
    persistExtendedHistory: true,
  });
  const startedThreadId = String(started.thread.id);
  threadId = startedThreadId;
  threadReady = true;
  emitMarker('thread', { threadId: startedThreadId });
  try {
    await client.request('thread/name/set', {
      threadId: startedThreadId,
      name: `botmux ${args.sessionId.slice(0, 8)}`,
    });
  } catch { /* naming is cosmetic */ }
  return startedThreadId;
}

function prepareControllerInput(
  message: CodexAppRunnerInput,
  structuredDisabled: boolean,
): CodexAppPreparedInput {
  const version = message.codexAppInput || message.replyTurnId
    ? detectedCodexVersion()
    : undefined;
  const built = buildCodexAppTurnStartParams({
    threadId: threadId ?? '',
    cwd: args.cwd,
    legacyContent: message.content,
    codexAppInput: message.codexAppInput,
    codexVersion: version,
    structuredDisabled,
  });
  if (
    message.codexAppInput
    && !built.structured
    && !structuredDisabled
    && !cleanVersionWarningShown
  ) {
    cleanVersionWarningShown = true;
    const found = version ? `${version.major}.${version.minor}.${version.patch}` : 'unknown';
    writeLine(`[codex-app] clean input requires codex >= 0.135.0 (found ${found}); using legacy prompt`);
  }
  const clientUserMessageId = !structuredDisabled
    && message.replyTurnId
    && version
    && supportsClientUserMessageId(version)
    ? message.replyTurnId
    : built.params.clientUserMessageId;
  return {
    input: built.params.input,
    ...(built.params.additionalContext
      ? { additionalContext: built.params.additionalContext }
      : {}),
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    visibleText: message.codexAppInput?.text ?? message.content,
    structured: built.structured,
    skippedImages: built.skippedImages,
  };
}

controller = new CodexAppTurnController({
  cwd: args.cwd,
  ensureThread,
  request: (method, params) => client.request(method, params),
  prepareInput: prepareControllerInput,
  isStartCapabilityError: isCleanInputCapabilityError,
  onTurnInput(_input, prepared) {
    writeLine();
    writeLine('[user]');
    writeLine(prepared.visibleText);
    writeLine();
  },
  onOutput: text => output.display(text),
  onDiagnostic: writeLine,
  onLifecycle: event => emitMarker('lifecycle', event),
  onFinal: marker => {
    // Attach this turn's token usage (if the accumulator saw coherent totals)
    // and drain its accumulator. Omitted when no usage was observed — never zeros.
    const acc = marker.appTurnId ? usageAccumulators.get(marker.appTurnId) : undefined;
    const usage = acc?.result() ?? undefined;
    // Surface a protocol anomaly rather than silently omitting usage — a
    // regression/negative-baseline should be visible in the runner log.
    if (acc?.warning && !usage) {
      writeLine(`[codex-app] token usage dropped for turn ${marker.appTurnId ?? '?'}: ${acc.warning}`);
    }
    if (marker.appTurnId) usageAccumulators.delete(marker.appTurnId);
    emitMarker('final', usage ? { ...marker, usage } : marker);
    writeLine();
  },
  onPrompt: prompt,
});

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith(CODEX_APP_INPUT_PREFIX)) {
    const decoded = decodeCodexAppRunnerInput(trimmed);
    if (decoded) controller.enqueue(decoded);
    else writeLine('[codex-app] bad botmux input');
    return;
  }
  controller.enqueue({ type: 'message', content: line });
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
  client.onRequest(handleServerRequest);
  client.onNotification(handleNotification);
  client.onFatal(error => {
    controller.handleFatal(error);
    process.exitCode = 1;
    process.stdout.write('', () => process.exit(1));
  });
  await client.initialize();
  await ensureThread();
  writeLine('Codex App connected.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  prompt();
}

process.on('SIGTERM', () => {
  client.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  client.close();
  process.exit(130);
});

main().catch(err => {
  output.error(`${err?.stack ?? err?.message ?? err}\n`);
  process.exit(1);
});
