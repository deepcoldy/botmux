/**
 * 入站语音转写编排（resolveInboundAudio）：
 * msg_type=audio → 下载 opus → ASR 转写 → 带 🎤 前缀文本。
 * Run: pnpm vitest run test/audio-transcribe.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveInboundAudio, AUDIO_TRANSCRIPTION_PREFIX } from '../src/im/lark/audio-transcribe.js';
import type { ResolvedAsrConfig } from '../src/services/voice/asr.js';

const mocks = vi.hoisted(() => ({
  resolveAsrConfig: vi.fn(),
  transcribeAudioFile: vi.fn(),
  downloadMessageResource: vi.fn(),
  deleteMessage: vi.fn(),
}));

vi.mock('../src/services/voice/index.js', () => ({
  resolveAsrConfig: mocks.resolveAsrConfig,
}));

vi.mock('../src/services/voice/asr.js', () => ({
  transcribeAudioFile: mocks.transcribeAudioFile,
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    downloadMessageResource: mocks.downloadMessageResource,
    deleteMessage: mocks.deleteMessage,
  };
});

const APP = 'cli_test';
const MSG = 'om_test_msg';
const AUDIO_CONTENT = JSON.stringify({ file_key: 'file_vc_123', duration: 5000 });
const cfg: ResolvedAsrConfig = { baseUrl: 'http://asr.example/v1', model: 'whisper-1', timeoutMs: 60000 };

/** reply 回调：记录调用并返回消息 id；可配置为抛错模拟反馈通道故障。 */
function makeReply(fail = false) {
  const calls: string[] = [];
  const fn = vi.fn(async (text: string) => {
    calls.push(text);
    if (fail) throw new Error('reply boom');
    return `om_reply_${calls.length}`;
  });
  return { fn, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.downloadMessageResource.mockResolvedValue(undefined);
  mocks.deleteMessage.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveInboundAudio', () => {
  it('非 audio 消息零开销返回 not_audio', async () => {
    const { fn } = makeReply();
    const r = await resolveInboundAudio(APP, MSG, 'text', '{}', '你好', fn);
    expect(r).toEqual({ kind: 'not_audio' });
    expect(mocks.resolveAsrConfig).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('已带前缀的内容幂等跳过（不重复转写）', async () => {
    const { fn } = makeReply();
    const already = `${AUDIO_TRANSCRIPTION_PREFIX}\n之前的转写`;
    const r = await resolveInboundAudio(APP, MSG, 'audio', AUDIO_CONTENT, already, fn);
    expect(r).toEqual({ kind: 'transcribed', text: already });
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
    expect(mocks.downloadMessageResource).not.toHaveBeenCalled();
  });

  it('未配置 ASR：回复提示并返回 failed', async () => {
    mocks.resolveAsrConfig.mockReturnValue(null);
    const { fn, calls } = makeReply();
    const r = await resolveInboundAudio(APP, MSG, 'audio', AUDIO_CONTENT, '[语音]', fn);
    expect(r.kind).toBe('failed');
    expect(calls.some(t => t.includes('未配置语音识别'))).toBe(true);
    expect(mocks.downloadMessageResource).not.toHaveBeenCalled();
  });

  it('内容缺 file_key：回复解析失败并返回 failed', async () => {
    mocks.resolveAsrConfig.mockReturnValue(cfg);
    const { fn, calls } = makeReply();
    const r = await resolveInboundAudio(APP, MSG, 'audio', JSON.stringify({ duration: 1000 }), '[语音]', fn);
    expect(r.kind).toBe('failed');
    expect(calls.some(t => t.includes('缺少 file_key'))).toBe(true);
    expect(mocks.downloadMessageResource).not.toHaveBeenCalled();
  });

  it('下载失败：错误透传到用户提示', async () => {
    mocks.resolveAsrConfig.mockReturnValue(cfg);
    mocks.downloadMessageResource.mockRejectedValue(new Error('UserTokenMissing: 请 /login'));
    const { fn, calls } = makeReply();
    const r = await resolveInboundAudio(APP, MSG, 'audio', AUDIO_CONTENT, '[语音]', fn);
    expect(r.kind).toBe('failed');
    expect(calls.some(t => t.includes('语音下载失败') && t.includes('/login'))).toBe(true);
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
  });

  it('ASR 转写失败：回复错误并返回 failed', async () => {
    mocks.resolveAsrConfig.mockReturnValue(cfg);
    mocks.transcribeAudioFile.mockRejectedValue(new Error('429 Too Many Requests'));
    const { fn, calls } = makeReply();
    const r = await resolveInboundAudio(APP, MSG, 'audio', AUDIO_CONTENT, '[语音]', fn);
    expect(r.kind).toBe('failed');
    expect(calls.some(t => t.includes('语音转写失败') && t.includes('429'))).toBe(true);
  });

  it('转写结果为空：回复空结果提示并返回 failed', async () => {
    mocks.resolveAsrConfig.mockReturnValue(cfg);
    mocks.transcribeAudioFile.mockResolvedValue('   \n  ');
    const { fn, calls } = makeReply();
    const r = await resolveInboundAudio(APP, MSG, 'audio', AUDIO_CONTENT, '[语音]', fn);
    expect(r.kind).toBe('failed');
    expect(calls.some(t => t.includes('转写结果为空'))).toBe(true);
  });

  it('成功：占位消息发出后删除，转写文本带前缀', async () => {
    mocks.resolveAsrConfig.mockReturnValue(cfg);
    mocks.transcribeAudioFile.mockResolvedValue('帮我看下这个函数为什么报错');
    const { fn, calls } = makeReply();
    const r = await resolveInboundAudio(APP, MSG, 'audio', AUDIO_CONTENT, '[语音]', fn);
    expect(r).toEqual({ kind: 'transcribed', text: `${AUDIO_TRANSCRIPTION_PREFIX}\n帮我看下这个函数为什么报错` });
    // 占位「正在转写」先发，成功后删除
    expect(calls[0]).toContain('正在转写');
    expect(mocks.deleteMessage).toHaveBeenCalledTimes(1);
    expect(mocks.downloadMessageResource).toHaveBeenCalledWith(APP, MSG, 'file_vc_123', 'file', expect.stringContaining('voice.ogg'));
    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith(cfg, expect.stringContaining('voice.ogg'));
  });

  it('占位消息发送失败不影响转写主流程', async () => {
    mocks.resolveAsrConfig.mockReturnValue(cfg);
    mocks.transcribeAudioFile.mockResolvedValue('测试内容');
    const { fn } = makeReply(true); // reply 全程抛错
    const r = await resolveInboundAudio(APP, MSG, 'audio', AUDIO_CONTENT, '[语音]', fn);
    expect(r).toEqual({ kind: 'transcribed', text: `${AUDIO_TRANSCRIPTION_PREFIX}\n测试内容` });
  });

  it('占位消息删除失败被容错（不炸主流程）', async () => {
    mocks.resolveAsrConfig.mockReturnValue(cfg);
    mocks.transcribeAudioFile.mockResolvedValue('测试内容');
    mocks.deleteMessage.mockRejectedValue(new Error('delete boom'));
    const { fn } = makeReply();
    const r = await resolveInboundAudio(APP, MSG, 'audio', AUDIO_CONTENT, '[语音]', fn);
    expect(r).toEqual({ kind: 'transcribed', text: `${AUDIO_TRANSCRIPTION_PREFIX}\n测试内容` });
  });
});
