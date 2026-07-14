/**
 * Dependency bootstrap. Called from `botmux start` and `botmux restart` so
 * a fresh machine that just `npm i -g botmux`'d gets tmux + screenshot fonts
 * provisioned without manual setup.
 *
 * - tmux is required (PTY 退役): when it's GENUINELY ABSENT and a bot wants the
 *   tmux backend, cli.ts hard-fails `start`/`restart` (non-zero exit, no pm2
 *   spawn) — see shouldHardFailStartupForMissingTmux. A present-but-broken tmux
 *   degrades gracefully via the per-session worker gate instead.
 * - fonts are nice-to-have: failures only print a warning.
 * - herdr is on-demand: only runs when at least one bot in bots.json has
 *   `backendType: 'herdr'`. Avoids dragging an extra binary onto every host.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectPlatform } from './detect-platform.js';
import { ensureTmux, type TmuxResult } from './ensure-tmux.js';
import { ensureFonts, type FontResult } from './ensure-fonts.js';
import { ensureHerdr, type HerdrResult } from './ensure-herdr.js';
import { ensureHerdrIntegrations, type HerdrIntegrationResult } from './ensure-herdr-integrations.js';
import type { CliId } from '../adapters/cli/types.js';

export interface DependenciesReport {
  tmux: TmuxResult;
  fonts: FontResult;
  herdr?: HerdrResult;
  herdrIntegrations?: HerdrIntegrationResult;
}

export { botmuxFontDir } from './ensure-fonts.js';

/**
 * Decide whether `botmux start`/`restart` should HARD-FAIL (refuse to spawn the
 * daemon) because tmux is missing. PR#289 Option A.
 *
 * Hard-fail ONLY when ALL of:
 *   - the tmux binary is GENUINELY ABSENT (`tmuxBinaryPresent === false`). This
 *     is deterministic and implies there is no tmux server — hence no surviving
 *     session to protect — so refusing to start loses nothing.
 *   - at least one bot actually wants the tmux backend (`anyBotWantsTmux`). A
 *     box whose bots all run pty/herdr/zellij doesn't need tmux at all.
 *   - the operator hasn't opted into the PTY escape hatch (`BACKEND_TYPE=pty`).
 *
 * Crucially we do NOT hard-fail when the binary IS present but its functional
 * probe failed: that probe is the same disposable `tmux new-session` check the
 * per-session gate retries, and a transient flake there must not block the
 * daemon from coming up and reattaching live sessions — that would re-introduce
 * the PR#249 false-negative at startup granularity. Present-but-broken tmux
 * degrades gracefully via the per-session worker gate (an actionable card).
 */
export function shouldHardFailStartupForMissingTmux(opts: {
  tmuxInstalled: boolean;
  tmuxBinaryPresent: boolean;
  anyBotWantsTmux: boolean;
  ptyOptIn: boolean;
}): boolean {
  if (opts.ptyOptIn) return false;
  if (opts.tmuxInstalled) return false;
  if (opts.tmuxBinaryPresent) return false;
  return opts.anyBotWantsTmux;
}

const BOTS_JSON_FILE = join(homedir(), '.botmux', 'bots.json');

/**
 * Read bots.json directly (no parser, no validation) to find which CLIs
 * have herdr backend selected. We deliberately bypass parseBotConfigsJson
 * to avoid pulling the full bot-config-editor module (and its CLI deps)
 * into the bootstrap path. Best-effort: any read/parse failure → empty list,
 * herdr install will simply skip.
 */
function herdrCliIds(): CliId[] {
  if (!existsSync(BOTS_JSON_FILE)) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(BOTS_JSON_FILE, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = new Set<CliId>();
  for (const bot of parsed) {
    if (!bot || typeof bot !== 'object') continue;
    if (bot.backendType !== 'herdr') continue;
    const cli = (bot.cliId ?? 'claude-code') as CliId;
    out.add(cli);
  }
  return [...out];
}

export async function ensureDependencies(): Promise<DependenciesReport> {
  const platform = detectPlatform();

  // tmux: REQUIRED (PTY 退役). PTY is no longer an automatic fallback, so a
  // host without functional tmux can't start sessions unless the operator
  // explicitly opts into the PTY escape hatch (BACKEND_TYPE=pty). Surface this
  // loudly instead of pretending "常规对话不受影响" — that was true under the
  // old silent-fallback behavior and is now misleading.
  const tmux = await ensureTmux(platform);
  const ptyOptIn = (process.env.BACKEND_TYPE ?? '').toLowerCase() === 'pty';
  if (tmux.installed) {
    if (!tmux.freshInstall) console.log(`✓ tmux ${tmux.version} (existing)`);
  } else if (ptyOptIn) {
    console.warn('');
    console.warn('⚠️  tmux 不可用，但已显式设置 BACKEND_TYPE=pty —— 将使用 PTY 后端兜底。');
    console.warn(`    原因：${tmux.reason ?? '未知'}`);
    console.warn('    注意：PTY 会话不跨 daemon 重启存活，/adopt 与多人 Web 终端不可用。');
    console.warn('');
  } else {
    console.error('');
    console.error('❌  tmux 不可用，botmux 会话将无法启动。');
    console.error(`    原因：${tmux.reason ?? '未知'}`);
    if (tmux.manualCommand) console.error(`    请安装：${tmux.manualCommand}`);
    console.error('    安装好 tmux 后重试即可。');
    console.error('    （如确需在没有 tmux 的环境运行，可显式设置环境变量 BACKEND_TYPE=pty 用 PTY 后端兜底，');
    console.error('      但 PTY 会话不跨 daemon 重启存活，仅作应急。）');
    console.error('');
  }

  // Fonts second — best-effort.
  const fonts = await ensureFonts(platform);
  if (fonts.failed.length === 0) {
    if (platform.os === 'darwin') {
      console.log('✓ 字体: 系统字体已就绪 (macOS)');
    } else {
      console.log(`✓ 字体: ${fonts.ready.join(' / ')} 已就绪`);
    }
  } else {
    console.warn(`⚠️  字体部分缺失: ${fonts.failed.join(' / ')} —— 飞书截图中相关字符可能渲染为方块`);
  }

  // herdr: on-demand only. We won't pull it onto hosts that don't use it.
  const herdrCandidates = herdrCliIds();
  let herdr: HerdrResult | undefined;
  let herdrIntegrations: HerdrIntegrationResult | undefined;
  if (herdrCandidates.length > 0) {
    herdr = await ensureHerdr();
    if (herdr.installed) {
      if (!herdr.freshInstall) console.log(`✓ herdr ${herdr.version} (existing)`);
      // Only attempt integration install when herdr itself is on PATH —
      // otherwise `herdr integration install` would just spam ENOENT.
      herdrIntegrations = await ensureHerdrIntegrations(herdrCandidates);
      reportHerdrIntegrations(herdrIntegrations);
    } else {
      console.warn('');
      console.warn('⚠️  herdr 安装失败，使用 herdr backend 的 bot 将无法启动');
      console.warn(`    原因：${herdr.reason ?? '未知'}`);
      if (herdr.manualCommand) console.warn(`    手动尝试：${herdr.manualCommand}`);
      console.warn('    临时方案：把对应 bot 的 backendType 改回 "tmux" 或 "pty"');
      console.warn('');
    }
  }

  return { tmux, fonts, herdr, herdrIntegrations };
}

function reportHerdrIntegrations(r: HerdrIntegrationResult): void {
  // NB: gate on `!r.traexPlugin`, not `!r.traexPlugin?.attempted` — a skipped
  // traex plugin (disabled / missing_source) has attempted=false but STILL needs
  // its hint printed, otherwise a herdr+traex host with the toggle on but no
  // source would silently no-op with no diagnostic when traex is the only herdr CLI.
  if (r.attempted.length === 0 && r.unsupportedCliIds.length === 0 && !r.traexPlugin) return;
  if (r.installed.length > 0) console.log(`✓ herdr integrations 已安装: ${r.installed.join(' / ')}`);
  if (r.alreadyInstalled.length > 0) console.log(`✓ herdr integrations (existing): ${r.alreadyInstalled.join(' / ')}`);
  if (r.traexPlugin) {
    const tp = r.traexPlugin;
    if (tp.skippedReason === 'disabled') {
      console.warn('ℹ️  检测到 herdr + traex；TraeX herdr plugin 自动安装默认关闭，可在 Dashboard Settings 中开启并填写可信 plugin source。');
    } else if (tp.skippedReason === 'missing_source') {
      console.warn('⚠️  herdr TraeX plugin 已开启但未配置 plugin source；请在 Dashboard Settings 填写你信任的 source（owner/repo，建议钉 ref）。');
    } else if (tp.skippedReason === 'plugin_unsupported') {
      console.warn(`⚠️  当前 herdr${tp.herdrVersion ? ` ${tp.herdrVersion}` : ''} 不支持插件（需 ≥0.7.0）；请运行 \`herdr update\` 升级后重试。`);
    } else if (tp.failed) {
      console.warn(`⚠️  herdr TraeX plugin ${tp.failed.step === 'install' ? '安装' : '配置'}失败：${tp.failed.reason}`);
      console.warn(`    手动尝试：${tp.failed.manualCommand}`);
      console.warn('    说明：herdr + traex 不装该插件也能启动，但状态只能退回屏幕启发式检测。');
    } else if (tp.installed || tp.actionInvoked) {
      console.log(`✓ herdr TraeX plugin 已安装并写入 ~/.trae hooks: ${tp.source}`);
    } else if (tp.alreadyInstalled) {
      console.log(`✓ herdr TraeX plugin (existing)，已是最新: ${tp.source}`);
    }
  }
  for (const f of r.failed) {
    console.warn(`⚠️  herdr integration 安装失败: ${f.name} — ${f.reason}`);
    console.warn(`    手动尝试：${f.manualCommand ?? `herdr integration install ${f.name}`}`);
  }
  if (r.unsupportedCliIds.length > 0) {
    console.warn(
      `⚠️  以下 CLI 暂无官方 herdr integration（herdr 仍可用，但仅靠屏幕启发式检测状态）: ${r.unsupportedCliIds.join(', ')}`,
    );
  }
}
