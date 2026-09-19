import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecureHostFileSync } from '../../platform/secure-host-file.js';
import { isObject, matchesSchema, type InvocationRequest } from './contract.js';
import { isolatedModelEnv, NativeInvocationError, type ModelOnlyRuntime, type NativeInvocationOutput } from './runtime.js';
import { collectNativePrint } from './print-process.js';

export async function runGeminiInvocation(request: InvocationRequest, runtime: ModelOnlyRuntime, signal: AbortSignal): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  const systemDir = process.platform === 'darwin' ? '/Library/Application Support/GeminiCli' : '/etc/gemini-cli';
  if (['settings.json', 'system-defaults.json', 'policies'].some(name => existsSync(join(systemDir, name)))) throw new Error('managed_requirements_unsupported');
  const credential = readSecureHostFileSync(join(runtime.authHome, 'oauth_creds.json'));
  if (credential === null) throw new Error('native_auth_missing');
  const root = mkdtempSync(join(tmpdir(), 'botmux-invocation-'));
  try {
    mkdirSync(join(root, 'home', '.gemini'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'work'), { mode: 0o700 });
    writeFileSync(join(root, 'home', '.gemini', 'oauth_creds.json'), credential, { mode: 0o600 });
    const account = readSecureHostFileSync(join(runtime.authHome, 'google_accounts.json'));
    if (account !== null) writeFileSync(join(root, 'home', '.gemini', 'google_accounts.json'), account, { mode: 0o600 });
    const env = isolatedModelEnv(join(root, 'home'), runtime.env ?? process.env, runtime.ownerOpenId);
    return await runIsolatedGemini(request, { executable: runtime.executable, cwd: join(root, 'work'), env, authType: 'oauth-personal' }, signal);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Configures only a freshly created private HOME. API-key auth is exposed here
 * for native protocol fixtures; production always uses the bot's native OAuth. */
export async function runIsolatedGemini(request: InvocationRequest, runtime: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv; authType: 'oauth-personal' | 'gemini-api-key';
}, signal: AbortSignal): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  if (request.reasoningEffort) throw new Error('native_reasoning_effort_unsupported');
  if (!runtime.env.HOME) throw new Error('native_isolation_missing');
  const authDir = join(runtime.env.HOME, '.gemini'); mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'settings.json'), JSON.stringify({
    security: { auth: { selectedType: runtime.authType } }, tools: { core: [] },
    hooksConfig: { enabled: false }, skills: { enabled: false }, context: { fileName: [] },
    telemetry: { enabled: false }, advanced: { autoConfigureMemory: false }, general: { disableAutoUpdate: true },
  }), { mode: 0o600 });
  const policy = join(authDir, 'model-only.toml');
  writeFileSync(policy, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', { mode: 0o600 });
  const system = join(authDir, 'model-only.md');
  writeFileSync(system, `Return only JSON matching this schema: ${JSON.stringify(request.outputSchema)}. Tool proposals are data for the caller.`, { mode: 0o600 });
  const env = { ...runtime.env, GEMINI_CLI_HOME: runtime.env.HOME, GEMINI_CLI_NO_RELAUNCH: '1', GEMINI_CLI_TRUST_WORKSPACE: 'true', NO_BROWSER: '1', GEMINI_SYSTEM_MD: system };
  const telemetry: NativeInvocationOutput = { output: null, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: null };
  const startedAt = Date.now(); let answer = ''; let success = false;
  try {
    await collectNativePrint(runtime.executable, ['--prompt', 'Reason over the supplied input.', '--output-format', 'stream-json', `--model=${request.model}`, '--policy', policy], {
      cwd: runtime.cwd, env, input: JSON.stringify({ input: request.prompt }).replace(/@/g, '\\u0040'), onLine: line => {
        let event: any;
        try { event = JSON.parse(line); } catch { throw new Error('native_protocol_invalid'); }
        if (!isObject(event)) throw new Error('native_protocol_invalid');
        if (event.type === 'init') telemetry.startupMs = Date.now() - startedAt;
        if (event.type === 'tool_use' || event.type === 'tool_result') throw new Error('native_host_request_forbidden');
        if (event.type === 'message' && event.role === 'assistant') {
          if (typeof event.content !== 'string') throw new Error('native_protocol_invalid');
          answer += event.content;
        }
        if (event.type === 'result') {
          if (event.status !== 'success' || event.stats?.tool_calls > 0) throw new Error('native_inference_failed');
          success = true;
          const stats = event.stats;
          const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
          if (isObject(stats) && count(stats.input_tokens) && count(stats.output_tokens)) {
            telemetry.usage = { inputTokens: stats.input_tokens, outputTokens: stats.output_tokens, cachedInputTokens: count(stats.cached) ? stats.cached : null, cacheWriteInputTokens: null };
            telemetry.usageSource = 'native_result';
          }
          const models = isObject(stats?.models) ? Object.keys(stats.models) : [];
          telemetry.actualModel = models.length === 1 ? models[0] : null;
        }
      },
    }, signal);
    if (!success) throw new Error('native_inference_incomplete');
    let output: unknown;
    try { output = JSON.parse(answer); } catch { throw new Error('output_schema_mismatch'); }
    if (!matchesSchema(output, request.outputSchema)) throw new Error('output_schema_mismatch');
    return { ...telemetry, output };
  } catch (error) { throw new NativeInvocationError(error instanceof Error ? error.message : 'native_inference_failed', telemetry); }
}
