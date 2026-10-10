import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { readSecureHostFileSync } from '../../platform/secure-host-file.js';
import { isObject, matchesSchema, type InvocationRequest, type InvocationResult } from './contract.js';
import { isolatedModelEnv, NativeInvocationError, type ModelOnlyRuntime, type NativeInvocationOutput } from './runtime.js';
import { spawnOwnedModelProcess } from './native-process.js';

/** Claude reports uncached input separately from cache reads/writes. */
export function claudeUsage(raw: unknown): InvocationResult['usage'] {
  if (!isObject(raw)) return null;
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!count(raw.input_tokens) || !count(raw.output_tokens)) return null;
  if (raw.cache_read_input_tokens !== undefined && !count(raw.cache_read_input_tokens)) return null;
  if (raw.cache_creation_input_tokens !== undefined && !count(raw.cache_creation_input_tokens)) return null;
  return {
    inputTokens: raw.input_tokens + (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0),
    outputTokens: raw.output_tokens,
    cachedInputTokens: raw.cache_read_input_tokens ?? null,
    cacheWriteInputTokens: raw.cache_creation_input_tokens ?? null,
  };
}

export async function runClaudeInvocation(request: InvocationRequest, runtime: ModelOnlyRuntime, signal: AbortSignal): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('constrained_capability_unsupported');
  // Managed policy must not be silently bypassed by this isolated mode.
  if (['/etc/claude-code/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.json'].some(path => existsSync(path))) throw new Error('managed_requirements_unsupported');
  const credential = readSecureHostFileSync(join(runtime.authHome, '.credentials.json'));
  if (credential === null) throw new Error('native_auth_missing');
  const startedAt = Date.now();
  const root = mkdtempSync(join(tmpdir(), 'botmux-invocation-'));
  try {
    for (const name of ['home', 'claude', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
    writeFileSync(join(root, 'claude', '.credentials.json'), credential, { mode: 0o600 });
    const env = isolatedModelEnv(join(root, 'home'), runtime.env ?? process.env, runtime.ownerOpenId);
    env.CLAUDE_CONFIG_DIR = join(root, 'claude');
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    return await runIsolatedClaude(request, { executable: runtime.executable, cwd: join(root, 'work'), env, startedAt }, signal);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Native print/stream-json protocol. The input pipe stays open until a terminal
 * result; no TUI, global settings, resume, or automatic permission approval. */
export async function runIsolatedClaude(request: InvocationRequest, runtime: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv; startedAt?: number; onSpawn?: (pid: number) => void;
}, signal: AbortSignal): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  const startedAt = runtime.startedAt ?? Date.now();
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--safe-mode', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence', '--settings', '{"disableAllHooks":true}',
    `--model=${request.model}`, '--json-schema', JSON.stringify(request.outputSchema),
    '--system-prompt', 'Reason only over the supplied input. Return the requested structured answer. Tool proposals are data for the caller, not executable actions.'];
  if (request.reasoningEffort) args.push('--effort', request.reasoningEffort);
  // Native generation budget, not post-hoc truncation. This applies to each
  // native model request (including serialization); aggregate usage stays native.
  const env = { ...runtime.env };
  if (request.maxOutputTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxOutputTokens);
  const child = spawnOwnedModelProcess(runtime.executable, args, { ...runtime, env });
  let closed = false;
  let bytes = 0;
  let initialized = false;
  const telemetry: NativeInvocationOutput = { output: null, configuredModel: null, actualModel: null, reasoningEffort: request.reasoningEffort ?? null, usage: null, usageSource: null, startupMs: null };
  const exited = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  const kill = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
  };
  let resolve!: (result: NativeInvocationOutput) => void;
  let reject!: (error: Error) => void;
  const done = new Promise<NativeInvocationOutput>((yes, no) => { resolve = yes; reject = no; });
  const fail = (reason: string) => { reject(new NativeInvocationError(reason, telemetry)); kill('SIGTERM'); };
  const abort = () => fail('invocation_aborted');
  signal.addEventListener('abort', abort, { once: true });
  const countBytes = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8_000_000) fail('native_output_limit'); };
  child.stdout.on('data', countBytes); child.stderr.on('data', countBytes);
  child.once('error', () => fail('native_spawn_failed'));
  child.once('close', () => reject(new NativeInvocationError('native_process_exited', telemetry)));
  child.stdin.on('error', () => fail('native_transport_closed'));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (bytes > 8_000_000) return;
    let event: any;
    try { event = JSON.parse(line); } catch { fail('native_protocol_invalid'); return; }
    if (!isObject(event)) { fail('native_protocol_invalid'); return; }
    if (event.type === 'system' && event.subtype === 'init') {
      // StructuredOutput is a native serialization tool, never a host action.
      if (!Array.isArray(event.tools) || event.tools.some((name: string) => name !== 'StructuredOutput') || event.mcp_servers?.length) { fail('native_tool_isolation_unproven'); return; }
      initialized = true;
      telemetry.configuredModel = typeof event.model === 'string' ? event.model : request.model;
      telemetry.startupMs = Date.now() - startedAt;
    }
    if (event.type === 'assistant') {
      if (typeof event.message?.model === 'string') telemetry.actualModel = event.message.model;
      if (event.message?.content?.some((item: any) => item.type === 'tool_use' && item.name !== 'StructuredOutput')) fail('native_host_request_forbidden');
    }
    if (event.type === 'result') {
      telemetry.usage = claudeUsage(event.usage);
      telemetry.usageSource = telemetry.usage ? 'native_result' : null;
      if (!initialized) { fail('native_tool_isolation_unproven'); return; }
      if (event.is_error || event.subtype !== 'success') { fail('native_inference_failed'); return; }
      if (!matchesSchema(event.structured_output, request.outputSchema)) { fail('output_schema_mismatch'); return; }
      telemetry.output = event.structured_output;
      resolve(telemetry);
    }
  });
  try {
    if (child.pid) runtime.onSpawn?.(child.pid);
    if (signal.aborted) abort();
    else child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: request.prompt } })}\n`);
    return await done;
  } finally {
    signal.removeEventListener('abort', abort);
    child.stdin.end();
    if (!closed) kill('SIGTERM');
    const hardKill = setTimeout(() => kill('SIGKILL'), 1000);
    try { await exited; } finally { clearTimeout(hardKill); lines.close(); }
  }
}
