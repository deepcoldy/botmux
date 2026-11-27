import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDshAdapter } from '../src/adapters/cli/dsh.js';
import { parseArgs } from '../src/dsh-runner-args.js';
import { readJsonLines } from './helpers/read-json-lines.js';
import { spawnTsScript } from './helpers/ts-runner.js';

/**
 * The preamble the real dsh runner puts in front of its first prompt, for the argv
 * the real dsh adapter builds. The runner is a CLI child and never sees the native
 * gateway marker, so in a native gateway core the adapter has to tell it; without
 * that the model is told it is a Feishu group bot.
 */
const APP = 'local_wecom_dshfix';
const RUNNER = resolve('src/dsh-runner.ts');
const FAKE_DSH = resolve('test/fixtures/fake-dsh-server.mjs');
const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(children.splice(0).map(child => new Promise<void>(done => {
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('exit', () => { clearTimeout(force); done(); });
    child.kill('SIGTERM');
  })));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function adapterFlags(mode: 'native' | 'bare-core', botName = APP): string[] {
  vi.unstubAllEnvs();
  vi.stubEnv('BOTMUX_CORE_ONLY', '1');
  if (mode === 'native') vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', '1');
  const argv = createDshAdapter('/opt/fake/dsh').buildArgs({
    sessionId: 'session-dsh-native', resume: false, workingDir: '/placeholder', botName, botOpenId: `bot_${APP}`, larkAppId: APP, locale: 'zh',
  } as any) as string[];
  vi.unstubAllEnvs();
  // The identity / locale / mode flags; the fixture supplies binary, profile and cwd.
  const flags: string[] = [];
  for (let i = argv.indexOf('--session-id'); i < argv.length; i++) {
    if (['--session-id', '--dsh-bin', '--cwd', '--dsh-profile', '--bridge-patch'].includes(argv[i]!)) { i++; continue; }
    flags.push(argv[i]!);
  }
  return flags;
}

/** First prompt text the runner sends to the fake dsh server for one message. */
async function firstPrompt(flags: string[]): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-native-preamble-'));
  dirs.push(home);
  const log = join(home, 'prompts.jsonl');
  const child = spawnTsScript(RUNNER, ['--session-id', 'test-session', '--dsh-bin', FAKE_DSH, '--cwd', home, ...flags], {
    cwd: resolve('.'),
    env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), FAKE_DSH_SCENARIO: 'happy', FAKE_DSH_LOG: log, DSH_CORDIS_CONFIG: '' },
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { stdout += d; });
  const until = async (cond: () => boolean, label: string) => {
    const deadline = Date.now() + 20_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${stdout}`);
      await new Promise(r => setTimeout(r, 50));
    }
  };
  await until(() => stdout.includes('›'), 'ready');
  child.stdin.write(`::botmux-dsh:${Buffer.from(JSON.stringify({ type: 'message', content: 'hello (fake)' }), 'utf8').toString('base64')}\n`);
  await until(() => /\x1b\]777;botmux:final:/.test(stdout), 'final');
  const prompt = readJsonLines(log).find((r: any) => r.prompt);
  return String(prompt.prompt.contentBlocks[0].text);
}

/** Sentences banning botmux send with no exception (as in native-gateway-prompt.test.ts). */
function unconditionalSendBans(text: string): string[] {
  return text.split(/\n|(?<=[.;。；])/)
    .filter(s => /botmux send|发消息/.test(s))
    .filter(s => /\b(do not|don't|never)\b|不要|禁止|不得/i.test(s))
    .filter(s => !/\b(other|unless|except|only)\b|其它|其他|除非|只有/i.test(s));
}

describe('dsh runner preamble in a native gateway core', () => {
  it('the adapter flags the runner only in a native gateway core', () => {
    expect(adapterFlags('native')).toContain('--native-gateway');
    expect(adapterFlags('bare-core')).not.toContain('--native-gateway');
  });

  it('describes the channel gateway, not Feishu/Lark, and keeps the send rule of the turn', async () => {
    const native = await firstPrompt(adapterFlags('native'));
    const preamble = native.slice(0, native.indexOf('</botmux_identity>'));
    expect(preamble).toContain('<botmux_identity>');
    expect(preamble).not.toMatch(/飞书|Feishu|Lark/i);
    expect(unconditionalSendBans(preamble)).toEqual([]);
    expect(preamble).not.toContain(APP);
    expect(native.endsWith('hello (fake)')).toBe(true);
    // Same runner, same identity, without the flag: the existing preamble.
    const bare = await firstPrompt(adapterFlags('bare-core'));
    expect(bare).not.toBe(native);
    expect(bare).toMatch(/飞书/);
  });

  it('a configured display name still reaches the preamble', async () => {
    const native = await firstPrompt(adapterFlags('native', '客服小助手'));
    expect(native).toContain('客服小助手');
  });

  it('reads the flag only where a flag can stand, never from another flag\'s value', () => {
    const base = ['--session-id', 's', '--dsh-bin', '/opt/fake/dsh'];
    expect(parseArgs([...base, '--native-gateway', '--locale', 'zh'])).toMatchObject({ nativeGateway: true, locale: 'zh' });
    expect(parseArgs([...base, '--locale', 'zh', '--native-gateway'])).toMatchObject({ nativeGateway: true, locale: 'zh' });
    const named = parseArgs([...base, '--bot-name', '--native-gateway', '--locale', 'zh']);
    expect(named.botName).toBe('--native-gateway');
    expect(named.nativeGateway).toBeUndefined();
    expect(parseArgs(base).nativeGateway).toBeUndefined();
  });
});
