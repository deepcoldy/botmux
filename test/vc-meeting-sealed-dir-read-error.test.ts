/**
 * End-to-end coverage for PR #2937: a stat failure on the delivery directory
 * must not demote a sealed receiver turn to ordinary (full routing wrapper,
 * not just the store-level scan).
 */
import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsFaults = vi.hoisted(() => ({ stat: new Map<string, string>() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((path: unknown, ...rest: unknown[]) => {
    const code = typeof path === 'string' ? fsFaults.stat.get(path) : undefined;
    if (code) {
      const e = new Error(`${code}: injected stat failure, stat '${path}'`) as NodeJS.ErrnoException;
      e.code = code;
      throw e;
    }
    return (actual.statSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.statSync;
  // Real existsSync swallows ANY stat error (incl EIO/EACCES) and returns false.
  const existsSync = ((path: unknown) => {
    if (typeof path === 'string' && fsFaults.stat.has(path)) return false;
    return (actual.existsSync as (p: unknown) => boolean)(path);
  }) as typeof actual.existsSync;
  const patched = { ...actual, statSync, existsSync };
  return { ...patched, default: patched };
});

import {
  applyVcMeetingMemberProjection,
  listVcMeetingActiveProjectionsForReceiverSession,
  type VcMeetingMemberProjectionInput,
} from '../src/services/vc-meeting-delivery-store.js';
import {
  applyVcMeetingHubMemberProjection,
  freezeVcMeetingHubDeliveryAssignment,
  observeVcMeetingHubReceiverReceipt,
  updateVcMeetingHubCloseState,
} from '../src/services/vc-meeting-delivery-hub-store.js';
import { recordVcMeetingListenerMessage } from '../src/services/vc-meeting-listener-message-store.js';
import { resolveVcMeetingImRoutingForTurn } from '../src/services/vc-meeting-im-routing.js';

const LISTENER = 'listener-app';
const CHAT = 'listener-chat';
const AGENT = 'agent-app';

describe('sealed route: unreadable delivery directory fails visibly', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-probe-2937-'));
  });
  afterEach(() => {
    fsFaults.stat.clear();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function buildSealed(meetingId: string): void {
    const projection: VcMeetingMemberProjectionInput = {
      listenerAppId: LISTENER,
      meetingId,
      ownerBootId: 'owner-boot-1',
      ownerEpoch: 1,
      memberId: `member-${meetingId}`,
      agentAppId: AGENT,
      role: 'minutes',
      memberEpoch: 1,
      membershipGeneration: 1,
      status: 'active',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ownedSinks: [],
      sinkOwnerGeneration: 1,
      joinedAtIngestSeq: 0,
      receiverSessionId: `receiver-${meetingId}`,
      outputChatId: CHAT,
    };
    expect(applyVcMeetingMemberProjection(dir, projection, 1_000)).toMatchObject({ ok: true });
    expect(recordVcMeetingListenerMessage(dir, {
      listenerAppId: LISTENER, meetingId, targetChatId: CHAT, messageId: 'om_sealed_output',
    }, 1_500)).toMatchObject({ ok: true });
    expect(applyVcMeetingHubMemberProjection(dir, {
      listenerAppId: LISTENER, meetingId, memberId: `member-${meetingId}`, memberEpoch: 1,
      ownerBootId: 'owner-boot-1', ownerEpoch: 1, agentAppId: AGENT, role: 'minutes',
      deliveryProfileHash: `sha256:${'a'.repeat(64)}`,
      membershipGeneration: 1, status: 'active', responseMode: 'silent',
      capabilities: ['meeting.read'], ownedSinks: [], sinkOwnerGeneration: 1, joinedAtIngestSeq: 0,
      receiverSessionId: `receiver-${meetingId}`, outputChatId: CHAT,
    }, 1_000)).toMatchObject({ ok: true });
    const deliveryKey = `vc_${'f'.repeat(47)}`;
    expect(freezeVcMeetingHubDeliveryAssignment(dir, {
      listenerAppId: LISTENER, meetingId, memberId: `member-${meetingId}`, memberEpoch: 1,
      ownerBootId: 'owner-boot-1', ownerEpoch: 1, membershipGeneration: 1,
      deliveryKey, inputHash: `sha256:${'b'.repeat(64)}`,
      fromSeq: 1, toSeq: 1, batchId: `final-${meetingId}`, final: true,
      entries: [{ deliverySeq: 1, kind: 'final', renderedTextHash: `sha256:${'c'.repeat(64)}` }],
      renderContext: { timeZone: 'Asia/Singapore', authorizedActorIds: [] },
      instructionVersion: 'vc-delivery-v1',
      target: { sessionId: `receiver-${meetingId}`, chatId: CHAT },
    }, 1_100)).toMatchObject({ kind: 'frozen' });
    expect(observeVcMeetingHubReceiverReceipt(dir, {
      listenerAppId: LISTENER, meetingId, memberId: `member-${meetingId}`, memberEpoch: 1,
      ownerBootId: 'owner-boot-1', ownerEpoch: 1, deliveryKey,
      inputHash: `sha256:${'b'.repeat(64)}`, fromSeq: 1, toSeq: 1,
      status: 'completed', receiverCommittedThrough: 1,
    }, 1_200)).toMatchObject({ ok: true, kind: 'acked' });
    for (const [phase, at] of [['data_closing', 1_800], ['finalizing', 1_900], ['closed', 2_000]] as const) {
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER, meetingId, ownerBootId: 'owner-boot-1', ownerEpoch: 1, phase,
      }, at)).toMatchObject({ ok: true });
    }
  }

  it('EIO on the delivery directory stat: sealed route blocks, never demotes to ordinary', () => {
    const meetingId = 'sealed';
    buildSealed(meetingId);
    const binding = {
      listenerAppId: LISTENER,
      listenerChatId: CHAT,
      meetingId,
      memberId: `member-${meetingId}`,
      memberEpoch: 1,
      agentAppId: AGENT,
      receiverSessionId: `receiver-${meetingId}`,
    };

    // Baseline: sealed state routes to the receiver.
    expect(resolveVcMeetingImRoutingForTurn(dir, {
      listenerChatId: CHAT,
      agentAppId: AGENT,
      sealedReceiverSessions: [binding],
    }, 2_500)).toMatchObject({ kind: 'receiver', selectedBy: 'only_sealed' });

    const deliveryDir = join(dir, 'vc-meeting-delivery');
    mkdirSync(deliveryDir, { recursive: true });
    fsFaults.stat.set(deliveryDir, 'EIO');

    // existsSync semantics: a stat EIO reports "no entry".
    // FIXED expectation: turn routing surfaces unavailable + block.
    expect(resolveVcMeetingImRoutingForTurn(dir, {
      listenerChatId: CHAT,
      agentAppId: AGENT,
      sealedReceiverSessions: [binding],
    }, 2_500)).toMatchObject({ kind: 'unavailable', fallback: 'block' });

    // Soft (non-routing) callers keep historical behaviour: [], no throw.
    expect(listVcMeetingActiveProjectionsForReceiverSession(dir, binding.receiverSessionId)).toEqual([]);

    fsFaults.stat.clear();
    expect(resolveVcMeetingImRoutingForTurn(dir, {
      listenerChatId: CHAT,
      agentAppId: AGENT,
      sealedReceiverSessions: [binding],
    }, 2_500)).toMatchObject({ kind: 'receiver', selectedBy: 'only_sealed' });
  });
});
