import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot,
} from '../src/bot-registry.js';
import {
  setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';

const APP = 'cli_trigger_user_auth_test';
const previousPolicy = { enabled: true, tools: ['lark-cli'], fallback: 'none' };
let dir: string;
let configPath: string;
let handle: IpcServerHandle | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dashboard-trigger-user-auth-'));
  configPath = join(dir, 'bots.json');
  vi.stubEnv('BOTS_CONFIG', configPath);
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: APP,
    larkAppSecret: 'test-secret',
    cliId: 'codex',
    triggerUserAuth: previousPolicy,
  }], null, 2));
  loadBotConfigs().forEach(registerBot);
  setLarkAppId(APP);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  setLarkAppId('');
  setIpcAuthSecret(null);
  __testOnly_resetBotRegistry();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function put(triggerUserAuth: unknown) {
  const res = await fetch(`http://127.0.0.1:${handle!.port}/api/bot-trigger-user-auth`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ triggerUserAuth }),
  });
  return { status: res.status, json: await res.json() };
}

function readEntry() {
  return JSON.parse(readFileSync(configPath, 'utf8'))[0];
}

// Exercise the real HTTP -> coercion -> locked atomic write -> live registry
// chain. Neither the parser nor either config store is mocked.
describe('PUT /api/bot-trigger-user-auth', () => {
  it.each([
    {
      input: { enabled: true },
      expected: { enabled: true, tools: ['lark-cli', 'bytedcli'], fallback: 'bot-identity' },
    },
    {
      input: {
        enabled: true, tools: ['bytedcli', 'lark-cli', 'bytedcli'], fallback: 'none',
        gitHost: 'code.example.com', gitTokenExchangeUrl: 'https://auth.example.com/exchange',
      },
      expected: {
        enabled: true, tools: ['bytedcli', 'lark-cli'], fallback: 'none',
        gitHost: 'code.example.com', gitTokenExchangeUrl: 'https://auth.example.com/exchange',
      },
    },
    {
      input: { enabled: false },
      expected: { enabled: false, tools: ['lark-cli', 'bytedcli'], fallback: 'bot-identity' },
    },
  ])('persists a normalized object and reloads after success: $input', async ({ input, expected }) => {
    expect(await put(input)).toEqual({ status: 200, json: { ok: true } });
    expect(typeof readEntry().triggerUserAuth).toBe('object');
    expect(readEntry().triggerUserAuth).toEqual(expected);
    const live = getBot(APP).config.triggerUserAuth;
    expect(typeof live).toBe('object');
    expect(live).toEqual(expected);
    // Re-run the production file loader after the success response. A JSON
    // string would throw "triggerUserAuth must be an object" here.
    expect(loadBotConfigs()[0].triggerUserAuth).toEqual(expected);
  });

  it.each([null, {}])('clears disk and live config for %j', async input => {
    expect(await put(input)).toEqual({ status: 200, json: { ok: true } });
    expect(readEntry()).not.toHaveProperty('triggerUserAuth');
    expect(getBot(APP).config.triggerUserAuth).toBeUndefined();
    expect(loadBotConfigs()[0].triggerUserAuth).toBeUndefined();
  });

  it.each([
    ['JSON string', JSON.stringify({ enabled: true }), 'must be an object'],
    ['empty string', '', 'must be an object'],
    ['number', 42, 'must be an object'],
    ['boolean', false, 'must be an object'],
    ['array', [], 'must be an object'],
    ['invalid enabled', { enabled: 'true' }, 'enabled must be a boolean'],
    ['unknown tool', { enabled: true, tools: ['unknown-cli'] }, 'tools has unknown entries'],
    ['invalid tools type', { enabled: true, tools: 'lark-cli' }, 'tools must be an array'],
    ['invalid fallback', { enabled: true, fallback: 'device' }, 'fallback must be one of'],
  ])('rejects %s without changing disk or memory', async (_label, input, reason) => {
    const diskBefore = readFileSync(configPath, 'utf8');
    const liveBefore = structuredClone(getBot(APP).config);
    const result = await put(input);
    expect(result.status).toBe(400);
    expect(result.json).toEqual({ ok: false, error: expect.stringContaining(reason as string) });
    expect(readFileSync(configPath, 'utf8')).toBe(diskBefore);
    expect(getBot(APP).config).toEqual(liveBefore);
    expect(loadBotConfigs()[0].triggerUserAuth).toEqual(previousPolicy);
  });
});
