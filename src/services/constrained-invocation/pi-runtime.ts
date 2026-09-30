import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecureHostFileSync } from '../../platform/secure-host-file.js';
import { isObject, matchesSchema, type InvocationRequest, type InvocationResult } from './contract.js';
import { isolatedModelEnv, NativeInvocationError, type ModelOnlyRuntime, type NativeInvocationOutput } from './runtime.js';
import { collectNativePrint } from './print-process.js';

export function piUsage(raw: unknown): InvocationResult['usage'] {
  if (!isObject(raw)) return null;
  const valid = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (![raw.input, raw.output, raw.cacheRead, raw.cacheWrite].every(valid)) return null;
  return { inputTokens: raw.input + raw.cacheRead + raw.cacheWrite, outputTokens: raw.output, cachedInputTokens: raw.cacheRead, cacheWriteInputTokens: raw.cacheWrite };
}

/** auth.json may contain executable !command key resolvers. This mode accepts
 * native OAuth or literal API keys, never credential helpers or extensions. */
export function assertPiCredential(raw: string): void {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('native_auth_invalid'); }
  if (!isObject(value)) throw new Error('native_auth_invalid');
  for (const credential of Object.values(value)) {
    if (!isObject(credential) || !['api_key', 'oauth'].includes(credential.type)) throw new Error('native_auth_invalid');
    if (credential.type === 'api_key' && (typeof credential.key !== 'string' || credential.key.startsWith('!') || credential.env !== undefined)) throw new Error('native_auth_helper_unsupported');
  }
}

export async function runPiInvocation(request: InvocationRequest, runtime: ModelOnlyRuntime, signal: AbortSignal): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  const credential = readSecureHostFileSync(join(runtime.authHome, 'auth.json'));
  if (credential === null) throw new Error('native_auth_missing');
  assertPiCredential(credential);
  const root = mkdtempSync(join(tmpdir(), 'botmux-invocation-'));
  try {
    for (const name of ['home', 'agent', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
    writeFileSync(join(root, 'agent', 'auth.json'), credential, { mode: 0o600 });
    const env = isolatedModelEnv(join(root, 'home'), runtime.env ?? process.env, runtime.ownerOpenId);
    Object.assign(env, { PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0' });
    return await runIsolatedPi(request, { executable: runtime.executable, cwd: join(root, 'work'), env }, signal);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function runIsolatedPi(request: InvocationRequest, runtime: { executable: string; cwd: string; env: NodeJS.ProcessEnv }, signal: AbortSignal): Promise<NativeInvocationOutput> {
  const effort = request.reasoningEffort === 'none' ? 'off' : request.reasoningEffort;
  if (effort === 'ultra') throw new Error('native_reasoning_effort_unsupported');
  const telemetry: NativeInvocationOutput = { output: null, configuredModel: request.model, actualModel: null, reasoningEffort: request.reasoningEffort ?? null, usage: null, usageSource: null, startupMs: null };
  const startedAt = Date.now();
  let message: any;
  let ended = false;
  const args = ['--print', '--mode', 'json', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-session', '--offline',
    '--model', request.model, '--system-prompt', `Return only JSON matching this schema: ${JSON.stringify(request.outputSchema)}. Tool proposals are data for the caller.`];
  if (effort) args.push('--thinking', effort);
  try {
    await collectNativePrint(runtime.executable, args, { ...runtime, input: `Input for reasoning:\n${request.prompt}`, onLine: line => {
      let event: any;
      try { event = JSON.parse(line); } catch { throw new Error('native_protocol_invalid'); }
      if (!isObject(event)) throw new Error('native_protocol_invalid');
      if (event.type === 'agent_start') telemetry.startupMs = Date.now() - startedAt;
      if (event.type === 'tool_execution_start' || event.assistantMessageEvent?.type === 'toolcall_start') throw new Error('native_host_request_forbidden');
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        if (message) throw new Error('native_multiple_responses');
        message = event.message;
        telemetry.actualModel = typeof message.model === 'string' ? message.model : null;
        telemetry.usage = piUsage(message.usage);
        telemetry.usageSource = telemetry.usage ? 'native_result' : null;
        if (message.content?.some((item: any) => item.type === 'toolCall')) throw new Error('native_host_request_forbidden');
      }
      if (event.type === 'agent_end') ended = true;
    } }, signal);
    if (!ended || !message || message.stopReason !== 'stop' || !Array.isArray(message.content)) throw new Error('native_inference_incomplete');
    let answer: unknown;
    try { answer = JSON.parse(message.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('')); }
    catch { throw new Error('output_schema_mismatch'); }
    if (!matchesSchema(answer, request.outputSchema)) throw new Error('output_schema_mismatch');
    return { ...telemetry, output: answer };
  } catch (error) { throw new NativeInvocationError(error instanceof Error ? error.message : 'native_inference_failed', telemetry); }
}
