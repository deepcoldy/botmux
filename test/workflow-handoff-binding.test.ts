/**
 * Workflow handoff bindings (design 2026-11-03 §5.4, P3): the receiving bot's
 * daemon treats an inbound bot message as a workflow handoff only when it
 * carries a host-signed binding (registered BEFORE the send, keyed by the
 * nonce in the card; linked to the message id after the send) naming this
 * bot, this chat and this topic. Forged, foreign, misrouted, cross-protocol
 * and echoed entries are plain messages; a revoked handoff is dropped.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkflowHandoffBinding,
  linkWorkflowHandoffMessage,
  lookupWorkflowHandoff,
  lookupWorkflowHandoffByNonce,
  readDispatchRegistryLoose,
  recordWorkflowHandoffBinding,
  resolveInboundWorkflowHandoff,
  revokeWorkflowHandoff,
  workflowHandoffNonce,
  WORKFLOW_HANDOFF_ENTRY_TTL_MS,
} from '../src/core/workflow-handoff-binding.js';
import {
  createDispatchReportBinding,
  resolveVerifiedDispatchReportTarget,
} from '../src/core/dispatch-report-binding.js';

const SECRET = 'host-secret';
const NONCE = workflowHandoffNonce(SECRET, 'idempotency-uuid-1');
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
    nonce: NONCE,
    publishRoot: 'om_card',
    targetLarkAppId: 'cli_doc',
    targetChatId: 'oc_chat',
    sourceLarkAppId: 'cli_main',
    workflow: { runId: 'run-1', nodeId: 'write', instanceId: 'write#001', attemptId: 'write#001/attempts/001', revision: 1 },
    ...overrides,
  } as any);
}

/** The receiver's view; the sender is proven to be the main bot unless a
 *  test says otherwise. */
function inbound(dir: string, messageId: string, content: string, overrides: Record<string, unknown> = {}) {
  return resolveInboundWorkflowHandoff({
    readRegistry: () => readDispatchRegistryLoose(dir),
    secret: () => SECRET,
    messageId,
    content,
    ...ROUTE,
    proveSender: (sourceLarkAppId: string) => sourceLarkAppId === 'cli_main',
    ...overrides,
  });
}

const CARD_TEXT = `【工作流任务】… 交接编号：${NONCE}`;

describe('inbound workflow handoff verification', () => {
  it('P3-9a: recognizes the handoff from the nonce in the card before its id is linked (no waiting)', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    expect(await inbound(dir, 'om_handoff', CARD_TEXT)).toMatchObject({
      kind: 'handoff',
      binding: { nonce: NONCE, workflow: { runId: 'run-1', attemptId: 'write#001/attempts/001' } },
    });
  });

  it('once linked, the message id alone identifies it — and only that message', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    await linkWorkflowHandoffMessage(dir, SECRET, NONCE, 'om_handoff');
    expect(await inbound(dir, 'om_handoff', CARD_TEXT, { proveSender: () => false })).toMatchObject({ kind: 'handoff' });
    // Another message echoing the nonce is not the handoff.
    expect(await inbound(dir, 'om_echo', CARD_TEXT)).toBeUndefined();
    expect(lookupWorkflowHandoff({ registry: readDispatchRegistryLoose(dir), dispatchRoot: 'om_handoff', secret: SECRET }))
      .toMatchObject({ kind: 'workflow', messageId: 'om_handoff', revoked: false });
  });

  it.each([
    ['another receiving bot', { selfLarkAppId: 'cli_test' }],
    ['another chat', { chatId: 'oc_elsewhere' }],
    ['another topic', { threadRootId: 'om_other_card' }],
    ['a sender that cannot be proven to be the main bot', { proveSender: () => false }],
  ])('refuses %s', async (_label, overrides) => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    expect(await inbound(dir, 'om_handoff', CARD_TEXT, overrides)).toBeUndefined();
  });

  it('P3-e: a message without a nonce is decided without reading the registry or proving anything', async () => {
    let reads = 0;
    let proofs = 0;
    expect(await resolveInboundWorkflowHandoff({
      readRegistry: () => { reads++; return {}; },
      secret: () => SECRET,
      messageId: 'om_plain',
      content: 'hello @bot',
      ...ROUTE,
      proveSender: () => { proofs++; return true; },
    })).toBeUndefined();
    expect([reads, proofs]).toEqual([0, 0]);
  });

  it('P3-c: before the link exists, another bot echoing the printed nonce is not the handoff (fail closed)', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    const asked: string[] = [];
    expect(await inbound(dir, 'om_echo_by_other_bot', CARD_TEXT, {
      proveSender: (source: string) => { asked.push(source); return false; },
    })).toBeUndefined();
    expect(asked).toEqual(['cli_main']);
    // Once the id is linked the link itself is the proof; no lookup needed.
    await linkWorkflowHandoffMessage(dir, SECRET, NONCE, 'om_handoff');
    expect(await inbound(dir, 'om_handoff', CARD_TEXT, { proveSender: () => false })).toMatchObject({ kind: 'handoff' });
  });

  it('P3-e: workflow entries older than the TTL are pruned (with their alias) on the next workflow write', async () => {
    const dir = dataDir();
    const old = Date.parse('2026-11-01T00:00:00.000Z');
    await recordWorkflowHandoffBinding(dir, SECRET, binding({ issuedAt: new Date(old).toISOString() }), old);
    await linkWorkflowHandoffMessage(dir, SECRET, NONCE, 'om_handoff', old);
    const fresh = workflowHandoffNonce(SECRET, 'idempotency-uuid-2');
    const later = old + WORKFLOW_HANDOFF_ENTRY_TTL_MS + 60_000;
    await recordWorkflowHandoffBinding(dir, SECRET, binding({ nonce: fresh, issuedAt: new Date(later).toISOString() }), later);
    expect(Object.keys(readDispatchRegistryLoose(dir))).toEqual([`workflow-handoff:${fresh}`]);
  });

  it('refuses a binding signed with another secret (forged)', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding({}, 'attacker-secret'));
    expect(await inbound(dir, 'om_handoff', CARD_TEXT)).toBeUndefined();
    expect(lookupWorkflowHandoffByNonce({ registry: readDispatchRegistryLoose(dir), nonce: NONCE, secret: SECRET }))
      .toEqual({ kind: 'unproven' });
  });

  it('refuses a message-id alias re-pointed at another message', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    await linkWorkflowHandoffMessage(dir, SECRET, NONCE, 'om_handoff');
    const registry = readDispatchRegistryLoose(dir);
    const moved = { ...registry, om_other: registry.om_handoff };
    expect(lookupWorkflowHandoff({ registry: moved, dispatchRoot: 'om_other', secret: SECRET })).toEqual({ kind: 'unproven' });
  });

  it('P2-1: a revoked handoff is reported as revoked (to be dropped), also when revoked before it was registered', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    await revokeWorkflowHandoff(dir, SECRET, NONCE, 'runCancelled');
    expect(await inbound(dir, 'om_handoff', CARD_TEXT)).toMatchObject({ kind: 'revoked' });

    const early = dataDir();
    await revokeWorkflowHandoff(early, SECRET, NONCE, 'runCancelled');
    expect(await recordWorkflowHandoffBinding(early, SECRET, binding())).toEqual({ revoked: true });
    expect(await inbound(early, 'om_handoff', CARD_TEXT)).toMatchObject({ kind: 'revoked' });
  });

  it('a revocation tombstone without a valid signature revokes nothing', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    const registry = readDispatchRegistryLoose(dir) as Record<string, any>;
    registry[`workflow-handoff:${NONCE}`].revoked = { at: new Date().toISOString(), reason: 'x', signature: 'forged' };
    expect(lookupWorkflowHandoffByNonce({ registry, nonce: NONCE, secret: SECRET })).toMatchObject({ kind: 'workflow', revoked: false });
  });

  it('M15: a nonce can never be re-bound to a different binding; re-recording the same one is idempotent', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    await expect(recordWorkflowHandoffBinding(dir, SECRET, binding())).resolves.toEqual({ revoked: false });
    await expect(recordWorkflowHandoffBinding(dir, SECRET, binding({
      workflow: { runId: 'run-1', nodeId: 'write', instanceId: 'write#001', attemptId: 'write#001/attempts/002', revision: 1 },
    }))).rejects.toThrow();
    await linkWorkflowHandoffMessage(dir, SECRET, NONCE, 'om_handoff');
    await expect(linkWorkflowHandoffMessage(dir, SECRET, NONCE, 'om_other')).rejects.toThrow();
    expect(lookupWorkflowHandoffByNonce({ registry: readDispatchRegistryLoose(dir), nonce: NONCE, secret: SECRET }))
      .toMatchObject({ binding: { workflow: { attemptId: 'write#001/attempts/001' } }, messageId: 'om_handoff' });
  });

  it('keeps the two binding protocols apart', async () => {
    const dir = dataDir();
    await recordWorkflowHandoffBinding(dir, SECRET, binding());
    await linkWorkflowHandoffMessage(dir, SECRET, NONCE, 'om_handoff');
    const dispatch = createDispatchReportBinding(SECRET, {
      dispatchRoot: 'om_seed', targetLarkAppId: 'cli_main', targetSessionId: 's1', sourceName: 'x', issuedAt: new Date().toISOString(),
    });
    // An ordinary dispatch entry is not a workflow handoff …
    expect(lookupWorkflowHandoff({ registry: { om_seed: { reportBinding: dispatch } }, dispatchRoot: 'om_seed', secret: SECRET }))
      .toEqual({ kind: 'none' });
    // … and a workflow handoff never routes an ordinary dispatch report.
    expect(resolveVerifiedDispatchReportTarget({ registry: readDispatchRegistryLoose(dir), dispatchRoot: 'om_handoff', secret: SECRET }))
      .toEqual({ ok: false, error: 'dispatch_binding_unproven' });
  });

  it('the nonce is stable per idempotency key and unguessable without the host secret', () => {
    expect(workflowHandoffNonce(SECRET, 'k')).toBe(workflowHandoffNonce(SECRET, 'k'));
    expect(workflowHandoffNonce(SECRET, 'k')).not.toBe(workflowHandoffNonce('other-secret', 'k'));
    expect(workflowHandoffNonce(SECRET, 'k')).not.toBe(workflowHandoffNonce(SECRET, 'k2'));
  });
});
