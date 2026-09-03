/**
 * Inbound voice-message transcription pipeline (语音接线):
 *
 *   msg_type=audio → 下载 opus → OpenAI 兼容 ASR 转写 → 带 🎤 前缀文本注入会话
 *
 * 设计要点：
 * - 对非 audio 消息零开销（第一行 msgType 检查即返回），daemon 在两个入口
 *   （新话题 / 话题续聊）admission 之后、session 创建之前调用，转写失败不留
 *   孤儿会话、不浪费额度。
 * - 转写耗时可达数秒至数十秒，先发「正在转写…」占位消息提供即时反馈，成功
 *   后删除占位；失败则删占位并回具体错误。
 * - 幂等：prepared 重投路径若 parsed.content 已带前缀，直接跳过转写。
 * - 所有 reply/delete 调用均 try/catch 容错——反馈通道故障不能炸主流程。
 *
 * ASR 配置（voice.asr，默认关闭）由 services/voice 的 resolveAsrConfig 按
 * per-bot 覆盖 global 解析；本模块不直接读配置文件。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { deleteMessage, downloadMessageResource } from './client.js';
import { extractAudioMeta } from './message-parser.js';
import { resolveAsrConfig } from '../../services/voice/index.js';
import { transcribeAudioFile } from '../../services/voice/asr.js';

/** 注入会话的转写文本前缀——CLI 与群成员据此可知输入来自语音转写。 */
export const AUDIO_TRANSCRIPTION_PREFIX = '🎤 语音转写：';

export type AudioTurnOutcome =
  | { kind: 'not_audio' }
  | { kind: 'transcribed'; text: string }
  | { kind: 'failed'; userMessage: string };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 反馈通道（reply/delete）故障只记 debug，不影响转写主流程。 */
async function safeReply(reply: (text: string) => Promise<string>, text: string): Promise<void> {
  try {
    await reply(text);
  } catch (err) {
    logger.debug(`[audio-transcribe] reply failed: ${errMsg(err)}`);
  }
}

/**
 * Resolve an inbound audio message into transcript text for session injection.
 *
 * @param larkAppId      bot 应用 ID（配置解析 + 资源下载）
 * @param messageId      飞书 om_ 消息 ID（下载资源 + reply 锚点）
 * @param msgType        parsed.msgType
 * @param rawEventContent data.message.content 原始 JSON（含 file_key）
 * @param parsedContent  parsed.content（幂等检查：已带前缀则跳过）
 * @param reply          发文本消息的回调（daemon 注入 replyMessage）
 */
export async function resolveInboundAudio(
  larkAppId: string,
  messageId: string,
  msgType: string,
  rawEventContent: string,
  parsedContent: string,
  reply: (text: string) => Promise<string>,
): Promise<AudioTurnOutcome> {
  if (msgType !== 'audio') return { kind: 'not_audio' };

  // 幂等：prepared 重投等路径下 content 已是转写文本，不重复转写。
  if (parsedContent.startsWith(AUDIO_TRANSCRIPTION_PREFIX)) {
    return { kind: 'transcribed', text: parsedContent };
  }

  const cfg = resolveAsrConfig(larkAppId);
  if (!cfg) {
    const userMessage = '未配置语音识别：请在 voice.asr 配置 enabled/baseUrl/model（可选 apiKey）后重试。';
    await safeReply(reply, userMessage);
    return { kind: 'failed', userMessage };
  }

  // 即时反馈：转写可能耗时数十秒，先回一条占位消息，结束后删除。
  let placeholderId: string | undefined;
  try {
    placeholderId = await reply('🎤 正在转写语音…');
  } catch (err) {
    logger.debug(`[audio-transcribe] placeholder reply failed: ${errMsg(err)}`);
  }
  const clearPlaceholder = async (): Promise<void> => {
    if (!placeholderId) return;
    try {
      await deleteMessage(larkAppId, placeholderId);
    } catch (err) {
      logger.debug(`[audio-transcribe] placeholder delete failed: ${errMsg(err)}`);
    }
  };

  const meta = extractAudioMeta(rawEventContent);
  if (!meta) {
    const userMessage = '语音消息解析失败：内容缺少 file_key，无法下载语音。';
    await clearPlaceholder();
    await safeReply(reply, userMessage);
    return { kind: 'failed', userMessage };
  }

  const dir = mkdtempSync(join(tmpdir(), 'botmux-asr-'));
  const audioPath = join(dir, 'voice.ogg');
  try {
    try {
      // 飞书语音是 ogg/opus；type='file' 走 im.v1.message.resource 下载。
      await downloadMessageResource(larkAppId, messageId, meta.fileKey, 'file', audioPath);
    } catch (err) {
      // UserTokenMissingError 的 message 已含 /login 提示，直接透传。
      const userMessage = `语音下载失败：${errMsg(err)}`;
      await clearPlaceholder();
      await safeReply(reply, userMessage);
      return { kind: 'failed', userMessage };
    }

    let text: string;
    try {
      text = await transcribeAudioFile(cfg, audioPath);
    } catch (err) {
      const userMessage = `语音转写失败：${errMsg(err)}`;
      await clearPlaceholder();
      await safeReply(reply, userMessage);
      return { kind: 'failed', userMessage };
    }
    text = text.trim();
    if (!text) {
      const userMessage = '语音转写失败：ASR 转写结果为空。';
      await clearPlaceholder();
      await safeReply(reply, userMessage);
      return { kind: 'failed', userMessage };
    }

    await clearPlaceholder();
    return { kind: 'transcribed', text: `${AUDIO_TRANSCRIPTION_PREFIX}\n${text}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
