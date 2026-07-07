/**
 * Voice feature entry point: resolve which TTS engine a bot should use
 * (per-bot override → global config), report whether voice is configured
 * (gates the "🔊 语音总结" button), and synthesize text → a ready-to-send
 * ogg/opus file.
 *
 * Engine is pluggable behind a tiny contract (text → PCM): `sami` (in-tree
 * JSON-over-WS, internal) and `openai` (OpenAI-compatible HTTP, open-source
 * default). Neither pulls a heavyweight dependency into the package.
 */
import { encodePcmToOpus, toSpoken, type OpusResult, type Pcm } from './audio.js';
import { samiSynthesizePcm, type SamiCreds } from './sami.js';
import { openaiSynthesizePcm, type OpenAITtsConfig } from './openai.js';
import { readGlobalConfig } from '../../global-config.js';
import { loadBotConfigs } from '../../bot-registry.js';
import type { VoiceConfig, VoiceEngine } from './types.js';

export type { VoiceConfig, VoiceEngine } from './types.js';

/** Default SAMI voice — 灿灿 (bigtts), the product-chosen default. */
export const DEFAULT_SAMI_SPEAKER = 'zh_female_cancan_mars_bigtts';
/** Default OpenAI-compatible voice. */
export const DEFAULT_OPENAI_SPEAKER = 'alloy';

function mergeVoice(base: VoiceConfig | undefined, over: VoiceConfig | undefined): VoiceConfig | undefined {
  if (!base && !over) return undefined;
  return {
    ...base,
    ...over,
    sami: { ...base?.sami, ...over?.sami },
    openai: { ...base?.openai, ...over?.openai },
  };
}

function hasUsableCreds(v: VoiceConfig | undefined): VoiceConfig | null {
  if (!v) return null;
  const engine = v.engine ?? (v.sami ? 'sami' : v.openai ? 'openai' : undefined);
  if (!engine) return null;
  if (engine === 'sami') {
    const { accessKey, secretKey, appkey } = v.sami ?? {};
    if (!accessKey || !secretKey || !appkey) return null;
  } else {
    const { baseUrl, model } = v.openai ?? {};
    if (!baseUrl || !model) return null;
  }
  return { ...v, engine };
}

/** Pure evaluation: per-bot `voice` merged over global `voice`, validated for
 *  usable creds. Exported for testing the button-gating logic without disk. */
export function evaluateVoiceConfig(global?: VoiceConfig, perBot?: VoiceConfig): VoiceConfig | null {
  return hasUsableCreds(mergeVoice(global, perBot));
}

/** Resolve effective voice config for a bot: per-bot `voice` merged over the
 *  global `voice` block. Returns null when nothing usable is configured. */
export function resolveVoiceConfig(larkAppId?: string): VoiceConfig | null {
  let global: VoiceConfig | undefined;
  try {
    global = readGlobalConfig().voice;
  } catch { /* no global config */ }

  let perBot: VoiceConfig | undefined;
  if (larkAppId) {
    try {
      const bot = loadBotConfigs().find((b) => b.larkAppId === larkAppId);
      perBot = bot?.voice;
    } catch { /* no bots.json */ }
  }
  return evaluateVoiceConfig(global, perBot);
}

/** Cheap predicate for conditionally rendering the voice button. */
export function isVoiceConfigured(larkAppId?: string): boolean {
  return resolveVoiceConfig(larkAppId) !== null;
}

function effectiveSpeaker(v: VoiceConfig): string {
  if (v.speaker) return v.speaker;
  return v.engine === 'openai' ? DEFAULT_OPENAI_SPEAKER : DEFAULT_SAMI_SPEAKER;
}

/**
 * Synthesize `text` into raw signed-16 PCM. Realtime VC voice uses this
 * intermediate directly; IM voice bubbles encode it to ogg/opus below.
 */
export async function synthesizeVoicePcmForMessage(larkAppId: string | undefined, text: string): Promise<Pcm> {
  const cfg = resolveVoiceConfig(larkAppId);
  if (!cfg) throw new Error('未配置语音引擎：在 ~/.botmux/config.json 的 voice 块或 bots.json 里配置 SAMI / OpenAI 兼容引擎。');
  const spoken = toSpoken(text);
  if (!spoken) throw new Error('精简后没有可朗读的内容');
  const speaker = effectiveSpeaker(cfg);

  return cfg.engine === 'openai'
    ? await openaiSynthesizePcm(cfg.openai as OpenAITtsConfig, spoken, { speaker, rate: cfg.rate })
    : await samiSynthesizePcm(cfg.sami as SamiCreds, spoken, { speaker, rate: cfg.rate });
}

/**
 * Synthesize `text` into an ogg/opus file for a Feishu voice bubble.
 * Caller owns the returned temp dir and must rm -rf it after sending.
 * Throws when voice isn't configured for this bot or synthesis fails.
 */
export async function synthesizeVoiceOpus(larkAppId: string | undefined, text: string): Promise<OpusResult> {
  const pcm = await synthesizeVoicePcmForMessage(larkAppId, text);
  return encodePcmToOpus(pcm);
}
