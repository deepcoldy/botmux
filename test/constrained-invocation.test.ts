import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvocationService } from '../src/services/constrained-invocation/service.js';
import { parseInvocation, matchesSchema } from '../src/services/constrained-invocation/contract.js';
import { assertConstrainedRuntime } from '../src/services/constrained-invocation/codex-profile.js';
import { modelOnlyCapabilities } from '../src/services/constrained-invocation/adapters.js';
import { nativeUsage, isolatedCatalog, isolatedInvocationEnv } from '../src/services/constrained-invocation/codex-runtime.js';
import { parseInvokeArgs } from '../src/cli/session-invoke-command.js';
import { claudeUsage } from '../src/services/constrained-invocation/claude-runtime.js';

const schema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false };
const request = (requestId = 'first') => ({ requestId, prompt: 'Reason about the supplied fixture', model: 'gpt-5.5', deadlineMs: 1000, outputSchema: schema });
const output = { output: { content: 'done' }, configuredModel: 'gpt-5.5', actualModel: null, reasoningEffort: 'high', startupMs: 12, usage: null, usageSource: null } as const;
const dirs: string[] = [];
const services: InvocationService[] = [];
function service(run: ConstructorParameters<typeof InvocationService>[0]['run'], maxConcurrent = 4) {
  const directory = mkdtempSync(join(tmpdir(), 'botmux-invocation-test-')); dirs.push(directory);
  const instance = new InvocationService({ directory, run, maxConcurrent }); services.push(instance);
  return { instance, directory };
}
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const abortable = (_request: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  if (signal.aborted) reject(new Error('aborted'));
  else signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 10), { once: true });
});

describe('constrained invocation contract', () => {
  it('rejects unsupported schema keywords and caller-controlled authority', () => {
    expect(() => parseInvocation({ ...request(), ownerOpenId: 'ou_other' })).toThrow();
    expect(() => parseInvocation({ ...request(), outputSchema: { ...schema, $ref: 'https://example.com/schema' } })).toThrow('unsupported_schema_keyword');
    expect(() => parseInvocation({ ...request(), outputSchema: { ...schema, required: [] } })).toThrow('schema_requires_all_properties');
    expect(matchesSchema({ content: 5 }, schema)).toBe(false);
    expect(matchesSchema({ content: 'ok', extra: true }, schema)).toBe(false);
  });
  it('checks CLI and platform without advertising a version or model allowlist', () => {
    expect(() => assertConstrainedRuntime('claude-code', 'linux')).toThrow();
    expect(() => assertConstrainedRuntime('codex', 'win32')).toThrow();
    expect(() => assertConstrainedRuntime('codex', 'linux')).not.toThrow();
    expect(modelOnlyCapabilities.versionPolicy).toBe('runtime_capabilities');
    expect(modelOnlyCapabilities).not.toHaveProperty('versions');
    expect(modelOnlyCapabilities).not.toHaveProperty('models');
  });
  it('accepts caller-selected models and keeps model changes in the idempotency contract', async () => {
    expect(parseInvocation({ ...request(), model: 'fixture-reasoner' }).model).toBe('fixture-reasoner');
    expect(() => parseInvocation({ ...request(), model: ' ' })).toThrow();
    const run = vi.fn(async (request: { model: string }) => ({ ...output, configuredModel: request.model }));
    const { instance } = service(run);
    instance.start({ ...request(), model: 'fixture-reasoner' });
    expect(() => instance.start(request())).toThrow('idempotency_conflict');
    expect((await instance.wait('first', 1000))?.configuredModel).toBe('fixture-reasoner');
  });
  it('disables model-advertised tools in a copy while preserving the selected model and transport', () => {
    const selected = { slug: 'fixture-reasoner', experimental_supported_tools: ['clock', 'send_user_message_async'], use_responses_lite: true, tool_mode: 'code_mode_only', context_window: 272000 };
    const catalog = { models: [{ ...selected, slug: 'gpt-5.5' }, selected] };
    expect(isolatedCatalog(catalog, 'fixture-reasoner').models).toEqual([{ ...selected, experimental_supported_tools: [], tool_mode: 'direct' }]);
    expect(selected.experimental_supported_tools).toEqual(['clock', 'send_user_message_async']);
    expect(selected.tool_mode).toBe('code_mode_only');
    expect(() => isolatedCatalog(catalog, 'missing-model')).toThrow('native_model_not_found');
  });
  it('removes inherited credentials, hooks and owner overrides', () => {
    const env = isolatedInvocationEnv('/isolated', '/isolated/codex', { PATH: '/bin', OPENAI_API_KEY: 'do-not-forward', NODE_OPTIONS: '--import hook', CODEX_HOME: '/foreign', BOTMUX_OWNER_OPEN_ID: 'ou_other', __OWNER_OPEN_ID: 'ou_other' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/isolated', CODEX_HOME: '/isolated/codex' });
    expect(isolatedInvocationEnv('/i', '/c', env, 'ou_owner').__OWNER_OPEN_ID).toBe('ou_owner');
  });
  it('reports unknown usage as null and does not invent cache writes', () => {
    expect(nativeUsage(undefined)).toBeNull();
    expect(nativeUsage({ inputTokens: 4, outputTokens: -1 })).toBeNull();
    expect(nativeUsage({ inputTokens: 4, outputTokens: 1, cachedInputTokens: 8 })).toBeNull();
    expect(nativeUsage({ inputTokens: 4, outputTokens: 1 })).toEqual({ inputTokens: 4, outputTokens: 1, cachedInputTokens: null, cacheWriteInputTokens: null });
  });
  it('normalizes Claude cache accounting without inventing missing metrics', () => {
    expect(claudeUsage({ input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 6, cache_creation_input_tokens: 3 })).toEqual({ inputTokens: 13, outputTokens: 2, cachedInputTokens: 6, cacheWriteInputTokens: 3 });
    expect(claudeUsage({ input_tokens: 4, output_tokens: 2 })?.cachedInputTokens).toBeNull();
    expect(claudeUsage({ input_tokens: 4, output_tokens: 2, cache_read_input_tokens: -1 })).toBeNull();
    expect(claudeUsage(undefined)).toBeNull();
  });
  it('keeps wait and deadline separate at the CLI boundary', () => {
    expect(parseInvokeArgs(['result', '--bot', 'fixture', '--request-id', 'r1', '--wait-ms', '50']).waitMs).toBe(50);
    expect(() => parseInvokeArgs(['start', '--bot', 'fixture', '--request-file', 'x', '--owner', 'other'])).toThrow();
  });
});

describe('invocation lifecycle', () => {
  it('reserves before execution and returns the same accepted/completed result', async () => {
    const run = vi.fn(async () => output); const { instance } = service(run);
    expect(instance.start(request()).state).toBe('running');
    expect(instance.start(request()).state).toBe('running');
    expect(() => instance.start({ ...request(), prompt: 'different round' })).toThrow('idempotency_conflict');
    expect((await instance.wait('first', 1000))?.state).toBe('completed');
    expect(instance.start(request()).output).toEqual(output.output);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('wait expiry leaves work running; cancellation waits for cleanup', async () => {
    const { instance } = service(abortable);
    instance.start(request());
    expect((await instance.wait('first', 5))?.state).toBe('running');
    expect((await instance.cancel('first'))?.state).toBe('cancelled');
    expect((await instance.cancel('first'))?.state).toBe('cancelled');
  });
  it('deadline aborts, awaits cleanup and releases capacity', async () => {
    const { instance } = service(abortable, 1);
    instance.start({ ...request(), deadlineMs: 100 });
    expect(() => instance.start(request('second'))).toThrow('invocation_capacity_exceeded');
    expect((await instance.wait('first', 1000))?.state).toBe('timed_out');
    expect(instance.start(request('second')).state).toBe('running');
    await instance.cancel('second');
  });
  it('isolates concurrent prompts and terminal results', async () => {
    const { instance } = service(async request => ({ ...output, output: { content: request.prompt } }));
    instance.start({ ...request('a'), prompt: 'secret-a' });
    instance.start({ ...request('b'), prompt: 'secret-b' });
    expect((await instance.wait('a', 1000))?.output).toEqual({ content: 'secret-a' });
    expect((await instance.wait('b', 1000))?.output).toEqual({ content: 'secret-b' });
  });
  it('persists failure without retriggering and retains no prompt in result files', async () => {
    const run = vi.fn(async () => { throw new Error('output_schema_mismatch'); });
    const { instance, directory } = service(run);
    instance.start(request());
    expect((await instance.wait('first', 1000))?.error).toBe('output_schema_mismatch');
    expect(instance.start(request()).state).toBe('failed');
    expect(run).toHaveBeenCalledTimes(1);
    expect(readdirSync(directory)).toEqual(['first.json']);
  });
  it('never replays an uncertain accepted request after process restart', async () => {
    const { instance, directory } = service(abortable);
    instance.start(request());
    const path = join(directory, 'first.json');
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    persisted.ownerPid = 2147483647;
    writeFileSync(path, JSON.stringify(persisted));
    const restartedRun = vi.fn(async () => output);
    const restarted = new InvocationService({ directory, run: restartedRun });
    expect(restarted.start(request()).error).toBe('interrupted_unknown_outcome');
    expect(restartedRun).not.toHaveBeenCalled();
    await instance.cancel('first');
  });
});
