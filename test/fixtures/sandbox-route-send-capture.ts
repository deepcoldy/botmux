// Execute the real send CLI as the trusted host re-exec of a sandbox relay;
// every Lark provider request is intercepted in-process and printed.
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url: string = config.url;
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
  let data: unknown;
  if (url.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'fake-token', expire: 7200 };
  } else if (/\/im\/v1\/messages(\?|$)/.test(url) && config.method?.toLowerCase() === 'post') {
    console.log('CAPTURE_SEND=' + JSON.stringify({ receiveId: body?.receive_id }));
    data = { code: 0, data: { message_id: 'om_fake_sent' } };
  } else if (/\/im\/v1\/messages\/[^/]+\/reply/.test(url)) {
    console.log('CAPTURE_REPLY=' + JSON.stringify({ url: url.replace(/^.*\/messages\//, '') }));
    data = { code: 0, data: { message_id: 'om_fake_reply' } };
  } else if (url.includes('/im/v1/chats/')) {
    data = { code: 0, data: { chat_mode: 'group', chat_type: 'private' } };
  } else if (/\/im\/v1\/messages\/[^/?]+(\?|$)/.test(url)) {
    data = { code: 0, data: { items: [{ message_id: 'om_root', chat_id: 'oc_target' }] } };
  } else {
    console.log('CAPTURE_OTHER=' + JSON.stringify({ url }));
    data = { code: 0, data: {} };
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
