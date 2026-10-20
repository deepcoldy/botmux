import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { readSecureHostFileSync } from '../../platform/secure-host-file.js';
import { isObject, matchesSchema, type InvocationRequest } from './contract.js';
import { isolatedModelEnv, NativeInvocationError, type ModelOnlyRuntime, type NativeInvocationOutput } from './runtime.js';
import { collectNativePrint } from './print-process.js';

export async function runOpenCodeInvocation(request: InvocationRequest, runtime: ModelOnlyRuntime, signal: AbortSignal): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  const managed = process.platform === 'darwin' ? [
    '/Library/Application Support/opencode', '/Library/Managed Preferences/ai.opencode.managed.plist',
    join('/Library/Managed Preferences', userInfo().username, 'ai.opencode.managed.plist'),
  ] : ['/etc/opencode'];
  if (managed.some(path => existsSync(path))) throw new Error('managed_requirements_unsupported');
  const credential = readSecureHostFileSync(join(runtime.authHome, 'auth.json'));
  if (credential === null) throw new Error('native_auth_missing');
  // Remote well-known auth entries may import configuration and executable
  // plugins. Only native API/OAuth records belong to this isolated mode.
  let auth: unknown;
  try { auth = JSON.parse(credential); } catch { throw new Error('native_auth_invalid'); }
  if (!isObject(auth) || Object.values(auth).some(value => !isObject(value) || !['api', 'oauth'].includes(value.type))) throw new Error('native_auth_helper_unsupported');
  const root = mkdtempSync(join(tmpdir(), 'botmux-invocation-'));
  try {
    mkdirSync(join(root, 'home', '.local', 'share', 'opencode'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'work'), { mode: 0o700 });
    writeFileSync(join(root, 'home', '.local', 'share', 'opencode', 'auth.json'), credential, { mode: 0o600 });
    const env = isolatedModelEnv(join(root, 'home'), runtime.env ?? process.env, runtime.ownerOpenId);
    return await runIsolatedOpenCode(request, { executable: runtime.executable, cwd: join(root, 'work'), env }, signal);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function runIsolatedOpenCode(request: InvocationRequest, runtime: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv;
  /** Only native protocol fixtures supply a synthetic provider. */
  fixtureProvider?: Record<string, unknown>;
}, signal: AbortSignal): Promise<NativeInvocationOutput> {
  const config = {
    autoupdate: false, share: 'disabled', permission: { '*': 'deny' }, compaction: { auto: false, prune: false },
    agent: {
      title: { disable: true }, summary: { disable: true }, compaction: { disable: true },
      modelonly: { mode: 'primary', prompt: `Return only JSON matching this schema: ${JSON.stringify(request.outputSchema)}. Tool proposals are data for the caller.`, permission: { '*': 'deny' } },
    },
    ...(runtime.fixtureProvider ? { provider: runtime.fixtureProvider } : {}),
  };
  const env = { ...runtime.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' };
  const args = ['run', '--pure', '--format', 'json', '--agent', 'modelonly', `--model=${request.model}`];
  if (request.reasoningEffort) args.push(`--variant=${request.reasoningEffort}`);
  const telemetry: NativeInvocationOutput = { output: null, configuredModel: request.model, actualModel: null, reasoningEffort: request.reasoningEffort ?? null, usage: null, usageSource: null, startupMs: null };
  const startedAt = Date.now(); const texts = new Map<string, string>(); let complete = false;
  try {
    await collectNativePrint(runtime.executable, args, { cwd: runtime.cwd, env, input: JSON.stringify({ input: request.prompt }).replace(/@/g, '\\u0040'), onLine: line => {
      let event: any;
      try { event = JSON.parse(line); } catch { throw new Error('native_protocol_invalid'); }
      if (!isObject(event)) throw new Error('native_protocol_invalid');
      if (event.type === 'tool_use' || event.part?.type === 'tool') throw new Error('native_host_request_forbidden');
      if (event.type === 'error') throw new Error('native_inference_failed');
      if (event.type === 'step_start') {
        if (telemetry.startupMs !== null) throw new Error('native_multiple_responses');
        telemetry.startupMs = Date.now() - startedAt;
      }
      if (event.type === 'text') {
        if (typeof event.part?.id !== 'string' || typeof event.part?.text !== 'string') throw new Error('native_protocol_invalid');
        texts.set(event.part.id, event.part.text);
      }
      if (event.type === 'step_finish') {
        if (event.part?.reason !== 'stop') throw new Error(event.part?.reason === 'tool-calls' ? 'native_host_request_forbidden' : 'native_inference_incomplete');
        complete = true;
        const t = event.part.tokens;
        const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
        if (isObject(t) && [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write].every(count)) {
          telemetry.usage = { inputTokens: t.input + t.cache.read + t.cache.write, outputTokens: t.output + t.reasoning, cachedInputTokens: t.cache.read, cacheWriteInputTokens: t.cache.write };
          telemetry.usageSource = 'native_result';
        }
      }
    } }, signal);
    if (!complete) throw new Error('native_inference_incomplete');
    let output: unknown;
    try { output = JSON.parse([...texts.values()].join('')); } catch { throw new Error('output_schema_mismatch'); }
    if (!matchesSchema(output, request.outputSchema)) throw new Error('output_schema_mismatch');
    return { ...telemetry, output };
  } catch (error) { throw new NativeInvocationError(error instanceof Error ? error.message : 'native_inference_failed', telemetry); }
}
