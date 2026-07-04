/**
 * Audio helpers for the voice feature: spoken-text cleanup, PCM→WAV framing,
 * and WAV→opus encoding via `opusenc` (opus-tools).
 *
 * Why PCM as the engine interchange format: TTS engines (SAMI in particular)
 * stream audio back as multiple ogg chunks; naively concatenating those yields
 * a *chained* ogg stream that confuses duration probes and may not play fully
 * in Feishu. Requesting raw PCM and encoding a single clean opus ourselves
 * sidesteps both problems and lets us compute an exact duration from the sample
 * count — no ffmpeg/ffprobe dependency, only `opusenc`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Pcm {
  data: Buffer; // signed 16-bit little-endian
  sampleRate: number;
  channels: number;
}

export interface OpusResult {
  path: string; // ogg/opus file on disk (caller cleans up the temp dir)
  durationMs: number;
  dir: string; // temp dir holding the file; rm -rf when done
}

/**
 * Strip everything that doesn't belong in spoken audio: code blocks, inline
 * code, images, bare URLs, markdown markers, table pipes. The model is asked to
 * pre-condense into colloquial prose; this is a defensive backstop so a stray
 * code fence or link never gets read aloud verbatim.
 */
export function toSpoken(s: string): string {
  return (s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*[>\-*+][ \t]+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\n{2,}/g, '。')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Exact playback duration of a 16-bit PCM buffer. */
export function pcmDurationMs(pcm: Pcm): number {
  const bytesPerSample = 2 * Math.max(1, pcm.channels);
  const frames = Math.floor(pcm.data.length / bytesPerSample);
  return Math.round((frames / pcm.sampleRate) * 1000);
}

/** Wrap raw signed-16 PCM in a minimal canonical WAV container. */
export function pcmToWav(pcm: Pcm): Buffer {
  const { data, sampleRate, channels } = pcm;
  const byteRate = sampleRate * channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let opusencChecked: boolean | null = null;
/** Whether `opusenc` (opus-tools) is on PATH. Cached after first probe.
 *  spawnSync sets `error` (ENOENT) when the binary is missing; `opusenc
 *  --version` exits 0, so presence == no spawn error. */
export function hasOpusenc(): boolean {
  if (opusencChecked !== null) return opusencChecked;
  const r = spawnSync('opusenc', ['--version'], { stdio: 'ignore' });
  opusencChecked = !r.error;
  return opusencChecked;
}

export const OPUSENC_HINT =
  '缺少 opus 编码器：请安装 opus-tools（Debian/Ubuntu: `apt-get install -y opus-tools`；macOS: `brew install opus-tools`）。';

/**
 * Encode PCM → a single ogg/opus file suitable for a Feishu voice bubble.
 * Returns the file path, its temp dir (caller rm -rf), and exact duration.
 */
export function encodePcmToOpus(pcm: Pcm): OpusResult {
  if (!hasOpusenc()) throw new Error(OPUSENC_HINT);
  const dir = mkdtempSync(join(tmpdir(), 'botmux-voice-'));
  const wavPath = join(dir, 'voice.wav');
  const opusPath = join(dir, 'voice.opus');
  writeFileSync(wavPath, pcmToWav(pcm));
  const r = spawnSync('opusenc', ['--quiet', '--bitrate', '32', wavPath, opusPath], { stdio: 'ignore' });
  try { rmSync(wavPath, { force: true }); } catch { /* ignore */ }
  if (r.error || r.status !== 0) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`opusenc 转码失败：${r.error?.message ?? `exit ${r.status}`}`);
  }
  // Sanity: ensure the encoder produced a non-empty file.
  const size = (() => { try { return readFileSync(opusPath).length; } catch { return 0; } })();
  if (size === 0) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('opusenc 产物为空');
  }
  return { path: opusPath, dir, durationMs: pcmDurationMs(pcm) };
}
