import { acquireFeedbackSendLease } from '../../src/services/feedback-maintenance.js';
import {
  acquireFeedbackSendLeaseWithRelay,
  type FeedbackSendLeaseRelay,
} from '../../src/services/feedback-send-lease-relay.js';

const [dataDir, portText, sessionId, capability, turnId] = process.argv.slice(2);
if (!dataDir || !portText || !sessionId || !capability || !turnId) {
  throw new Error('usage: feedback-send-lease-relay-child <dataDir> <port> <sessionId> <capability> <turnId>');
}

const relay: FeedbackSendLeaseRelay = async (body, signal) => {
  const response = await fetch(`http://127.0.0.1:${portText}/api/sessions/${encodeURIComponent(sessionId)}/feedback-send-lease`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body,
      originCapability: capability,
      originTurnId: turnId,
      originDispatchAttempt: 1,
    }),
    signal,
  });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => undefined) };
};

try {
  const release = await acquireFeedbackSendLeaseWithRelay({
    acquireLocal: () => acquireFeedbackSendLease(dataDir),
    relay,
  });
  process.send?.({ ready: true });
  process.once('message', async message => {
    if (message !== 'release') return;
    try {
      await release();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
  setInterval(() => {}, 1000);
} catch (error) {
  process.send?.({ ready: false, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
