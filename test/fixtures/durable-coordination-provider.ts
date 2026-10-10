import { createInterface } from 'node:readline';
import {
  DURABLE_COORDINATION_PROVIDER_PROTOCOL,
  DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION,
} from '../../src/services/durable-coordination-provider-protocol.js';
import { DURABLE_COORDINATION_CONTRACT_VERSION } from '../../src/services/durable-coordination.js';

const badContract = process.argv.includes('--bad-contract');
const provider = process.argv.includes('--slow') ? 'fixture-slow' : 'fixture';

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
  if (request.method === 'readSession' || request.method === 'readOutbox'
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
