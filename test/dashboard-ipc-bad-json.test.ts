/**
 * `readJsonBodyOrBadJson`：请求体不是合法 JSON 时，这些路由在做任何事之前回 400
 * `{ ok:false, error:'bad_json' }`。表中路径取自重构前基线实测（已绑定 bot 的 daemon，
 * body 为 `{`），重构前后逐字一致。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testOnly_resetBotRegistry, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';

const APP_ID = 'cli_bad_json_test';

const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/api/sessions/:sessionId/durable-send'],
  ['POST', '/api/sessions/:sessionId/native-subagent-runtime'],
  ['POST', '/api/host-overload/sweep'],
  ['POST', '/api/sessions/:sessionId/preview'],
  ['POST', '/api/sessions/:sessionId/board'],
  ['POST', '/api/sessions/:sessionId/whiteboard'],
  ['POST', '/api/sessions/:sessionId/rename'],
  ['POST', '/api/sessions/:sessionId/lock'],
  ['PUT', '/api/blocked-users'],
  ['PUT', '/api/chat-group-grant'],
  ['PUT', '/api/groups/:chatId/name'],
  ['PUT', '/api/oncall/:chatId'],
  ['POST', '/api/roles/batch'],
  ['POST', '/api/doc-watches'],
  ['PUT', '/api/global-message-listener'],
  ['PUT', '/api/command-triggers'],
  ['POST', '/api/role-profiles/:profileId/apply'],
  ['PUT', '/api/bot-quota-fallback'],
  ['PUT', '/api/bot-card-prefs'],
  ['PUT', '/api/bot-substitute-mode'],
  ['POST', '/api/bot-substitute-targets/resolve'],
  ['PUT', '/api/bot-summary-range'],
  ['PUT', '/api/bot-grant-prefs'],
  ['PUT', '/api/bot-brand-label'],
  ['PUT', '/api/bot-reply-style'],
  ['PUT', '/api/bot-ask-option-layout'],
  ['PUT', '/api/bot-rename'],
  ['PUT', '/api/bot-avatar'],
  ['PUT', '/api/bot-agent'],
  ['POST', '/api/oauth-callback'],
  ['PUT', '/api/session-group-tag-config'],
  ['PUT', '/api/chat-feedback/:chatId'],
  ['PUT', '/api/chat-pin-streaming-card/:chatId'],
  ['PUT', '/api/bot-session-owner-reminder'],
  ['PUT', '/api/bot-sandbox'],
  ['PUT', '/api/bot-sandbox-paths'],
  ['PUT', '/api/bot-read-isolation'],
  ['PUT', '/api/bot-backend-type'],
  ['PUT', '/api/bot-working-dir-mode'],
  ['POST', '/api/groups/transfer-owner'],
];

describe('malformed JSON body → 400 bad_json (readJsonBodyOrBadJson)', () => {
  let dir: string;
  let configPath: string;
  let handle: IpcServerHandle | null = null;
  let previousBotsConfig: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ipc-bad-json-'));
    configPath = join(dir, 'bots.json');
    previousBotsConfig = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' }], null, 2));
    __testOnly_resetBotRegistry();
    loadBotConfigs().forEach((c: any) => registerBot(c));
    setLarkAppId(APP_ID);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    setLarkAppId('');
    if (previousBotsConfig === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = previousBotsConfig;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(ROUTES)('%s %s', async (method, path) => {
    const before = readFileSync(configPath, 'utf8');
    const res = await fetch(`http://127.0.0.1:${handle!.port}${path.replace(/:[a-zA-Z]+/g, 'x')}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_json' });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});
