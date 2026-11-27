import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { TurnSendLedger } from '../../src/services/turn-send-ledger.js';

/** Commit one provider final, then let the concurrent loser replay it while
 * deliberately skipping the winner's entire post-ledger continuation. */
const execute = TurnSendLedger.prototype.execute;
let armFinalRace = true;
TurnSendLedger.prototype.execute = async function (key, kind, content, dispatch, options) {
  if (!armFinalRace || kind !== 'final') return execute.call(this, key, kind, content, dispatch, options);
  armFinalRace = false;
  let entered!: () => void;
  const winnerDispatching = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const winner = execute.call(this, key, kind, content, async uuid => {
    entered();
    await blocked;
    return dispatch(uuid);
  }, options);
  await winnerDispatching;
  const loser = execute.call(this, key, kind, content, dispatch, options);
  release();
  const delivered = await winner;
  const reused = await loser;
  console.log('REPLAY_RESULT=' + JSON.stringify({ winnerReplayed: delivered.replayed, loserReplayed: reused.replayed }));
  return reused;
};

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url = new URL(config.url, 'https://open.feishu.cn');
  const method = String(config.method).toUpperCase();
  let data;
  if (url.pathname.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (url.pathname.includes('/im/v1/messages') && ['POST', 'PATCH'].includes(method)) {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    console.log('CAPTURE_REPLY=' + JSON.stringify({ method, path: url.pathname, body }));
    data = { code: 0, data: { message_id: 'om_final' } };
  } else if (url.pathname.includes('/im/v1/messages/')) {
    data = { code: 0, data: { items: [{ message_id: 'om_turn', body: { content: '{"text":"hello"}' } }] } };
  } else {
    throw new Error(`Unexpected test HTTP request: ${method} ${url.pathname}`);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
