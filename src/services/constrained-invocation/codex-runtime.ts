import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { readSecureHostFileSync } from '../../platform/secure-host-file.js';
import { provisionCodexAuth } from '../codex-auth-sync.js';
import { assertConstrainedRuntime, CONSTRAINED_CODEX_CONFIG } from './codex-profile.js';
import { isObject, matchesSchema, type InvocationRequest, type InvocationResult } from './contract.js';
import { isolatedModelEnv, NativeInvocationError, type NativeInvocationOutput } from './runtime.js';
export { NativeInvocationError, type NativeInvocationOutput } from './runtime.js';

export interface CodexInvocationRuntime {
  executable: string;
  authHome: string;
  catalogPath: string;
  ownerOpenId?: string;
  /** Only transport environment; no inherited CLI customization or credentials. */
  env?: NodeJS.ProcessEnv;
}

/** Native events report cumulative thread totals. A fresh thread per invocation
 * lets us replace each snapshot instead of summing duplicate/last-turn updates. */
export function nativeUsage(value: unknown): InvocationResult['usage'] {
  if (!isObject(value)) return null;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!count(value.inputTokens) || !count(value.outputTokens)) return null;
  if (value.cachedInputTokens !== undefined && !count(value.cachedInputTokens)) return null;
  if (value.cacheWriteInputTokens !== undefined && !count(value.cacheWriteInputTokens)) return null;
  if (value.cachedInputTokens > value.inputTokens) return null;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cachedInputTokens: value.cachedInputTokens ?? null, cacheWriteInputTokens: value.cacheWriteInputTokens ?? null };
}

export function isolatedInvocationEnv(home: string, codexHome: string, source: NodeJS.ProcessEnv, owner?: string): NodeJS.ProcessEnv {
  const env = isolatedModelEnv(home, source, owner);
  env.CODEX_HOME = codexHome;
  return env;
}

/** Model metadata can independently enable tools even when feature flags are
 * disabled. Disable those tools in the per-invocation catalog copy, preserving
 * the model identity, transport (including Responses Lite) and other metadata. */
export function isolatedCatalog(raw: unknown, modelId: string): { models: unknown[] } {
  if (!isObject(raw) || !Array.isArray(raw.models)) throw new Error('native_catalog_missing');
  const model = raw.models.find((m: any) => m?.slug === modelId);
  if (!model) throw new Error('native_model_not_found');
  return { models: [{ ...model, experimental_supported_tools: [], tool_mode: 'direct' }] };
}

export async function runCodexInvocation(
  request: InvocationRequest,
  runtime: CodexInvocationRuntime,
  signal: AbortSignal,
): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  const startedAt = Date.now();
  assertConstrainedRuntime('codex');
  if (readSecureHostFileSync(join(runtime.authHome, 'auth.json')) === null) throw new Error('native_auth_missing');
  const catalog = isolatedCatalog(JSON.parse(readFileSync(runtime.catalogPath, 'utf8')), request.model);
  const root = mkdtempSync(join(tmpdir(), 'botmux-invocation-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(work, { mode: 0o700 });
  try {
    // Existing Botmux native-auth provisioning, without parsing/exposing tokens.
    const codexHome = provisionCodexAuth({ botHome: root, mode: 'shared', globalCodexHome: runtime.authHome, log: () => {} });
    const catalogPath = join(root, 'models.json');
    writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    writeFileSync(join(codexHome, 'config.toml'), `model_catalog_json=${JSON.stringify(catalogPath)}\n${CONSTRAINED_CODEX_CONFIG}`, { mode: 0o600 });
    return await runIsolatedCodex(request, {
      executable: runtime.executable, cwd: work,
      env: isolatedInvocationEnv(home, codexHome, runtime.env ?? process.env, runtime.ownerOpenId),
      startedAt,
    }, signal);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Exported for the credential-free real-CLI fixture; callers must provision
 * an isolated config/home first. Never exposed as request-supplied options. */
export async function runIsolatedCodex(request: InvocationRequest, runtime: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv; startedAt?: number; onSpawn?: (pid: number) => void;
}, signal: AbortSignal): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  const startedAt = runtime.startedAt ?? Date.now();
  const child = spawn(runtime.executable, ['app-server', '--listen', 'stdio://'], {
    cwd: runtime.cwd, env: runtime.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  let id = 0;
  let threadId: string | undefined;
  let nativeTurnId: string | undefined;
  let configuredModel: string | null = null;
  let effort: string | null = null;
  let startupMs: number | null = null;
  let usage: InvocationResult['usage'] = null;
  let bytes = 0;
  let closed = false;
  let fatal: Error | undefined;
  let terminal: Record<string, any> | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let finish!: (value: Record<string, any>) => void;
  let fail!: (error: Error) => void;
  const done = new Promise<Record<string, any>>((resolve, reject) => { finish = resolve; fail = reject; });
  // Terminal errors can precede awaiting done during initialize/thread/start.
  void done.catch(() => {});
  const exit = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  const kill = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already exited */ } }
  };
  const rejectAll = (error: Error) => {
    fatal ??= error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    fail(error);
  };
  const abort = () => { rejectAll(new Error('invocation_aborted')); kill('SIGTERM'); };
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', () => rejectAll(new Error('native_spawn_failed')));
  child.once('close', () => rejectAll(new Error('native_process_exited')));
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8_000_000) rejectAll(new Error('native_output_limit')); });
  child.stdin.on('error', () => rejectAll(new Error('native_transport_closed')));
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 8_000_000) { rejectAll(new Error('native_output_limit')); kill('SIGTERM'); }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (bytes > 8_000_000) { rejectAll(new Error('native_output_limit')); kill('SIGTERM'); return; }
    let message: any;
    try { message = JSON.parse(line); } catch { rejectAll(new Error('native_protocol_invalid')); return; }
    if (!isObject(message)) { rejectAll(new Error('native_protocol_invalid')); return; }
    if (message.method && message.id !== undefined) {
      // Never reuse the interactive engine's auto-approval policy.
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Host tools are disabled' } })}\n`);
      rejectAll(new Error('native_host_request_forbidden'));
      kill('SIGTERM');
    } else if (message.id !== undefined) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) p?.reject(new Error(`native_rpc_error:${message.error.code ?? 'unknown'}`));
      else p?.resolve(message.result);
    } else if (message.params?.threadId === threadId) {
      const params = message.params;
      if (message.method === 'thread/tokenUsage/updated') {
        if (nativeTurnId && params.turnId !== nativeTurnId) return;
        usage = nativeUsage(params.tokenUsage?.total);
      }
      if (message.method === 'turn/completed') {
        terminal = params.turn;
        if (nativeTurnId && terminal?.id === nativeTurnId) finish(terminal!);
      }
    }
  });
  const rpc = (method: string, params: unknown): Promise<any> => {
    if (fatal) return Promise.reject(fatal);
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
  };
  try {
    if (child.pid) runtime.onSpawn?.(child.pid);
    if (signal.aborted) abort();
    await rpc('initialize', { clientInfo: { name: 'botmux-constrained', version: '1' }, capabilities: { experimentalApi: true } });
    const requirements = await rpc('configRequirements/read', {});
    if (requirements.requirements != null) throw new Error('managed_requirements_unsupported');
    const effective = await rpc('config/read', { includeLayers: true });
    const layers = effective.layers;
    if (!Array.isArray(layers)) throw new Error('native_config_isolation_unproven');
    const ownConfig = realpathSync(join(runtime.env.CODEX_HOME!, 'config.toml'));
    for (const layer of layers) {
      if (!Object.keys(layer.config ?? {}).length) continue;
      if (layer.name?.type !== 'user' || realpathSync(layer.name.file) !== ownConfig) throw new Error('native_config_isolation_unproven');
    }
    const own = layers.find((layer: any) => layer.name?.type === 'user')?.config;
    const cfg = effective.config;
    // Refuse managed policy overriding isolation, rather than overriding policy.
    if (!isObject(cfg) || cfg.web_search !== 'disabled' || cfg.project_doc_max_bytes !== 0
      || cfg.agents?.enabled !== false || cfg.orchestrator?.skills?.enabled !== false || cfg.orchestrator?.mcp?.enabled !== false
      || own?.tools?.update_plan?.enabled !== false || own?.tools?.experimental_request_user_input?.enabled !== false
      || cfg.notify || cfg.instructions || cfg.developer_instructions || cfg.model_instructions_file
      || Object.keys(cfg.mcp_servers ?? {}).length || Object.keys(cfg.plugins ?? {}).length || cfg.hooks) throw new Error('native_config_isolation_unproven');
    for (const line of CONSTRAINED_CODEX_CONFIG.split('[features]')[1].trim().split('\n')) {
      const [key, value] = line.split('=');
      if (cfg.features?.[key] !== (value === 'true')) throw new Error('native_feature_isolation_unproven');
    }
    const started = await rpc('thread/start', {
      model: request.model, cwd: runtime.cwd, ephemeral: true, environments: [], selectedCapabilityRoots: [],
      approvalPolicy: 'never', sandbox: 'read-only',
      baseInstructions: 'Perform structured reasoning on the supplied input. Return only the schema-conforming result. Tool proposals are data for the caller; no host tools are available.',
      developerInstructions: '',
      config: { model_reasoning_effort: request.reasoningEffort ?? 'high' },
    });
    threadId = started.thread?.id;
    if (!threadId || started.model !== request.model || started.thread.ephemeral !== true
      || !Array.isArray(started.instructionSources) || started.instructionSources.length !== 0
      || !Array.isArray(started.runtimeWorkspaceRoots) || started.runtimeWorkspaceRoots.length !== 0) throw new Error('native_thread_isolation_unproven');
    configuredModel = started.model;
    effort = started.reasoningEffort ?? null;
    startupMs = Date.now() - startedAt;
    const turn = await rpc('turn/start', {
      threadId, input: [{ type: 'text', text: request.prompt }], outputSchema: request.outputSchema,
    });
    nativeTurnId = turn.turn?.id;
    if (!nativeTurnId) throw new Error('native_turn_identity_missing');
    if (terminal?.id === nativeTurnId) finish(terminal);
    const final = await done;
    if (final.status !== 'completed') throw new Error(`native_turn_${final.status ?? 'unknown'}`);
    const messages = Array.isArray(final.items) ? final.items.filter((item: any) => item?.type === 'agentMessage') : undefined;
    if (!Array.isArray(messages) || messages.length !== 1) throw new Error('native_final_ambiguous');
    let output: unknown;
    try { output = JSON.parse(messages[0].text); } catch { throw new Error('output_schema_mismatch'); }
    if (!matchesSchema(output, request.outputSchema)) throw new Error('output_schema_mismatch');
    return { output, configuredModel, actualModel: null, reasoningEffort: effort, startupMs, usage, usageSource: usage ? 'native_thread_total' : null };
  } catch (error) {
    throw new NativeInvocationError(error instanceof Error ? error.message : 'native_invocation_failed', {
      output: null, configuredModel, actualModel: null, reasoningEffort: effort, startupMs, usage, usageSource: usage ? 'native_thread_total' : null,
    });
  } finally {
    signal.removeEventListener('abort', abort);
    lines.close();
    rejectAll(new Error('native_transport_closed'));
    child.stdin.end();
    kill('SIGTERM');
    // Never publish a terminal result while the owned process is still live.
    const timer = setTimeout(() => kill('SIGKILL'), 1000);
    if (!closed) await exit;
    clearTimeout(timer);
  }
}
