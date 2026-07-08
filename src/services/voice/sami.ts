/**
 * SAMI (Internal speech) TTS adapter — pure JSON-over-WebSocket, no SDK.
 *
 * The official `@byted-sami/speech-sdk` is a browser bundle (needs window/
 * document shims + a subprocess), but the `tts.sync` endpoint it drives is
 * dead simple: send ONE JSON text frame, receive binary audio frames + JSON
 * status frames. We reimplement just that here in ~40 lines so the SAMI engine
 * is plain in-tree code with zero npm deps — keeping the open-source package
 * clean while internal users still get SAMI's high-quality voices.
 *
 * Auth: a short-lived token minted from AccessKey/SecretKey via a two-step
 * HMAC-SHA256 signature (auth-v1). The SecretKey never leaves this process.
 *
 * We request `pcm` (not ogg_opus): SAMI streams audio as multiple chunks, and
 * concatenating ogg chunks yields a chained stream; raw PCM concatenates
 * cleanly and lets us encode one well-formed opus. See ./audio.ts.
 */
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import type { Pcm } from './audio.js';

export interface SamiCreds {
  accessKey: string;
  secretKey: string;
  appkey: string;
  /** Optional endpoint overrides. Default to the standard SAMI endpoints; set
   *  these (or SAMI_TOKEN_URL / SAMI_WS_URL env) only to point elsewhere. */
  tokenUrl?: string;
  wsUrl?: string;
}

const AUTH_VERSION = 'auth-v1';
const OK = 20000000; // SAMI success status_code
const SAMI_SR = 24000;
const DEFAULT_TOKEN_URL = 'https://sami.bytedance.com/internal/api/v1/token';
const DEFAULT_WS_URL = 'wss://sami.bytedance.com/internal/api/v1/ws?api_resource_id=tts.sync';

/** Resolve an endpoint: per-call config override → env var → default. */
function samiEndpoint(fromConfig: string | undefined, envName: string, fallback: string): string {
  return fromConfig || process.env[envName] || fallback;
}

/** Mint a short-lived SAMI token (default 24h). Two-step HMAC: sign the
 *  canonical string with the SecretKey, then HMAC an empty body with that. */
export async function mintSamiToken(creds: SamiCreds, expiration = 86400): Promise<string> {
  if (!creds.accessKey || !creds.secretKey || !creds.appkey) {
    throw new Error('SAMI 凭证不完整（需要 accessKey / secretKey / appkey）。');
  }
  const ts = Math.floor(Date.now() / 1000);
  const signKey = createHmac('sha256', creds.secretKey)
    .update(`${AUTH_VERSION}/${creds.accessKey}/${ts}/${expiration}`, 'utf8')
    .digest('hex');
  const signature = createHmac('sha256', signKey).update('', 'utf8').digest('hex');
  const qs = new URLSearchParams({
    version: AUTH_VERSION,
    access_key: creds.accessKey,
    appkey: creds.appkey,
    timestamp: String(ts),
    expiration: String(expiration),
    signature,
  });
  const tokenUrl = samiEndpoint(creds.tokenUrl, 'SAMI_TOKEN_URL', DEFAULT_TOKEN_URL);
  const res = await fetch(`${tokenUrl}?${qs.toString()}`, { cache: 'no-store' });
  const data = (await res.json()) as { token?: string; status_text?: string };
  if (!data.token) throw new Error(`SAMI token 签发失败：${data.status_text ?? JSON.stringify(data).slice(0, 160)}`);
  return data.token;
}

export interface SamiSynthOpts {
  speaker: string;
  /** 1.0 = normal. bigtts voices honour speech_rate via post_process. */
  rate?: number;
  timeoutMs?: number;
}

/** Synthesize text → raw PCM (s16le mono, 24kHz) via the tts.sync WebSocket. */
export async function samiSynthesizePcm(creds: SamiCreds, text: string, opts: SamiSynthOpts): Promise<Pcm> {
  const clean = text.trim();
  if (!clean) throw new Error('没有要合成的文字');
  const token = await mintSamiToken(creds);

  const audio_config: Record<string, unknown> = { format: 'pcm', sample_rate: SAMI_SR };
  const config: Record<string, unknown> = { text: clean, speaker: opts.speaker, audio_config };
  const rate = opts.rate ?? 1.0;
  if (rate && rate !== 1) {
    // bigtts/ICL/saturn voices take speech_rate through extra.post_process;
    // standard voices take a -50..100 percentage on audio_config.
    if (/bigtts|ICL|saturn|mars|moon|jupiter/i.test(opts.speaker)) {
      config.extra = { post_process: { speech_rate: Math.max(0.5, Math.min(2, rate)) } };
    } else {
      (audio_config as any).speech_rate = Math.max(-50, Math.min(100, Math.round((rate - 1) * 100)));
    }
  }

  const req = {
    token,
    appkey: creds.appkey,
    namespace: 'TTS',
    event: 'StartTask',
    payload: JSON.stringify(config),
    ...(config.extra ? { extra: config.extra } : {}),
  };

  const wsUrl = samiEndpoint(creds.wsUrl, 'SAMI_WS_URL', DEFAULT_WS_URL);
  return await new Promise<Pcm>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* ignore */ }
      clearTimeout(timer);
      if (err) return reject(err);
      if (!chunks.length) return reject(new Error('SAMI 未返回音频'));
      resolve({ data: Buffer.concat(chunks), sampleRate: SAMI_SR, channels: 1 });
    };
    const timer = setTimeout(() => finish(new Error('SAMI 合成超时')), opts.timeoutMs ?? 60000);

    ws.on('open', () => ws.send(JSON.stringify(req)));
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) { chunks.push(data); return; }
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.status_code !== undefined && m.status_code !== OK) {
        return finish(new Error(`SAMI 错误 ${m.status_code}: ${m.status_text ?? ''}`));
      }
      if (m.data) chunks.push(Buffer.from(m.data, 'base64')); // base64 audio fallback path
      if (m.event === 'TaskFinished') finish();
    });
    ws.on('error', (e: Error) => finish(new Error(`SAMI 连接失败：${e.message}`)));
    ws.on('close', () => finish());
  });
}
