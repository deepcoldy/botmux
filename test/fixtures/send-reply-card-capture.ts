import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// The >MAX_STRING_LENGTH regression uses a sparse attachment to prove the CLI
// never decodes it as UTF-8. Keep the later upload path lightweight: production
// uploadFile still asks fs for bytes, but this fixture only needs to exercise
// routing and captures the resulting file message rather than uploading 512MiB.
const stubbedLargeUpload = process.env.BOTMUX_TEST_STUB_LARGE_FILE_UPLOAD;
if (stubbedLargeUpload) {
  const originalReadFileSync = fs.readFileSync.bind(fs);
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(path) === stubbedLargeUpload && options === undefined) {
      return Buffer.from('fixture-upload');
    }
    return originalReadFileSync(path, options as never);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
}

const topicLookups = new Map<string, number>();

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url = new URL(config.url, 'https://open.feishu.cn');
  const method = String(config.method).toUpperCase();
  let data;
  if (url.pathname.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (url.pathname.includes('/im/v1/files')) {
    data = { code: 0, data: { file_key: 'file_test_upload' } };
  } else if (url.pathname.includes('/im/v1/messages') && ['POST', 'PATCH'].includes(method)) {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    console.log('CAPTURE_REPLY=' + JSON.stringify({ method, path: url.pathname, body }));
    data = { code: 0, data: { message_id: 'om_separate_message' } };
  } else if (url.pathname.includes('/im/v1/messages/') && process.env.BOTMUX_TEST_TOPIC_STATE) {
    const state = process.env.BOTMUX_TEST_TOPIC_STATE;
    data = { code: 0, data: { items: state === 'missing' ? [] : [{
      message_id: url.pathname.split('/').at(-1),
      ...(state === 'unknown' ? {} : { deleted: state === 'deleted' }),
      body: { content: '{"text":"hello"}' },
    }] } };
  } else if (url.pathname.includes('/im/v1/messages/') && process.env.BOTMUX_TEST_TOPIC_STATES) {
    const id = url.pathname.split('/').at(-1)!;
    const states = JSON.parse(process.env.BOTMUX_TEST_TOPIC_STATES);
    const count = (topicLookups.get(id) ?? 0) + 1;
    topicLookups.set(id, count);
    console.log('CAPTURE_TOPIC=' + JSON.stringify({ id, count }));
    const state = states[id] ?? 'live';
    if (state === 'error') throw new Error('topic lookup unavailable');
    data = state === 'withdrawn-code' ? { code: 230011, msg: 'withdrawn' }
      : { code: 0, data: { items: [{ message_id: id, chat_id: 'oc_test',
        deleted: state === 'withdrawn' || (state === 'withdraw-after-preflight' && count > 1),
        body: { content: '{"text":"hello"}' } }] } };
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
