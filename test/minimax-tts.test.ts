import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MINIMAX_SPEAKER,
  DEFAULT_MINIMAX_TTS_MODEL,
  MINIMAX_CN_TTS_ENDPOINT,
  MINIMAX_GLOBAL_TTS_ENDPOINT,
  minimaxSynthesizePcm,
} from '../src/services/voice/minimax.js';

function successResponse(audio = '00017fff8000', extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    data: { audio, status: 2 },
    extra_info: { audio_sample_rate: 24000, audio_channel: 1, audio_format: 'pcm' },
    base_resp: { status_code: 0, status_msg: 'success' },
    ...extra,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const CFG = { apiKey: 'test-key' };
const OPTS = { speaker: DEFAULT_MINIMAX_SPEAKER };

describe('MiniMax TTS adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the T2A v2 PCM request and decodes hex audio', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      order.push('fetch');
      return successResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await minimaxSynthesizePcm(
      { apiKey: 'test-key' },
      ' hello ',
      { speaker: DEFAULT_MINIMAX_SPEAKER, rate: 1.25 },
      { beforeProviderEffect: () => { order.push('fence'); } },
    );

    expect(order).toEqual(['fence', 'fetch']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(MINIMAX_GLOBAL_TTS_ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: DEFAULT_MINIMAX_TTS_MODEL,
      text: 'hello',
      stream: false,
      output_format: 'hex',
      voice_setting: {
        voice_id: DEFAULT_MINIMAX_SPEAKER,
        speed: 1.25,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 24000,
        format: 'pcm',
        channel: 1,
      },
    });
    expect(result).toEqual({
      data: Buffer.from('00017fff8000', 'hex'),
      sampleRate: 24000,
      channels: 1,
    });
  });

  it('selects the China endpoint and forwards an explicit model', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => successResponse('0102'));
    vi.stubGlobal('fetch', fetchMock);

    await minimaxSynthesizePcm(
      { apiKey: 'test-key', region: 'cn', model: 'custom-speech-model' },
      'hello',
      { speaker: 'custom-voice' },
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(MINIMAX_CN_TTS_ENDPOINT);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'custom-speech-model' });
  });

  it('clamps speed into the documented [0.5, 2] range', async () => {
    const fetchMock = vi.fn(async () => successResponse('00'));
    vi.stubGlobal('fetch', fetchMock);
    await minimaxSynthesizePcm(CFG, 'hi', { ...OPTS, rate: 5 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).voice_setting.speed).toBe(2);
  });

  it('rejects empty text and a missing API key before any fetch', async () => {
    const fetchMock = vi.fn(async () => successResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(minimaxSynthesizePcm(CFG, '   ', OPTS)).rejects.toThrow('没有要合成的文字');
    await expect(minimaxSynthesizePcm({ apiKey: '' }, 'hi', OPTS)).rejects.toThrow('API key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx HTTP status with the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    await expect(minimaxSynthesizePcm(CFG, 'hi', OPTS))
      .rejects.toThrow(/MiniMax TTS HTTP 401.*bad key/);
  });

  it('surfaces a provider base_resp error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: null,
      base_resp: { status_code: 1004, status_msg: 'invalid request' },
    }), { status: 200 })));
    await expect(minimaxSynthesizePcm(CFG, 'hi', OPTS)).rejects.toThrow('接口错误 1004');
  });

  it('rejects an incomplete data.status (streaming/intermediate status)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { audio: '00', status: 1 },
      base_resp: { status_code: 0, status_msg: 'ok' },
    }), { status: 200 })));
    await expect(minimaxSynthesizePcm(CFG, 'hi', OPTS)).rejects.toThrow('音频状态不完整');
  });

  it('rejects a non-PCM audio_format announced in extra_info', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => successResponse('00', {
      extra_info: { audio_sample_rate: 24000, audio_channel: 1, audio_format: 'mp3' },
    })));
    await expect(minimaxSynthesizePcm(CFG, 'hi', OPTS)).rejects.toThrow('非预期的音频格式');
  });

  it('rejects odd-length hex (length guard, regex alone would pass)', async () => {
    // 'abc' is odd-length yet matches /^[0-9a-f]+$/i — only the % 2 guard can catch it.
    vi.stubGlobal('fetch', vi.fn(async () => successResponse('abc')));
    await expect(minimaxSynthesizePcm(CFG, 'hi', OPTS)).rejects.toThrow('hex 解码失败');
  });

  it('rejects even-length non-hex audio (regex guard, length alone would pass)', async () => {
    // 'zzzz' has even length but contains no hex digits — only the regex can catch it.
    vi.stubGlobal('fetch', vi.fn(async () => successResponse('zzzz')));
    await expect(minimaxSynthesizePcm(CFG, 'hi', OPTS)).rejects.toThrow('hex 解码失败');
  });

  it('maps an abort (timeout) to a Chinese timeout error', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    })));
    await expect(minimaxSynthesizePcm(CFG, 'hi', { ...OPTS, timeoutMs: 5 }))
      .rejects.toThrow('MiniMax TTS 合成超时');
  });
});
