/**
 * A2-companion — feishu-send-demo end-to-end with mocked Feishu client.
 *
 * Drives the same dispatchWork → executeSideEffect → invoke path that
 * production uses, but stubs `../src/im/lark/client.js` so no real Feishu
 * call is made.  Confirms:
 *   1. The default registry routes `executor: "feishu-send"` to the
 *      feishuSendExecutor without extra wiring at the workflow author's
 *      end.
 *   2. The runtime-derived `idempotencyKey` flows through invoke() to
 *      `sendMessage(..., uuid)` — that's the contract that makes Feishu
 *      dedupe possible on resume.
 *   3. activitySucceeded's `outputRef` blob carries
 *      `{ output: {messageId}, externalRefs: {messageId} }`.
 *
 * Deliberately no real-API CLI dogfood — user must explicitly pick a
 * test chatId before that's safe to run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { runLoop } from '../src/workflows/loop.js';
import { createRun } from '../src/workflows/run-init.js';

const FIXTURE_PATH = join(__dirname, '..', 'workflows', 'feishu-send-demo.workflow.json');

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'wf-a2-runs-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  vi.doUnmock('../src/im/lark/client.js');
  vi.resetModules();
});

describe('feishu-send-demo workflow — A2 dogfood (mocked client)', () => {
  it('drives feishu-send end-to-end via mock and lands externalRefs.messageId', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => 'om_demo_123');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));

    const { createDefaultHostExecutorRegistry } = await import(
      '../src/workflows/hostExecutors/registry.js'
    );
    const { createStubSpawnFn } = await import('../src/workflows/spawn-bot.js');

    const raw = await fs.readFile(FIXTURE_PATH, 'utf-8');
    const def = parseWorkflowDefinition(JSON.parse(raw));
    expect(def.workflowId).toBe('feishu-send-demo');

    const runId = `feishu-send-demo-${Date.now()}`;
    const log = new EventLog(runId, runsDir);

    await createRun(log, {
      def,
      params: {},
      initiator: 'a2-companion-test',
      botResolver: () => ({}),
    });

    const ctx = {
      log,
      def,
      spawnSubagent: createStubSpawnFn(() => ({ never: 'called' })),
      hostExecutors: createDefaultHostExecutorRegistry(),
    };
    const result = await runLoop(ctx, { maxTicks: 50 });

    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'effectAttempted',
      'activitySucceeded',
      'nodeSucceeded',
      'runSucceeded',
    ]);

    // sendMessage was called with placeholder ids from the fixture +
    // runtime-minted idempotencyKey (5-tuple hash).
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = sendMessage.mock.calls[0];
    expect(callArgs[0]).toBe('cli_demo_PLACEHOLDER');
    expect(callArgs[1]).toBe('oc_demo_PLACEHOLDER');
    expect(callArgs[2]).toBe('feishu-send-demo: hello from workflow A2');
    expect(callArgs[3]).toBe('text');
    expect(typeof callArgs[4]).toBe('string');
    expect(callArgs[4]).toMatch(/^wf_[0-9a-f]+$/);

    const effect = events.find((e) => e.type === 'effectAttempted')! as {
      payload: { provider: string; idempotencyKey: string };
    };
    expect(effect.payload.provider).toBe('feishu-im');
    // idempotencyKey forwarded to sendMessage is the same one recorded
    // on effectAttempted — that's what makes resume's idempotentSubmit
    // hit the same Feishu uuid.
    expect(callArgs[4]).toBe(effect.payload.idempotencyKey);

    const succeeded = events.find((e) => e.type === 'activitySucceeded')! as {
      payload: {
        externalRefs: { messageId: string };
        outputRef: { outputPath: string; contentType?: string };
      };
    };
    expect(succeeded.payload.externalRefs.messageId).toBe('om_demo_123');
    expect(succeeded.payload.outputRef.contentType).toBe('application/json');

    const blob = JSON.parse(
      await fs.readFile(succeeded.payload.outputRef.outputPath, 'utf-8'),
    );
    expect(blob).toEqual({
      output: { messageId: 'om_demo_123' },
      externalRefs: { messageId: 'om_demo_123' },
    });
  });
});
