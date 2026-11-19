import { afterEach, describe, expect, it, vi } from 'vitest';
import { volcengineSynthesizePcm, DEFAULT_VOLCENGINE_SPEAKER } from '../src/services/voice/volcengine.js';
import type { VolcengineTtsConfig } from '../src/services/voice/types.js';
import { z } from 'zod';

const cfg = { mode: 'standard', apiKey: 'KEY_CANARY' } satisfies VolcengineTtsConfig;
const opts = { speaker: DEFAULT_VOLCENGINE_SPEAKER };
const audio = '{"code":0,"data":"AQIDBA=="}';
const end = '{"code":20000000}';
const complete = audio + end;

function reply(body: string | Uint8Array) {
  const fetcher = vi.fn(async () => new Response(body));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function streamReply(chunks: Uint8Array[], close = true, cancel = vi.fn()) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
    cancel,
  });
  const fetcher = vi.fn(async () => new Response(stream));
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, cancel };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Volcengine request', () => {
  it.each(['standard', 'agent-plan'] satisfies VolcengineTtsConfig['mode'][])('uses only the fixed %s endpoint', async (mode) => {
    const fetcher = reply(complete);
    const pcm = await volcengineSynthesizePcm({ ...cfg, mode }, '  TEXT_CANARY  ', { speaker: 'custom', rate: 1.1 });
    expect(pcm).toEqual({ data: Buffer.from([1, 2, 3, 4]), sampleRate: 24000, channels: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls.at(0);
    const requestSchema = z.tuple([z.string(), z.object({
      method: z.literal('POST'), redirect: z.literal('error'), body: z.string(),
      headers: z.record(z.string()), signal: z.instanceof(AbortSignal),
    })]);
    const [url, request] = requestSchema.parse(call);
    expect(url).toBe(`https://openspeech.bytedance.com/api/v3/${mode === 'agent-plan' ? 'plan/' : ''}tts/unidirectional`);
    expect(request.headers).toEqual({
      'Content-Type': 'application/json', 'X-Api-Key': 'KEY_CANARY',
      'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Request-Id': expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    });
    expect(JSON.parse(request.body)).toEqual({
      req_params: { text: 'TEXT_CANARY', speaker: 'custom', audio_params: { format: 'pcm', sample_rate: 24000, speech_rate: 10 } },
    });
  });
  it.each([[0.1, -50], [0.5, -50], [1, 0], [1.1, 10], [2, 100], [3, 100]])('maps rate %s to %s', async (rate, expected) => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = z.object({ req_params: z.object({ audio_params: z.object({ speech_rate: z.number() }) }) })
        .parse(JSON.parse(String(init?.body)));
      expect(body.req_params.audio_params.speech_rate).toBe(expected);
      return new Response(complete);
    });
    vi.stubGlobal('fetch', fetcher);
    await volcengineSynthesizePcm(cfg, 'hi', { ...opts, rate });
  });
  it('defaults the rate to one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(String(init?.body)).toContain('"speech_rate":0');
      return new Response(complete);
    }));
    await volcengineSynthesizePcm(cfg, 'hi', opts);
  });
  it.each([
    { mode: 'typo', apiKey: 'key' }, { apiKey: 'key' }, { mode: 'standard' },
    { mode: 'standard', apiKey: '' }, { mode: 'standard', apiKey: 'key\ninjection' },
  ])('rejects direct untyped invalid config before effects, row %#', async (invalid) => {
    const fetcher = reply(complete);
    const hook = vi.fn();
    await expect(Reflect.apply(volcengineSynthesizePcm, undefined, [invalid, 'hi', opts, { beforeProviderEffect: hook }])).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });
  it.each([
    ['', opts], ['hi', { speaker: ' ' }], ['hi', { ...opts, rate: 0 }],
    ['hi', { ...opts, rate: -1 }], ['hi', { ...opts, rate: NaN }], ['hi', { ...opts, rate: Infinity }],
    ['hi', { ...opts, timeoutMs: 0 }], ['hi', { ...opts, timeoutMs: NaN }], ['hi', { ...opts, timeoutMs: Infinity }],
  ] satisfies Array<[string, Parameters<typeof volcengineSynthesizePcm>[2]]>)('validates input before effects, row %#', async (text, options) => {
    const fetcher = reply(complete);
    const hook = vi.fn();
    await expect(volcengineSynthesizePcm(cfg, text, options, { beforeProviderEffect: hook })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('Volcengine response framing', () => {
  const fixture = JSON.stringify({ code: 0, data: null, metadata: '中文 }{ [\\] "quote"\nline' }, null, 2)
    + '\r\n' + audio + ' ' + end + '\n\t';
  it('accepts every network byte split including UTF-8, escapes, adjacent and pretty records', async () => {
    const bytes = Buffer.from(fixture);
    for (let split = 0; split <= bytes.length; split++) {
      streamReply([bytes.subarray(0, split), bytes.subarray(split)]);
      const pcm = await volcengineSynthesizePcm(cfg, 'hi', opts);
      expect(pcm.data).toEqual(Buffer.from([1, 2, 3, 4]));
    }
    streamReply([...bytes].map((byte) => Uint8Array.of(byte)));
    expect((await volcengineSynthesizePcm(cfg, 'hi', opts)).data.length).toBe(4);
  });
  it.each([undefined, '', null])('accepts metadata and completion data %s', async (data) => {
    reply(JSON.stringify({ code: 0, data }) + audio + JSON.stringify({ code: 20000000, data }));
    expect((await volcengineSynthesizePcm(cfg, 'hi', opts)).data.length).toBe(4);
  });
  it('checks sample alignment on the aggregate, allowing odd individual fragments', async () => {
    reply('{"code":0,"data":"AQ=="}{"code":0,"data":"Ag=="}' + end);
    expect((await volcengineSynthesizePcm(cfg, 'hi', opts)).data).toEqual(Buffer.from([1, 2]));
  });
  it('rejects a business error before completion without returning partial audio or exposing provider messages', async () => {
    const fetcher = reply(audio + '{"code":42,"message":"KEY_CANARY TEXT_CANARY"}' + end);
    const synthesis = volcengineSynthesizePcm(cfg, 'TEXT_CANARY', opts);
    await expect(synthesis).rejects.toThrow(/Volcengine TTS business code 42/);
    await expect(synthesis).rejects.toThrow(/^火山引擎语音合成返回业务错误/);
    await expect(synthesis).rejects.not.toThrow(/KEY_CANARY|TEXT_CANARY/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    '', audio, end, complete + end, complete + audio, complete + '{"code":42}',
    audio + '{"code":20000000,"data":"AQI="}', audio + '{"code":20000000,"data":1}',
    audio + '{"code":42,"message":"KEY_CANARY TEXT_CANARY"}',
    '{}', '{"code":"0"}', '{"code":0.5}', '{"code":0,"data":12}', '{"code":0,"data":false}',
    '{"code":0,"canary":"KEY_CANARY TEXT_CANARY",}', '{"code":0,"canary":"KEY_CANARY TEXT_CANARY',
    '[]', 'null', '{"code":0,}', '{"code":0', '{"code":0,"x":[}',
    complete + 'garbage', complete + '\u00a0', '[ ' + complete + ' ]',
    'data: ' + audio, '{"code":0,"data":"AQ=="}' + end,
  ])('rejects malformed, partial and nonterminal responses, row %#', async (body) => {
    const fetcher = reply(body);
    const error = await volcengineSynthesizePcm(cfg, 'TEXT_CANARY', opts).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/KEY_CANARY|TEXT_CANARY/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['A===', 'AQ=', 'AQI', 'AQI===', 'AQ I=', 'AQI_', 'AQI-', '!!!!', '=AQI', 'AB==', 'AAB=', '===='])('rejects noncanonical base64 %s', async (data) => {
    reply(JSON.stringify({ code: 0, data }) + end);
    await expect(volcengineSynthesizePcm(cfg, 'hi', opts)).rejects.toThrow(/base64/);
  });
  it('rejects invalid UTF-8 instead of replacing bytes', async () => {
    reply(Buffer.concat([Buffer.from(complete), Buffer.from([0xff])]));
    await expect(volcengineSynthesizePcm(cfg, 'hi', opts)).rejects.toThrow(/UTF-8/);
  });
});

describe('Volcengine limits and safe transport errors', () => {
  it('accepts exactly 8 MiB PCM and rejects one extra decoded byte', async () => {
    for (const length of [8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) {
      reply(JSON.stringify({ code: 0, data: Buffer.alloc(length).toString('base64') }) + end);
      if (length % 2 === 0) expect((await volcengineSynthesizePcm(cfg, 'hi', opts)).data.length).toBe(length);
      else await expect(volcengineSynthesizePcm(cfg, 'hi', opts)).rejects.toThrow(/PCM limit/);
    }
  });
  it('counts decoded bytes across records', async () => {
    const part = JSON.stringify({ code: 0, data: Buffer.alloc(4 * 1024 * 1024).toString('base64') });
    reply(part + part + audio + end);
    await expect(volcengineSynthesizePcm(cfg, 'hi', opts)).rejects.toThrow(/PCM limit/);
  });
  it('accepts exactly 16 MiB wire bytes and cancels an overflow', async () => {
    reply(complete + ' '.repeat(16 * 1024 * 1024 - Buffer.byteLength(complete)));
    expect((await volcengineSynthesizePcm(cfg, 'hi', opts)).data.length).toBe(4);
    const { cancel } = streamReply([Buffer.alloc(16 * 1024 * 1024, 32), Buffer.from(' ')], false);
    await expect(volcengineSynthesizePcm(cfg, 'hi', opts)).rejects.toThrow(/body limit/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('accepts 10000 records including completion, then rejects the next record', async () => {
    reply('{"code":0}'.repeat(9998) + complete);
    expect((await volcengineSynthesizePcm(cfg, 'hi', opts)).data.length).toBe(4);
    reply('{"code":0}'.repeat(9999) + complete);
    await expect(volcengineSynthesizePcm(cfg, 'hi', opts)).rejects.toThrow(/record limit/);
  });
  it('does not read or echo an HTTP error body and never falls back', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 403 });
    const text = vi.spyOn(response, 'text');
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetcher);
    await expect(volcengineSynthesizePcm({ ...cfg, mode: 'agent-plan' }, 'TEXT_CANARY', opts)).rejects.toThrow(/^火山引擎语音合成请求失败（Volcengine TTS HTTP 403）$/);
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a missing body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)));
    await expect(volcengineSynthesizePcm(cfg, 'hi', opts)).rejects.toThrow(/missing response body/);
  });
  it('hides network and stream errors without attaching a cause', async () => {
    for (const fetcher of [
      vi.fn(async () => { throw new Error('KEY_CANARY TEXT_CANARY'); }),
      vi.fn(async () => new Response(new ReadableStream({ pull() { throw new Error('KEY_CANARY TEXT_CANARY'); } }))),
    ]) {
      vi.stubGlobal('fetch', fetcher);
      const error = await volcengineSynthesizePcm(cfg, 'TEXT_CANARY', opts).catch((value: unknown) => value);
      expect(error).toEqual(new Error('Volcengine TTS transport failure'));
      expect(error instanceof Error && error.cause).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('aborts when response headers never arrive', async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    }));
    await expect(volcengineSynthesizePcm(cfg, 'hi', { ...opts, timeoutMs: 25 })).rejects.toThrow(/timeout/);
    expect(signal?.aborted).toBe(true);
  });
  it.each([false, true])('aborts a stalled body, even after completion=%s, without awaiting hanging cancel', async (includeCompletion) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const { fetcher } = streamReply(includeCompletion ? [Buffer.from(complete)] : [], false, cancel);
    await expect(volcengineSynthesizePcm(cfg, 'hi', { ...opts, timeoutMs: 25 })).rejects.toThrow(/timeout/);
    expect(cancel).toHaveBeenCalledTimes(1);
    const call = z.tuple([z.string(), z.object({ signal: z.instanceof(AbortSignal) })]).parse(fetcher.mock.calls[0]);
    expect(call[1].signal.aborted).toBe(true);
  });
  it('clears the provider timer on both success and failure', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    reply(complete);
    await volcengineSynthesizePcm(cfg, 'hi', opts);
    expect(clear).toHaveBeenCalledTimes(1);
    reply('{}');
    await expect(volcengineSynthesizePcm(cfg, 'hi', opts)).rejects.toThrow();
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it('checks the deadline after synchronous parsing before returning PCM', async () => {
    reply(complete);
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(100);
    await expect(volcengineSynthesizePcm(cfg, 'hi', { ...opts, timeoutMs: 50 })).rejects.toThrow(/timeout/);
  });
});
