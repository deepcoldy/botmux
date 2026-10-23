import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveBunExecutable, spawnNodeTsScript } from './helpers/ts-runner.js';
import { invalidateGlobalConfigCache, readGlobalConfig } from '../src/global-config.js';
import { resolveVoiceConfig, synthesizeVoicePcmForMessage } from '../src/services/voice/index.js';
import { loadBotConfigs } from '../src/bot-registry.js';

const asr = { enabled: true, baseUrl: 'https://asr.example.test/v1', apiKey: 'ASR_KEY', model: 'whisper-1', language: 'zh', timeoutMs: 45000 };
const initial = { voice: { engine: 'minimax', minimax: { apiKey: 'STALE_KEY' }, speaker: 'stale', rate: 1.6, asr }, lang: 'zh' };
type Step = [prompt: string, answer: string];
let home: string;
let config: string;
let bots: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-voice-cli-'));
  config = join(home, 'config.json');
  bots = join(home, 'bots.json');
  mkdirSync(join(home, 'bin'));
  writeFileSync(config, JSON.stringify(initial));
  writeFileSync(bots, '[]');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  invalidateGlobalConfigCache();
  rmSync(home, { recursive: true, force: true });
});

function cli(runtime: 'node' | 'bun', args: string[], steps: Step[] = []): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('BOTMUX_') && key !== 'BOTS_CONFIG'));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, BOTMUX_GLOBAL_CONFIG_FILE: config, BOTS_CONFIG: bots,
    BOTMUX_NO_CLAIM: '1', XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    PATH: join(home, 'bin'),
  });
  const script = resolve('src/cli.ts');
  const bun = resolveBunExecutable();
  if (runtime === 'bun' && !bun) throw new Error('Bun is required for CLI verification');
  const child = runtime === 'bun' && bun
    ? spawn(bun, [script, 'voice', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawnNodeTsScript(script, ['voice', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((done, reject) => {
    let output = '';
    let cursor = 0;
    let step = 0;
    let declined = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15_000);
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
      const next = steps[step];
      if (next) {
        const index = output.indexOf(next[0], cursor);
        if (index >= 0) {
          cursor = index + next[0].length;
          step++;
          child.stdin?.write(next[1] + '\n');
        }
      }
      if (!declined && output.includes('现在自动安装 opus-tools？')) {
        declined = true;
        child.stdin?.write('n\n');
      }
    });
    child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) reject(new Error(`CLI failed (${code}, ${signal}): ${output}`));
      else if (step !== steps.length) reject(new Error(`CLI consumed ${step}/${steps.length} prompts: ${output}`));
      else done(output);
    });
  });
}

function volcengineSteps(mode: string, key = 'VOLC_KEY_CANARY', rate = ''): Step[] {
  return [['选择 TTS 引擎', '4'], ['选择 mode', mode], ['专用 API key', key], ['音色 speaker', ''], ['语速倍率', rate]];
}

function savedVoice() {
  return z.object({ voice: z.record(z.unknown()), lang: z.string() }).parse(JSON.parse(readFileSync(config, 'utf8')));
}

describe.each(['node', 'bun'] satisfies Array<'node' | 'bun'>)('real voice setup under %s', (runtime) => {
  it.each([['1', 'standard'], ['agent-plan', 'agent-plan']])('saves explicit mode %s, preserves ASR, and hides the whole key in status', async (answer, mode) => {
    const output = await cli(runtime, [], volcengineSteps(answer));
    expect(output).toContain('已写入 voice 配置');
    expect(output).toContain('已跳过');
    const saved = savedVoice();
    expect(saved.lang).toBe('zh');
    expect(saved.voice).toEqual({
      engine: 'volcengine', volcengine: { mode, apiKey: 'VOLC_KEY_CANARY' },
      speaker: 'zh_female_vv_uranus_bigtts', rate: 1, asr,
    });
    const status = await cli(runtime, ['status']);
    expect(status).toContain(`mode=${mode}`);
    expect(status).toContain('seed-tts-2.0');
    expect(status).toContain('apiKey=(已设置)');
    expect(status).toContain('火山引擎配置: 可用');
    expect(status).not.toContain('VOLC');
    expect(status).not.toContain('ASR_KEY');
  }, 25_000);

  it.each(['', 'typo', 'STANDARD'])('does not write when mode is %s', async (mode) => {
    const before = readFileSync(config, 'utf8');
    const output = await cli(runtime, [], volcengineSteps(mode).slice(0, 2));
    expect(output).toContain('未写入');
    expect(readFileSync(config, 'utf8')).toBe(before);
  });
  it.each(['', 'bad\tkey'])('does not write an invalid key, row %#', async (key) => {
    const before = readFileSync(config, 'utf8');
    const output = await cli(runtime, [], volcengineSteps('2', key).slice(0, 3));
    expect(output).toContain('未写入');
    expect(readFileSync(config, 'utf8')).toBe(before);
  });
  it.each(['NaN', 'Infinity', '0', '-1', 'oops'])('does not write invalid rate %s', async (rate) => {
    const before = readFileSync(config, 'utf8');
    const output = await cli(runtime, [], volcengineSteps('standard', 'fake', rate));
    expect(output).toContain('未写入');
    expect(readFileSync(config, 'utf8')).toBe(before);
  });
  it.each([
    [['选择 TTS 引擎', '1'], ['SAMI accessKey', 'ak'], ['SAMI secretKey', 'sk'], ['SAMI appkey', 'app'], ['音色 speaker', ''], ['自定义 SAMI 端点', ''], ['语速倍率', '']],
    [['选择 TTS 引擎', '2'], ['baseUrl（', 'https://tts.example.test/v1'], ['apiKey（', 'fake'], ['model（', 'tts-1'], ['音色 voice（', ''], ['语速倍率', '']],
    [['选择 TTS 引擎', '3'], ['MiniMax API key', 'fake'], ['接入区域', '2'], ['模型 model', ''], ['音色 voice id', ''], ['语速倍率', '']],
  ] satisfies Step[][])('preserves ASR for existing engines, row %#', async (...steps) => {
    expect(await cli(runtime, [], steps)).toContain('已跳过');
    const voice = savedVoice().voice;
    expect(voice.asr).toEqual(asr);
    expect(voice.speaker).toBeUndefined();
    expect(voice.rate).toBeUndefined();
    expect(voice.volcengine).toBeUndefined();
    expect(JSON.stringify(voice)).not.toContain('STALE_KEY');
  });
  it.each([null, undefined, { mode: 'agent-plan' }, { apiKey: 'VOLC_KEY_CANARY' }])('reports an incomplete account as disabled, row %#', async (volcengine) => {
    writeFileSync(config, JSON.stringify({ voice: { engine: 'volcengine', volcengine } }));
    const status = await cli(runtime, ['status']);
    expect(status).toContain('已禁用或不完整');
    expect(status).not.toContain('VOLC');
    expect(status).not.toContain('配置: 可用');
  });
});

describe('real disk voice inheritance and dispatch', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', config);
    vi.stubEnv('BOTS_CONFIG', bots);
    writeFileSync(config, JSON.stringify({ voice: {
      engine: 'volcengine', volcengine: { mode: 'standard', apiKey: 'GLOBAL_STANDARD_KEY' }, asr,
    } }));
    invalidateGlobalConfigCache();
  });
  function botVoice(voice: unknown) {
    writeFileSync(bots, JSON.stringify([{ larkAppId: 'cli_voice_fixture', larkAppSecret: 'fake', voice }]));
  }
  it.each([null, { mode: 'typo' }, { mode: 'agent-plan' }, { apiKey: '' }])('denies malformed or switched accounts without falling back, row %#', async (volcengine) => {
    botVoice({ volcengine });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(readGlobalConfig().voice?.asr).toEqual(asr);
    const loaded = loadBotConfigs()[0]?.voice;
    expect(loaded).toBeDefined();
    if (volcengine === null || volcengine.mode === 'typo') expect(loaded?.volcengine).toBeNull();
    expect(resolveVoiceConfig('cli_voice_fixture')).toBeNull();
    await expect(synthesizeVoicePcmForMessage('cli_voice_fixture', 'hi')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not activate a global mode-less key through a bot mode', () => {
    writeFileSync(config, JSON.stringify({ voice: { engine: 'volcengine', volcengine: { apiKey: 'UNSCOPED' } } }));
    invalidateGlobalConfigCache();
    botVoice({ volcengine: { mode: 'agent-plan' } });
    expect(resolveVoiceConfig('cli_voice_fixture')).toBeNull();
  });
  it.each([{ rate: 1.2 }, { speaker: 'custom' }])('retains scalar-only bot overrides from disk, row %#', (voice) => {
    botVoice(voice);
    expect(resolveVoiceConfig('cli_voice_fixture')).toMatchObject({
      ...voice, volcengine: { mode: 'standard', apiKey: 'GLOBAL_STANDARD_KEY' },
    });
  });
  it('dispatches spoken text and the explicit plan account through the PCM entry point', async () => {
    botVoice({ volcengine: { mode: 'agent-plan', apiKey: 'BOT_PLAN_KEY' }, rate: 1.1 });
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe('https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional');
      expect(init?.headers).toMatchObject({ 'X-Api-Key': 'BOT_PLAN_KEY' });
      expect(String(init?.body)).toContain('"speaker":"zh_female_vv_uranus_bigtts"');
      return new Response('{"code":0,"data":"AQI="}{"code":20000000}');
    });
    vi.stubGlobal('fetch', fetcher);
    expect((await synthesizeVoicePcmForMessage('cli_voice_fixture', '**hello**')).data).toEqual(Buffer.from([1, 2]));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
