import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import {
  DISPATCH_LAUNCH_ID_RE,
  parseDispatchLaunchOperation,
  type DispatchLaunchOperationV1,
  type DispatchLaunchOperationState,
} from './dispatch-launch-contract.js';

const TERMINAL_STATES = new Set<DispatchLaunchOperationState>([
  'succeeded', 'failed', 'cancelled', 'delivery_unknown',
]);

const ALLOWED_TRANSITIONS: Readonly<Record<DispatchLaunchOperationState, readonly DispatchLaunchOperationState[]>> = {
  created: ['preparing', 'failed', 'cancelled'],
  preparing: ['prepared', 'failed', 'cancelled'],
  prepared: ['starting', 'failed', 'cancelled'],
  // Same-state checkpoints durably publish root/session/generation one at a
  // time. They are what makes recovery safe at every external side-effect.
  starting: ['starting', 'awaiting_proof', 'failed', 'cancelled', 'delivery_unknown'],
  awaiting_proof: ['succeeded', 'failed', 'cancelled', 'delivery_unknown'],
  succeeded: [],
  failed: [],
  cancelled: [],
  delivery_unknown: [],
};

function ownerDirectory(dataDir: string, ownerLarkAppId: string): string {
  return join(
    dataDir,
    'dispatch-launch',
    'operations',
    createHash('sha256').update(ownerLarkAppId).digest('hex'),
  );
}

function operationPath(dataDir: string, ownerLarkAppId: string, dispatchId: string): string {
  if (!DISPATCH_LAUNCH_ID_RE.test(dispatchId)) throw new Error('invalid dispatch launch id');
  return join(ownerDirectory(dataDir, ownerLarkAppId), `${dispatchId}.json`);
}

function readOperation(path: string): DispatchLaunchOperationV1 | undefined {
  if (!existsSync(path)) return undefined;
  return parseDispatchLaunchOperation(JSON.parse(readFileSync(path, 'utf8')));
}

function writeOperation(path: string, operation: DispatchLaunchOperationV1): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify(operation, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function sameIdentity(left: DispatchLaunchOperationV1, right: DispatchLaunchOperationV1): boolean {
  return left.dispatchId === right.dispatchId
    && left.owner === right.owner
    && left.sourceLarkAppId === right.sourceLarkAppId
    && left.sourceSessionId === right.sourceSessionId
    && left.sourceTurnId === right.sourceTurnId
    && left.callerUnionId === right.callerUnionId
    && left.targetLarkAppId === right.targetLarkAppId
    && left.chatId === right.chatId
    && left.kickoff.digest === right.kickoff.digest
    && JSON.stringify(left.requestedOverride) === JSON.stringify(right.requestedOverride)
    && left.expiresAt === right.expiresAt;
}

function samePreparedIdentity(left: DispatchLaunchOperationV1, right: DispatchLaunchOperationV1): boolean {
  if (!('effectiveOverride' in left) || left.effectiveOverride === undefined) return true;
  return 'effectiveOverride' in right
    && right.effectiveOverride !== undefined
    && JSON.stringify(left.effectiveOverride) === JSON.stringify(right.effectiveOverride)
    && JSON.stringify(left.launchIdentity) === JSON.stringify(right.launchIdentity);
}

export class DispatchLaunchOperationConflictError extends Error {
  constructor(message: string, public readonly current?: DispatchLaunchOperationV1) {
    super(message);
    this.name = 'DispatchLaunchOperationConflictError';
  }
}

export interface DispatchLaunchOperationStore {
  get(dispatchId: string): DispatchLaunchOperationV1 | undefined;
  create(operation: DispatchLaunchOperationV1): { created: boolean; operation: DispatchLaunchOperationV1 };
  transition(input: {
    dispatchId: string;
    expectedState: DispatchLaunchOperationState | readonly DispatchLaunchOperationState[];
    next: DispatchLaunchOperationV1;
  }): DispatchLaunchOperationV1;
  listRecoverable(): DispatchLaunchOperationV1[];
}

/** Durable, per-owner CAS store. A daemon must construct this only for its own app id. */
export function createDispatchLaunchOperationStore(input: {
  dataDir: string;
  ownerLarkAppId: string;
}): DispatchLaunchOperationStore {
  const directory = ownerDirectory(input.dataDir, input.ownerLarkAppId);
  const pathFor = (dispatchId: string): string => operationPath(input.dataDir, input.ownerLarkAppId, dispatchId);
  const assertOwner = (operation: DispatchLaunchOperationV1): void => {
    if (operation.owner !== 'source' && operation.owner !== 'target') {
      throw new DispatchLaunchOperationConflictError('operation owner is invalid');
    }
    const expectedOwner = operation.owner === 'source'
      ? operation.sourceLarkAppId
      : operation.targetLarkAppId;
    if (expectedOwner !== input.ownerLarkAppId) {
      throw new DispatchLaunchOperationConflictError('operation does not belong to this daemon');
    }
  };

  return {
    get(dispatchId) {
      const operation = readOperation(pathFor(dispatchId));
      if (operation) assertOwner(operation);
      return operation;
    },
    create(rawOperation) {
      const operation = parseDispatchLaunchOperation(rawOperation);
      assertOwner(operation);
      const path = pathFor(operation.dispatchId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return withFileLockSync(path, () => {
        const existing = readOperation(path);
        if (existing) {
          assertOwner(existing);
          if (!sameIdentity(existing, operation)) {
            throw new DispatchLaunchOperationConflictError(
              'dispatch id already belongs to a different operation', existing,
            );
          }
          return { created: false, operation: existing };
        }
        writeOperation(path, operation);
        return { created: true, operation };
      });
    },
    transition({ dispatchId, expectedState, next: rawNext }) {
      const next = parseDispatchLaunchOperation(rawNext);
      assertOwner(next);
      if (next.dispatchId !== dispatchId) {
        throw new DispatchLaunchOperationConflictError('transition changed dispatch id');
      }
      const expectedStates = Array.isArray(expectedState) ? expectedState : [expectedState];
      const path = pathFor(dispatchId);
      return withFileLockSync(path, () => {
        const current = readOperation(path);
        if (!current) throw new DispatchLaunchOperationConflictError('operation does not exist');
        assertOwner(current);
        if (!sameIdentity(current, next)) {
          throw new DispatchLaunchOperationConflictError('transition changed immutable operation identity', current);
        }
        if (!samePreparedIdentity(current, next)) {
          throw new DispatchLaunchOperationConflictError('transition changed prepared launch identity', current);
        }
        if (!expectedStates.includes(current.state)) {
          throw new DispatchLaunchOperationConflictError(`expected state ${expectedStates.join('|')}, got ${current.state}`, current);
        }
        if (!ALLOWED_TRANSITIONS[current.state].includes(next.state)) {
          throw new DispatchLaunchOperationConflictError(`illegal transition ${current.state} -> ${next.state}`, current);
        }
        if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
          throw new DispatchLaunchOperationConflictError('updatedAt moved backwards', current);
        }
        writeOperation(path, next);
        return next;
      });
    },
    listRecoverable() {
      if (!existsSync(directory)) return [];
      const operations: DispatchLaunchOperationV1[] = [];
      for (const name of readdirSync(directory).sort()) {
        if (!name.endsWith('.json')) continue;
        const operation = readOperation(join(directory, name));
        if (!operation) continue;
        assertOwner(operation);
        if (!TERMINAL_STATES.has(operation.state)) operations.push(operation);
      }
      return operations;
    },
  };
}
