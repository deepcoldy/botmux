import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CandidateTurnDurability,
  candidateTurnOutputUuid,
} from '../src/services/candidate-turn-durability.js';
import { CandidateTurnReceiptReporter } from '../src/services/candidate-turn-reporter.js';
import { deliverCandidateTurnReceiptHistory } from '../src/services/rca-shadow-mirror.js';

const BOTMUX_COMMIT = 'b'.repeat(40);
const BOTMUX_ARTIFACT_SHA256 = '6'.repeat(64);

const MIRROR_CONFIG = {
  url: 'http://127.0.0.1:9090',
  token: 'test-token',
  botAppIds: ['cli_candidate'],
  candidateBotAppIds: ['cli_candidate'],
  timeoutMs: 1_000,
  maxInFlight: 1,
  maxQueued: 1,
};

function turnInput(turnId: string) {
  return {
    incidentKey: 'argos:alarm-42',
    candidateDispatchId: 'cand_alarm_42',
    releaseId: 'release-a',
    releaseManifestSha256: '1'.repeat(64),
    runtimeBundleId: 'runtime-a',
    larkAppId: 'cli_candidate',
    chatId: 'oc_shadow',
    rootMessageId: 'om_candidate_root',
    botmuxSessionId: 'botmux-session-1',
    botmuxCommit: BOTMUX_COMMIT,
    botmuxArtifactSha256: BOTMUX_ARTIFACT_SHA256,
    turnId,
    prompt: `prompt:${turnId}`,
    acceptedAt: '2026-08-14T00:00:00.000Z',
  };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-shadow-delivery-callback-'));
  return { dataDir, turns: new CandidateTurnDurability({ dataDir }) };
}

async function submitTurn(turns: CandidateTurnDurability, turnId: string) {
  await turns.accept(turnInput(turnId));
  await turns.claimHead('cand_alarm_42', { receiverBootId: 'boot-a', workerGeneration: 1 });
  await turns.markSubmitted({
    candidateDispatchId: 'cand_alarm_42',
    turnId,
    dispatchAttempt: 1,
    workerGeneration: 1,
    evidence: { kind: 'cli_transcript', nativeSessionId: 'coco-a', transcriptRef: 'events:10' },
  });
}

async function completeTurnWithDeliveredOutput(
  turns: CandidateTurnDurability,
  turnId: string,
  messageId: string,
) {
  await submitTurn(turns, turnId);
  const uuid = candidateTurnOutputUuid('botmux-session-1', turnId);
  await turns.claimOutputDelivery({
    candidateDispatchId: 'cand_alarm_42',
    turnId,
    dispatchAttempt: 1,
    workerGeneration: 1,
    uuid,
  });
  await turns.markOutputDelivered({
    candidateDispatchId: 'cand_alarm_42',
    turnId,
    dispatchAttempt: 1,
    workerGeneration: 1,
    uuid,
    messageId,
    output: 'candidate conclusion',
  });
  return turns.markTerminal({
    candidateDispatchId: 'cand_alarm_42',
    turnId,
    dispatchAttempt: 1,
    workerGeneration: 1,
    status: 'completed',
    evidence: {
      kind: 'cli_transcript_terminal',
      nativeSessionId: 'coco-a',
      transcriptRef: 'events:20',
      output: 'candidate conclusion',
    },
  });
}

describe('Candidate shadow delivery callback', () => {
  it('attaches the delivered lark messageId only to the completed callback', async () => {
    const { turns } = fixture();
    const receipt = await completeTurnWithDeliveredOutput(turns, 'om_turn_ok', 'om_shadow_answer');
    const bodies: any[] = [];

    await deliverCandidateTurnReceiptHistory(receipt, MIRROR_CONFIG, (async (
      _url: string,
      init?: RequestInit,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true } as Response;
    }) as typeof fetch);

    expect(bodies.map(body => body.status)).toEqual(['accepted', 'submitted', 'completed']);
    for (const body of bodies) {
      if (body.status === 'completed') {
        expect(body.outputDelivery).toEqual({ provider: 'lark', messageId: 'om_shadow_answer' });
      } else {
        expect(body).not.toHaveProperty('outputDelivery');
      }
    }
  });

  it('never invents a delivery fact for a completed turn without a delivered output', async () => {
    const { turns } = fixture();
    await submitTurn(turns, 'om_turn_undelivered');
    const receipt = await turns.markTerminal({
      candidateDispatchId: 'cand_alarm_42',
      turnId: 'om_turn_undelivered',
      dispatchAttempt: 1,
      workerGeneration: 1,
      status: 'completed',
      evidence: {
        kind: 'cli_transcript_terminal',
        nativeSessionId: 'coco-a',
        transcriptRef: 'events:20',
        output: 'candidate conclusion',
      },
    });
    const bodies: any[] = [];

    await deliverCandidateTurnReceiptHistory(receipt, MIRROR_CONFIG, (async (
      _url: string,
      init?: RequestInit,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true } as Response;
    }) as typeof fetch);

    expect(bodies.map(body => body.status)).toEqual(['accepted', 'submitted', 'completed']);
    for (const body of bodies) {
      expect(body).not.toHaveProperty('outputDelivery');
    }
  });

  it('retries a failed sync durably across restart with the same messageId and no topic resend', async () => {
    const { dataDir, turns } = fixture();
    await completeTurnWithDeliveredOutput(turns, 'om_turn_retry', 'om_shadow_answer');
    const deliveredBefore = turns.get('cand_alarm_42', 'om_turn_retry')?.outputDelivery;
    expect(deliveredBefore?.status).toBe('delivered');
    expect(deliveredBefore?.messageId).toBe('om_shadow_answer');

    const completedBodies: any[] = [];
    const failingFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.status === 'completed') {
        completedBodies.push(body);
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true } as Response;
    }) as typeof fetch;
    const firstReporter = new CandidateTurnReceiptReporter({
      dataDir,
      deliver: receipt => deliverCandidateTurnReceiptHistory(receipt, MIRROR_CONFIG, failingFetch),
      schedule: () => setTimeout(() => {}, 0),
    });
    firstReporter.report(turns.get('cand_alarm_42', 'om_turn_retry')!);
    await firstReporter.flush();
    expect(completedBodies).toHaveLength(1);

    const afterFailure = turns.get('cand_alarm_42', 'om_turn_retry')!;
    expect(afterFailure.controlPlaneDelivery?.lastError).toMatch(/500/);
    expect(afterFailure.outputDelivery?.messageId).toBe('om_shadow_answer');

    const succeedingFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.status === 'completed') completedBodies.push(body);
      return { ok: true } as Response;
    }) as typeof fetch;
    const restartedReporter = new CandidateTurnReceiptReporter({
      dataDir,
      deliver: receipt => deliverCandidateTurnReceiptHistory(receipt, MIRROR_CONFIG, succeedingFetch),
    });
    restartedReporter.recoverPending();
    await restartedReporter.flush();

    expect(completedBodies).toHaveLength(2);
    expect(completedBodies[0].outputDelivery).toEqual({ provider: 'lark', messageId: 'om_shadow_answer' });
    expect(completedBodies[1].outputDelivery).toEqual(completedBodies[0].outputDelivery);
    const settled = turns.get('cand_alarm_42', 'om_turn_retry')!;
    expect(settled.controlPlaneDelivery?.acknowledgedTransitions).toBe(settled.transitions.length);
    expect(settled.outputDelivery).toEqual(deliveredBefore);
  });
});
