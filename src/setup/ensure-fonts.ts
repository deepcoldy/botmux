/**
 * Ensure the screenshot-renderer (`@napi-rs/canvas`) has CJK / Latin / emoji
 * fonts available. Downloads missing categories from GitHub release
 * artifacts to `~/.botmux/fonts/` so registration (`GlobalFonts.registerFromPath`)
 * can find them at runtime.
 *
 * macOS is skipped entirely — PingFang + Menlo + Apple Color Emoji are
 * preinstalled.
 *
 * Failures are NOT fatal: missing fonts only degrade the screenshot rendered
 * for Lark (CJK becomes tofu, emoji becomes monochrome). The daemon should
 * still come up. Tmux is the load-bearing dep, fonts are nice-to-have.
 */
import { existsSync, mkdirSync, createWriteStream, statSync, unlinkSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { get as httpsGet } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { detectPlatform, type PlatformInfo } from './detect-platform.js';

export interface FontResult {
  /** The directory we downloaded into (or would have, if any download was needed). */
  fontDir: string;
  /** Categories we successfully ensured (system OR downloaded). */
  ready: string[];
  /** Categories we failed to ensure (download failed, etc.). Non-fatal. */
  failed: string[];
}

const FONT_DIR = join(homedir(), '.botmux', 'fonts');

const FONT_PROXY_ENV_KEYS = [
  'npm_config_https_proxy',
  'NPM_CONFIG_HTTPS_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'npm_config_proxy',
  'NPM_CONFIG_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const;

/** Build an env-aware agent only when a proxy is configured. ProxyAgent also
 * applies NO_PROXY per redirect target, so GitHub and its CDN can make the
 * proxy/direct decision independently. Exported for the env contract test. */
export function createFontDownloadAgent(): ProxyAgent | undefined {
  if (!FONT_PROXY_ENV_KEYS.some(key => process.env[key]?.trim())) return undefined;
  return new ProxyAgent();
}

interface FontSpec {
  /** Friendly category label for log lines. */
  category: 'CJK' | 'Latin' | 'Emoji';
  /** Files we'll write under FONT_DIR. */
  files: Array<{ name: string; url: string; minBytes: number }>;
  /** System paths that, if any exists, skip the download. */
  systemPaths: string[];
}

/** Download targets — pinned to specific release tags so the URLs don't rot.
 *
 *  Sources (all permissive licenses, GitHub-hosted):
 *  - notofonts/noto-cjk @ Sans2.004 (Mono variant) — OFL
 *  - JetBrains/JetBrainsMono @ v2.304 — Apache 2.0 (replaces DejaVu since
 *    DejaVu only ships .tar.bz2 release artifacts, not individual TTFs)
 *  - googlefonts/noto-emoji @ v2.047 — OFL
 */
const FONT_SPECS: FontSpec[] = [
  {
    category: 'CJK',
    files: [
      {
        name: 'NotoSansMonoCJKsc-Regular.otf',
        url: 'https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/Mono/NotoSansMonoCJKsc-Regular.otf',
        minBytes: 1_000_000,
      },
      {
        name: 'NotoSansMonoCJKsc-Bold.otf',
        url: 'https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/Mono/NotoSansMonoCJKsc-Bold.otf',
        minBytes: 1_000_000,
      },
    ],
    systemPaths: [
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansMonoCJK-Regular.ttc',
    ],
  },
  {
    category: 'Latin',
    files: [
      {
        name: 'JetBrainsMono-Regular.ttf',
        url: 'https://github.com/JetBrains/JetBrainsMono/raw/v2.304/fonts/ttf/JetBrainsMono-Regular.ttf',
        minBytes: 100_000,
      },
      {
        name: 'JetBrainsMono-Bold.ttf',
        url: 'https://github.com/JetBrains/JetBrainsMono/raw/v2.304/fonts/ttf/JetBrainsMono-Bold.ttf',
        minBytes: 100_000,
      },
    ],
    systemPaths: [
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
      '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
      '/usr/share/fonts/liberation/LiberationMono-Regular.ttf',
      '/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf',
    ],
  },
  {
    category: 'Emoji',
    files: [
      {
        name: 'NotoColorEmoji.ttf',
        url: 'https://github.com/googlefonts/noto-emoji/raw/v2.047/fonts/NotoColorEmoji.ttf',
        minBytes: 5_000_000,
      },
    ],
    systemPaths: [
      '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
      '/usr/share/fonts/noto/NotoColorEmoji.ttf',
      '/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf',
    ],
  },
];

/** Public: paths the screenshot-renderer should also probe. */
export function botmuxFontDir(): string {
  return FONT_DIR;
}

function categoryAlreadyOk(spec: FontSpec): boolean {
  // 1. System path present?
  if (spec.systemPaths.some(p => existsSync(p))) return true;
  // 2. We already downloaded it on a prior run?
  return spec.files.every(f => {
    const p = join(FONT_DIR, f.name);
    if (!existsSync(p)) return false;
    try {
      return statSync(p).size >= f.minBytes;
    } catch {
      return false;
    }
  });
}

/** Download a URL to disk, following redirects (GitHub raw → CDN).
 *  All FONT_SPECS URLs are https, so we don't bother with an http fallback.
 *  Hard timeout (default 60s) covers connect + transfer; on expiry the
 *  request is destroyed and the partial file is unlinked. */
function downloadFile(url: string, destPath: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = destPath + '.part';
    let settled = false;
    let activeReq: ReturnType<typeof httpsGet> | null = null;
    const agent = createFontDownloadAgent();

    const cleanup = () => {
      try { unlinkSync(tmp); } catch { /* may not exist */ }
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeReq) try { activeReq.destroy(); } catch { /* ignore */ }
      if (agent) try { agent.destroy(); } catch { /* ignore */ }
      if (err) { cleanup(); reject(err); }
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`下载超时 (${timeoutMs}ms): ${url}`)), timeoutMs);

    const followRedirect = (current: string, hops: number) => {
      if (hops > 5) return finish(new Error(`太多重定向: ${url}`));
      const u = new URL(current);
      if (u.protocol !== 'https:') return finish(new Error(`仅支持 https://, got ${u.protocol} for ${current}`));

      activeReq = httpsGet(u, { agent, headers: { 'user-agent': 'botmux-font-installer' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          followRedirect(new URL(res.headers.location, u).toString(), hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(new Error(`HTTP ${res.statusCode} for ${current}`));
        }
        const out = createWriteStream(tmp);
        res.pipe(out);
        out.on('error', (err) => finish(err));
        out.on('finish', () => {
          out.close(() => {
            try {
              renameSync(tmp, destPath);
              finish();
            } catch (err: any) {
              finish(err);
            }
          });
        });
      });
      activeReq.on('error', (err) => finish(err));
    };

    followRedirect(url, 0);
  });
}

async function downloadCategory(spec: FontSpec): Promise<void> {
  if (!existsSync(FONT_DIR)) mkdirSync(FONT_DIR, { recursive: true });
  for (const f of spec.files) {
    const dest = join(FONT_DIR, f.name);
    // Skip if already present and big enough.
    try {
      if (existsSync(dest) && statSync(dest).size >= f.minBytes) continue;
    } catch { /* fall through to redownload */ }
    console.log(`   下载 ${spec.category}: ${f.name} ...`);
    await downloadFile(f.url, dest);
    const sz = statSync(dest).size;
    if (sz < f.minBytes) {
      try { unlinkSync(dest); } catch { /* ignore */ }
      throw new Error(`${f.name} 下载完毕但大小异常 (${sz} < ${f.minBytes})`);
    }
  }
}

export async function ensureFonts(info?: PlatformInfo): Promise<FontResult> {
  const platform = info ?? detectPlatform();
  const result: FontResult = { fontDir: FONT_DIR, ready: [], failed: [] };

  // macOS: skip — system fonts cover everything we need.
  if (platform.os === 'darwin') {
    result.ready.push('CJK', 'Latin', 'Emoji');
    return result;
  }

  for (const spec of FONT_SPECS) {
    if (categoryAlreadyOk(spec)) {
      result.ready.push(spec.category);
      continue;
    }
    try {
      await downloadCategory(spec);
      result.ready.push(spec.category);
    } catch (err: any) {
      console.warn(`⚠️  字体下载失败 [${spec.category}]: ${err?.message ?? err}`);
      result.failed.push(spec.category);
    }
  }

  return result;
}
