import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';

let messageCount = 0;
(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const path = new URL(config.url, 'https://open.feishu.cn').pathname;
  let data;
  if (path.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (path.includes('/im/v1/files')) {
    data = { code: 0, data: { file_key: 'test-audio' } };
  } else if (path.endsWith('/messages') || path.endsWith('/replies') || /\/messages\/[^/]+\/reply$/.test(path)) {
    messageCount++;
    console.log('PROVIDER_DELIVERY=' + path);
    data = { code: 0, data: { message_id: `sent-${messageCount}`, reply_id: `sent-${messageCount}` } };
  } else if (path.endsWith('/comments/reaction')) {
    data = { code: 0, data: {} };
  } else {
    throw new Error(`Unexpected test request: ${path}`);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
globalThis.fetch = async input => {
  if (String(input) !== 'https://tts.example.test/v1/audio/speech') throw new Error(`Unexpected test fetch: ${input}`);
  return new Response(new Uint8Array([0, 0]), { status: 200 });
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
