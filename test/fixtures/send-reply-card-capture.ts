import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url = new URL(config.url, 'https://open.feishu.cn');
  const method = String(config.method).toUpperCase();
  let data;
  if (url.pathname.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (url.pathname.includes('/im/v1/messages') && ['POST', 'PATCH'].includes(method)) {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    console.log('CAPTURE_REPLY=' + JSON.stringify({ method, path: url.pathname, body }));
    data = { code: 0, data: { message_id: 'om_separate_message' } };
  } else if (url.pathname.includes('/im/v1/messages/')) {
    data = { code: 0, data: { items: [{ message_id: 'om_turn', body: { content: '{"text":"hello"}' } }] } };
  } else if (url.pathname.includes('/im/v1/chats/')) {
    data = { code: 0, data: { chat_mode: 'group', chat_type: 'private' } };
  } else {
    throw new Error(`Unexpected test HTTP request: ${method} ${url.pathname}`);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
// Any non-SDK network request also fails closed; this fixture never contacts Feishu.
globalThis.fetch = async () => { throw new Error('Unexpected test fetch'); };
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
