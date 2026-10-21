/**
 * `botConfigPutRoute` / `requireBoundBot` / `readJsonBodyOrBadJson` 的行为钉住：
 * 经真实 IPC server 驱动每条 config-field PUT 路由，覆盖 503（未绑定）、400 bad_json、
 * 校验失败、成功写盘与响应形状。期望值来自重构前基线的逐字对比（重构前后 4085 次请求的
 * 响应与 bots.json 落盘内容完全一致）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testOnly_resetBotRegistry, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { config } from '../src/config.js';

const APP_ID = 'cli_config_routes_test';

/** [path, 未绑定时的 503 body]：legacy 形状没有 ok 字段，no-progress-notify 带 ok:false。 */
const LEGACY = { error: 'larkAppId_not_set' };
const OK_FALSE = { ok: false, error: 'larkAppId_not_set' };
const ROUTES: ReadonlyArray<readonly [string, object]> = [
  ['/api/bot-p2p-mode', LEGACY],
  ['/api/bot-envelope-injection', LEGACY],
  ['/api/bot-topic-unavailable-policy', LEGACY],
  ['/api/bot-prompt-injection', LEGACY],
  ['/api/bot-reply-delivery', LEGACY],
  ['/api/bot-skill-injection', LEGACY],
  ['/api/bot-startup-commands', LEGACY],
  ['/api/bot-custom-passthrough', LEGACY],
  ['/api/bot-cantalk-daemon-commands', LEGACY],
  ['/api/bot-launch-shell', LEGACY],
  ['/api/bot-oncall-group', LEGACY],
  ['/api/bot-no-progress-notify', OK_FALSE],
  ['/api/bot-feedback', LEGACY],
  ['/api/bot-env', LEGACY],
  ['/api/bot-max-live-workers', LEGACY],
  ['/api/bot-idle-suspend-minutes', LEGACY],
  ['/api/bot-riff', LEGACY],
  ['/api/bot-herdr', LEGACY],
  ['/api/bot-skills', LEGACY],
  ['/api/bot-sandbox-network-policy', LEGACY],
  ['/api/bot-lark-tool-binding', LEGACY],
];

/** [path, 请求体, 期望 status, 期望 body（toMatchObject）, 期望落盘的 config 字段（undefined = 不应出现）] */
type Case = readonly [string, string, number, unknown, Record<string, unknown>?];
const CASES: readonly Case[] = [
  ['/api/bot-p2p-mode', '{"p2pMode":"thread"}', 200, { ok: true, p2pMode: 'thread' }, { p2pMode: 'thread' }],
  ['/api/bot-p2p-mode', '{"p2pMode":5}', 200, { ok: true, p2pMode: 'chat' }, { p2pMode: undefined }],
  ['/api/bot-envelope-injection', '{"envelopeInjection":"auto"}', 200, { ok: true, envelopeInjection: 'auto' }, { envelopeInjection: 'auto' }],
  ['/api/bot-envelope-injection', '{"envelopeInjection":"off"}', 200, { ok: true, envelopeInjection: 'off' }, { envelopeInjection: undefined }],
  ['/api/bot-topic-unavailable-policy', '{"topicUnavailablePolicy":"stop"}', 200, { ok: true, topicUnavailablePolicy: 'stop' }, { topicUnavailablePolicy: 'stop' }],
  ['/api/bot-topic-unavailable-policy', '{"topicUnavailablePolicy":"x"}', 400, { ok: false, error: 'invalid_topic_unavailable_policy' }],
  ['/api/bot-topic-unavailable-policy', '[]', 400, { ok: false, error: 'invalid_topic_unavailable_policy' }],
  // Zero injection forces transcript delivery; the response carries the effective value.
  ['/api/bot-prompt-injection', '{"promptInjection":"none"}', 200, { ok: true, promptInjection: 'none', replyDelivery: 'transcript' }, { promptInjection: 'none' }],
  ['/api/bot-prompt-injection', '{"promptInjection":"default"}', 200, { ok: true, promptInjection: 'default', replyDelivery: 'send' }, { promptInjection: 'default' }],
  ['/api/bot-prompt-injection', '{"promptInjection":"x"}', 400, { ok: false, error: 'invalid_prompt_injection' }],
  ['/api/bot-reply-delivery', '{"replyDelivery":"transcript"}', 200, { ok: true, replyDelivery: 'transcript', replyDeliveryDefault: 'send' }, { replyDelivery: 'transcript' }],
  ['/api/bot-reply-delivery', '{"replyDelivery":"send"}', 200, { ok: true, replyDelivery: 'send', replyDeliveryDefault: 'send' }, { replyDelivery: 'send' }],
  ['/api/bot-skill-injection', '{"skillInjection":"global"}', 200, { ok: true, skillInjection: 'global' }, { skillInjection: 'global' }],
  ['/api/bot-skill-injection', '{"skillInjection":"zz"}', 200, { ok: true, skillInjection: null }, { skillInjection: undefined }],
  ['/api/bot-startup-commands', '{"startupCommands":"/effort high, /foo"}', 200, { ok: true, startupCommands: '/effort high\n/foo' }, { startupCommands: ['/effort high', '/foo'] }],
  ['/api/bot-startup-commands', '{"startupCommands":"   "}', 200, { ok: true, startupCommands: '' }, { startupCommands: undefined }],
  ['/api/bot-custom-passthrough', '{"customPassthroughCommands":"/a /b"}', 200, { ok: true, customPassthroughCommands: '/a /b' }, { customPassthroughCommands: ['/a', '/b'] }],
  ['/api/bot-custom-passthrough', '{"customPassthroughCommands":""}', 200, { ok: true, customPassthroughCommands: '' }, { customPassthroughCommands: undefined }],
  ['/api/bot-cantalk-daemon-commands', '{"canTalkDaemonCommands":"/status /clear"}', 200, { ok: true, canTalkDaemonCommands: '/status' }, { canTalkDaemonCommands: ['/status'] }],
  ['/api/bot-cantalk-daemon-commands', '{"canTalkDaemonCommands":"nonsense"}', 400, { ok: false, error: 'empty' }],
  ['/api/bot-launch-shell', '{"launchShell":"bash"}', 200, { ok: true, launchShell: 'bash' }, { launchShell: 'bash' }],
  ['/api/bot-launch-shell', '{"launchShell":"  "}', 200, { ok: true, launchShell: '' }, { launchShell: undefined }],
  ['/api/bot-oncall-group', '{"oncallGroup":"x"}', 400, { ok: false, error: 'invalid_json' }],
  ['/api/bot-no-progress-notify', '{"noProgressNotify":{"timeoutMs":300000}}', 200, { ok: true, noProgressNotify: { enabled: true, timeoutMs: 300000 } }, { noProgressNotify: { enabled: true, timeoutMs: 300000 } }],
  ['/api/bot-no-progress-notify', '{"noProgressNotify":null}', 200, { ok: true, noProgressNotify: null }, { noProgressNotify: undefined }],
  ['/api/bot-no-progress-notify', '{"noProgressNotify":{"timeoutMs":5}}', 400, { ok: false, error: expect.stringContaining('invalid_no_progress_notify') }],
  ['/api/bot-feedback', '{"feedback":"{bad"}', 400, { ok: false, error: 'invalid_json' }],
  ['/api/bot-env', '{"env":"{\\"FOO\\":\\"bar\\"}"}', 200, { ok: true, env: '', envKeys: ['FOO'] }, { env: { FOO: 'bar' } }],
  ['/api/bot-env', '{"mode":"nope"}', 400, { ok: false, error: 'invalid_mode' }],
  ['/api/bot-env', '{"remove":"FOO"}', 400, { ok: false, error: 'invalid_remove' }],
  ['/api/bot-env', '{"remove":[1]}', 400, { ok: false, error: 'invalid_remove' }],
  ['/api/bot-max-live-workers', '{"maxLiveWorkers":5}', 200, { ok: true, maxLiveWorkers: 5 }, { maxLiveWorkers: 5 }],
  ['/api/bot-max-live-workers', '{"maxLiveWorkers":0}', 400, { ok: false, error: 'invalid_number' }],
  ['/api/bot-max-live-workers', '[]', 400, { ok: false, error: 'no_valid_fields' }],
  ['/api/bot-max-live-workers', '{}', 200, { ok: true, maxLiveWorkers: null }, { maxLiveWorkers: undefined }],
  ['/api/bot-idle-suspend-minutes', '{"idleSuspendMinutes":30}', 200, { ok: true, idleSuspendMinutes: 30 }, { idleSuspendMinutes: 30 }],
  ['/api/bot-idle-suspend-minutes', '{"idleSuspendMinutes":null}', 200, { ok: true, idleSuspendMinutes: null }, { idleSuspendMinutes: undefined }],
  ['/api/bot-idle-suspend-minutes', '{"idleSuspendMinutes":"x"}', 400, { ok: false, error: 'invalid_number' }],
  ['/api/bot-idle-suspend-minutes', '{}', 200, { ok: true, idleSuspendMinutes: null }, { idleSuspendMinutes: undefined }],
  ['/api/bot-sandbox-network-policy', '{"policy":null}', 200, { ok: true, sandboxNetworkPolicy: null }],
  ['/api/bot-sandbox-network-policy', '{"policy":1,"x":2}', 400, { ok: false, error: 'policy_required' }],
  // 校验通过后由 applyConfigField 拒绝：reason 原样作为 400 的 error。
  ['/api/bot-sandbox-network-policy', '{"policy":"allow"}', 400, { ok: false, error: 'sandboxNetworkPolicy must be an object' }],
  ['/api/bot-sandbox-network-policy', '{"policy":{"mode":"deny"}}', 400, { ok: false, error: 'sandboxNetworkPolicy: unsupported field mode' }],
  ['/api/bot-sandbox-network-policy', '{}', 400, { ok: false, error: 'policy_required' }],
  ['/api/bot-riff', '{"riff":"{\\"baseUrl\\":\\"https://riff.example.com\\",\\"model\\":\\"m\\"}"}', 200, {
    ok: true,
    riff: '{\n  "baseUrl": "https://riff.example.com",\n  "model": "m",\n  "sandboxCluster": "boe"\n}',
  }, { riff: { baseUrl: 'https://riff.example.com', model: 'm', sandboxCluster: 'boe' } }],
  ['/api/bot-riff', '{"riff":"   "}', 200, { ok: true, riff: '' }, { riff: undefined }],
  ['/api/bot-riff', '{"riff":"{\\"baseUrl\\":\\"https://riff.example.com\\",\\"sandboxCluster\\":\\"nope\\"}"}', 400, { ok: false, error: 'invalid_sandbox_cluster' }],
  ['/api/bot-riff', '{"riff":"{\\"baseUrl\\":\\"ftp://x\\"}"}', 400, { ok: false, error: 'invalid_base_url' }],
  // herdr：合法值经 normalizeHerdrBackendConfig 归一落盘；非法字段显式拒绝；空串 / 空对象清除。
  ['/api/bot-herdr', '{"herdr":"{\\"placement\\":\\"tab\\"}"}', 200, { ok: true }, { herdr: { placement: 'tab' } }],
  ['/api/bot-herdr', '{"herdr":"   "}', 200, { ok: true, herdr: '' }, { herdr: undefined }],
  ['/api/bot-herdr', '{"herdr":"{}"}', 200, { ok: true, herdr: '' }, { herdr: undefined }],
  ['/api/bot-herdr', '{"herdr":"{\\"placement\\":\\"nope\\"}"}', 400, { ok: false, error: expect.stringContaining('invalid_herdr_config') }],
  ['/api/bot-herdr', '{"herdr":"{\\"session\\":\\"default\\"}"}', 400, { ok: false, error: expect.stringContaining('invalid_herdr_config') }],
  ['/api/bot-herdr', '{"herdr":"{\\"chatTypes\\":[\\"group\\",\\"x\\"]}"}', 400, { ok: false, error: expect.stringContaining('invalid_herdr_config') }],
  ['/api/bot-herdr', '{"herdr":"[1,2]"}', 400, { ok: false, error: expect.stringContaining('invalid_herdr_config') }],
  // 激活条件：无 sessionName/placement 时只填 tab/workspace/splitDirection/chatTypes，
  // 叠加全局 env 后仍不生效 → 拒绝，杜绝「保存成功但零效果」。
  ['/api/bot-herdr', '{"herdr":"{\\"tab\\":\\"3\\"}"}', 400, { ok: false, error: expect.stringContaining('invalid_herdr_config') }],
  ['/api/bot-herdr', '{"herdr":"{\\"chatTypes\\":[\\"group\\"]}"}', 400, { ok: false, error: expect.stringContaining('invalid_herdr_config') }],
  // 重复 chatTypes 与 bots.json/env 门一致，去重后接受。
  ['/api/bot-herdr', '{"herdr":"{\\"sessionName\\":\\"default\\",\\"chatTypes\\":[\\"group\\",\\"group\\"]}"}', 200, { ok: true }, { herdr: { sessionName: 'default', chatTypes: ['group'] } }],
  // 非字符串 body 不能静默当清除（破坏性字段类型门）。
  ['/api/bot-herdr', '{"herdr":{"tab":"3"}}', 400, { ok: false, error: expect.stringContaining('invalid_herdr_config') }],
  ['/api/bot-skills', '{"action":"set","policy":null}', 200, { ok: true, skills: null }],
  ['/api/bot-skills', '{"action":"x"}', 400, { ok: false, error: 'invalid_action' }],
  ['/api/bot-skills', '{"action":"attach"}', 400, { ok: false, error: 'name_required' }],
  ['/api/bot-skills', '[]', 400, { ok: false, error: 'bad_json' }],
  ['/api/bot-lark-tool-binding', '{"enabled":true}', 200, { ok: true, larkToolBinding: true }, { larkToolBinding: undefined }],
  ['/api/bot-lark-tool-binding', '{"enabled":false}', 200, { ok: true, larkToolBinding: false }, { larkToolBinding: false }],
  ['/api/bot-lark-tool-binding', '{"larkToolBinding":true}', 200, { ok: true, larkToolBinding: true }, { larkToolBinding: undefined }],
  ['/api/bot-lark-tool-binding', '{"larkToolBinding":false}', 200, { ok: true, larkToolBinding: false }, { larkToolBinding: false }],
  ['/api/bot-lark-tool-binding', 'null', 400, { ok: false, error: 'no_valid_fields' }],
  ['/api/bot-lark-tool-binding', '[]', 400, { ok: false, error: 'no_valid_fields' }],
  ['/api/bot-lark-tool-binding', '"not_an_object"', 400, { ok: false, error: 'no_valid_fields' }],
];

describe('config-field PUT routes (botConfigPutRoute)', () => {
  let dir: string;
  let configPath: string;
  let handle: IpcServerHandle | null = null;
  let previousBotsConfig: string | undefined;

  const persistedBot = () => JSON.parse(readFileSync(configPath, 'utf8'))[0] as Record<string, unknown>;
  const put = (path: string, body?: string) => fetch(`http://127.0.0.1:${handle!.port}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ipc-config-routes-'));
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
    delete (config.daemon as { herdr?: unknown }).herdr;
    if (handle) await handle.close();
    handle = null;
    setLarkAppId('');
    if (previousBotsConfig === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = previousBotsConfig;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(ROUTES)('%s answers 503 before the daemon is bound, without touching bots.json', async (path, notBound) => {
    setLarkAppId('');
    const before = readFileSync(configPath, 'utf8');
    const res = await put(path, '{}');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(notBound);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it.each(ROUTES.map(([path]) => path))('%s answers 400 bad_json for an unparsable body', async (path) => {
    const res = await put(path, '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_json' });
  });

  // Rest params on purpose: rows without a `persisted` column are shorter, and
  // `bun test` treats a declared-but-unfilled trailing parameter as a `done`
  // callback (the test then waits forever). Arity 0 keeps both runners happy.
  it.each(CASES)('%s %s → %i', async (...row) => {
    const [path, body, status, expected, persisted] = row;
    const res = await put(path, body);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject(expected as object);
    if (status === 200 && persisted) {
      const bot = persistedBot();
      for (const [key, value] of Object.entries(persisted)) {
        if (value === undefined) expect(bot).not.toHaveProperty(key);
        else expect(bot[key]).toEqual(value);
      }
    }
    if (status !== 200) {
      expect(persistedBot()).toEqual({ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' });
    }
  });

  it('/api/bot-env merges and removes keys, then clears an empty merge result', async () => {
    const seed = await put('/api/bot-env', JSON.stringify({
      env: JSON.stringify({ KEEP: 'old', DROP: 'delete', UNTOUCHED: 'same' }),
    }));
    expect(seed.status).toBe(200);

    const merge = await put('/api/bot-env', JSON.stringify({
      mode: 'merge',
      env: JSON.stringify({ KEEP: 'new', ADDED: 'yes' }),
      remove: ['DROP'],
    }));
    expect(merge.status).toBe(200);
    expect(await merge.json()).toEqual({ ok: true, env: '', envKeys: ['ADDED', 'KEEP', 'UNTOUCHED'] });
    expect(persistedBot().env).toEqual({ KEEP: 'new', ADDED: 'yes', UNTOUCHED: 'same' });

    const clear = await put('/api/bot-env', JSON.stringify({
      mode: 'merge',
      remove: ['KEEP', 'ADDED', 'UNTOUCHED'],
    }));
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ ok: true, env: '', envKeys: [] });
    expect(persistedBot()).not.toHaveProperty('env');
  });

  it('/api/bot-herdr normalizes a full block, echoes it pretty-printed, then clears', async () => {
    // 重复 chatTypes 与 bots.json/env 门一致：去重接受，不报错。
    const dedupBody = JSON.stringify({
      herdr: JSON.stringify({
        sessionName: ' default ',  // trim
        placement: 'split',
        workspace: '',              // empty after trim → dropped
        tab: '3',
        splitDirection: 'right',
        chatTypes: ['group', 'group'],  // duplicated → deduped
      }),
    });
    const save = await put('/api/bot-herdr', dedupBody);
    expect(save.status).toBe(200);
    const savedBody = await save.json();
    expect(savedBody.ok).toBe(true);
    expect(JSON.parse(savedBody.herdr)).toEqual({
      sessionName: 'default',
      placement: 'split',
      tab: '3',
      splitDirection: 'right',
      chatTypes: ['group'],
    });
    expect(persistedBot().herdr).toEqual({
      sessionName: 'default',
      placement: 'split',
      tab: '3',
      splitDirection: 'right',
      chatTypes: ['group'],
    });
    // 缺激活字段：只填 tab 被拒且不落盘。
    const inert = await put('/api/bot-herdr', JSON.stringify({ herdr: JSON.stringify({ tab: '9' }) }));
    expect(inert.status).toBe(400);
    expect((await inert.json()).error).toContain('invalid_herdr_config');
    // 非字符串 body：拒绝，不当清除。
    const wrongType = await put('/api/bot-herdr', JSON.stringify({ herdr: { tab: '9' } }));
    expect(wrongType.status).toBe(400);
    expect(persistedBot().herdr).toBeDefined();

    const clear = await put('/api/bot-herdr', JSON.stringify({ herdr: '' }));
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ ok: true, herdr: '' });
    expect(persistedBot()).not.toHaveProperty('herdr');
  });

  it('/api/bot-herdr accepts partial bot overrides when the env already activates placement', async () => {
    // 全局 env 已提供 placement（BOTMUX_HERDR_PLACEMENT），bot 块只覆盖 tab 是
    // 合法的字段级叠加，不能被「需至少 sessionName/placement」误杀。
    const daemon = config.daemon as { herdr?: unknown };
    daemon.herdr = { placement: 'split', chatTypes: ['group'] };
    try {
      const save = await put('/api/bot-herdr', JSON.stringify({ herdr: JSON.stringify({ tab: '3' }) }));
      expect(save.status).toBe(200);
      expect(JSON.parse((await save.json()).herdr)).toEqual({ tab: '3' });
      expect(persistedBot().herdr).toEqual({ tab: '3' });
      // env 只放了非激活字段时，bot 部分覆盖仍不生效 → 拒绝。
      daemon.herdr = { chatTypes: ['group'] };
      const inert = await put('/api/bot-herdr', JSON.stringify({ herdr: JSON.stringify({ tab: '3' }) }));
      expect(inert.status).toBe(400);
      expect((await inert.json()).error).toContain('invalid_herdr_config');
    } finally {
      delete daemon.herdr;
    }
  });

  it('never reaches the spec_missing branch: every field key resolves in the config store', async () => {
    // 成功路径能走到 200 即说明 findConfigField 命中；这里用「必不为 500」兜住所有路由。
    for (const [path] of ROUTES) {
      for (const body of ['{}', '{"x":1}']) {
        const res = await put(path, body);
        expect(res.status, `${path} ${body}`).not.toBe(500);
        expect(await res.text(), `${path} ${body}`).not.toContain('spec_missing');
      }
    }
  });
});
