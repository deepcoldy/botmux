/**
 * Voice config gating + audio helpers (pure logic).
 * Run: pnpm vitest run test/voice-config.test.ts
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SAMI_SPEAKER, evaluateVoiceConfig } from '../src/services/voice/index.js';
import { toSpoken, pcmDurationMs, pcmToWav } from '../src/services/voice/audio.js';
import { parseVolcengineConfig, mergeVolcengineConfig } from '../src/services/voice/volcengine-config.js';
import type { VoiceConfig } from '../src/services/voice/types.js';

describe('Volcengine credentials', () => {
  const standard = { mode: 'standard', apiKey: 'S' } satisfies VoiceConfig['volcengine'];
  const plan = { mode: 'agent-plan', apiKey: 'P' } satisfies VoiceConfig['volcengine'];
  const rows: Array<[VoiceConfig['volcengine'], VoiceConfig['volcengine'], VoiceConfig['volcengine']]> = [
    [standard, undefined, standard],
    [standard, {}, standard],
    [standard, { apiKey: 'S2' }, { mode: 'standard', apiKey: 'S2' }],
    [standard, { mode: 'standard' }, standard],
    [standard, { mode: 'agent-plan' }, { mode: 'agent-plan' }],
    [standard, plan, plan],
    [plan, standard, standard],
    [plan, { mode: 'standard' }, { mode: 'standard' }],
    [standard, { apiKey: '' }, { mode: 'standard', apiKey: '' }],
    [standard, null, null],
    [null, plan, plan],
    [undefined, { mode: 'standard' }, { mode: 'standard' }],
    [{ apiKey: 'unscoped' }, { mode: 'agent-plan' }, { mode: 'agent-plan' }],
    [{ apiKey: 'unscoped' }, undefined, { apiKey: 'unscoped' }],
  ];
  it.each(rows)('merges mode and account safely, row %#', (base, over, expected) => {
    expect(mergeVolcengineConfig(base, over)).toEqual(expected);
    const result = evaluateVoiceConfig({ engine: 'volcengine', volcengine: base }, { volcengine: over });
    if (expected?.mode && expected.apiKey) expect(result?.volcengine).toEqual(expected);
    else expect(result).toBeNull();
  });

  it.each([[null], [[]], [true], [1], ['standard'], [{ mode: '' }], [{ mode: null }], [{ mode: 'STANDARD' }],
    [{ mode: 'typo' }], [{ apiKey: 1 }], [{ apiKey: null }], [{ apiKey: 'key\ninjected' }]])('keeps malformed blocks disabled, row %#', (raw) => {
    expect(parseVolcengineConfig(raw)).toBeNull();
    expect(evaluateVoiceConfig({ engine: 'volcengine', volcengine: standard }, {
      volcengine: parseVolcengineConfig(raw),
    })).toBeNull();
  });
  it('normalizes partial storage without inventing credentials', () => {
    expect(parseVolcengineConfig(undefined)).toBeUndefined();
    expect(parseVolcengineConfig({ apiKey: '  ' })).toEqual({ apiKey: '' });
    expect(parseVolcengineConfig({ mode: 'standard', other: 1 })).toEqual({ mode: 'standard' });
  });
  it('requires explicit engine and never falls through from an invalid selected engine', () => {
    expect(evaluateVoiceConfig({ volcengine: standard })).toBeNull();
    expect(evaluateVoiceConfig({ engine: 'volcengine', volcengine: null, minimax: { apiKey: 'M' } })).toBeNull();
    expect(evaluateVoiceConfig({ volcengine: standard, minimax: { apiKey: 'M' } })?.engine).toBe('minimax');
  });
});

describe('evaluateVoiceConfig — button gating', () => {
  it('returns null when nothing configured', () => {
    expect(evaluateVoiceConfig(undefined, undefined)).toBeNull();
    expect(evaluateVoiceConfig({}, {})).toBeNull();
  });

  it('SAMI needs all three creds', () => {
    expect(evaluateVoiceConfig({ engine: 'sami', sami: { accessKey: 'a', secretKey: 'b' } }, undefined)).toBeNull();
    const ok = evaluateVoiceConfig({ engine: 'sami', sami: { accessKey: 'a', secretKey: 'b', appkey: 'c' } }, undefined);
    expect(ok?.engine).toBe('sami');
  });

  it('OpenAI needs baseUrl + model', () => {
    expect(evaluateVoiceConfig({ engine: 'openai', openai: { baseUrl: 'http://x/v1' } }, undefined)).toBeNull();
    const ok = evaluateVoiceConfig({ engine: 'openai', openai: { baseUrl: 'http://x/v1', model: 'tts-1' } }, undefined);
    expect(ok?.engine).toBe('openai');
  });

  it('MiniMax needs an API key and accepts the built-in endpoint and model defaults', () => {
    expect(evaluateVoiceConfig({ engine: 'minimax', minimax: {} }, undefined)).toBeNull();
    const ok = evaluateVoiceConfig({ engine: 'minimax', minimax: { apiKey: 'key', region: 'cn' } }, undefined);
    expect(ok).toMatchObject({ engine: 'minimax', minimax: { apiKey: 'key', region: 'cn' } });
  });

  it('infers engine from creds when engine omitted (sami / openai / minimax)', () => {
    expect(evaluateVoiceConfig({ sami: { accessKey: 'a', secretKey: 'b', appkey: 'c' } }, undefined)?.engine).toBe('sami');
    expect(evaluateVoiceConfig({ openai: { baseUrl: 'http://x/v1', model: 'tts-1' } }, undefined)?.engine).toBe('openai');
    expect(evaluateVoiceConfig({ minimax: { apiKey: 'k' } }, undefined)?.engine).toBe('minimax');
  });

  it('does not infer an engine from empty / partial credential blocks', () => {
    expect(evaluateVoiceConfig({}, undefined)).toBeNull();
    expect(evaluateVoiceConfig({ minimax: {} }, undefined)).toBeNull();
    expect(evaluateVoiceConfig({ openai: { apiKey: 'k' } }, undefined)).toBeNull();
    expect(evaluateVoiceConfig({ sami: { accessKey: 'a' } }, undefined)).toBeNull();
  });

  it('inference precedence is sami → openai → minimax', () => {
    const v = evaluateVoiceConfig({
      sami: { accessKey: 'a', secretKey: 'b', appkey: 'c' },
      openai: { baseUrl: 'http://x/v1', model: 'm' },
      minimax: { apiKey: 'k' },
    }, undefined);
    expect(v?.engine).toBe('sami');
  });

  it('per-bot overrides global field-by-field', () => {
    const global = { engine: 'sami' as const, speaker: 'global_voice', sami: { accessKey: 'a', secretKey: 'b', appkey: 'c' } };
    const perBot = { speaker: 'bot_voice' };
    const v = evaluateVoiceConfig(global, perBot);
    expect(v?.engine).toBe('sami');          // inherited from global
    expect(v?.speaker).toBe('bot_voice');     // overridden by per-bot
    expect(v?.sami?.appkey).toBe('c');        // creds inherited
  });

  it('per-bot can switch engine entirely', () => {
    const global = { engine: 'sami' as const, sami: { accessKey: 'a', secretKey: 'b', appkey: 'c' } };
    const perBot = { engine: 'openai' as const, openai: { baseUrl: 'http://x/v1', model: 'kokoro' } };
    const v = evaluateVoiceConfig(global, perBot);
    expect(v?.engine).toBe('openai');
  });
});

describe('audio helpers', () => {
  it('toSpoken strips code, urls, markdown', () => {
    const s = toSpoken('# 标题\n看 `foo()` 和 ```js\nbar()\n``` 还有 https://x.com 链接 **粗体**');
    expect(s).not.toContain('```');
    expect(s).not.toContain('http');
    expect(s).not.toContain('#');
    expect(s).not.toContain('**');
    expect(s).toContain('粗体');
  });

  it('pcmDurationMs: 1s of 24kHz mono s16le = ~1000ms', () => {
    const oneSec: Buffer = Buffer.alloc(24000 * 2); // 24000 frames * 2 bytes
    expect(pcmDurationMs({ data: oneSec, sampleRate: 24000, channels: 1 })).toBe(1000);
  });

  it('pcmToWav writes a 44-byte RIFF/WAVE header with correct rate', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav({ data: pcm, sampleRate: 24000, channels: 1 });
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(22)).toBe(1);     // channels
    expect(wav.length).toBe(44 + 100);
  });

  // 外部服务标识：SAMI 侧的音色 id，写错只会在运行时合成失败。
  it('default SAMI speaker is 灿灿', () => {
    expect(DEFAULT_SAMI_SPEAKER).toBe('zh_female_cancan_mars_bigtts');
  });
});
