// Execute the real send CLI; every provider request is intercepted in-process.
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { readFileSync } from 'node:fs';
const e = process.env;
console.log('CAPTURE_RUNTIME=' + JSON.stringify({
  owner: e.BOTMUX_OWNER_OPEN_ID === 'ou_owner' && e.__OWNER_OPEN_ID === 'ou_owner',
  registry: !!e.BOTS_CONFIG && JSON.parse(readFileSync(e.BOTS_CONFIG, 'utf8'))[0].larkAppId === 'cli_strict_probe',
  model: e.OPENAI_API_KEY === 'own-model-auth',
  codexHome: !!e.CODEX_HOME && JSON.parse(readFileSync(`${e.CODEX_HOME}/auth.json`, 'utf8')).OPENAI_API_KEY === 'own-file-auth',
  householdAbsent: !('HOUSEHOLD_API_CREDENTIAL' in e), financeAbsent: !('FINANCE_SERVICE_SECRET' in e),
  siblingAbsent: !('SIBLING_AUTH' in e), daemonCredentialAbsent: !('LARK_APP_SECRET' in e),
}));
(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url: string = config.url;
  let data;
  if (url.includes('/auth/')) {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    console.log('CAPTURE_AUTH=' + JSON.stringify({ own: body.app_id === 'cli_strict_probe' && body.app_secret === 'own-im-secret' }));
    data = { code: 0, tenant_access_token: 'fake-token', expire: 7200 };
  } else if (url.endsWith('/im/v1/messages')) {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    console.log('CAPTURE_TARGET=' + JSON.stringify({ own: body.receive_id === 'oc_strict_probe', text: body.content.includes('strict message') }));
    data = { code: 0, data: { message_id: 'om_fake_sent' } };
  } else if (url.includes('/im/v1/chats/')) data = { code: 0, data: { chat_mode: 'group', chat_type: 'private' } };
  else throw new Error('Unexpected mocked send request');
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
