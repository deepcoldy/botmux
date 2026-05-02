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

  // tmux first — it's the load-bearing dep. Throws on failure.
  const tmux = await ensureTmux(platform);
  if (!tmux.freshInstall) {
    console.log(`✓ tmux ${tmux.version} (existing)`);
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
