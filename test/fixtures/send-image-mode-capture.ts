import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url = config.url;
  let data;
  if (url.includes('/auth/')) data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  else if (url.endsWith('/im/v1/messages')) {
    const body = JSON.parse(config.data);
    console.log('CAPTURE_CARD=' + body.content);
    data = { code: 0, data: { message_id: 'om_test_sent' } };
  } else if (url.includes('/im/v1/chats/')) data = { code: 0, data: { chat_mode: 'group', chat_type: 'private' } };
  else if (url.endsWith('/im/v1/images')) data = { code: 0, data: { image_key: 'img_v3_test_upload' } };
  else throw new Error('Unexpected HTTP request: ' + url);
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
