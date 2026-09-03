import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import {
  DISPATCH_LAUNCH_ID_RE,
  parseDispatchLaunchAdmissionReceipt,
  type DispatchLaunchAdmissionReceiptV1,
} from './dispatch-launch-contract.js';

function ownerDirectory(dataDir: string, targetLarkAppId: string): string {
  return join(
    dataDir,
    'dispatch-launch',
    'admissions',
    createHash('sha256').update(targetLarkAppId).digest('hex'),
  );
}

function receiptPath(dataDir: string, targetLarkAppId: string, dispatchId: string): string {
  if (!DISPATCH_LAUNCH_ID_RE.test(dispatchId)) throw new Error('invalid dispatch launch id');
  return join(ownerDirectory(dataDir, targetLarkAppId), `${dispatchId}.json`);
}

function readReceipt(path: string): DispatchLaunchAdmissionReceiptV1 | undefined {
  if (!existsSync(path)) return undefined;
  return parseDispatchLaunchAdmissionReceipt(JSON.parse(readFileSync(path, 'utf8')));
}

function writeReceipt(path: string, receipt: DispatchLaunchAdmissionReceiptV1): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function immutableIdentity(receipt: DispatchLaunchAdmissionReceiptV1): string {
  return JSON.stringify({
    dispatchId: receipt.dispatchId,
    sourceLarkAppId: receipt.sourceLarkAppId,
    sourceSessionId: receipt.sourceSessionId,
    sourceTurnId: receipt.sourceTurnId,
    callerUnionId: receipt.callerUnionId,
    sourceOpenId: receipt.sourceOpenId,
    chatType: receipt.chatType,
    talkReason: receipt.talkReason,
    quotaKey: receipt.quotaKey,
    grantChatId: receipt.grantChatId,
    chatId: receipt.chatId,
    targetLarkAppId: receipt.targetLarkAppId,
    policyDigest: receipt.policyDigest,
    effectiveOverride: receipt.effectiveOverride,
    launchIdentity: receipt.launchIdentity,
    talkAuthorizationReceiptId: receipt.talkAuthorizationReceiptId,
    quotaReceiptId: receipt.quotaReceiptId,
    workingDir: receipt.workingDir,
    capacityReservationId: receipt.capacityReservationId,
    createdAt: receipt.createdAt,
  });
}

export class DispatchLaunchAdmissionConflictError extends Error {
  constructor(message: string, public readonly current?: DispatchLaunchAdmissionReceiptV1) {
    super(message);
    this.name = 'DispatchLaunchAdmissionConflictError';
  }
}

export interface DispatchLaunchAdmissionStore {
  get(dispatchId: string): DispatchLaunchAdmissionReceiptV1 | undefined;
  authorize(receipt: DispatchLaunchAdmissionReceiptV1): { created: boolean; receipt: DispatchLaunchAdmissionReceiptV1 };
  commit(dispatchId: string, committedAt: string): DispatchLaunchAdmissionReceiptV1;
  release(dispatchId: string, releasedAt: string): DispatchLaunchAdmissionReceiptV1;
  listAuthorized(): DispatchLaunchAdmissionReceiptV1[];
}

/** Target-owned durable receipt. Admission side effects are keyed by dispatchId. */
export function createDispatchLaunchAdmissionStore(input: {
  dataDir: string;
  targetLarkAppId: string;
}): DispatchLaunchAdmissionStore {
  const directory = ownerDirectory(input.dataDir, input.targetLarkAppId);
  const pathFor = (dispatchId: string): string => receiptPath(input.dataDir, input.targetLarkAppId, dispatchId);
  const assertOwner = (receipt: DispatchLaunchAdmissionReceiptV1): void => {
    if (receipt.targetLarkAppId !== input.targetLarkAppId) {
      throw new DispatchLaunchAdmissionConflictError('admission receipt does not belong to this target');
    }
  };

  const settle = (dispatchId: string, state: 'committed' | 'released', at: string) => {
    const path = pathFor(dispatchId);
    return withFileLockSync(path, () => {
      const current = readReceipt(path);
      if (!current) throw new DispatchLaunchAdmissionConflictError('admission receipt does not exist');
      assertOwner(current);
      if (current.state === state) return current;
      if (current.state !== 'authorized') {
        throw new DispatchLaunchAdmissionConflictError(`cannot ${state} a ${current.state} admission`, current);
      }
      const next = parseDispatchLaunchAdmissionReceipt({
        ...current,
        state,
        ...(state === 'committed' ? { committedAt: at } : { releasedAt: at }),
      });
      writeReceipt(path, next);
      return next;
    });
  };

  return {
    get(dispatchId) {
      const receipt = readReceipt(pathFor(dispatchId));
      if (receipt) assertOwner(receipt);
      return receipt;
    },
    authorize(rawReceipt) {
      const receipt = parseDispatchLaunchAdmissionReceipt(rawReceipt);
      assertOwner(receipt);
      if (receipt.state !== 'authorized') {
        throw new DispatchLaunchAdmissionConflictError('new admission receipt must be authorized');
      }
      const path = pathFor(receipt.dispatchId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return withFileLockSync(path, () => {
        const existing = readReceipt(path);
        if (existing) {
          assertOwner(existing);
          if (immutableIdentity(existing) !== immutableIdentity(receipt)) {
            throw new DispatchLaunchAdmissionConflictError(
              'dispatch id already belongs to a different admission', existing,
            );
          }
          return { created: false, receipt: existing };
        }
        writeReceipt(path, receipt);
        return { created: true, receipt };
      });
    },
    commit(dispatchId, committedAt) {
      return settle(dispatchId, 'committed', committedAt);
    },
    release(dispatchId, releasedAt) {
      return settle(dispatchId, 'released', releasedAt);
    },
    listAuthorized() {
      if (!existsSync(directory)) return [];
      const receipts: DispatchLaunchAdmissionReceiptV1[] = [];
      for (const name of readdirSync(directory).sort()) {
        if (!name.endsWith('.json')) continue;
        const receipt = readReceipt(join(directory, name));
        if (!receipt) continue;
        assertOwner(receipt);
        if (receipt.state === 'authorized') receipts.push(receipt);
      }
      return receipts;
    },
  };
}
