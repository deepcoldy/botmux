/**
 * Best-effort CJK font auto-install for Debian/Ubuntu hosts.
 *
 * 截图渲染依赖系统里有 Noto Sans CJK + Noto Color Emoji，否则中文/emoji 会
 * 渲染成豆腐块。macOS 自带 PingFang/Hiragino，无需处理；其他 Linux 发行版
 * 仅打印手动命令不强行执行。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { logger } from './logger.js';

const CJK_PROBE_PATHS = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansMonoCJK-Regular.ttc',
];

const PKGS = ['fonts-noto-cjk', 'fonts-noto-color-emoji'];
const MANUAL_CMD = `sudo apt-get install -y ${PKGS.join(' ')}`;

let triggered = false;

export function ensureCjkFontsInstalled(): void {
  if (triggered) return;
  triggered = true;

  if (process.platform !== 'linux') return;
  if (CJK_PROBE_PATHS.some(p => existsSync(p))) return;
  if (!existsSync('/usr/bin/apt-get')) {
    logger.warn(`截图缺 CJK 字体，但当前系统不是 Debian/Ubuntu，请手动安装 Noto CJK 字体（包名因发行版而异）。`);
    return;
  }

  const isRoot = process.getuid?.() === 0;
  const argv = isRoot
    ? ['apt-get', 'install', '-y', ...PKGS]
    : ['sudo', '-n', 'apt-get', 'install', '-y', ...PKGS];

  logger.info(`[font-installer] 后台安装 CJK 字体：${argv.join(' ')}`);

  const proc = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    detached: false,
  });
  let stderr = '';
  proc.stderr?.on('data', d => { stderr += d.toString(); });
  proc.on('error', err => {
    logger.warn(`[font-installer] 启动失败：${err.message}。请手动执行：${MANUAL_CMD}`);
  });
  proc.on('exit', code => {
    if (code === 0) {
      logger.info('[font-installer] CJK 字体安装成功；重启 daemon 后截图即可正确渲染中文（pnpm daemon:restart）。');
    } else {
      const hint = stderr.includes('password is required') || stderr.includes('a terminal is required')
        ? '（当前用户没有免密 sudo 权限）'
        : '';
      logger.warn(`[font-installer] 安装失败 exit=${code}${hint}。请手动执行：${MANUAL_CMD}\n${stderr.trim().slice(0, 400)}`);
    }
  });
  proc.unref();
}
