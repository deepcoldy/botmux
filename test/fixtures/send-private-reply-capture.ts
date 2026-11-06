import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { registerBot } from '../../src/bot-registry.js';

registerBot({ larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'claude-code', allowedUsers: [] });
// Exercise the real CLI and Lark client; no request leaves this process.
(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url = config.url;
  let data;
  if (url.includes('/auth/')) data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  else if (url.endsWith('/im/v1/messages') || url.endsWith('/reply')) {
    const body = JSON.parse(config.data);
    const privateSend = url.endsWith('/im/v1/messages');
    console.log('DELIVERY=' + JSON.stringify({ privateSend, url, body }));
    data = privateSend && process.env.TEST_PRIVATE_REPLY_FAIL === '1'
      ? { code: 230013, msg: 'private delivery denied' }
      : { code: 0, data: { message_id: privateSend ? 'om_private' : 'om_group' } };
  } else if (url.includes('/im/v1/chats/')) data = { code: 0, data: { chat_mode: 'topic', chat_type: 'private' } };
  else throw new Error('Unexpected HTTP request: ' + url);
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
