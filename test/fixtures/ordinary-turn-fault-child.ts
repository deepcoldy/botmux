/**
 * Hard-exit fixture for the ordinary-turn ledger integration test.
 *
 * The parent launches this through test/helpers/ts-runner.ts under both Node
 * and Bun. Every phase exits without cleanup after one exact durable boundary,
 * modelling a daemon crash rather than an in-process cache reset.
 */
import { claimMessageOnce } from '../../src/services/seen-message-store.js';
import {
  markOrdinaryTurnAccepted,
  markOrdinaryTurnCommitted,
  markOrdinaryTurnRouted,
  prepareOrdinaryTurnClaim,
  prepareOrdinaryTurnOutput,
} from '../../src/services/ordinary-turn-ledger.js';

const [phase, dataDir] = process.argv.slice(2);
if (!phase || !dataDir) throw new Error('usage: ordinary-turn-fault-child <phase> <dataDir>');

const larkAppId = 'cli_fault_injection';
const messageId = `om_fault_${phase}`;
process.env.SESSION_DATA_DIR = dataDir;

const payload = {
  message: {
    message_id: messageId,
    chat_id: 'oc_fault',
    chat_type: 'group',
    content: JSON.stringify({ text: `fault phase ${phase}` }),
  },
  sender: { sender_id: { open_id: 'ou_fault' }, sender_type: 'user' },
};

const claimed = claimMessageOnce(larkAppId, messageId, Date.now(), () =>
  prepareOrdinaryTurnClaim({ dataDir, larkAppId, messageId, payload }) === 'created');
if (!claimed) throw new Error(`fixture failed to claim ${messageId}`);

if (phase !== 'received') {
  markOrdinaryTurnRouted({
    dataDir,
    larkAppId,
    messageId,
    routing: { chatId: 'oc_fault', scope: 'thread', anchor: messageId },
  });
  markOrdinaryTurnAccepted({
    dataDir,
    larkAppId,
    messageId,
    turnId: messageId,
    sessionId: 'sid_fault',
  });
}

if (phase === 'committed') {
  markOrdinaryTurnCommitted({
    dataDir,
    larkAppId,
    turnId: messageId,
    sessionId: 'sid_fault',
    workerGeneration: 7,
  });
} else if (phase === 'output') {
  prepareOrdinaryTurnOutput({
    dataDir,
    larkAppId,
    turnId: messageId,
    delivery: {
      rootId: messageId,
      content: 'durable answer',
      msgType: 'text',
      turnId: messageId,
      options: {
        uuid: 'bf_fault_injection_uuid',
        replyTarget: { mode: 'thread', rootMessageId: messageId },
      },
    },
  });
} else if (phase !== 'received') {
  throw new Error(`unknown phase ${phase}`);
}

// Deliberately bypass normal cleanup/finalizers: this is the fault boundary.
process.exit(73);
