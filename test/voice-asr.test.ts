/**
 * ASR 配置解析（evaluateAsrConfig）+ OpenAI 兼容转写适配器（transcribeAudioFile）。
 * Run: pnpm vitest run test/voice-asr.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAsrConfig, DEFAULT_ASR_TIMEOUT_MS } from '../src/services/voice/index.js';
import { transcribeAudioFile, type ResolvedAsrConfig } from '../src/services/voice/asr.js';

const baseCfg: ResolvedAsrConfig = { baseUrl: 'http://asr.example/v1', model: 'whisper-1', timeoutMs: 60000 };

let tmpDir: string;
let audioPath: string;
const audioBytes = Buffer.from('fake-ogg-opus-bytes');

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'botmux-asr-test-'));
  audioPath = join(tmpDir, 'voice.ogg');
  writeFileSync(audioPath, audioBytes);
});

afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(text: string): any {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ text }),
    text: async () => '',
  };
}

function textResponse(body: string): any {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
    json: async () => { throw new Error('not json'); },
    text: async () => body,
  };
}

function errorResponse(status: number, body: string): any {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: async () => { throw new Error('not json'); },
    text: async () => body,
  };
}

describe('evaluateAsrConfig', () => {
  it('双 undefined / 空对象 → null', () => {
    expect(evaluateAsrConfig(undefined, undefined)).toBeNull();
    expect(evaluateAsrConfig({}, {})).toBeNull();
  });

  it('enabled 缺省或 false → null（即使 baseUrl/model 齐全）', () => {
    expect(evaluateAsrConfig({ baseUrl: 'http://x/v1', model: 'whisper-1' }, undefined)).toBeNull();
    expect(evaluateAsrConfig({ enabled: false, baseUrl: 'http://x/v1', model: 'whisper-1' }, undefined)).toBeNull();
  });

  it('enabled=true 但缺 baseUrl → null', () => {
    expect(evaluateAsrConfig({ enabled: true, model: 'whisper-1' }, undefined)).toBeNull();
  });

  it('enabled=true 但缺 model → null', () => {
    expect(evaluateAsrConfig({ enabled: true, baseUrl: 'http://x/v1' }, undefined)).toBeNull();
  });

  it('enabled=true + baseUrl + model → 有效配置，timeoutMs 默认 120000', () => {
    const cfg = evaluateAsrConfig({ enabled: true, baseUrl: 'http://x/v1', model: 'whisper-1' }, undefined);
    expect(cfg).toEqual({ baseUrl: 'http://x/v1', model: 'whisper-1', timeoutMs: DEFAULT_ASR_TIMEOUT_MS });
    expect(DEFAULT_ASR_TIMEOUT_MS).toBe(120000);
  });

  it('apiKey 缺省 → 仍有效（自托管场景），结果不含 apiKey 字段', () => {
    const cfg = evaluateAsrConfig({ enabled: true, baseUrl: 'http://x/v1', model: 'whisper-1' }, undefined);
    expect(cfg).not.toBeNull();
    expect(cfg).not.toHaveProperty('apiKey');
  });

  it('per-bot 逐字段覆盖 global（model 覆盖，baseUrl/apiKey 继承）', () => {
    const cfg = evaluateAsrConfig(
      { enabled: true, baseUrl: 'http://global/v1', apiKey: 'sk-global', model: 'whisper-1' },
      { model: 'whisper-large' },
    );
    expect(cfg?.model).toBe('whisper-large');
    expect(cfg?.baseUrl).toBe('http://global/v1');
    expect(cfg?.apiKey).toBe('sk-global');
  });

  it('per-bot 可补全 global 缺的字段', () => {
    const cfg = evaluateAsrConfig(
      { enabled: true, baseUrl: 'http://global/v1' },
      { model: 'whisper-1', apiKey: 'sk-bot' },
    );
    expect(cfg?.model).toBe('whisper-1');
    expect(cfg?.apiKey).toBe('sk-bot');
  });

  it('timeoutMs 自定义 → 透传', () => {
    const cfg = evaluateAsrConfig({ enabled: true, baseUrl: 'http://x/v1', model: 'whisper-1', timeoutMs: 5000 }, undefined);
    expect(cfg?.timeoutMs).toBe(5000);
  });

  it('language 透传', () => {
    const cfg = evaluateAsrConfig({ enabled: true, baseUrl: 'http://x/v1', model: 'whisper-1', language: 'zh' }, undefined);
    expect(cfg?.language).toBe('zh');
  });
});

describe('transcribeAudioFile', () => {
  it('POST 到 {baseUrl去尾斜杠}/audio/transcriptions，multipart 含 file(voice.ogg)+model', async () => {
    const fetchStub = vi.fn(async () => jsonResponse('你好'));
    vi.stubGlobal('fetch', fetchStub as any);
    const text = await transcribeAudioFile({ ...baseCfg, baseUrl: 'http://asr.example/v1/' }, audioPath);
    expect(text).toBe('你好');
    const [url, init] = fetchStub.mock.calls[0] as [string, any];
    expect(url).toBe('http://asr.example/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('whisper-1');
    const file = form.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe('voice.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(file.size).toBe(audioBytes.length);
  });

  it('带 apiKey → Authorization: Bearer 头', async () => {
    const fetchStub = vi.fn(async () => jsonResponse('你好'));
    vi.stubGlobal('fetch', fetchStub as any);
    await transcribeAudioFile({ ...baseCfg, apiKey: 'sk-test' }, audioPath);
    const [, init] = fetchStub.mock.calls[0] as [string, any];
    expect(init.headers.Authorization).toBe('Bearer sk-test');
  });

  it('无 apiKey → 不带 Authorization 头', async () => {
    const fetchStub = vi.fn(async () => jsonResponse('你好'));
    vi.stubGlobal('fetch', fetchStub as any);
    await transcribeAudioFile(baseCfg, audioPath);
    const [, init] = fetchStub.mock.calls[0] as [string, any];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('language：cfg 透传 / opts 覆盖 / 都缺省不带', async () => {
    const fetchStub = vi.fn(async () => jsonResponse('你好'));
    vi.stubGlobal('fetch', fetchStub as any);

    await transcribeAudioFile({ ...baseCfg, language: 'zh' }, audioPath);
    let form = (fetchStub.mock.calls.at(-1) as [string, any])[1].body as FormData;
    expect(form.get('language')).toBe('zh');

    await transcribeAudioFile({ ...baseCfg, language: 'zh' }, audioPath, { language: 'en' });
    form = (fetchStub.mock.calls.at(-1) as [string, any])[1].body as FormData;
    expect(form.get('language')).toBe('en');

    await transcribeAudioFile(baseCfg, audioPath);
    form = (fetchStub.mock.calls.at(-1) as [string, any])[1].body as FormData;
    expect(form.has('language')).toBe(false);
  });

  it('JSON 响应 {text} → 返回文本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('你好，世界')) as any);
    expect(await transcribeAudioFile(baseCfg, audioPath)).toBe('你好，世界');
  });

  it('纯文本响应 → trim 后返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('  纯文本转写  ')) as any);
    expect(await transcribeAudioFile(baseCfg, audioPath)).toBe('纯文本转写');
  });

  it('JSON 响应缺 text 字段 → 抛 ASR 转写结果为空', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
      text: async () => '',
    })) as any);
    await expect(transcribeAudioFile(baseCfg, audioPath)).rejects.toThrow('ASR 转写结果为空');
  });

  it('HTTP 401 → 抛 ASR HTTP 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(401, 'invalid api key')) as any);
    await expect(transcribeAudioFile(baseCfg, audioPath)).rejects.toThrow('ASR HTTP 401');
  });

  it('HTTP 500 → 错误消息含 status 且 detail 截断到 200 字符', async () => {
    const detail = 'X'.repeat(300);
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(500, detail)) as any);
    const err = await transcribeAudioFile(baseCfg, audioPath).catch((e) => e as Error);
    expect(err.message).toContain('ASR HTTP 500');
    expect(err.message.endsWith('X'.repeat(200))).toBe(true);
    expect(err.message).not.toContain('X'.repeat(201));
  });

  it('空文本响应 → 抛 ASR 转写结果为空', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('   ')) as any);
    await expect(transcribeAudioFile(baseCfg, audioPath)).rejects.toThrow('ASR 转写结果为空');
  });

  it('AbortError（超时）→ 抛 ASR 转写超时', async () => {
    const fetchStub = vi.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    vi.stubGlobal('fetch', fetchStub as any);
    await expect(transcribeAudioFile(baseCfg, audioPath, { timeoutMs: 30 })).rejects.toThrow('ASR 转写超时');
  });
});
