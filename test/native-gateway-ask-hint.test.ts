// Must stay the first import: the spawn path and session store below write under HOME / the data dir.
import './helpers/require-fenced-data-dir.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeGatewayAskHintBlock } from '../src/skills/injection-mode.js';
import { CLI_DISPLAY_NAMES } from '../src/adapters/cli/display-names.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { parseAskOptions } from '../src/core/ask-args.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { readRequestBodyJson } from './helpers/read-request-body.js';

/**
 * A native IM gateway's core offers no built-in skills, so a CLI there no longer
 * learns about `botmux ask` from the skill catalog / help pointer / ask skill
 * file it used to get. Asks do work there (test/native-gateway-ask-request.test.ts
 * runs them through the real ask route and gateway). Every CLI that learned of
 * it before must still learn of it, in the same place (opening turn vs system
 * prompt); a CLI that takes questions through its own hook gets nothing.
 *
 * "Before" is a bare core-only service: it renders exactly what a native core
 * rendered before skills were withdrawn there (that change is gated on the
 * native flag alone).
 */
const APP = 'local_wecom_askhint';
const SID = '11111111-2222-4333-8444-555555555555';
const CLI_IDS = Object.keys(CLI_DISPLAY_NAMES) as CliId[];
// The catalog entry, the command, or `ask` in the help pointer's capability list.
const MENTIONS_ASK = /botmux-ask|botmux ask|(?:[（(]|\/ )ask \//;

function enter(mode: 'native' | 'bare-core', cli: CliId, skillInjection = 'prompt'): void {
  vi.stubEnv('BOTMUX_CORE_ONLY', '1');
  vi.stubEnv('BOTMUX_API_ONLY_BOT', APP);
  vi.stubEnv('BOTMUX_CORE_BOT_CONFIG', JSON.stringify({ skillInjection }));
  vi.stubEnv('BOTMUX_CORE_CLI', cli);
  vi.stubEnv('BOTMUX_CORE_SKIP_DOTENV', '1');
  vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', mode === 'native' ? '1' : '');
}

let codexHome: string;
beforeAll(() => { codexHome = mkdtempSync(join(tmpdir(), 'botmux-ask-hint-codex-')); });
afterAll(() => rmSync(codexHome, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

/** A fresh module graph, as a fresh core process has: the spawn path installs
 *  the ask skill once per CLI per process (worker-pool's once-gate). */
async function freshCore() {
  vi.resetModules();
  const [sm, inj, registry, pool, bots, store] = await Promise.all([
    import('../src/core/session-manager.js'),
    import('../src/skills/injection-mode.js'),
    import('../src/adapters/cli/registry.js'),
    import('../src/core/worker-pool.js'),
    import('../src/bot-registry.js'),
    import('../src/services/session-store.js'),
  ]);
  enter('native', 'codex');
  for (const cfg of bots.loadBotConfigs()) bots.registerBot(cfg);
  store.init(APP);
  return { sm, inj, registry, pool };
}
type Core = Awaited<ReturnType<typeof freshCore>>;

/** Where a session of `cli` reads about asks, in the current process mode. */
function channels(core: Core, cli: CliId): { opening: string; systemPrompt: string; skillFile: boolean; adapter: any } {
  const { sm, inj, registry, pool } = core;
  vi.stubEnv('CODEX_HOME', codexHome);
  const adapter: any = registry.createCliAdapterSync(cli);
  const opening = sm.buildNewTopicCliInput('hello (fake)', SID, cli, undefined, [], [], undefined, undefined,
    { name: APP, openId: `bot_${APP}` }, 'zh', undefined, { larkAppId: APP, chatId: 'http_async_hint-1', larkToolResume: false }).content;
  let systemPrompt = '';
  try {
    const env: Record<string, string> = {};
    const argv = adapter.buildArgs({ sessionId: SID, resume: false, workingDir: tmpdir(), botName: APP, botOpenId: `bot_${APP}`,
      larkAppId: APP, noTransport: true, locale: 'zh', promptInjection: 'default', hideLocalAddresses: false, disableCliBypass: false, env });
    systemPrompt = [...(Array.isArray(argv) ? argv : []), ...Object.values(env)].join('\n');
  } catch { /* an adapter whose binary is missing renders no system prompt here, in either mode */ }
  // mojo's block is resolved by the worker (worker.ts) with exactly this call.
  if (cli === 'mojo') systemPrompt += inj.builtinSkillBlockForInjectsSessionContext(APP, 'zh', { asksViaHook: false, whiteboardEnabled: false, hasRoutingBlock: false });
  const dirs = [adapter.pluginDir ? join(adapter.pluginDir, 'skills') : '', adapter.skillsDir ? adapter.skillsDir.replace(/^~(?=\/)/, homedir()) : ''].filter(Boolean);
  for (const d of dirs) rmSync(join(d, 'botmux-ask'), { recursive: true, force: true });
  pool.ensureCliSkills(cli);
  const skillFile = dirs.some(d => existsSync(join(d, 'botmux-ask', 'SKILL.md')));
  for (const d of dirs) rmSync(join(d, 'botmux-ask'), { recursive: true, force: true });
  return { opening, systemPrompt, skillFile, adapter };
}

describe('the ask hint replaces exactly what each CLI learned about botmux ask', () => {
  it.each(['prompt', 'off', 'global'])('skillInjection=%s: same CLIs, same place, nothing for hook askers', async (skillInjection) => {
    const core = await freshCore();
    const informed: string[] = [];
    for (const cli of CLI_IDS) {
      enter('bare-core', cli, skillInjection);
      const before = channels(core, cli);
      const learnedBefore = MENTIONS_ASK.test(before.opening) || MENTIONS_ASK.test(before.systemPrompt) || before.skillFile;
      enter('native', cli, skillInjection);
      const now = channels(core, cli);
      const inOpening = now.opening.includes('<botmux_ask>');
      const inSystemPrompt = now.systemPrompt.includes('<botmux_ask>');
      if (learnedBefore && !now.adapter.asksViaHook) {
        informed.push(cli);
        expect({ cli, inOpening, inSystemPrompt }).toEqual({
          cli,
          inOpening: !now.adapter.injectsSessionContext,
          inSystemPrompt: !!now.adapter.injectsSessionContext,
        });
      } else {
        expect({ cli, inOpening, inSystemPrompt }).toEqual({ cli, inOpening: false, inSystemPrompt: false });
      }
    }
    // The matrix is not vacuous: both kinds of CLI are covered.
    expect(informed.length).toBeGreaterThan(5);
  });

  it('rides the opening turn only, never a follow-up', async () => {
    const { sm } = await freshCore();
    enter('native', 'codex');
    expect(sm.buildNewTopicCliInput('hello (fake)', SID, 'codex', undefined, [], [], undefined, undefined,
      { name: APP, openId: `bot_${APP}` }, 'zh', undefined, { larkAppId: APP, chatId: 'http_async_hint-1', larkToolResume: false }).content)
      .toContain('<botmux_ask>');
    const follow = sm.buildFollowUpCliInput('next (fake)', SID, {
      isAdoptMode: false, cliId: 'codex', locale: 'zh', larkAppId: APP, chatId: 'http_async_hint-1', sessionBackendType: 'pty', turnId: 'turn_2',
    }).content;
    expect(follow).not.toContain('<botmux_ask>');
  });
});

describe('the command in the ask hint', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** The example as the model sees it, split by a real shell. */
  function exampleArgv(locale: 'zh' | 'en'): string[] {
    const command = /`(botmux ask [^`]+)`/.exec(nativeGatewayAskHintBlock(locale))?.[1];
    expect(command, 'hint names a botmux ask command').toBeTruthy();
    const out = spawnSync('/bin/sh', ['-c', `for a in ${command}; do printf '%s\\0' "$a"; done`], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    return out.stdout.split('\0').slice(0, -1);
  }

  it.each(['zh', 'en'] as const)('[%s] is accepted by the real botmux ask CLI and prints the chosen key', async (locale) => {
    const argv = exampleArgv(locale);
    expect(argv.slice(0, 2)).toEqual(['botmux', 'ask']);
    const optionsRaw = argv[argv.indexOf('--options') + 1];
    const expectedOptions = parseAskOptions(optionsRaw);

    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-hint-cli-')); dirs.push(dataDir);
    let body: Record<string, any> | undefined;
    const server = createServer(async (req: IncomingMessage, res) => {
      if (req.method !== 'POST' || req.url !== '/api/asks') { req.resume(); res.writeHead(404).end(); return; }
      body = await readRequestBodyJson<Record<string, any>>(req, { strict: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'answered', answers: [[expectedOptions[0].key]], by: 'user_fake', comment: null, timedOut: false }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
      writeFileSync(join(dataDir, 'dashboard-daemons', `${APP}.json`), JSON.stringify({
        larkAppId: APP, ipcPort: (server.address() as AddressInfo).port, lastHeartbeat: Date.now(),
      }));
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        // The session env of a native gateway core turn: an HTTP virtual chat, chat scope, no root message.
        const child = spawnTsScript(join(__dirname, '..', 'src', 'cli.ts'), argv.slice(1), {
          env: { ...process.env, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: 'sess_hint', BOTMUX_CHAT_ID: 'http_async_hint-1',
            BOTMUX_LARK_APP_ID: APP, BOTMUX_SESSION_SCOPE: 'chat', BOTMUX_ROOT_MESSAGE_ID: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams;
        let stdout = ''; let stderr = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (c: string) => { stdout += c; });
        child.stderr.on('data', (c: string) => { stderr += c; });
        child.once('error', reject);
        child.once('close', status => resolve({ status, stdout, stderr }));
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${expectedOptions[0].key}\n`);
      expect(body?.options).toEqual(expectedOptions);
      expect(body?.prompt).toBe(argv[argv.length - 1]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
