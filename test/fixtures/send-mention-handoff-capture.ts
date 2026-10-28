import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';

// Exercise the real `botmux send` against a fake Lark API. Daemon IPC goes to
// the test's own HTTP server through BOTMUX_DAEMON_IPC_PORT.
(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url: string = config.url;
  let data;
  if (url.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (url.endsWith('/im/v1/messages') || /\/im\/v1\/messages\/[^/]+\/reply$/.test(url)) {
    console.log('CAPTURE_MESSAGE=' + config.data);
    data = { code: 0, data: { message_id: 'om_handoff_sent' } };
  } else if (url.includes('/im/v1/chats/oc_test')) {
    data = { code: 0, data: { chat_mode: 'group', chat_type: 'private' } };
  } else {
    console.log('UNEXPECTED_HTTP=' + url);
    data = { code: 0, data: {} };
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
