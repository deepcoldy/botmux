import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFile, atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import {
  assertCandidateRuntimeArtifacts,
  validateCandidateRuntimeContract,
  type CandidateBotmuxIdentityOptions,
  type CandidateRuntimeContract,
} from './candidate-runtime-contract.js';

const RECEIPT_DIR = 'candidate-rca-launches';
// Feishu documents a one-hour UUID dedupe window. Keep five minutes of margin
// so a boundary retry cannot cross the provider window while in flight.
const FEISHU_UUID_SAFE_RETRY_MS = 55 * 60 * 1000;
const FEISHU_UUID_SEND_TIMEOUT_MS = 4 * 60 * 1000;

export interface CandidateRcaLaunchRequest {
  incidentKey: string;
  candidateDispatchId: string;
  larkAppId: string;
  chatId: string;
  topicMessage: string;
  launchContext: CandidateRuntimeContract;
}

export type CandidateRcaLaunchReceiptStatus = 'creating' | 'sending' | 'topic_created' | 'dispatching' | 'launched';

export interface CandidateRcaLaunchReceipt {
  schemaVersion: 1;
  incidentKey: string;
  candidateDispatchId: string;
  feishuUuid: string;
  larkAppId: string;
  chatId: string;
  topicMessage: string;
  launchContext: CandidateRuntimeContract;
  status: CandidateRcaLaunchReceiptStatus;
  rootMessageId?: string;
  botmuxSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type CandidateRcaLaunchResult = CandidateRcaLaunchReceipt & { ok: true }
  | { ok: false; reason: 'identity_gap' | 'identity_conflict' };

export interface CandidateRcaLaunchDeps extends CandidateBotmuxIdentityOptions {
  dataDir: string;
  sendTopic(input: {
    larkAppId: string;
    chatId: string;
    content: string;
    uuid: string;
    timeoutMs: number;
  }): Promise<string>;
  findTopicByDispatch(
    candidateDispatchId: string,
    larkAppId: string,
    chatId: string,
    topicMessage: string,
    receiptCreatedAt: string,
  ): string | undefined | Promise<string | undefined>;
  findSessionByRoot(rootMessageId: string, larkAppId: string): string | undefined | Promise<string | undefined>;
  prepareLaunchTurn(input: {
    request: CandidateRcaLaunchRequest;
    rootMessageId: string;
    botmuxSessionId: string;
    stableTurnId: string;
    prompt: string;
    workerGeneration: number;
  }): { dispatchAttempt: number };
  dispatchTurn(input: {
    request: CandidateRcaLaunchRequest;
    rootMessageId: string;
    stableTurnId: string;
    botmuxSessionId?: string;
    beforeDispatch(context: {
      sessionId: string;
      workerGeneration: number;
      prompt: string;
    }): { dispatchAttempt: number; prompt?: string };
  }): Promise<{ ok: boolean; sessionId?: string; error?: string }>;
}

export function isCandidateRcaLaunchRequest(value: unknown): value is CandidateRcaLaunchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['incidentKey', 'candidateDispatchId', 'larkAppId', 'chatId', 'topicMessage']
    .every(field => typeof record[field] === 'string')
    && !!record.launchContext
    && typeof record.launchContext === 'object'
    && !Array.isArray(record.launchContext);
}

function receiptFileName(candidateDispatchId: string): string {
  return `${createHash('sha256').update(candidateDispatchId).digest('hex')}.json`;
}

export function candidateRcaLaunchReceiptPath(dataDir: string, candidateDispatchId: string): string {
  return join(dataDir, RECEIPT_DIR, receiptFileName(candidateDispatchId));
}

export function readCandidateRcaLaunchReceipt(
  dataDir: string,
  candidateDispatchId: string,
): CandidateRcaLaunchReceipt | undefined {
  const file = candidateRcaLaunchReceiptPath(dataDir, candidateDispatchId);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, 'utf8')) as CandidateRcaLaunchReceipt;
  return value.candidateDispatchId === candidateDispatchId ? value : undefined;
}

export function findCandidateRcaLaunchByIncidentAndDispatch(
  dataDir: string,
  incidentKey: string,
  candidateDispatchId: string,
): { rootMessageId: string; botmuxSessionId: string } | null {
  const receipt = readCandidateRcaLaunchReceipt(dataDir, candidateDispatchId);
  if (!receipt
    || receipt.incidentKey !== incidentKey
    || receipt.status !== 'launched'
    || !receipt.rootMessageId
    || !receipt.botmuxSessionId) {
    return null;
  }
  return {
    rootMessageId: receipt.rootMessageId,
    botmuxSessionId: receipt.botmuxSessionId,
  };
}

function sameIdentity(receipt: CandidateRcaLaunchReceipt, request: CandidateRcaLaunchRequest): boolean {
  return receipt.incidentKey === request.incidentKey
    && receipt.candidateDispatchId === request.candidateDispatchId
    && receipt.larkAppId === request.larkAppId
    && receipt.chatId === request.chatId;
}

function successful(receipt: CandidateRcaLaunchReceipt): CandidateRcaLaunchResult {
  return { ok: true, ...receipt };
}

export function candidateRcaTopicContent(topicMessage: string, candidateDispatchId: string): string {
  return `${topicMessage}\n\n[Search RCA dispatch: ${candidateDispatchId}]`;
}

function syncPath(file: string): void {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableWriteSync(file: string, receipt: CandidateRcaLaunchReceipt): void {
  atomicWriteFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  syncPath(file);
  syncPath(dirname(file));
}

async function durableWrite(file: string, receipt: CandidateRcaLaunchReceipt): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  syncPath(file);
  syncPath(dirname(file));
}

/**
 * Durable Candidate launch boundary. The receipt lock serializes callers in
 * this process and across daemon processes. `creating` is fsynced before the
 * first provider request. Ambiguous sends are reconciled through the durable
 * dispatch marker in chat history before UUID resubmission; after the safe
 * provider window the launch fails closed. Session creation remains owned by
 * triggerSessionTurn through dispatchTurn.
 */
export async function launchCandidateRca(
  request: CandidateRcaLaunchRequest,
  deps: CandidateRcaLaunchDeps,
): Promise<CandidateRcaLaunchResult> {
  const incidentKey = request.incidentKey?.trim();
  const candidateDispatchId = request.candidateDispatchId?.trim();
  if (!incidentKey || !candidateDispatchId) return { ok: false, reason: 'identity_gap' };
  if (candidateDispatchId.length > 50) return { ok: false, reason: 'identity_conflict' };
  let launchContext: CandidateRuntimeContract;
  try {
    launchContext = validateCandidateRuntimeContract(request.launchContext, {
      incidentKey,
      candidateDispatchId,
      larkAppId: request.larkAppId,
      chatId: request.chatId,
    }, deps);
  } catch {
    return { ok: false, reason: 'identity_conflict' };
  }
  assertCandidateRuntimeArtifacts(launchContext, deps);
  request = { ...request, incidentKey, candidateDispatchId, launchContext };

  const file = candidateRcaLaunchReceiptPath(deps.dataDir, candidateDispatchId);
  mkdirSync(join(deps.dataDir, RECEIPT_DIR), { recursive: true });
  return withFileLock(file, async () => {
    let receipt = readCandidateRcaLaunchReceipt(deps.dataDir, candidateDispatchId);
    const receiptExisted = !!receipt;
    if (receipt && !sameIdentity(receipt, { ...request, incidentKey, candidateDispatchId })) {
      return { ok: false, reason: 'identity_conflict' };
    }
    if (receipt) {
      const persistedContract = validateCandidateRuntimeContract(receipt.launchContext, {
        incidentKey: receipt.incidentKey,
        candidateDispatchId: receipt.candidateDispatchId,
        larkAppId: receipt.larkAppId,
        chatId: receipt.chatId,
      }, deps);
      assertCandidateRuntimeArtifacts(persistedContract, deps);
      receipt = { ...receipt, launchContext: persistedContract };
    }
    if (findCandidateRcaLaunchByIncidentAndDispatch(deps.dataDir, incidentKey, candidateDispatchId)) {
      return successful(receipt!);
    }

    if (!receipt) {
      const now = new Date().toISOString();
      receipt = {
        schemaVersion: 1,
        incidentKey,
        candidateDispatchId,
        feishuUuid: candidateDispatchId,
        larkAppId: request.larkAppId,
        chatId: request.chatId,
        topicMessage: request.topicMessage,
        launchContext: structuredClone(request.launchContext),
        status: 'creating',
        createdAt: now,
        updatedAt: now,
      };
      await durableWrite(file, receipt);
    }

    if (!receipt.rootMessageId && receiptExisted && receipt.status === 'sending') {
      const reconciledRootMessageId = await deps.findTopicByDispatch(
        receipt.candidateDispatchId,
        receipt.larkAppId,
        receipt.chatId,
        receipt.topicMessage,
        receipt.createdAt,
      );
      if (reconciledRootMessageId) {
        receipt = {
          ...receipt,
          status: 'topic_created',
          rootMessageId: reconciledRootMessageId,
          updatedAt: new Date().toISOString(),
        };
        await durableWrite(file, receipt);
      } else {
        const receiptAgeMs = Date.now() - Date.parse(receipt.createdAt);
        if (!Number.isFinite(receiptAgeMs) || receiptAgeMs >= FEISHU_UUID_SAFE_RETRY_MS) {
          throw new Error('candidate topic outcome is unresolved and cannot safely retry beyond Feishu UUID dedupe');
        }
      }
    }

    if (!receipt.rootMessageId) {
      if (receipt.status !== 'sending') {
        receipt = {
          ...receipt,
          status: 'sending',
          updatedAt: new Date().toISOString(),
        };
        await durableWrite(file, receipt);
      }
      const rootMessageId = await deps.sendTopic({
        larkAppId: receipt.larkAppId,
        chatId: receipt.chatId,
        content: candidateRcaTopicContent(receipt.topicMessage, receipt.candidateDispatchId),
        uuid: receipt.feishuUuid,
        timeoutMs: FEISHU_UUID_SEND_TIMEOUT_MS,
      });
      if (!rootMessageId) throw new Error('candidate topic send produced no root message identity');
      receipt = {
        ...receipt,
        status: 'topic_created',
        rootMessageId,
        updatedAt: new Date().toISOString(),
      };
      await durableWrite(file, receipt);
    }
    const rootMessageId = receipt.rootMessageId;
    if (!rootMessageId) throw new Error('candidate launch receipt lost root message identity');

    const rootSessionId = await deps.findSessionByRoot(rootMessageId, receipt.larkAppId);
    if (receipt.botmuxSessionId && rootSessionId && receipt.botmuxSessionId !== rootSessionId) {
      throw new Error('candidate root maps to a conflicting Session identity');
    }
    const reconciledSessionId = receipt.botmuxSessionId || rootSessionId;
    const frozenRequest: CandidateRcaLaunchRequest = {
      incidentKey: receipt.incidentKey,
      candidateDispatchId: receipt.candidateDispatchId,
      larkAppId: receipt.larkAppId,
      chatId: receipt.chatId,
      topicMessage: receipt.topicMessage,
      launchContext: structuredClone(receipt.launchContext),
    };

    const response = await deps.dispatchTurn({
      request: frozenRequest,
      rootMessageId,
      stableTurnId: candidateDispatchId,
      ...(reconciledSessionId ? { botmuxSessionId: reconciledSessionId } : {}),
      beforeDispatch: ({ sessionId, workerGeneration, prompt }) => {
        if (reconciledSessionId && sessionId !== reconciledSessionId) {
          throw new Error('candidate Session identity changed during reconciliation');
        }
        receipt = {
          ...receipt!,
          status: 'dispatching',
          botmuxSessionId: sessionId,
          updatedAt: new Date().toISOString(),
        };
        durableWriteSync(file, receipt);
        const prepared = deps.prepareLaunchTurn({
          request: frozenRequest,
          rootMessageId,
          botmuxSessionId: sessionId,
          stableTurnId: candidateDispatchId,
          prompt,
          workerGeneration,
        });
        return { ...prepared, prompt };
      },
    });
    if (!response.ok) throw new Error(response.error || 'candidate trigger failed');
    const botmuxSessionId = receipt.botmuxSessionId || response.sessionId;
    if (!botmuxSessionId) throw new Error('candidate dispatch produced no Session identity');
    if (response.sessionId && response.sessionId !== botmuxSessionId) {
      throw new Error('candidate dispatch returned a conflicting Session identity');
    }
    receipt = {
      ...receipt,
      status: 'launched',
      botmuxSessionId,
      updatedAt: new Date().toISOString(),
    };
    await durableWrite(file, receipt);
    return successful(receipt);
  });
}
