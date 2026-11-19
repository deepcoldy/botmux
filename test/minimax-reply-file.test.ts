import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { prepareReplyFile } from '../src/im/lark/reply-file.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('MiniMax reply file transport', () => {
  it('scrubs a link-dense multi-MB attachment outside the caller and reuses its bytes on retry', async () => {
    const source = '[site](https://example.com/page) http://localhost/note\n'.repeat(40_000);
    const policy = { internalFileLabel: '[private]' };
    const first = await prepareReplyFile(source, policy);
    expect(first.bytes.equals(Buffer.from('[site](https://example.com/page) [private]\n'.repeat(40_000)))).toBe(true);
    expect(await prepareReplyFile(source, policy, first)).toBe(first);
    const changedPolicy = await prepareReplyFile(source, { disabled: true }, first);
    expect(changedPolicy.bytes.equals(Buffer.from(source))).toBe(true);
    const changedBody = await prepareReplyFile('new body', policy, first);
    expect(changedBody.bytes.toString()).toBe('new body');
  });

  it('reports the failing stage and exit status without including reply text', async () => {
    const context = { workspaceRoots: [null as unknown as string] };
    await expect(prepareReplyFile('private reply', context))
      .rejects.toThrow(/^MiniMax reply file sanitizer failed \(stage=sanitize, code=1, signal=-\)$/);
  });

  it('carries an exact 8 MB final_output from the worker over a real daemon IPC channel', async () => {
    const child = spawnTsEvalWithRepoImports(`
      import { loadWorkerFunction } from './test/helpers/worker-function-harness.ts';
      const scope = {
        sessionId: 'session', isWorkflowWorker: () => false,
        turnExecutionClock: { peek: () => undefined }, frozenTurnLinkRefMode: () => undefined,
        sessionEventMetadata: message => message,
      };
      scope.workerIpcPayload = loadWorkerFunction('workerIpcPayload', scope);
      const send = loadWorkerFunction('send', scope);
      process.once('message', () => process.disconnect());
      send({ type: 'final_output', turnId: 'turn', dispatchAttempt: 2, content: '甲\\0'.repeat(2_000_000) });
    `, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const closed = once(child, 'close');
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    try {
      const [message] = await Promise.race([
        once(child, 'message'),
        closed.then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); }),
      ]);
      expect(message).toMatchObject({ type: 'final_output', turnId: 'turn', dispatchAttempt: 2, sessionId: 'session' });
      expect(Buffer.from(message.content).equals(Buffer.from('甲\0'.repeat(2_000_000)))).toBe(true);
      child.send('received');
      expect((await closed)[0]).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });
});
