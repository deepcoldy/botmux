import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { TurnSendLedger } from '../../src/services/turn-send-ledger.js';
import { recordBridgeReplyMarker } from '../../src/services/bridge-reply-marker.js';

// Run the real CLI with a provider ACK deferred until after a newer input.
const startedAt = Date.now();
let clock = startedAt;
Date.now = () => clock;
console.log('SEND_CLOCK=' + JSON.stringify({ startedAt, nextInputAt: startedAt + 20 }));
let messageCount = 0;

if (process.env.BOTMUX_TEST_REPLAY_FINAL === '1') {
  const execute = TurnSendLedger.prototype.execute;
  TurnSendLedger.prototype.execute = async function(key, kind, content, dispatch, options) {
    // Simulate another CLI passing the same preflight, then winning publication
    // while this CLI waits. Both paths use the actual ledger and its file lock.
    const first = execute.call(this, key, kind, content, dispatch, options);
    const duplicate = execute.call(this, key, kind, content, dispatch, options);
    const delivered = await first;
    recordBridgeReplyMarker({
      dataDir: process.env.SESSION_DATA_DIR!, ...key, sentAtMs: startedAt,
      messageId: delivered.messageId, content, responseKind: 'final', deliveryKind: 'current_session_send',
    });
    return duplicate;
  };
  const sequence = TurnSendLedger.prototype.executeNonIdempotentSequence;
  TurnSendLedger.prototype.executeNonIdempotentSequence = async function(...args) {
    const first = sequence.apply(this, args);
    const duplicate = sequence.apply(this, args);
    const delivered = await first;
    recordBridgeReplyMarker({
      dataDir: process.env.SESSION_DATA_DIR!, ...args[0], sentAtMs: startedAt,
      messageId: delivered.messageId, content: args[2], responseKind: 'final', deliveryKind: 'current_session_send',
    });
    return duplicate;
  };
}

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const path = new URL(config.url, 'https://open.feishu.cn').pathname;
  let data;
  if (path.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (path.includes('/im/v1/files')) {
    data = { code: 0, data: { file_key: 'test-audio' } };
  } else if (path.endsWith('/messages') || path.endsWith('/replies')) {
    messageCount++;
    let acknowledge!: () => void;
    const pending = new Promise<void>(resolve => { acknowledge = resolve; });
    // A second user input is processed while the old send remains in flight.
    if (process.env.BOTMUX_TEST_DELAY_ATTACHMENT === '1' && messageCount === 1) {
      acknowledge();
    } else {
      clock = startedAt + 20;
      setImmediate(() => {
        clock = startedAt + 60;
        acknowledge();
      });
    }
    await pending;
    data = { code: 0, data: { message_id: `sent-${messageCount}`, reply_id: `sent-${messageCount}` } };
  } else {
    throw new Error(`Unexpected test request: ${path}`);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
globalThis.fetch = async (input) => {
  if (String(input) !== 'https://tts.example.test/v1/audio/speech') {
    throw new Error('Unexpected test fetch');
  }
  return new Response(new Uint8Array([0, 0]), { status: 200 });
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
