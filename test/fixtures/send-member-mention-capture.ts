import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';

// Exercise the real CLI, resolver, and member pagination without network sends.
(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url: string = config.url;
  let data;
  if (url.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (url.includes('/contact/v3/users/batch_get_id')) {
    console.log('CONTACT_LOOKUP=' + config.data);
    data = { code: 0, data: { user_list: [] } };
  } else if (url.includes('/im/v1/chats/oc_test/members')) {
    const scenario = process.env.TEST_MEMBER_SCENARIO;
    const items = scenario === 'missing'
      ? [{ member_id: 'ou_other', name: 'Other' }]
      : [
          { member_id: 'ou_recipient', name: 'Recipient' },
          ...(scenario === 'duplicate' ? [{ member_id: 'ou_duplicate', name: 'Recipient' }] : []),
        ];
    console.log('MEMBER_LOOKUP=oc_test');
    data = { code: 0, data: { items, has_more: false } };
  } else if (url.endsWith('/im/v1/messages')) {
    const body = JSON.parse(config.data);
    console.log('CAPTURE_MESSAGE=' + JSON.stringify(body));
    data = { code: 0, data: { message_id: 'om_test_sent' } };
  } else if (url.includes('/im/v1/chats/oc_test')) {
    data = { code: 0, data: { chat_mode: 'group', chat_type: 'private' } };
  } else {
    throw new Error('Unexpected HTTP request: ' + url);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
