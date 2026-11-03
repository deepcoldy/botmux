/**
 * Workflow handoff bindings (design 2026-11-03 §5.4, P3): the receiving bot's
 * daemon treats an inbound bot message as a workflow handoff only when its
 * EXACT message id carries a host-signed binding naming this bot, this chat
 * and this topic. Forged, foreign, misrouted and cross-protocol entries are
 * plain messages; a pending marker only makes the receiver wait briefly for a
 * binding the sender is about to publish.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkflowHandoffBinding,
  lookupWorkflowHandoff,
  readDispatchRegistryLoose,
  recordWorkflowHandoffBinding,
  recordWorkflowHandoffPending,
  resolveInboundWorkflowHandoff,
} from '../src/core/workflow-handoff-binding.js';
import {
  createDispatchReportBinding,
  resolveVerifiedDispatchReportTarget,
} from '../src/core/dispatch-report-binding.js';

const SECRET = 'host-secret';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wf-binding-'));
  dirs.push(dir);
  return dir;
}

const ROUTE = { chatId: 'oc_chat', threadRootId: 'om_card', selfLarkAppId: 'cli_doc' };

function binding(overrides: Record<string, unknown> = {}, secret = SECRET) {
  return createWorkflowHandoffBinding(secret, {
    dispatchRoot: 'om_handoff',
    publishRoot: 'om_card',
    targetLarkAppId: 'cli_doc',
    targetChatId: 'oc_chat',
    sourceLarkAppId: 'cli_main',
    workflow: { runId: 'run-1', nodeId: 'write', instanceId: 'write#001', attemptId: 'write#001/attempts/001', revision: 1 },
    ...overrides,
  } as any);
}

function inbound(dir: string, messageId: string, overrides: Partial<typeof ROUTE> = {}, clock?: { t: number }) {
  return resolveInboundWorkflowHandoff({
    readRegistry: () => readDispatchRegistryLoose(dir),
    secret: () => SECRET,
    messageId,
    ...ROUTE,
    ...overrides,
    ...(clock ? {
      now: () => clock.t,
      sleep: async (ms: number) => { clock.t += ms; },
    } : {}),
  });
}

describe('inbound workflow handoff verification', () => {
  it('accepts exactly the bound message, for this bot, chat and topic', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, 'uuid-1', binding());
    expect(await inbound(dir, 'om_handoff')).toMatchObject({
      dispatchRoot: 'om_handoff',
      workflow: { runId: 'run-1', attemptId: 'write#001/attempts/001' },
    });
  });

  it.each([
    ['another message id', { messageId: 'om_other' }],
    ['another receiving bot', { selfLarkAppId: 'cli_test' }],
    ['another chat', { chatId: 'oc_elsewhere' }],
    ['another topic', { threadRootId: 'om_other_card' }],
  ])('refuses %s', async (_label, overrides) => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, 'uuid-1', binding());
    const { messageId, ...route } = { messageId: 'om_handoff', ...overrides } as { messageId: string } & Partial<typeof ROUTE>;
    expect(await inbound(dir, messageId, route)).toBeUndefined();
  });

  it('refuses a binding signed with another secret (forged)', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, 'uuid-1', binding({}, 'attacker-secret'));
    expect(await inbound(dir, 'om_handoff')).toBeUndefined();
    expect(lookupWorkflowHandoff({ registry: readDispatchRegistryLoose(dir), dispatchRoot: 'om_handoff', secret: SECRET }))
      .toEqual({ kind: 'unproven' });
  });

  it('refuses a valid binding re-filed under another message id', async () => {
    const dir = dataDir();
    const signed = binding();
    await recordWorkflowHandoffBinding(dir, 'uuid-1', { ...signed, payload: { ...signed.payload } });
    const registry = readDispatchRegistryLoose(dir);
    const moved = { om_other: registry.om_handoff };
    expect(lookupWorkflowHandoff({ registry: moved, dispatchRoot: 'om_other', secret: SECRET })).toEqual({ kind: 'unproven' });
  });

  it('keeps the two binding protocols apart', () => {
    const dispatch = createDispatchReportBinding(SECRET, {
      dispatchRoot: 'om_handoff', targetLarkAppId: 'cli_main', targetSessionId: 's1', sourceName: 'x', issuedAt: new Date().toISOString(),
    });
    // A dispatch report binding is not a workflow handoff …
    expect(lookupWorkflowHandoff({ registry: { om_handoff: { workflowHandoff: dispatch } }, dispatchRoot: 'om_handoff', secret: SECRET }))
      .toEqual({ kind: 'unproven' });
    expect(lookupWorkflowHandoff({ registry: { om_handoff: { reportBinding: dispatch } }, dispatchRoot: 'om_handoff', secret: SECRET }))
      .toEqual({ kind: 'none' });
    // … and a workflow handoff never routes an ordinary dispatch report.
    expect(resolveVerifiedDispatchReportTarget({ registry: { om_handoff: { reportBinding: binding() } }, dispatchRoot: 'om_handoff', secret: SECRET }))
      .toEqual({ ok: false, error: 'dispatch_binding_unproven' });
  });

  it('a message in a topic without a pending marker is decided at once (no wait)', async () => {
    const dir = dataDir();
    const clock = { t: 1_000 };
    expect(await inbound(dir, 'om_handoff', {}, clock)).toBeUndefined();
    expect(clock.t).toBe(1_000);
  });

  it('waits for a binding announced by a pending marker, then gives up at the bound', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffPending(dir, 'uuid-1', {
      chatId: 'oc_chat', publishRoot: 'om_card', targetLarkAppId: 'cli_doc', expiresAt: Date.now() + 60_000,
    });
    const clock = { t: 1_000 };
    let publishedAt: number | undefined;
    const late = resolveInboundWorkflowHandoff({
      readRegistry: () => {
        if (publishedAt === undefined && clock.t >= 1_300) {
          publishedAt = clock.t;
          // The sender publishes after Lark returned the id.
          void recordWorkflowHandoffBinding(dir, 'uuid-1', binding());
        }
        return readDispatchRegistryLoose(dir);
      },
      secret: () => SECRET,
      messageId: 'om_handoff',
      ...ROUTE,
      now: () => clock.t,
      sleep: async (ms) => { clock.t += ms; await new Promise((resolve) => setTimeout(resolve, 5)); },
    });
    expect(await late).toMatchObject({ dispatchRoot: 'om_handoff' });

    const never = dataDir();
    await recordWorkflowHandoffPending(never, 'uuid-2', {
      chatId: 'oc_chat', publishRoot: 'om_card', targetLarkAppId: 'cli_doc', expiresAt: Date.now() + 60_000,
    });
    const neverClock = { t: 0 };
    expect(await inbound(never, 'om_handoff', {}, neverClock)).toBeUndefined();
    expect(neverClock.t).toBeGreaterThanOrEqual(5_000);
  });

  it('publishing the binding consumes its pending marker; re-publishing is idempotent', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffPending(dir, 'uuid-1', {
      chatId: 'oc_chat', publishRoot: 'om_card', targetLarkAppId: 'cli_doc', expiresAt: Date.now() + 60_000,
    });
    await recordWorkflowHandoffBinding(dir, 'uuid-1', binding());
    await recordWorkflowHandoffBinding(dir, 'uuid-1', binding());
    expect(Object.keys(readDispatchRegistryLoose(dir))).toEqual(['om_handoff']);
  });
});
