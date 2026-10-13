/**
 * Shared voice-config types. Kept dependency-free so both global-config.ts and
 * bot-registry.ts can import them (type-only) without a runtime import cycle
 * with the engine adapters in ./index.ts.
 */
export type VoiceEngine = 'sami' | 'openai' | 'minimax';

export interface VoiceSamiCreds {
  accessKey?: string;
  secretKey?: string;
  appkey?: string;
  /** SAMI is internal; its endpoints are NOT hardcoded in this public repo.
   *  Supply here (or via SAMI_TOKEN_URL / SAMI_WS_URL env). */
  tokenUrl?: string;
  wsUrl?: string;
}

export interface VoiceOpenAIConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface VoiceMiniMaxConfig {
  apiKey?: string;
  model?: string;
  /** Selects the matching official API endpoint. Defaults to `global`. */
  region?: 'global' | 'cn';
}

/** ASR (语音转文字) 配置，走 OpenAI 兼容 `POST {baseUrl}/audio/transcriptions`
 *  协议（whisper API 格式，原生支持 ogg/opus）。与 TTS 同款「用户自带
 *  baseUrl/key」模式。默认关闭：`enabled !== true` 即不生效。 */
export interface VoiceAsrConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 转写请求超时（毫秒），缺省 120000。 */
  timeoutMs?: number;
  /** ISO-639-1 语言提示（如 'zh'），透传给 ASR 服务。 */
  language?: string;
}

/** Stored under `voice` in ~/.botmux/config.json (global) or per bot in
 *  bots.json. A per-bot block is merged over the global one. */
export interface VoiceConfig {
  engine?: VoiceEngine;
  /** Default speaker or voice id for the selected engine. */
  speaker?: string;
  /** Speech rate multiplier (1.0 = normal). */
  rate?: number;
  sami?: VoiceSamiCreds;
  openai?: VoiceOpenAIConfig;
  minimax?: VoiceMiniMaxConfig;
  /** 语音消息转写（ASR）。与 TTS 字段相互独立：可只配 ASR 不配 TTS。 */
  asr?: VoiceAsrConfig;
}
