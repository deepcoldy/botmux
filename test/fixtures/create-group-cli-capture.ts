import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';

// Test-only fixture that intercepts @larksuiteoapi/node-sdk HTTP calls and then
// executes the real `src/cli.ts` entrypoint so `botmux create-group` can be
// verified end-to-end without making real Feishu API requests.
const shareLinkMode = process.env.BOTMUX_TEST_SHARE_LINK_MODE ?? 'ok';
const peerBotOpenId = process.env.BOTMUX_TEST_PEER_BOT_OPEN_ID ?? 'ou_peer_obs';

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const rawUrl = String(config?.url ?? '');
  const url = new URL(rawUrl, 'https://open.feishu.cn');
  const method = String(config?.method ?? 'GET').toUpperCase();
  const path = url.pathname;
  let data: any;

  if (path.endsWith('/auth/v3/tenant_access_token/internal')) {
    data = { code: 0, tenant_access_token: 't-fake-token', expire: 7200 };
  } else if (method === 'POST' && path.endsWith('/im/v1/chats')) {
    data = { code: 0, data: { chat_id: 'oc_cli_created', invalid_id_list: [] } };
  } else if (method === 'POST' && path.endsWith('/members')) {
    data = { code: 0, data: { invalid_id_list: [] } };
  } else if (method === 'POST' && path.endsWith('/link')) {
    if (shareLinkMode === 'throw') {
      throw new Error('simulated post-create transport failure');
    }
    if (shareLinkMode === 'error') {
      data = { code: 99991672, msg: 'permission_denied' };
    } else {
      data = {
        code: 0,
        data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_cli' },
      };
    }
  } else if (method === 'GET' && path.endsWith('/members/is_in_chat')) {
    data = { code: 0, data: { is_in_chat: true } };
  } else if (method === 'GET' && path.endsWith('/members/bots')) {
    data = {
      code: 0,
      data: {
        items: [
          { bot_id: 'ou_creator_obs', bot_name: 'claude-code' },
          { bot_id: peerBotOpenId, bot_name: 'codex' },
        ],
      },
    };
  } else if (method === 'POST' && path.endsWith('/im/v1/messages')) {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    if (process.env.BOTMUX_TEST_CAPTURE_SEND === '1') {
      console.error('CAPTURE_SEND=' + JSON.stringify(body));
    }
    data = { code: 0, data: { message_id: 'om_cli_kickoff_1' } };
  } else if (method === 'GET' && path.endsWith('/bot/v3/info')) {
    data = { code: 0, bot: { open_id: peerBotOpenId, app_name: 'Peer Bot' } };
  } else {
    data = { code: 0, data: {} };
  }

  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

await import('../../src/cli.js');
