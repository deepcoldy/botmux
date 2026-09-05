import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MINIMAX_SPEAKER,
  DEFAULT_MINIMAX_TTS_MODEL,
  MINIMAX_CN_TTS_ENDPOINT,
  MINIMAX_GLOBAL_TTS_ENDPOINT,
  minimaxSynthesizePcm,
} from '../src/services/voice/minimax.js';

function successResponse(audio = '00017fff8000'): Response {
  return new Response(JSON.stringify({
    data: { audio, status: 2 },
    extra_info: { audio_sample_rate: 24000, audio_channel: 1, audio_format: 'pcm' },
    base_resp: { status_code: 0, status_msg: 'success' },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

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

  it('rejects provider errors and malformed audio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: null,
      base_resp: { status_code: 1004, status_msg: 'invalid request' },
    }), { status: 200 })));
    await expect(minimaxSynthesizePcm(
      { apiKey: 'test-key' },
      'hello',
      { speaker: DEFAULT_MINIMAX_SPEAKER },
    )).rejects.toThrow('MiniMax TTS error 1004');

    vi.stubGlobal('fetch', vi.fn(async () => successResponse('not-hex')));
    await expect(minimaxSynthesizePcm(
      { apiKey: 'test-key' },
      'hello',
      { speaker: DEFAULT_MINIMAX_SPEAKER },
    )).rejects.toThrow('invalid hex audio');
  });
});
