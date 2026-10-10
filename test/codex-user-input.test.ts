import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ post: vi.fn(), loopback: vi.fn(), claim: vi.fn(), daemon: vi.fn() }));
vi.mock('../src/core/daemon-ipc-auth.js', () => ({ fetchDaemonIpc: mocks.post }));
vi.mock('../src/core/loopback-fetch.js', () => ({ loopbackFetch: mocks.loopback }));
vi.mock('../src/core/managed-origin-capability.js', () => ({ readManagedOriginCapability: mocks.claim }));
vi.mock('../src/utils/daemon-discovery.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/daemon-discovery.js')>(), findOnlineDaemon: mocks.daemon,
}));
import { bridgeCodexUserInput, codexUserInputAnswer, parseCodexUserInputQuestions } from '../src/services/codex-user-input.js';
const params = { threadId: 'native-thread', turnId: 'native-turn', questions: [
  { id: 'environment', question: 'Choose environment', options: [
    { label: 'Staging (Recommended)', description: 'Test first' }, { label: 'Production', description: 'Live traffic' },
  ] },
  { id: '__proto__', question: 'Choose channel', multiSelect: true, options: [{ label: 'Lark' }, { label: 'Email' }] },
] };
const result = { kind: 'answered' as const, answers: [['Staging (Recommended)'], ['Lark', 'Email']], by: 'answerer', comment: null, timedOut: false as const };
const context = { sessionId: 'session', larkAppId: 'app', chatId: 'chat', rootMessageId: 'om_root', originTurnId: 'reply-turn', env: {} };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.daemon.mockReturnValue({ ipcPort: 12345 });
  mocks.post.mockResolvedValue(Response.json(result));
  mocks.loopback.mockResolvedValue(Response.json(result));
});
describe('Codex native user input bridge', () => {
  it('preserves question ids, option labels and descriptions without accepting a recommended answer automatically', () => {
    const questions = parseCodexUserInputQuestions(params);
    expect(questions[0].question.prompt).toContain('Production: Live traffic');
    expect(questions[0].question.defaultSelectedKeys).toBeUndefined();
    expect(codexUserInputAnswer(questions, result)).toEqual({ answers: {
      environment: { answers: ['Staging (Recommended)'] }, ['__proto__']: { answers: ['Lark', 'Email'] },
    } });
  });
  it('returns custom text for the entire batch without mixing in unsubmitted defaults', () => {
    expect(codexUserInputAnswer(parseCodexUserInputQuestions(params), {
      ...result, answers: [[], []], comment: 'Use staging and notify in Lark',
    }).answers.environment.answers).toEqual(['Use staging and notify in Lark']);
  });
  it.each([
    { questions: [params.questions[0], { id: 'invalid', question: 'Explain', options: [] }] },
    { questions: [{ ...params.questions[0], isSecret: true }] },
    { questions: [params.questions[0], params.questions[0]] },
    { questions: [{ id: 'duplicate', options: [{ label: 'Yes' }, { label: 'Yes' }] }] },
  ])('rejects the whole unsupported/malformed batch: %j', unsupported => {
    expect(() => parseCodexUserInputQuestions(unsupported)).toThrow();
  });
  it.each([
    { kind: 'timedOut', timedOut: true }, { kind: 'invalidated', reason: 'cancelled' },
    { ...result, answers: [[]] }, { ...result, answers: [['unknown'], []] }, { ...result, answers: [[], []] },
  ])('never converts a failed or incomplete result to empty success: %j', bad => {
    expect(() => codexUserInputAnswer(parseCodexUserInputQuestions(params), bad as any)).toThrow();
  });
  it('posts the whole batch with trusted-host auth and frozen reply identity', async () => {
    await expect(bridgeCodexUserInput(context, params)).resolves.toEqual(codexUserInputAnswer(parseCodexUserInputQuestions(params), result));
    const [port, route, init] = mocks.post.mock.calls[0];
    expect([port, route]).toEqual([12345, '/api/asks']);
    expect(JSON.parse(init.body)).toMatchObject({ originTurnId: 'reply-turn', rootMessageId: 'om_root',
      originKind: 'native-user-input', questions: [{ prompt: expect.stringContaining('Test first') }, {}] });
    expect(mocks.loopback).not.toHaveBeenCalled();
  });
  it('uses the live capability and port in a read-isolated runner instead of accessing the host secret', async () => {
    mocks.claim.mockReturnValue({ capability: 'token', turnId: 'reply-turn', dispatchAttempt: 3, ipcPort: 23456 });
    await bridgeCodexUserInput({ ...context, rootMessageId: 'oc_chat', env: { BOTMUX_SEND_RELAY: '/relay' } }, params);
    expect(mocks.loopback.mock.calls[0][0]).toBe('http://127.0.0.1:23456/api/asks');
    expect(JSON.parse(mocks.loopback.mock.calls[0][1].body)).toMatchObject({ rootMessageId: null,
      originCapability: 'token', originTurnId: 'reply-turn', originDispatchAttempt: 3 });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('rejects stale capability, missing isolation capability and workflow asks before posting', async () => {
    mocks.claim.mockReturnValue({ capability: 'token', turnId: 'other-turn' });
    await expect(bridgeCodexUserInput(context, params)).rejects.toThrow('current Botmux turn');
    mocks.claim.mockReturnValue(null);
    await expect(bridgeCodexUserInput({ ...context, env: { BOTMUX_SEND_RELAY: '/relay' } }, params)).rejects.toThrow('no live');
    await expect(bridgeCodexUserInput({ ...context, env: { BOTMUX_WORKFLOW: '1' } }, params)).rejects.toThrow('workflow');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.loopback).not.toHaveBeenCalled();
  });
  it('surfaces daemon refusal and aborts instead of returning empty answers', async () => {
    mocks.post.mockResolvedValue(new Response('unsupported', { status: 400 }));
    await expect(bridgeCodexUserInput(context, params)).rejects.toThrow('HTTP 400');
    const controller = new AbortController(); controller.abort();
    await expect(bridgeCodexUserInput(context, params, controller.signal)).rejects.toThrow();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
