/**
 * Dependency bootstrap. Called from `botmux start` and `botmux restart` so
 * a fresh machine that just `npm i -g botmux`'d gets tmux + screenshot fonts
 * provisioned without manual setup.
 *
 * - tmux is required: a failed install throws so cli.ts can exit non-zero.
 * - fonts are nice-to-have: failures only print a warning.
 */
import { detectPlatform } from './detect-platform.js';
import { ensureTmux, type TmuxResult } from './ensure-tmux.js';
import { ensureFonts, type FontResult } from './ensure-fonts.js';

export interface DependenciesReport {
  tmux: TmuxResult;
  fonts: FontResult;
}

export { botmuxFontDir } from './ensure-fonts.js';

export async function ensureDependencies(): Promise<DependenciesReport> {
  const platform = detectPlatform();

  // tmux: nice-to-have (enables /adopt + multi-pane Web terminal). Daemon
  // still works on PTY backend without it, so failure is a warning, not fatal.
  const tmux = await ensureTmux(platform);
  if (tmux.installed) {
    if (!tmux.freshInstall) console.log(`✓ tmux ${tmux.version} (existing)`);
    for (const warning of tmux.warnings ?? []) {
      console.warn(`⚠️  tmux 兼容性提醒：${warning}`);
    }
  } else {
    console.warn('');
    console.warn('⚠️  tmux 不可用，已退回到 PTY backend');
    console.warn(`    原因：${tmux.reason ?? '未知'}`);
    if (tmux.manualCommand) console.warn(`    手动尝试：${tmux.manualCommand}`);
    console.warn('    影响：/adopt（接管已有 CLI 会话）和多人 Web 终端不可用；常规对话不受影响。');
    console.warn('');
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

  return { tmux, fonts };
}
