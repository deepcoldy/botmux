import { closeSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  DURABLE_COORDINATION_PROVIDER_PROTOCOL,
  DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION,
} from '../../src/services/durable-coordination-provider-protocol.js';
import { DURABLE_COORDINATION_CONTRACT_VERSION } from '../../src/services/durable-coordination.js';

const badContract = process.argv.includes('--bad-contract');
const closeStdinAfterHello = process.argv.includes('--close-stdin-after-hello');
if (process.env.DURABLE_FIXTURE_PID_PATH) writeFileSync(process.env.DURABLE_FIXTURE_PID_PATH, `${process.pid}\n`);
const provider = process.argv.includes('--slow') ? 'fixture-slow' : 'fixture';

function controlRecord(
  state: 'pending' | 'attempting' | 'ambiguous' | 'completed',
  extra: Record<string, unknown> = {},
) {
  return {
    operationId: 'fixture-control',
    sessionKey: 'session-a',
    payload: { action: 'close' },
    createdAt: 1,
    state,
    originEpoch: 1,
    attempts: state === 'pending' ? 0 : 1,
    updatedAt: 2,
    ...extra,
  };
}

function send(value: unknown, exitAfter = false): void {
  process.stdout.write(`${JSON.stringify(value)}\n`, () => {
    if (exitAfter) process.exit(0);
  });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  const request = JSON.parse(line) as any;
  const base = {
    protocol: DURABLE_COORDINATION_PROVIDER_PROTOCOL,
    version: DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION,
    requestId: request.requestId,
  };
  if (request.type === 'hello') {
    if (closeStdinAfterHello) {
      // 先关读端再回 hello：store 收到 hello 时管道已无人读，之后的任何写入都是
      // EPIPE。libuv 不会替 stdin.destroy() 关掉 0 号 fd，所以显式 closeSync(0)。
      // 进程本身保持存活，由 store 负责回收。
      lines.close();
      process.stdin.destroy();
      closeSync(0);
      setTimeout(() => {}, 60_000);
    }
    send({
      ...base,
      type: 'hello',
      provider,
      contractVersion: badContract ? 999 : DURABLE_COORDINATION_CONTRACT_VERSION,
    });
    return;
  }
  if (process.argv.includes('--slow')) return;
  if (request.type !== 'call') {
    send({ ...base, type: 'error', code: 'invalid_request', message: 'invalid request', retryable: false });
    return;
  }
  if (request.method === 'close') {
    send({ ...base, type: 'result', result: null }, true);
    return;
  }
  if (request.method === 'readSession' && request.input === 'provider-error') {
    send({ ...base, type: 'error', code: 'fixture_failure', message: 'fixture failed', retryable: true });
    return;
  }
  if (request.method === 'readSession' && request.input === 'invalid-result') {
    send({ ...base, type: 'result', result: { revision: 'wrong' } });
    return;
  }
  if (request.method === 'listSessions') {
    if (request.input?.limit === 999) {
      send({ ...base, type: 'result', result: { records: [{ revision: 'wrong' }] } });
      return;
    }
    send({
      ...base,
      type: 'result',
      result: {
        records: [{
          sessionKey: 'session-a',
          revision: 1,
          value: { status: 'active' },
          updatedAt: 2,
        }],
      },
    });
    return;
  }
  if (request.method === 'readAuxiliaryState' && request.input === 'invalid-result') {
    send({ ...base, type: 'result', result: { revision: 'wrong' } });
    return;
  }
  if (request.method === 'writeAuxiliaryState') {
    send({
      ...base,
      type: 'result',
      result: {
        kind: 'written',
        record: {
          stateKey: request.input.lease.sessionKey,
          revision: 1,
          value: request.input.value,
          updatedAt: 2,
        },
      },
    });
    return;
  }
  if (request.method === 'enqueueControlOperation') {
    send({ ...base, type: 'result', result: { kind: 'inserted' } });
    return;
  }
  if (request.method === 'enqueueInbox' || request.method === 'enqueueInboxWithLease') {
    send({ ...base, type: 'result', result: { kind: 'inserted' } });
    return;
  }
  if (request.method === 'beginControlOperationAttempt') {
    send({
      ...base,
      type: 'result',
      result: {
        kind: 'applied',
        record: controlRecord('attempting'),
        attempt: {
          operationId: 'fixture-control',
          sessionKey: 'session-a',
          ownerId: 'worker-a',
          leaseEpoch: 1,
          attempt: 1,
        },
      },
    });
    return;
  }
  if (request.method === 'completeControlOperationAttempt') {
    send({
      ...base,
      type: 'result',
      result: {
        kind: 'applied',
        record: controlRecord('completed', { result: { status: 'closed' } }),
      },
    });
    return;
  }
  if (request.method === 'retryControlOperationAttempt') {
    send({
      ...base,
      type: 'result',
      result: {
        kind: 'applied',
        record: controlRecord('pending', { attempts: 1, lastError: 'not dispatched' }),
      },
    });
    return;
  }
  if (request.method === 'markControlOperationAmbiguous') {
    send({
      ...base,
      type: 'result',
      result: {
        kind: 'applied',
        record: controlRecord('ambiguous', { lastError: 'outcome unknown' }),
      },
    });
    return;
  }
  if (request.method === 'reconcileControlOperation') {
    send({
      ...base,
      type: 'result',
      result: {
        kind: 'applied',
        record: controlRecord('completed', {
          result: { status: 'closed' },
          reconciliation: {
            kind: 'completed',
            attempt: 1,
            evidence: { source: 'fixture' },
          },
        }),
      },
    });
    return;
  }
  if (request.method === 'readControlOperation' && request.input === 'fixture-control') {
    send({
      ...base,
      type: 'result',
      result: controlRecord('completed', { result: { status: 'closed' } }),
    });
    return;
  }
  if (request.method === 'readSession' || request.method === 'readAuxiliaryState'
      || request.method === 'readOutbox'
      || request.method === 'readControlOperation'
      || request.method === 'claimNextInbox' || request.method === 'reserveNextOutbox') {
    send({ ...base, type: 'result', result: null });
    return;
  }
  if (request.method === 'acquireSessionLease') {
    send({
      ...base,
      type: 'result',
      result: {
        kind: 'acquired',
        lease: {
          sessionKey: request.input.sessionKey,
          ownerId: request.input.ownerId,
          epoch: 1,
          leaseUntil: 1234,
        },
      },
    });
    return;
  }
  send({ ...base, type: 'result', result: { kind: 'applied' } });
});
