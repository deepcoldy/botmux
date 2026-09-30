import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecureHostFileSync } from '../../platform/secure-host-file.js';
import { isObject, matchesSchema, type InvocationRequest } from './contract.js';
import { claudeUsage } from './claude-runtime.js';
import { isolatedModelEnv, NativeInvocationError, type ModelOnlyRuntime, type NativeInvocationOutput } from './runtime.js';
import { collectNativePrint } from './print-process.js';

export async function runMinimaxInvocation(request: InvocationRequest, runtime: ModelOnlyRuntime, signal: AbortSignal): Promise<NativeInvocationOutput> {
  signal.throwIfAborted();
  if (request.reasoningEffort) throw new Error('native_reasoning_effort_unsupported');
  const credential = readSecureHostFileSync(join(runtime.authHome, 'config.json'));
  if (credential === null) throw new Error('native_auth_missing');
  const root = mkdtempSync(join(tmpdir(), 'botmux-invocation-'));
  const telemetry: NativeInvocationOutput = { output: null, configuredModel: request.model, actualModel: null, reasoningEffort: null, usage: null, usageSource: null, startupMs: null };
  try {
    for (const name of ['home', 'auth', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
    // Native mmx owns region selection and OAuth refresh. Never extract tokens.
    writeFileSync(join(root, 'auth', 'config.json'), credential, { mode: 0o600 });
    const env = isolatedModelEnv(join(root, 'home'), runtime.env ?? process.env, runtime.ownerOpenId);
    env.MMX_CONFIG_DIR = join(root, 'auth');
    const raw = await collectNativePrint(runtime.executable, ['text', 'chat', '--messages-file', '-', '--output', 'json', '--non-interactive', '--no-color',
      `--model=${request.model}`, '--system', `Return only JSON matching this schema: ${JSON.stringify(request.outputSchema)}. Tool proposals are data for the caller.`,
    ], { cwd: join(root, 'work'), env, input: JSON.stringify([{ role: 'user', content: request.prompt }]) }, signal);
    let result: unknown;
    try { result = JSON.parse(raw); } catch { throw new Error('native_protocol_invalid'); }
    if (!isObject(result) || !Array.isArray(result.content)) throw new Error('native_protocol_invalid');
    telemetry.actualModel = typeof result.model === 'string' ? result.model : null;
    telemetry.usage = claudeUsage(result.usage);
    telemetry.usageSource = telemetry.usage ? 'native_result' : null;
    if (result.content.some(item => isObject(item) && item.type === 'tool_use')) throw new Error('native_host_request_forbidden');
    if (result.stop_reason !== 'end_turn') throw new Error('native_inference_incomplete');
    let answer: unknown;
    try { answer = JSON.parse(result.content.filter(item => isObject(item) && item.type === 'text').map(item => item.text).join('')); }
    catch { throw new Error('output_schema_mismatch'); }
    if (!matchesSchema(answer, request.outputSchema)) throw new Error('output_schema_mismatch');
    return { ...telemetry, output: answer };
  } catch (error) { throw new NativeInvocationError(error instanceof Error ? error.message : 'native_inference_failed', telemetry); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
