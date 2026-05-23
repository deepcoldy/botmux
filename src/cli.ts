#!/usr/bin/env node
/**
 * CLI entry point for botmux.
 *
 * Usage:
 *   botmux setup          — interactive first-time configuration
 *   botmux start          — start daemon (pm2)
 *   botmux stop           — stop daemon
 *   botmux restart        — restart daemon (auto-restores sessions)
 *   botmux logs [--lines] — view daemon logs
 *   botmux status         — show daemon status
 *   botmux upgrade        — upgrade to latest version
 *   botmux list           — interactive session picker (TUI), attach to tmux
 *   botmux list --plain   — plain table output (for piping / scripts)
 *   botmux delete <id>    — close a session by ID prefix
 *   botmux delete all     — close all active sessions
 *   botmux autostart enable|disable|status — manage boot-time autostart (launchd / user systemd)
 */
import { execSync, spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, readdirSync, readlinkSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';
import { validateWorkingDir } from './core/working-dir.js';
import { enableAutostart, disableAutostart, autostartStatus, refreshAutostart } from './autostart.js';
import { tmuxEnv } from './setup/ensure-tmux.js';
import { writeBotsJsonAtomic as writeBotsAtomic } from './setup/bots-store.js';
import {
  applyBotConfigEdits,
  assertUniqueBotProcessNames,
  botProcessName,
  normalizeBotConfig,
  parseBotConfigsJson,
  parseBotSelection,
  removeBotConfig,
  resolveCliId,
  type BotConfigEditInput,
} from './setup/bot-config-editor.js';
import type { CliId } from './adapters/cli/types.js';
import { logger } from './utils/logger.js';
import { invalidWorkingDirs } from './utils/working-dir.js';
import { firstPositional } from './cli/arg-utils.js';
import {
  formatBotInfoEntriesForCli,
  formatChatBotsForCli,
} from './cli/bots-list-output.js';
import { isLocale, setDefaultLocale, SUPPORTED_LOCALES, type Locale } from './i18n/index.js';
import { readGlobalConfig, setGlobalLocale, globalConfigPath } from './global-config.js';

// Resolve the CLI's UI locale once from the global config file, so subsequent
// CLI output (and any t() callers that don't pass an explicit locale) honour
// the user's chosen language. Daemon entrypoint sets this separately for the
// daemon process.
{
  const cfg = readGlobalConfig();
  if (cfg.lang) setDefaultLocale(cfg.lang);
}

// CLI subcommands (send/thread/bots/list/etc) print JSON to stdout for
// callers to parse. Transitive logger.info calls from shared modules would
// corrupt that stream, so the CLI process runs silent by default. DEBUG=1
// re-enables logging end-to-end for CLI troubleshooting.
logger.setSilent(true);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Package root is one level up from dist/
const PKG_ROOT = dirname(__dirname);
const CONFIG_DIR = join(homedir(), '.botmux');
const ENV_FILE = join(CONFIG_DIR, '.env');
const DATA_DIR = join(CONFIG_DIR, 'data');
const LOG_DIR = join(CONFIG_DIR, 'logs');
const HEAPSHOT_DIR = join(CONFIG_DIR, 'heapshots');
const BOTS_JSON_FILE = join(CONFIG_DIR, 'bots.json');
const PM2_NAME = 'botmux';
/**
 * Dedicated PM2_HOME for botmux. Isolates our pm2 daemon state from any
 * other pm2 installation on the machine (e.g. the one bundled in IDE
 * remote-ssh extensions). Prevents stale ProcessContainerFork.js paths
 * when those external pm2 installations get moved or removed.
 */
const PM2_HOME = join(CONFIG_DIR, 'pm2');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureConfigDir(): void {
  for (const dir of [CONFIG_DIR, DATA_DIR, LOG_DIR, HEAPSHOT_DIR, PM2_HOME]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve the pm2 CLI script path. Uses require.resolve so it always lands
 * on the pm2 bundled with this package, never on a PATH-resolved pm2 that
 * may belong to an unrelated installation (e.g. IDE remote extensions).
 */
function pm2Bin(): string {
  try {
    return require.resolve('pm2/bin/pm2');
  } catch { /* fall through */ }
  // Fallbacks for unusual installation layouts
  const direct = join(PKG_ROOT, 'node_modules', 'pm2', 'bin', 'pm2');
  if (existsSync(direct)) return direct;
  const symlink = join(PKG_ROOT, 'node_modules', '.bin', 'pm2');
  if (existsSync(symlink)) return symlink;
  return 'pm2';
}

/** Env for pm2 invocations with an isolated PM2_HOME. */
function pm2Env(home: string = PM2_HOME): NodeJS.ProcessEnv {
  return { ...process.env, PM2_HOME: home };
}

function listPm2GodDaemonPids(home: string = PM2_HOME): number[] {
  if (process.platform !== 'linux') return [];
  const marker = `God Daemon (${home})`;
  const pids: number[] = [];
  try {
    for (const ent of readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = parseInt(ent, 10);
      if (!pid) continue;
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\u0000/g, ' ').trim();
        if (cmd.includes('PM2 v') && cmd.includes(marker)) pids.push(pid);
      } catch { /* ignore unreadable proc entries */ }
    }
  } catch { /* ignore proc scan failure */ }
  return pids.sort((a, b) => a - b);
}

function killDuplicatePm2GodDaemons(home: string = PM2_HOME): boolean {
  const pids = listPm2GodDaemonPids(home);
  if (pids.length <= 1) return false;

  const pidFile = join(home, 'pm2.pid');
  let keepPid = 0;
  if (existsSync(pidFile)) {
    try {
      const parsed = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pids.includes(parsed)) keepPid = parsed;
    } catch { /* ignore malformed pid file */ }
  }
  if (!keepPid) keepPid = pids[pids.length - 1];

  const dupes = pids.filter(pid => pid !== keepPid);
  if (dupes.length === 0) return false;

  for (const pid of dupes) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }

  try {
    writeFileSync(pidFile, `${keepPid}\n`, 'utf-8');
  } catch { /* ignore */ }

  console.warn(`⚠️  检测到同一 PM2_HOME (${home}) 下存在多个 PM2 God Daemon，已清理重复实例；保留 pid ${keepPid}，移除: ${dupes.join(', ')}`);
  return true;
}

function runPm2(args: string[], inherit = true, home: string = PM2_HOME): void {
  execSync(`${pm2Bin()} ${args.join(' ')}`, {
    stdio: inherit ? 'inherit' : 'pipe',
    env: pm2Env(home),
  });
}

function loadBotsJson(): any[] {
  if (existsSync(BOTS_JSON_FILE)) {
    try {
      return parseBotConfigsJson(readFileSync(BOTS_JSON_FILE, 'utf-8'), BOTS_JSON_FILE);
    } catch (err: any) {
      console.error(`❌ ${err?.message ?? String(err)}`);
      process.exit(1);
    }
  }
  return [];
}

function ensureBotWorkingDirsExist(bot: Record<string, any>, context = 'workingDir'): boolean {
  const invalid = invalidWorkingDirs(bot);
  if (invalid.length === 0) return true;
  console.log(`\n❌ ${context} 指向的目录不存在或不是目录:`);
  for (const dir of invalid) console.log(`   - ${dir}`);
  console.log('   请先创建目录，或重新填写一个已存在的工作目录。');
  return false;
}

function ensureUniqueBotProcessNames(bots: any[]): void {
  try {
    assertUniqueBotProcessNames(bots, PM2_NAME);
  } catch (err: any) {
    console.error(`❌ ${err?.message ?? String(err)}`);
    console.error('   请修改 bots.json 中的 name，确保进程名唯一。');
    process.exit(1);
  }
}

function ecosystemConfig(): string {
  const daemonScript = join(PKG_ROOT, 'dist', 'index-daemon.js');
  const bots = loadBotsJson();
  ensureUniqueBotProcessNames(bots);

  const baseApp = {
    script: daemonScript,
    cwd: CONFIG_DIR,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    node_args: [
      '--max-old-space-size=8192',
      // Do not enable --heapsnapshot-near-heap-limit here. On large V8
      // heaps the snapshot generator is synchronous, can add many GiB of
      // RSS, and blocks the daemon before our memdiag timer can run.
      `--diagnostic-dir=${HEAPSHOT_DIR}`,
    ],
  };

  const apps: any[] = bots.map((_bot: any, i: number) => ({
    ...baseApp,
    name: botProcessName(_bot, i, PM2_NAME),
    error_file: join(LOG_DIR, `daemon-${i}-error.log`),
    out_file: join(LOG_DIR, `daemon-${i}-out.log`),
    env: {
      SESSION_DATA_DIR: DATA_DIR,
      BOTMUX_BOT_INDEX: String(i),
      // Native-memory diagnostics. Default off; operator can flip it on
      // ad-hoc (e.g. `BOTMUX_MEMORY_DIAG_INTERVAL_MS=5000`) when chasing an
      // RSS regression — turned off in master so logs stay quiet.
      BOTMUX_MEMORY_DIAG_INTERVAL_MS: process.env.BOTMUX_MEMORY_DIAG_INTERVAL_MS ?? '0',
    },
  }));

  apps.push({
    name: 'botmux-dashboard',
    script: join(PKG_ROOT, 'dist', 'dashboard.js'),
    cwd: PKG_ROOT,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    error_file: join(LOG_DIR, 'dashboard-error.log'),
    out_file: join(LOG_DIR, 'dashboard-out.log'),
    merge_logs: true,
    env: {
      BOTMUX_DASHBOARD_HOST: process.env.BOTMUX_DASHBOARD_HOST ?? '0.0.0.0',
      BOTMUX_DASHBOARD_PORT: process.env.BOTMUX_DASHBOARD_PORT ?? '7891',
    },
  });

  const cfg = { apps };
  const tmpFile = join(CONFIG_DIR, 'ecosystem.config.json');
  writeFileSync(tmpFile, JSON.stringify(cfg, null, 2));
  return tmpFile;
}

function hasConfig(): boolean {
  return existsSync(BOTS_JSON_FILE) || existsSync(ENV_FILE);
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

// ─── Setup helpers ──────────────────────────────────────────────────────────

function printInputHelp(title: string, lines: string[]): void {
  console.log(`\n${title}`);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

// Thin wrapper around setup/bots-store.writeBotsJsonAtomic so call-sites keep
// the same name without passing BOTS_JSON_FILE explicitly each time.
function writeBotsJsonAtomic(bots: any[]): void {
  const normalized = bots.map(bot => normalizeBotConfig(bot));
  ensureUniqueBotProcessNames(normalized);
  writeBotsAtomic(BOTS_JSON_FILE, normalized);
}

/**
 * 从 bot 配置里取 brand. 旧的 bots.json (1.0 之前) 没这个字段, default 到 feishu
 * 保留向后兼容. cmdStart 凭证校验 + printRemainingSteps 深链都靠它选 host.
 */
function botBrand(b: any): 'feishu' | 'lark' {
  return b?.brand === 'lark' ? 'lark' : 'feishu';
}

/**
 * 把 botmux 推荐的完整 scope JSON (从 src/setup/lark-scopes.json) 写到
 * 用户配置目录, 同时给出跨平台一键复制命令. JSON 长 (293 项, 297 行),
 * terminal 直接打印用户也复制不了, 写文件 + pbcopy/xclip 才是顺手的姿势.
 *
 * Returns: 写出的 JSON 文件绝对路径.
 */
function writeScopesJsonToConfigDir(): string {
  // build script 会把 src/setup/lark-scopes.json copy 到 dist/setup/.
  // dist 模式下 __dirname 是 dist/, 找 ./setup/lark-scopes.json; dev (tsx)
  // 模式找 src/setup/lark-scopes.json 在源码同目录也成立.
  const here = dirname(fileURLToPath(import.meta.url));
  const srcCandidates = [
    join(here, 'setup', 'lark-scopes.json'),
    join(here, '..', 'src', 'setup', 'lark-scopes.json'),
  ];
  let scopesPath = srcCandidates[0];
  for (const p of srcCandidates) {
    if (existsSync(p)) { scopesPath = p; break; }
  }
  const destPath = join(CONFIG_DIR, 'lark-scopes.json');
  copyFileSync(scopesPath, destPath);
  return destPath;
}

function printCopyHint(filePath: string): void {
  // 环境感知: SSH/headless 没有 X server, xclip 一定报 "Can't open display".
  // 这种场景下"剪贴板"在用户本地 (运行 SSH 客户端的那台机器), 远程机上能做的:
  //   - 直接 cat, 让用户在本地 terminal 鼠标选中 (SSH 选中即写本地剪贴板)
  //   - OSC 52: terminal app 代写本地剪贴板, iTerm2 / kitty / WezTerm /
  //     Alacritty / tmux 1.5+ 都支持, gnome-terminal / Terminal.app 不支持
  // 检测 DISPLAY (X11) 或 WAYLAND_DISPLAY 都没有, 或 SSH_* 环境变量存在
  // → 当作 SSH 场景, 不推荐 xclip / pbcopy.
  const isSsh = !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
  const hasLocalGui = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !isSsh;
  const isMacLocal = process.platform === 'darwin' && !isSsh;

  console.log('  把 JSON 内容拷到本地剪贴板, 然后到飞书"批量导入/导出权限"页粘贴:');
  if (isMacLocal) {
    console.log(`    macOS 本地:  cat ${filePath} | pbcopy`);
  } else if (hasLocalGui) {
    console.log(`    Linux 本地 (X 服务器):  cat ${filePath} | xclip -selection clipboard`);
  } else {
    // SSH / headless: 鼠标选中是最稳的, OSC 52 作为高级选项
    console.log(`    SSH 终端鼠标选中复制:  cat ${filePath}`);
    console.log('       (终端把选中的字符直接写到你本地剪贴板, 不依赖远端剪贴板工具)');
    console.log(`    或 OSC 52 (兼容 iTerm2 / kitty / WezTerm / Alacritty / tmux 1.5+):`);
    console.log(`       base64 -w0 < ${filePath} | awk 'BEGIN{printf "\\033]52;c;"}{printf "%s",$0}END{printf "\\a"}'`);
  }
  console.log('');
}

function printRemainingSteps(appId: string, brand: 'feishu' | 'lark'): void {
  // PersonalAgent 应用扫码建出来时已默认订阅 im.message.receive_v1 +
  // card.action.trigger, 并开通 bot 能力, 主线只剩两步: 申请权限 + 重定向
  // URL (按需). README "Step 8 收不到消息时" 段提供 fallback 自查链接.
  const host = brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  const home = `https://${host}/app/${appId}`;
  let scopesJsonPath = '';
  try {
    scopesJsonPath = writeScopesJsonToConfigDir();
  } catch (err) {
    // 不应阻止 setup 完成, 只 WARN
    console.log(`\n⚠️  写权限 JSON 失败 (${(err as Error).message}), 请手动从仓库源码 src/setup/lark-scopes.json 拷.`);
  }

  console.log('\n剩余两步在开放平台完成:\n');

  console.log('  1. 申请权限 (一次性导入完整 JSON 提交审批)');
  console.log(`     申请链接: ${home}/auth → 进入「权限管理」→「批量导入/导出权限」→ 粘贴 → 提交`);
  if (scopesJsonPath) {
    console.log(`     权限 JSON: ${scopesJsonPath}`);
    printCopyHint(scopesJsonPath);
  }
  console.log('');

  console.log('  2. 添加重定向 URL (用于 botmux 内 `/login` 拿用户 UAT 获取卡片消息)');
  console.log(`     申请链接: ${home}/safe → 进入「安全设置」→「重定向 URL」`);
  console.log('     填入: http://127.0.0.1:9768/callback');
  console.log('     不需要 `/login` 拿卡片消息的话, 这一步可以跳过.\n');

  console.log('  完成后 `botmux start` (或 `botmux restart`)，启动检查不会卡住，');
  console.log('  缺权限只 WARN，去开放平台补齐后 daemon 自动恢复。\n');
}

/**
 * 让用户选"扫码建应用"还是"手动粘 AppID/Secret".
 *
 * 默认走扫码: 调 SDK `registerApp` → 拿 client_id/client_secret. 失败 (用户拒绝/
 * 超时/网络/取消) 一律降级到手动, 不阻塞流程.
 *
 * Codex review 边界:
 * - secret 不进 argv / 日志 / 错误链 (registerApp 内部 safeMsg 已做; 手动模式下
 *   AppSecret 通过 rl.question 异步读取, 不会出现在 process.argv)
 * - 任何失败都返回结构化对象, 不抛 (调用方根据 ok=false 回退)
 */
async function obtainCredentials(rl: ReturnType<typeof createInterface>): Promise<
  | { ok: true; appId: string; appSecret: string; brand: 'feishu' | 'lark'; userOpenId?: string }
  | { ok: false; reason: 'cancelled' | 'lark_unsupported' }
> {
  console.log('── 飞书应用建立 ──\n');
  console.log('1) 扫码建应用（推荐，一步拿到 AppID/Secret，需要飞书 App 扫码）');
  console.log('2) 手动粘 AppID/Secret（已经在开放平台创建好应用了）\n');
  const choice = (await ask(rl, '选择 [1]: ')).trim();

  if (choice !== '2') {
    // 动态导入避免冷启动加载 SDK
    const { tryRegisterApp } = await import('./setup/register-app.js');
    const result = await tryRegisterApp();
    if (result.ok) {
      // Lark 国际版需要 daemon 链路全程走 larksuite.com 域 (Client domain /
      // WSClient / event-dispatcher 的 fetch URL / scope 深链 host). 当前
      // botmux runtime 这几处都硬编码 feishu.cn, 所以即使扫码成功了也无法
      // 真正跑起来. 干净做法是 setup 阶段就拒绝, 让用户用 feishu 租户. 单
      // 独 PR 完整接入 lark 后再去掉这个分支.
      if (result.brand === 'lark') {
        console.log(`\n❌ 检测到 Lark 国际版 (larksuite.com) 租户。`);
        console.log(`   botmux 当前 daemon 运行链路仅支持飞书 (feishu.cn) 租户,`);
        console.log(`   Lark 国际版完整接入会在单独 PR 跟进 (BotConfig / Client domain /`);
        console.log(`   WSClient / event-dispatcher 等需要一并支持).`);
        console.log(`   请用飞书 (feishu.cn) 租户重试 setup。\n`);
        return { ok: false, reason: 'lark_unsupported' };
      }
      console.log(`\n✅ 应用创建成功`);
      console.log(`   App ID: ${result.appId}`);
      console.log(`   租户类型: ${result.brand}`);
      if (result.userOpenId) {
        console.log(`   扫码人 open_id: ${result.userOpenId}（将默认作为 allowedUsers）`);
      }
      return {
        ok: true,
        appId: result.appId,
        appSecret: result.appSecret,
        brand: result.brand,
        userOpenId: result.userOpenId,
      };
    }
    console.log(`\n⚠️  扫码失败 (${result.error}): ${result.message}`);
    if (result.error === 'aborted') {
      // 用户主动取消整个 setup, 不再问手动 fallback
      return { ok: false, reason: 'cancelled' };
    }
    console.log('   降级到手动输入 AppID/Secret。\n');
  } else {
    console.log('\n请在浏览器打开 https://open.feishu.cn/app 创建应用，然后回来粘 ID/Secret。\n');
  }

  // 手动 fallback. 不再提问租户类型 — 当前 daemon runtime 只支持 feishu,
  // 让用户选 lark 是误导. 等 lark 完整接入再加回来.
  const appId = (await ask(rl, 'AppID (cli_xxx): ')).trim();
  const appSecret = (await ask(rl, 'AppSecret: ')).trim();

  if (!appId || !appSecret) {
    console.log('\n❌ AppID/AppSecret 不能为空，setup 中止。');
    return { ok: false, reason: 'cancelled' };
  }
  return { ok: true, appId, appSecret, brand: 'feishu' };
}

/**
 * 收集一个机器人完整配置 (凭证 + CLI/工作目录/allowedUsers).
 *
 * 顺序: 拿凭证 → tenant_access_token 验证 → 通过才返回 bot 对象. 验证失败
 * 直接返回 null, 调用方负责"不写 bots.json". Codex review 边界 #2.
 */
async function promptBotConfig(rl: ReturnType<typeof createInterface>): Promise<Record<string, any> | null> {
  const creds = await obtainCredentials(rl);
  if (!creds.ok) return null;

  // 凭证立刻验证. 通不过不写 bots.json.
  console.log('\n校验凭证（取 tenant_access_token）…');
  const { validateCredentials } = await import('./setup/verify-permissions.js');
  const v = await validateCredentials(creds.appId, creds.appSecret, creds.brand);
  if (!v.ok) {
    console.log(`\n❌ 凭证校验失败 (${v.error}): ${v.message}`);
    console.log('   不写 bots.json。请重新运行 botmux setup。');
    return null;
  }
  console.log('✅ 凭证有效（tenant_access_token 已成功获取）\n');

  console.log('支持的 CLI: 1) claude-code  2) aiden  3) coco  4) codex  5) cursor  6) gemini  7) opencode  8) antigravity');
  const cliChoice = await ask(rl, 'CLI 适配器 [1]: ');
  let cliId: CliId;
  try {
    cliId = resolveCliId(cliChoice) ?? 'claude-code';
  } catch (err: any) {
    console.log(`\n❌ ${err?.message ?? String(err)}`);
    console.log('   不写 bots.json。请重新运行 botmux setup。');
    return null;
  }
  const workingDir = await ask(rl, '默认工作目录 [~]: ');

  // 不再持久化 brand 字段: setup 阶段 brand=lark 直接被 obtainCredentials 中止,
  // 落盘的永远是 'feishu', 写进配置是死字段. 等 lark 完整接入再加回来, 那时
  // 同步打开 daemon 链路的 brand 透传. botBrand() helper 读不到字段会 default
  // 到 'feishu', 兼容旧版同时支持将来扩展.
  const bot: Record<string, any> = {
    larkAppId: creds.appId,
    larkAppSecret: creds.appSecret,
    cliId,
    // 总是写 workingDir, 留空用 '~'. 用户手动编辑 bots.json 时一眼能看到字段
    // 在哪儿, 不用去 README 查字段名.
    workingDir: workingDir.trim() || '~',
  };
  // 不再问 allowedUsers — 扫码场景默认填扫码人自己 (registerApp 返回里有 open_id);
  // 想改成多人共用 / 不限制, 用户后续手动编辑 ~/.botmux/bots.json 的 allowedUsers
  // 字段即可. 手动 fallback 场景没 open_id, 字段直接不写 (== 不限制).
  if (creds.userOpenId) bot.allowedUsers = [creds.userOpenId];

  if (!ensureBotWorkingDirsExist(bot, '默认工作目录')) return null;

  return normalizeBotConfig(bot);
}

function formatOptionalValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'string' && v) return v;
  return '未设置';
}

/**
 * 把 bots.json 渲染成对齐的小表格. 不带行号——进程名 (botmux-N) 已经
 * 是唯一可寻址的标识, 行号 + 进程名后缀 1-based / 0-based 并列容易引
 * 起 off-by-one 误解 (用户曾踩过 "1. botmux-0" 这种排版).
 *
 * 选择机器人时直接输完整进程名 (botmux-N / botmux-custom) 或 AppID,
 * parseBotSelection 不再接受裸数字, 避免又冒出 "序号到底是几" 的歧义.
 */
function formatBotConfigTable(bots: any[]): string {
  if (bots.length === 0) return '';
  const headers = ['进程名', 'App ID', 'CLI'];
  const rows = bots.map((b, i) => [
    botProcessName(b, i, PM2_NAME),
    String(b?.larkAppId ?? ''),
    String(b?.cliId ?? 'claude-code'),
  ]);
  const widths = headers.map((h, c) =>
    Math.max(displayWidth(h), ...rows.map(r => displayWidth(r[c]))),
  );
  const render = (cells: string[]) =>
    '  ' + cells.map((cell, i) => padEndDisplay(cell, widths[i])).join('  ');
  return [render(headers), ...rows.map(render)].join('\n');
}

async function promptEditBotConfig(
  rl: ReturnType<typeof createInterface>,
  bot: Record<string, any>,
): Promise<Record<string, any>> {
  console.log('\n字段留空表示保留当前值；可选字段输入 - 表示清空。\n');
  const input: BotConfigEditInput = {};

  printInputHelp('botmux status 显示名称', [
    '可选。用于本机进程名，方便在 botmux status / logs 中识别机器人。',
    '留空保留当前值；输入 - 清空自定义名称并恢复 botmux-<序号>。',
  ]);
  input.name = await ask(rl, `botmux status 显示名称 [${formatOptionalValue(bot.name)}]: `);

  printInputHelp('LARK_APP_ID', [
    '飞书开放平台应用的 App ID。修改后，这个配置项会切到另一个飞书应用。',
    '留空保留当前值；修改会二次确认，因为历史会话和群聊状态不会自动迁移。',
  ]);
  input.larkAppId = await ask(rl, `LARK_APP_ID [${bot.larkAppId}]: `);

  printInputHelp('LARK_APP_SECRET', [
    '当前 App ID 对应的 App Secret。只更新密钥时填写这一项即可。',
    '留空保留当前值。',
  ]);
  input.larkAppSecret = await ask(rl, `LARK_APP_SECRET [保留当前值]: `);

  console.log('\n支持的 CLI: 1) claude-code  2) aiden  3) coco  4) codex  5) cursor  6) gemini  7) opencode  8) antigravity');
  printInputHelp('CLI 适配器', [
    '选择 botmux 需要套用哪一种 CLI 参数协议和会话恢复方式。',
    '留空保留当前值；可以输入序号，也可以直接输入适配器 ID。',
  ]);
  input.cliChoice = await ask(rl, `CLI 适配器 [${bot.cliId ?? 'claude-code'}]: `);

  printInputHelp('CLI 可执行文件路径覆盖', [
    '可选。CLI 入口的绝对路径，用于在原 CLI 外面套一层 wrapper / router。',
    '典型场景：ccr (Claude Code Router) / claude-w / aiden-x-claude 等自定义入口。',
    '留空保留当前值；输入 - 清空覆盖，回到 PATH 查 cliId 对应的默认二进制。',
  ]);
  input.cliPathOverride = await ask(rl, `CLI 可执行文件路径覆盖 [${formatOptionalValue(bot.cliPathOverride)}]: `);

  printInputHelp('会话后端 backendType', [
    '可选。pty 更轻量；tmux 支持 adopt 和 Web Terminal 附着。',
    '留空保留当前值；输入 - 回到自动检测；只接受 pty 或 tmux。',
  ]);
  input.backendType = await ask(rl, `会话后端 backendType [${formatOptionalValue(bot.backendType)}]: `);

  printInputHelp('默认工作目录', [
    '可选。新会话默认进入的目录，支持逗号分隔多个候选目录。',
    '留空保留当前值；输入 - 清空并回到默认 ~。',
  ]);
  input.workingDir = await ask(rl, `默认工作目录 [${formatOptionalValue(bot.workingDir)}]: `);

  printInputHelp('允许的用户', [
    '可选。限制哪些飞书用户可以操作机器人，支持邮箱前缀或 open_id，多个值用逗号分隔。',
    '留空保留当前值；输入 - 清空限制。',
  ]);
  input.allowedUsers = await ask(rl, `允许的用户 [${formatOptionalValue(bot.allowedUsers)}]: `);

  const edited = applyBotConfigEdits(bot, input);
  if (edited.larkAppId !== bot.larkAppId) {
    console.log('\n⚠️  LARK_APP_ID 变更后，旧 appId 下的历史会话/群聊状态数据不会自动迁移。');
    const confirm = (await ask(rl, `确认将 LARK_APP_ID 从 ${bot.larkAppId} 改为 ${edited.larkAppId}? (y/N): `)).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes') {
      edited.larkAppId = bot.larkAppId;
    }
  }
  return edited;
}

/** Parse .env file to extract bot config for migration to bots.json */
function parseDotEnvToBotConfig(): Record<string, any> {
  const content = readFileSync(ENV_FILE, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    vars[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
  }

  const bot: Record<string, any> = {
    larkAppId: vars.LARK_APP_ID || '',
    larkAppSecret: vars.LARK_APP_SECRET || '',
  };
  if (vars.CLI_ID) bot.cliId = vars.CLI_ID;
  if (vars.CLI_PATH?.trim()) bot.cliPathOverride = vars.CLI_PATH.trim();
  if (vars.BACKEND_TYPE) bot.backendType = vars.BACKEND_TYPE;
  if (vars.WORKING_DIR) bot.workingDir = vars.WORKING_DIR;
  if (vars.ALLOWED_USERS) bot.allowedUsers = vars.ALLOWED_USERS.split(',').map((s: string) => s.trim()).filter(Boolean);

  return bot;
}

/**
 * 收集一个机器人配置并写盘 (单机器人 fresh install / 重新配置).
 *
 * 失败路径 (扫码取消 / 凭证校验不通过): 不创建任何配置文件, 不动旧 .env.
 * Codex review 边界 #2: 中途失败一律不留半截 JSON.
 */
async function writeSingleBotConfig(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const bot = await promptBotConfig(rl);
  rl.close();

  if (!bot) return false;

  writeBotsJsonAtomic([bot]);
  console.log(`\n✅ 配置已写入: ${BOTS_JSON_FILE}`);
  printRemainingSteps(bot.larkAppId, botBrand(bot));
  console.log(`下一步:`);
  console.log(`  1. botmux start              启动 daemon`);
  console.log(`  2. botmux autostart enable   注册开机自启（推荐：${process.platform === 'darwin' ? 'mac launchd' : process.platform === 'linux' ? 'linux user systemd' : '当前平台暂不支持'}，无需 sudo）`);
  return true;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdSetup(): Promise<void> {
  ensureConfigDir();

  const hasBots = existsSync(BOTS_JSON_FILE);
  const hasEnv = existsSync(ENV_FILE);

  console.log('\n🤖 botmux 配置向导\n');
  console.log(`配置目录: ${CONFIG_DIR}`);
  console.log(`数据目录: ${DATA_DIR}\n`);

  if (hasBots) {
    // --- Multi-bot mode (bots.json exists) ---
    const bots = loadBotsJson();
    console.log(`已配置 ${bots.length} 个机器人：\n`);
    console.log(formatBotConfigTable(bots));
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const action = await ask(rl, '操作: 1) 添加新机器人  2) 重新配置  3) 编辑现有机器人  4) 删除机器人  (1/2/3/4) [1]: ');

    if (action === '2') {
      console.log('\n── 重新配置 ──\n');
      const newBot = await promptBotConfig(rl);
      rl.close();
      if (!newBot) {
        console.log('\n⚠️  setup 中止，旧配置保留不动。');
        return;
      }
      // Codex review #1: 先 copyFileSync 备份, 再原子写新文件. 之前先 rename
      // 旧文件再 write, 一旦 write 失败 (磁盘/权限/进程被 kill) 用户就丢了
      // bots.json. copy 之后写失败旧文件原地不动, .bak 是无害的同名副本.
      copyFileSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak`);
      writeBotsJsonAtomic([newBot]);
      console.log(`✅ 配置已写入: ${BOTS_JSON_FILE}`);
      printRemainingSteps(newBot.larkAppId, botBrand(newBot));
      console.log(`下一步: botmux restart\n`);
      return;
    }

    if (action === '3') {
      console.log('\n── 编辑现有机器人 ──\n');
      const selected = await ask(rl, '选择机器人（进程名 或 AppID）: ');
      const index = parseBotSelection(selected, bots);
      if (index === undefined) {
        rl.close();
        console.log('\n❌ 找不到指定机器人，配置未修改。');
        return;
      }

      const original = bots[index];
      let edited: Record<string, any>;
      try {
        edited = await promptEditBotConfig(rl, original);
      } catch (err: any) {
        rl.close();
        console.log(`\n❌ 编辑失败: ${err?.message ?? String(err)}`);
        return;
      }
      if (!ensureBotWorkingDirsExist(edited, '默认工作目录')) {
        rl.close();
        console.log('   配置未修改。');
        return;
      }

      // 凭证字段有变化时, 像 promptBotConfig 一样跑一次 tenant_access_token
      // 校验. 失败不写盘——避免编辑后 typo 一个字符, daemon 重启时才发现.
      // (cmdRestart 不校验凭证, 只 cmdStart 校验, 所以编辑路径必须自己兜.)
      const appIdChanged = edited.larkAppId !== original.larkAppId;
      const appSecretChanged = edited.larkAppSecret !== original.larkAppSecret;
      if (appIdChanged || appSecretChanged) {
        console.log('\n校验新凭证（取 tenant_access_token）…');
        const { validateCredentials } = await import('./setup/verify-permissions.js');
        const v = await validateCredentials(edited.larkAppId, edited.larkAppSecret, botBrand(edited));
        if (!v.ok) {
          rl.close();
          console.log(`\n❌ 凭证校验失败 (${v.error}): ${v.message}`);
          console.log('   配置未修改。请重新运行 botmux setup → 编辑现有机器人。');
          return;
        }
        console.log('✅ 凭证有效\n');
      }
      rl.close();

      const nextBots = bots.slice();
      nextBots[index] = edited;
      copyFileSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak`);
      writeBotsJsonAtomic(nextBots);
      console.log(`✅ 已更新机器人 ${botProcessName(edited, index, PM2_NAME)} (${edited.larkAppId})`);
      // appId 切换 = 换了一个飞书应用, 新 appId 大概率需要重新申请权限 + 配重定向 URL.
      // 把 printRemainingSteps 的深链端给用户, 比 README 警告里那句"历史数据不迁移"更可操作.
      if (appIdChanged) {
        printRemainingSteps(edited.larkAppId, botBrand(edited));
      }
      console.log(`下一步: botmux restart\n`);
      return;
    }

    if (action === '4') {
      console.log('\n── 删除机器人 ──\n');
      const selected = await ask(rl, '选择机器人（进程名 或 AppID）: ');
      const result = removeBotConfig(bots, selected);
      if (!result) {
        rl.close();
        console.log('\n❌ 找不到指定机器人，配置未修改。');
        return;
      }
      const confirm = (await ask(
        rl,
        `确认删除 ${botProcessName(result.removed, result.index, PM2_NAME)} (${result.removed.larkAppId})? (y/N): `,
      )).trim().toLowerCase();
      rl.close();
      if (confirm !== 'y' && confirm !== 'yes') {
        console.log('\n已取消，配置未修改。');
        return;
      }

      copyFileSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak`);
      writeBotsJsonAtomic(result.bots);
      console.log(`✅ 已删除机器人 ${botProcessName(result.removed, result.index, PM2_NAME)} (${result.removed.larkAppId})`);
      console.log(`下一步: botmux restart\n`);
      return;
    }

    console.log('\n── 添加新机器人 ──\n');
    const newBot = await promptBotConfig(rl);
    rl.close();
    if (!newBot) {
      console.log('\n⚠️  setup 中止，bots.json 不动。');
      return;
    }
    writeBotsJsonAtomic([...bots, newBot]);
    console.log(`\n✅ 已添加机器人 ${newBot.larkAppId}，共 ${bots.length + 1} 个`);
    console.log(`   配置文件: ${BOTS_JSON_FILE}`);
    printRemainingSteps(newBot.larkAppId, botBrand(newBot));
    console.log(`下一步: botmux restart\n`);

  } else if (hasEnv) {
    // --- Single-bot mode (.env exists) ---
    console.log(`当前使用单机器人配置: ${ENV_FILE}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const action = await ask(rl, '操作: 1) 添加新机器人  2) 覆盖当前配置  (1/2): ');

    if (action === '2') {
      rl.close();
      const ok = await writeSingleBotConfig();
      if (ok) {
        renameSync(ENV_FILE, ENV_FILE + '.bak');
        console.log(`   旧 .env 已备份: ${ENV_FILE}.bak`);
      }
      return;
    }

    // Migrate .env → bots.json
    const existingBot = parseDotEnvToBotConfig();
    if (!existingBot.larkAppId || !existingBot.larkAppSecret) {
      console.log('\n⚠️  当前 .env 缺少 LARK_APP_ID 或 LARK_APP_SECRET，请先完成基础配置');
      rl.close();
      await writeSingleBotConfig();
      return;
    }
    console.log(`\n当前机器人: ${existingBot.larkAppId} (${existingBot.cliId ?? 'claude-code'})`);
    console.log('\n── 添加新机器人 ──\n');
    const newBot = await promptBotConfig(rl);
    rl.close();
    if (!newBot) {
      console.log('\n⚠️  setup 中止，.env 和 bots.json 都不动。');
      return;
    }

    // 写新文件成功后才备份 .env. 失败不动两边.
    writeBotsJsonAtomic([existingBot, newBot]);
    renameSync(ENV_FILE, ENV_FILE + '.bak');
    console.log(`\n✅ 已迁移到多机器人配置`);
    console.log(`   配置文件: ${BOTS_JSON_FILE}`);
    console.log(`   旧配置已备份: ${ENV_FILE}.bak`);
    printRemainingSteps(newBot.larkAppId, botBrand(newBot));
    console.log(`下一步: botmux restart\n`);

  } else {
    // --- Fresh install ---
    await writeSingleBotConfig();
  }
}

/**
 * Pre-flight check for stale Node interpreters.
 *
 * Failure mode: user installs botmux globally under nvm Node vX, later
 * uninstalls that version. The pm2 god daemon may still be alive with a
 * dead execPath (kept in-memory but removed from disk), and this package
 * lives under a node_modules dir whose Node binary no longer exists.
 * Both cases cause `spawn … node ENOENT` loops when pm2 tries to fork
 * the daemon, but the error gets buried in pm2 logs and the user sees
 * silence.
 *
 * Detects two cases and either auto-heals or aborts with a clear message:
 *   1. pm2 god daemon's running binary is deleted → auto `pm2 kill`
 *   2. This package is installed under an nvm Node version that no longer
 *      exists on disk → abort with reinstall instructions
 */
function preflightNodeSanity(): void {
  // Case 1: pm2 god is alive but its Node binary has been deleted.
  const pm2PidFile = join(PM2_HOME, 'pm2.pid');
  if (existsSync(pm2PidFile)) {
    let pm2Pid = 0;
    try { pm2Pid = parseInt(readFileSync(pm2PidFile, 'utf-8').trim(), 10); } catch { /* ignore */ }
    if (pm2Pid) {
      let pm2Alive = false;
      try { process.kill(pm2Pid, 0); pm2Alive = true; } catch { /* not alive */ }
      if (pm2Alive && process.platform === 'linux') {
        // On Linux, /proc/<pid>/exe is a symlink to the running executable.
        // readlink includes a " (deleted)" suffix when the on-disk file is gone.
        try {
          const exe = readlinkSync(`/proc/${pm2Pid}/exe`);
          const cleanPath = exe.replace(/ \(deleted\)$/, '');
          const exeDeleted = exe.endsWith(' (deleted)') || !existsSync(cleanPath);
          if (exeDeleted) {
            console.warn(`⚠️  pm2 god daemon (pid ${pm2Pid}) 使用的 Node 二进制已失效: ${cleanPath}`);
            console.warn(`   自动杀掉 pm2 god 以便用当前 Node 重启...`);
            try {
              execSync(`${pm2Bin()} kill`, { env: pm2Env(), stdio: 'pipe', timeout: 10_000 });
            } catch {
              try { process.kill(pm2Pid, 'SIGKILL'); } catch { /* ignore */ }
            }
          }
        } catch { /* /proc not readable, skip */ }
      }
    }
  }

  // Case 2: botmux installed under a dead nvm Node version.
  const nvmMatch = PKG_ROOT.match(/\/\.nvm\/versions\/node\/([^/]+)\//);
  if (nvmMatch) {
    const installedVersion = nvmMatch[1];
    const installedNodeBin = PKG_ROOT.slice(0, PKG_ROOT.indexOf(installedVersion) + installedVersion.length) + '/bin/node';
    if (!existsSync(installedNodeBin)) {
      console.error(`❌ botmux 安装在 Node ${installedVersion}, 但该 Node 二进制已不存在:`);
      console.error(`     ${installedNodeBin}`);
      console.error(`   daemon 启动后 fork worker 时会报 ENOENT, 无法正常工作。`);
      console.error(``);
      console.error(`   请在当前可用的 Node 下重新全局安装 botmux:`);
      console.error(`     npm i -g botmux`);
      console.error(``);
      console.error(`   验证重装后路径不再指向 ${installedVersion}:`);
      console.error(`     readlink -f $(which botmux)`);
      process.exit(1);
    }
  }
}

async function cmdStart(): Promise<void> {
  if (!hasConfig()) {
    console.error('❌ 未找到配置文件');
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  killDuplicatePm2GodDaemons();
  preflightNodeSanity();
  await ensureSystemDependencies();

  // 启动前快速校验每个 bot 的凭证. Codex review 边界 #5: 凭证无效是
  // 唯一应该阻塞 start 的情况; scope/event 缺失在 daemon 起来后用 WARN
  // + 私信处理 (event-dispatcher.checkRequiredScopes).
  //
  // 失败时打印明确的 appId 前缀和错误码, 不打印 secret, 不 spawn pm2 进程.
  const botsForCheck = loadBotsJson();
  if (botsForCheck.length > 0) {
    const { validateCredentials } = await import('./setup/verify-permissions.js');
    const invalid: Array<{ appId: string; reason: string }> = [];
    for (const b of botsForCheck) {
      if (!b.larkAppId || !b.larkAppSecret) {
        invalid.push({ appId: b.larkAppId || '(空 appId)', reason: 'larkAppId/larkAppSecret 缺失' });
        continue;
      }
      const v = await validateCredentials(b.larkAppId, b.larkAppSecret, botBrand(b));
      if (!v.ok) {
        if (v.error === 'invalid_credentials') {
          invalid.push({ appId: b.larkAppId, reason: v.message });
        } else {
          // network / unknown — 不应该拦下启动, 走 WARN
          console.warn(`⚠️  [${b.larkAppId}] 启动前凭证验证未成功（${v.error}）: ${v.message}`);
          console.warn(`   daemon 仍会启动；启动后 dispatcher 会自行重试。`);
        }
      }
    }
    if (invalid.length > 0) {
      console.error('\n❌ 以下机器人凭证无效，botmux start 中止：\n');
      for (const e of invalid) console.error(`   - ${e.appId}: ${e.reason}`);
      console.error('\n   修复方式: 运行 `botmux setup` 选 "重新配置" 重新走扫码/手动流程。');
      process.exit(1);
    }
  }

  cleanupLegacyPm2();
  const cfg = ecosystemConfig();
  runPm2(['start', cfg]);
  const bots = loadBotsJson();
  const count = bots.length || 1;
  console.log(`\n✅ daemon 已启动${count > 1 ? ` (${count} 个机器人, 每个独立进程)` : ''}`);
  console.log(`   日志: botmux logs`);
  console.log(`   状态: botmux status`);
  // If the user previously enabled autostart, sync the unit file in case
  // node/cli.js paths changed since (nvm switch, npm upgrade, etc.).
  if (refreshAutostart({ pkgRoot: PKG_ROOT, configDir: CONFIG_DIR, logDir: LOG_DIR })) {
    console.log(`   autostart unit 已同步到当前 Node/cli.js 路径`);
  }
}

/**
 * Wipe stale dashboard-daemon descriptors (mtime older than 5 minutes).
 * Live daemons refresh their descriptor every 30s via heartbeat; anything
 * older is from a daemon that exited without cleaning up. Called as part of
 * the pm2 zombie-cleanup flow so the dashboard registry stays consistent.
 */
function cleanupStaleDaemonDescriptors(): void {
  const regDir = join(DATA_DIR, 'dashboard-daemons');
  if (!existsSync(regDir)) return;
  for (const f of readdirSync(regDir)) {
    if (!f.endsWith('.json')) continue;
    const fp = join(regDir, f);
    try {
      const stat = statSync(fp);
      if (Date.now() - stat.mtimeMs > 5 * 60_000) unlinkSync(fp);
    } catch { /* ignore */ }
  }
}

/** Delete all pm2 processes matching botmux / botmux-* under the given PM2_HOME. */
function deleteAllBotmuxProcesses(home: string = PM2_HOME): void {
  try {
    const output = execSync(`${pm2Bin()} jlist`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pm2Env(home),
      timeout: 10_000,
    });
    const apps = JSON.parse(output) as any[];
    for (const app of apps) {
      if (app.name === PM2_NAME || app.name.startsWith(`${PM2_NAME}-`)) {
        try {
          execSync(`${pm2Bin()} delete ${app.name}`, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: pm2Env(home),
            timeout: 10_000,
          });
        } catch { /* */ }
      }
    }
  } catch { /* pm2 not running or no apps */ }
}

/**
 * One-time migration for users upgrading from versions that used the default
 * ~/.pm2 directory. Removes any lingering botmux-* processes registered under
 * the legacy home so the new dedicated PM2_HOME becomes the sole source of
 * truth. Only touches processes named `botmux` or `botmux-*` — the user's
 * unrelated pm2 apps are left untouched. No-op on fresh installs.
 */
function cleanupLegacyPm2(): boolean {
  const legacyHome = join(homedir(), '.pm2');
  if (legacyHome === PM2_HOME) return false;
  const legacyPidFile = join(legacyHome, 'pm2.pid');
  if (!existsSync(legacyPidFile)) return false;

  let legacyPid = 0;
  try { legacyPid = parseInt(readFileSync(legacyPidFile, 'utf-8').trim(), 10); } catch { return false; }
  if (!legacyPid) return false;
  // If the legacy daemon isn't alive anymore there's nothing to clean.
  try { process.kill(legacyPid, 0); } catch { return false; }

  deleteAllBotmuxProcesses(legacyHome);
  return true;
}

function cmdStop(): void {
  killDuplicatePm2GodDaemons();
  cleanupLegacyPm2();
  let stopped = false;
  try {
    const output = execSync(`${pm2Bin()} jlist`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pm2Env(),
      timeout: 10_000,
    });
    const apps = JSON.parse(output) as any[];
    for (const app of apps) {
      if (app.name === PM2_NAME || app.name.startsWith(`${PM2_NAME}-`)) {
        try { runPm2(['stop', app.name]); stopped = true; } catch { /* */ }
      }
    }
  } catch { /* */ }
  // Wipe abandoned dashboard-daemon descriptors left behind by stopped daemons.
  cleanupStaleDaemonDescriptors();
  if (!stopped) console.log('daemon 未在运行。');
}

async function cmdRestart(): Promise<void> {
  if (!hasConfig()) {
    console.error('❌ 未找到配置文件');
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  killDuplicatePm2GodDaemons();
  preflightNodeSanity();
  await ensureSystemDependencies();
  const cfg = ecosystemConfig();
  cleanupLegacyPm2();
  // Delete all botmux processes (handles both old single-process and new multi-process)
  deleteAllBotmuxProcesses();
  // Wipe abandoned dashboard-daemon descriptors left behind by killed daemons.
  cleanupStaleDaemonDescriptors();
  runPm2(['start', cfg]);
  if (refreshAutostart({ pkgRoot: PKG_ROOT, configDir: CONFIG_DIR, logDir: LOG_DIR })) {
    console.log(`autostart unit 已同步到当前 Node/cli.js 路径`);
  }
}

/** Wraps `ensureDependencies()`. Neither tmux nor fonts are load-bearing —
 *  ensureDependencies surfaces failures as warnings and the daemon continues
 *  on PTY backend. Only an unexpected exception (programmer error) propagates. */
async function ensureSystemDependencies(): Promise<void> {
  const { ensureDependencies } = await import('./setup/index.js');
  try {
    await ensureDependencies();
  } catch (err: any) {
    console.error('');
    console.error(`依赖检测内部错误: ${err?.message ?? String(err)}`);
    // Don't exit — let daemon start try anyway; worst case PTY backend works.
  }
}

/**
 * If a legacy ~/.pm2 daemon with botmux processes still exists alongside our
 * new PM2_HOME, warn the user so read-only commands (status/logs) don't
 * silently show an empty new home while the old daemon keeps running.
 */
function warnIfLegacyBotmuxAlive(): void {
  const legacyHome = join(homedir(), '.pm2');
  if (legacyHome === PM2_HOME) return;
  const legacyPidFile = join(legacyHome, 'pm2.pid');
  if (!existsSync(legacyPidFile)) return;
  let legacyPid = 0;
  try { legacyPid = parseInt(readFileSync(legacyPidFile, 'utf-8').trim(), 10); } catch { return; }
  if (!legacyPid) return;
  try { process.kill(legacyPid, 0); } catch { return; }
  try {
    const output = execSync(`${pm2Bin()} jlist`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pm2Env(legacyHome),
      timeout: 10_000,
    });
    const apps = JSON.parse(output) as any[];
    const hasBotmux = apps.some(a => a.name === PM2_NAME || a.name.startsWith(`${PM2_NAME}-`));
    if (hasBotmux) {
      console.warn('⚠️  检测到旧版 PM2_HOME (~/.pm2) 下仍有 botmux 进程,运行 `botmux restart` 完成迁移。\n');
    }
  } catch { /* ignore */ }
}

function cmdLogs(): void {
  killDuplicatePm2GodDaemons();
  warnIfLegacyBotmuxAlive();
  const lines = process.argv.includes('--lines')
    ? process.argv[process.argv.indexOf('--lines') + 1] || '50'
    : '50';

  const bots = loadBotsJson();
  // Support --bot <0-based-index|pm2-name|appId> to filter specific bot logs.
  const botIdx = process.argv.includes('--bot')
    ? process.argv[process.argv.indexOf('--bot') + 1]
    : undefined;

  let target: string;
  if (botIdx !== undefined) {
    const numericIdx = /^\d+$/.test(botIdx) ? Number(botIdx) : undefined;
    const selectedIdx = numericIdx === undefined
      ? parseBotSelection(botIdx, bots)
      : numericIdx >= 0 && numericIdx < bots.length
        ? numericIdx
        : undefined;
    target = selectedIdx !== undefined
      ? botProcessName(bots[selectedIdx], selectedIdx, PM2_NAME)
      : numericIdx !== undefined
        ? `${PM2_NAME}-${botIdx}`
        : botIdx;
  } else {
    // Show all botmux logs via pm2 regex match
    target = `/^${PM2_NAME}/`;
  }

  // Use spawn for streaming output
  const child = spawn(pm2Bin(), ['logs', target, '--lines', lines], {
    stdio: 'inherit',
    env: pm2Env(),
  });
  child.on('exit', code => process.exit(code ?? 0));
}

function cmdStatus(): void {
  killDuplicatePm2GodDaemons();
  warnIfLegacyBotmuxAlive();
  runPm2(['status']);
}

function cmdUpgrade(): void {
  console.log('🔄 升级中...');
  try {
    execSync('npm install -g botmux@latest', { stdio: 'inherit' });
    console.log('\n✅ 升级完成。运行 botmux restart 以应用更新。');
  } catch {
    console.error('❌ 升级失败，请手动运行: npm install -g botmux@latest');
    process.exit(1);
  }
}

/**
 * Print a fresh dashboard URL by HMAC-authing to the dashboard process's
 * loopback rotation endpoint. Each call invalidates the previously-issued
 * token, so sharing a URL is the same as sharing a one-shot session.
 */
async function cmdDashboard(): Promise<void> {
  const SECRET_PATH = join(CONFIG_DIR, '.dashboard-secret');
  if (!existsSync(SECRET_PATH)) {
    console.error('Dashboard not initialised. Run `botmux restart` first.');
    process.exit(1);
  }
  const secret = readFileSync(SECRET_PATH, 'utf8').trim();
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const sig = createHmac('sha256', secret).update(`${ts}:${nonce}`).digest('base64url');
  const port = process.env.BOTMUX_DASHBOARD_PORT ?? '7891';

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/__cli/rotate`, {
      method: 'POST',
      headers: {
        'X-Botmux-Cli-Ts': ts,
        'X-Botmux-Cli-Nonce': nonce,
        'X-Botmux-Cli-Auth': sig,
      },
    });
  } catch {
    console.error(
      `dashboard process not reachable on 127.0.0.1:${port} — \`botmux restart\` will start it`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error('Rotation failed:', res.status, await res.text());
    process.exit(1);
  }
  const body = await res.json() as { url: string };
  console.log(body.url);
}

// ─── Session helpers ──────────────────────────────────────────────────────────

interface SessionData {
  sessionId: string;
  chatId: string;
  chatType?: 'group' | 'p2p';
  rootMessageId: string;
  /** 'thread' (legacy default) → cmdSend uses reply_in_thread to rootMessageId.
   *  'chat' → cmdSend posts a plain message to chatId (普通群整群一个会话). */
  scope?: 'thread' | 'chat';
  title: string;
  status: 'active' | 'closed';
  createdAt: string;
  closedAt?: string;
  pid?: number;
  workingDir?: string;
  webPort?: number;
  larkAppId?: string;
  ownerOpenId?: string;
}

/**
 * Resolve the session data directory.
 * Priority: SESSION_DATA_DIR env > daemon breadcrumb (~/.botmux/.data-dir) > default (~/.botmux/data)
 */
function resolveDataDir(): string {
  if (process.env.SESSION_DATA_DIR) return process.env.SESSION_DATA_DIR;

  // Read breadcrumb written by the daemon at startup
  const breadcrumb = join(CONFIG_DIR, '.data-dir');
  if (existsSync(breadcrumb)) {
    try {
      const dir = readFileSync(breadcrumb, 'utf-8').trim();
      if (dir && existsSync(dir)) {
        // Check for any session file (legacy or per-bot)
        if (existsSync(join(dir, 'sessions.json'))) return dir;
        try {
          const files = readdirSync(dir);
          if (files.some(f => f.startsWith('sessions-') && f.endsWith('.json'))) return dir;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  return DATA_DIR;
}

/** Load sessions from all session files (legacy + per-bot). */
function loadSessions(): Map<string, SessionData> {
  const dataDir = resolveDataDir();
  const sessions = new Map<string, SessionData>();

  // Read legacy sessions.json
  const legacyFp = join(dataDir, 'sessions.json');
  let legacyData: Record<string, SessionData> = {};
  if (existsSync(legacyFp)) {
    try {
      legacyData = JSON.parse(readFileSync(legacyFp, 'utf-8'));
      for (const [, v] of Object.entries(legacyData)) {
        const s = v as SessionData;
        if (s.sessionId) sessions.set(s.sessionId, s);
      }
    } catch { /* ignore */ }
  }

  // Read per-bot session files (sessions-{appId}.json)
  try {
    for (const file of readdirSync(dataDir)) {
      if (file.startsWith('sessions-') && file.endsWith('.json')) {
        try {
          // Extract appId from filename: sessions-{appId}.json
          const appId = file.slice('sessions-'.length, -'.json'.length);
          const data = JSON.parse(readFileSync(join(dataDir, file), 'utf-8'));
          for (const [, v] of Object.entries(data)) {
            const session = v as SessionData;
            if (!session.sessionId) continue;
            // Stamp larkAppId so saveSession writes back to the correct file
            if (!session.larkAppId) session.larkAppId = appId;
            sessions.set(session.sessionId, session);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Migrate: remove sessions from legacy file if they have larkAppId (belong in per-bot files)
  let legacyDirty = false;
  for (const [k, v] of Object.entries(legacyData)) {
    const s = v as SessionData;
    if (s.larkAppId) {
      delete legacyData[k];
      legacyDirty = true;
      // Ensure the session exists in its per-bot file
      const perBotFp = join(dataDir, `sessions-${s.larkAppId}.json`);
      let perBotData: Record<string, SessionData> = {};
      if (existsSync(perBotFp)) {
        try { perBotData = JSON.parse(readFileSync(perBotFp, 'utf-8')); } catch { /* */ }
      }
      // Only write if per-bot file doesn't already have this session
      if (!perBotData[k]) {
        perBotData[k] = s;
        const tmpFp = perBotFp + '.tmp';
        writeFileSync(tmpFp, JSON.stringify(perBotData, null, 2), 'utf-8');
        renameSync(tmpFp, perBotFp);
      }
    }
  }
  if (legacyDirty) {
    const tmpFp = legacyFp + '.tmp';
    writeFileSync(tmpFp, JSON.stringify(legacyData, null, 2), 'utf-8');
    renameSync(tmpFp, legacyFp);
  }

  return sessions;
}

/** Save a single session back to its appropriate file based on larkAppId. */
function saveSession(session: SessionData): void {
  const dataDir = resolveDataDir();
  const fileName = session.larkAppId ? `sessions-${session.larkAppId}.json` : 'sessions.json';
  const fp = join(dataDir, fileName);

  // Read current file, update session, write back
  let data: Record<string, SessionData> = {};
  if (existsSync(fp)) {
    try { data = JSON.parse(readFileSync(fp, 'utf-8')); } catch { /* start fresh */ }
  }
  data[session.sessionId] = session;

  // Clean up entries where file key doesn't match the entry's sessionId (data corruption)
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === 'object' && 'sessionId' in val && (val as SessionData).sessionId !== key) {
      delete data[key];
    }
  }

  const tmpFp = fp + '.tmp';
  writeFileSync(tmpFp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpFp, fp);

  // Remove duplicate from legacy file if session moved to per-bot file (or vice versa)
  const otherFile = session.larkAppId ? 'sessions.json' : null;
  if (otherFile) {
    const otherFp = join(dataDir, otherFile);
    if (existsSync(otherFp)) {
      try {
        const otherData: Record<string, SessionData> = JSON.parse(readFileSync(otherFp, 'utf-8'));
        if (otherData[session.sessionId]) {
          delete otherData[session.sessionId];
          const otherTmp = otherFp + '.tmp';
          writeFileSync(otherTmp, JSON.stringify(otherData, null, 2), 'utf-8');
          renameSync(otherTmp, otherFp);
        }
      } catch { /* ignore */ }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

/** Get display width of a string, accounting for CJK double-width characters. */
function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    // CJK Unified Ideographs, CJK Compatibility, Fullwidth forms, Hangul, Kana, etc.
    if (
      (code >= 0x1100 && code <= 0x115f) ||   // Hangul Jamo
      (code >= 0x2e80 && code <= 0x303e) ||   // CJK Radicals, Kangxi, CJK Symbols
      (code >= 0x3040 && code <= 0x33bf) ||   // Hiragana, Katakana, Bopomofo, CJK Compat
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Unified Ext A
      (code >= 0x4e00 && code <= 0xa4cf) ||   // CJK Unified, Yi
      (code >= 0xac00 && code <= 0xd7af) ||   // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) ||   // CJK Compat Ideographs
      (code >= 0xfe30 && code <= 0xfe6f) ||   // CJK Compat Forms
      (code >= 0xff01 && code <= 0xff60) ||   // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) ||   // Fullwidth Signs
      (code >= 0x20000 && code <= 0x2fa1f)    // CJK Unified Ext B-F, Compat Supplement
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Truncate string to fit within maxWidth display columns, append '…' if truncated. */
function truncate(str: string, maxWidth: number): string {
  let width = 0;
  let i = 0;
  const chars = [...str];
  for (; i < chars.length; i++) {
    const cw = displayWidth(chars[i]);
    if (width + cw > maxWidth - 1) {  // reserve 1 col for '…'
      return chars.slice(0, i).join('') + '…';
    }
    width += cw;
  }
  return str;
}

/** Pad string to exact display width with trailing spaces. */
function padEndDisplay(str: string, targetWidth: number): string {
  const w = displayWidth(str);
  return w >= targetWidth ? str : str + ' '.repeat(targetWidth - w);
}

/** Load bot configs for display (best effort — returns empty array on failure) */
function loadBotConfigsForDisplay(): Array<{ larkAppId: string; cliId?: string }> {
  if (existsSync(BOTS_JSON_FILE)) {
    try { return JSON.parse(readFileSync(BOTS_JSON_FILE, 'utf-8')); } catch { /* ignore */ }
  }
  return [];
}


/** Format a single session row for display (used by both plain table and TUI). */
function formatSessionRow(
  s: SessionData,
  multiBot: boolean,
  botLabels: Map<string, string>,
  cols: { id: number; bot?: number; title: number; dir: number; pid: number; uptime: number; status: number },
): { text: string; alive: boolean } {
  const id = padEndDisplay(s.sessionId.substring(0, 8), cols.id);
  const parts = [id];
  if (multiBot) {
    const label = s.larkAppId ? (botLabels.get(s.larkAppId) ?? s.larkAppId.substring(0, 18)) : '-';
    parts.push(padEndDisplay(truncate(label, cols.bot!), cols.bot!));
  }
  const title = padEndDisplay(truncate((s.title || '(untitled)').replace(/[\r\n]+/g, ' '), cols.title), cols.title);
  const dir = padEndDisplay(truncate(s.workingDir || '-', cols.dir), cols.dir);
  const pid = s.pid ? String(s.pid).padEnd(cols.pid) : '-'.padEnd(cols.pid);
  const uptime = formatDuration(Date.now() - new Date(s.createdAt).getTime()).padEnd(cols.uptime);
  const alive = !!(s.pid && isProcessAlive(s.pid));
  const status = (alive ? 'online' : s.pid ? 'stopped' : 'idle').padEnd(cols.status);
  parts.push(title, dir, pid, uptime, status);
  return { text: parts.join(' │ '), alive };
}

/** Print plain session table (non-interactive). */
function printSessionTable(active: SessionData[]): void {
  const botConfigs = loadBotConfigsForDisplay();
  const multiBot = botConfigs.length > 1 || new Set(active.map(s => s.larkAppId).filter(Boolean)).size > 1;
  const botLabels = new Map<string, string>();
  for (let i = 0; i < botConfigs.length; i++) {
    const b = botConfigs[i];
    botLabels.set(b.larkAppId, `bot${i + 1} (${b.cliId ?? 'claude-code'})`);
  }

  const cols = { id: 10, ...(multiBot ? { bot: 22 } : {}), title: 28, dir: 28, pid: 8, uptime: 8, status: 8 };

  const headerParts = ['id'.padEnd(cols.id)];
  if (multiBot) headerParts.push('bot'.padEnd(cols.bot!));
  headerParts.push(
    'title'.padEnd(cols.title),
    'working dir'.padEnd(cols.dir),
    'pid'.padEnd(cols.pid),
    'uptime'.padEnd(cols.uptime),
    'status'.padEnd(cols.status),
  );
  const header = headerParts.join(' │ ');
  const separator = '─'.repeat(displayWidth(header));

  console.log(separator);
  console.log(header);
  console.log(separator);

  for (const s of active) {
    const { text } = formatSessionRow(s, multiBot, botLabels, cols);
    console.log(text);
  }

  console.log(separator);
  console.log(`共 ${active.length} 个活跃会话`);
}

/** Check if a tmux session exists. */
function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${name} 2>/dev/null`, { stdio: 'ignore', env: tmuxEnv() });
    return true;
  } catch {
    return false;
  }
}

/** Shorten path for display: replace $HOME with ~. */
function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Interactive TUI session picker — returns a promise that resolves when done. */
function interactiveSessionPicker(active: SessionData[]): Promise<void> {
  const botConfigs = loadBotConfigsForDisplay();
  const multiBot = botConfigs.length > 1 || new Set(active.map(s => s.larkAppId).filter(Boolean)).size > 1;
  const botLabels = new Map<string, string>();
  for (let i = 0; i < botConfigs.length; i++) {
    const b = botConfigs[i];
    botLabels.set(b.larkAppId, `bot${i + 1} (${b.cliId ?? 'claude-code'})`);
  }

  // Responsive column widths based on terminal width
  const termWidth = process.stdout.columns || 100;
  const PREFIX = 4;    // "  ❯ " or "    "
  const SEP_W = 3;     // " │ "
  const fixedCols = { id: 10, pid: 8, uptime: 7, status: 7 };
  const botW = multiBot ? 18 : 0;
  const numSeps = (multiBot ? 7 : 6) - 1;  // separators between columns
  const fixedTotal = PREFIX + fixedCols.id + botW + fixedCols.pid + fixedCols.uptime + fixedCols.status + numSeps * SEP_W;
  const flexTotal = Math.max(20, termWidth - fixedTotal);
  const titleW = Math.floor(flexTotal * 0.4);
  const dirW = flexTotal - titleW;

  const cols = {
    id: fixedCols.id,
    ...(multiBot ? { bot: botW } : {}),
    title: titleW,
    dir: dirW,
    pid: fixedCols.pid,
    uptime: fixedCols.uptime,
    status: fixedCols.status,
  };

  // Build row data — use shortened paths for TUI
  function buildRows(): Array<{ session: SessionData; text: string; alive: boolean; tmuxName: string; hasTmux: boolean }> {
    return active.map(s => {
      // Build row text with shortened dir
      const id = padEndDisplay(s.sessionId.substring(0, 8), cols.id);
      const parts = [id];
      if (multiBot) {
        const label = s.larkAppId ? (botLabels.get(s.larkAppId) ?? s.larkAppId.substring(0, 16)) : '-';
        parts.push(padEndDisplay(truncate(label, cols.bot!), cols.bot!));
      }
      const title = padEndDisplay(truncate((s.title || '(untitled)').replace(/[\r\n]+/g, ' '), cols.title), cols.title);
      const dir = padEndDisplay(truncate(shortenPath(s.workingDir || '-'), cols.dir), cols.dir);
      const pid = s.pid ? String(s.pid).padEnd(cols.pid) : '-'.padEnd(cols.pid);
      const uptime = formatDuration(Date.now() - new Date(s.createdAt).getTime()).padEnd(cols.uptime);
      const alive = !!(s.pid && isProcessAlive(s.pid));
      const status = (alive ? 'online' : s.pid ? 'stopped' : 'idle').padEnd(cols.status);
      parts.push(title, dir, pid, uptime, status);

      const tmuxName = `bmx-${s.sessionId.substring(0, 8)}`;
      const hasTmux = tmuxSessionExists(tmuxName);
      return { session: s, text: parts.join(' │ '), alive, tmuxName, hasTmux };
    });
  }

  let rows = buildRows();

  // Build header (same column layout as rows, no extra prefix in join)
  function buildHeader(): string {
    const hParts = ['id'.padEnd(cols.id)];
    if (multiBot) hParts.push('bot'.padEnd(cols.bot!));
    hParts.push(
      'title'.padEnd(cols.title),
      'working dir'.padEnd(cols.dir),
      'pid'.padEnd(cols.pid),
      'uptime'.padEnd(cols.uptime),
      'status'.padEnd(cols.status),
    );
    return hParts.join(' │ ');
  }

  const header = buildHeader();
  const separator = '─'.repeat(displayWidth(header));

  let cursor = 0;
  let confirmDelete = false;  // true when waiting for y/n confirmation
  let flashMsg = '';

  function render(): void {
    process.stdout.write('\x1b[H\x1b[J');

    process.stdout.write(`\x1b[1m botmux sessions\x1b[0m  \x1b[2m(${rows.length})\x1b[0m\n\n`);

    // Header + separator — use same 4-char prefix as rows
    process.stdout.write(`    ${separator}\n`);
    process.stdout.write(`    \x1b[2m${header}\x1b[0m\n`);
    process.stdout.write(`    ${separator}\n`);

    if (rows.length === 0) {
      process.stdout.write(`\n    \x1b[2m没有活跃会话\x1b[0m\n`);
      process.stdout.write(`    ${separator}\n`);
      process.stdout.write(`\n  \x1b[2mq 退出\x1b[0m\n`);
      return;
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const pointer = i === cursor ? '\x1b[36m❯\x1b[0m' : ' ';
      if (i === cursor) {
        process.stdout.write(`  ${pointer} \x1b[7m${r.text}\x1b[0m\n`);
      } else {
        process.stdout.write(`  ${pointer} ${r.text}\n`);
      }
    }

    process.stdout.write(`    ${separator}\n`);

    // Footer info
    const selected = rows[cursor];
    const tmuxHint = selected.hasTmux
      ? `\x1b[32mtmux: ${selected.tmuxName}\x1b[0m`
      : `\x1b[2mtmux: 无会话\x1b[0m`;
    process.stdout.write(`\n  ${tmuxHint}\n`);

    // Flash message or confirmation prompt
    if (confirmDelete) {
      const s = selected.session;
      process.stdout.write(`\n  \x1b[33m确认删除 ${s.sessionId.substring(0, 8)} "${truncate(s.title || '', 20)}"? (y/n)\x1b[0m\n`);
    } else if (flashMsg) {
      process.stdout.write(`\n  ${flashMsg}\n`);
    } else {
      process.stdout.write('\n');
    }

    // Keybinding hints
    process.stdout.write(`\n  \x1b[2m↑/↓ 选择  ⏎ 连接  d 删除  q 退出\x1b[0m\n`);
  }

  return new Promise<void>((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    process.stdout.write('\x1b[?25l');   // hide cursor
    process.stdout.write('\x1b[?1049h'); // alt screen

    render();

    function cleanup(): void {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');   // show cursor
      process.stdout.write('\x1b[?1049l'); // leave alt screen
    }

    function deleteSession(idx: number): void {
      const r = rows[idx];
      const s = r.session;

      // Kill CLI process
      if (s.pid && isProcessAlive(s.pid)) {
        killProcess(s.pid);
      }

      // Kill tmux session
      if (r.hasTmux) {
        try { execSync(`tmux kill-session -t '${r.tmuxName}' 2>/dev/null`, { stdio: 'ignore', env: tmuxEnv() }); } catch { /* */ }
      }

      // Mark closed & persist
      s.status = 'closed';
      s.closedAt = new Date().toISOString();
      saveSession(s);

      // Remove from active list and TUI rows
      const activeIdx = active.indexOf(s);
      if (activeIdx >= 0) active.splice(activeIdx, 1);
      rows.splice(idx, 1);

      if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
      flashMsg = `\x1b[32m✓ 已删除 ${s.sessionId.substring(0, 8)}\x1b[0m`;
    }

    process.stdin.on('data', (key: string) => {
      // Delete confirmation mode
      if (confirmDelete) {
        confirmDelete = false;
        if (key === 'y' || key === 'Y') {
          deleteSession(cursor);
        } else {
          flashMsg = '\x1b[2m取消删除\x1b[0m';
        }
        render();
        return;
      }

      flashMsg = '';

      // Ctrl-C or q or Esc
      if (key === '\x03' || key === 'q' || key === '\x1b') {
        cleanup();
        resolve();
        return;
      }

      if (rows.length === 0) {
        // No sessions left, only q works
        render();
        return;
      }

      // Arrow up or k
      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + rows.length) % rows.length;
        render();
        return;
      }

      // Arrow down or j
      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % rows.length;
        render();
        return;
      }

      // d or x — delete session
      if (key === 'd' || key === 'x') {
        confirmDelete = true;
        render();
        return;
      }

      // Enter — attach to tmux
      if (key === '\r' || key === '\n') {
        const selected = rows[cursor];
        if (!selected.hasTmux) {
          flashMsg = '\x1b[33m该会话没有 tmux，无法连接\x1b[0m';
          render();
          return;
        }
        cleanup();
        spawnSync('tmux', ['attach-session', '-t', selected.tmuxName], {
          stdio: 'inherit',
          env: tmuxEnv(),
        });
        resolve();
        return;
      }
    });
  });
}

async function cmdList(): Promise<void> {
  const sessions = loadSessions();
  const active = [...sessions.values()].filter(s => s.status === 'active');

  // Auto-prune unrecoverable sessions: process dead and no tmux session
  const pruned: SessionData[] = [];
  const live: SessionData[] = [];
  for (const s of active) {
    const hasPid = !!(s.pid && isProcessAlive(s.pid));
    const hasTmux = tmuxSessionExists(`bmx-${s.sessionId.substring(0, 8)}`);
    if (!hasPid && !hasTmux) {
      pruned.push(s);
    } else {
      live.push(s);
    }
  }
  if (pruned.length > 0) {
    for (const s of pruned) {
      s.status = 'closed';
      s.closedAt = new Date().toISOString();
      saveSession(s);
    }
    console.log(`已自动清理 ${pruned.length} 个不可恢复的会话（进程已死且无 tmux session）`);
  }

  // Sort by creation time, newest first
  live.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (live.length === 0) {
    console.log('没有活跃会话。');
    return;
  }

  // Non-TTY (piped output) or explicit --plain flag: plain table
  if (!process.stdout.isTTY || process.argv.includes('--plain')) {
    printSessionTable(live);
    return;
  }

  // Interactive TUI
  await interactiveSessionPicker(live);
}

function cmdDelete(): void {
  const target = process.argv[3];
  if (!target) {
    console.error('用法: botmux delete <session-id|all>');
    process.exit(1);
  }

  const sessions = loadSessions();
  const active = [...sessions.values()].filter(s => s.status === 'active');

  if (active.length === 0) {
    console.log('没有活跃会话。');
    return;
  }

  let toDelete: SessionData[];

  if (target === 'all') {
    toDelete = active;
  } else if (target === 'stopped') {
    toDelete = active.filter(s => {
      const hasPid = !!(s.pid && isProcessAlive(s.pid));
      const hasTmux = tmuxSessionExists(`bmx-${s.sessionId.substring(0, 8)}`);
      return !hasPid && !hasTmux;
    });
    if (toDelete.length === 0) {
      console.log('没有 stopped 状态的会话。');
      return;
    }
  } else {
    // Match by session ID prefix
    toDelete = active.filter(s => s.sessionId.startsWith(target));
    if (toDelete.length === 0) {
      console.error(`❌ 未找到匹配 "${target}" 的活跃会话`);
      console.error('   使用 botmux list 查看所有会话');
      process.exit(1);
    }
    if (toDelete.length > 1) {
      console.error(`❌ "${target}" 匹配了 ${toDelete.length} 个会话，请提供更长的 ID 前缀：`);
      for (const s of toDelete) {
        console.error(`   ${s.sessionId.substring(0, 8)}  ${s.title}`);
      }
      process.exit(1);
    }
  }

  for (const s of toDelete) {
    // Kill CLI process if running
    if (s.pid && isProcessAlive(s.pid)) {
      killProcess(s.pid);
      console.log(`  killed pid ${s.pid}`);
    }

    // Kill associated tmux session if it exists
    const tmuxName = `bmx-${s.sessionId.substring(0, 8)}`;
    try {
      execSync(`tmux kill-session -t '${tmuxName}' 2>/dev/null`, { stdio: 'ignore', env: tmuxEnv() });
      console.log(`  killed tmux ${tmuxName}`);
    } catch { /* no tmux session */ }

    // Mark session as closed
    s.status = 'closed';
    s.closedAt = new Date().toISOString();
    saveSession(s);
    console.log(`✓ ${s.sessionId.substring(0, 8)} ${s.title}`);
  }
  console.log(`\n已关闭 ${toDelete.length} 个会话`);
}

/**
 * Discover online daemons. Mirrors the staleness rule used by
 * dashboard/registry.ts (90s heartbeat) so we don't try to talk to a daemon
 * that's been dead but left a stale descriptor behind. Uses resolveDataDir()
 * so SESSION_DATA_DIR / breadcrumb-overridden deployments find the right
 * descriptor directory.
 */
function listOnlineDaemons(): Array<{ ipcPort: number; larkAppId: string; lastHeartbeat?: number }> {
  const regDir = join(resolveDataDir(), 'dashboard-daemons');
  if (!existsSync(regDir)) return [];
  const STALE_MS = 90_000;
  const now = Date.now();
  const all: Array<{ ipcPort: number; larkAppId: string; lastHeartbeat?: number }> = [];
  let names: string[] = [];
  try { names = readdirSync(regDir); } catch { return []; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(regDir, f), 'utf-8'));
      if (typeof d?.ipcPort !== 'number' || typeof d?.larkAppId !== 'string') continue;
      if (now - (d.lastHeartbeat ?? 0) > STALE_MS) continue;
      all.push({ ipcPort: d.ipcPort, larkAppId: d.larkAppId, lastHeartbeat: d.lastHeartbeat });
    } catch { /* skip malformed */ }
  }
  return all;
}

function findDaemon(larkAppId?: string): { ipcPort: number; larkAppId: string } | null {
  const all = listOnlineDaemons();
  if (larkAppId) return all.find(d => d.larkAppId === larkAppId) ?? null;
  return all[0] ?? null;
}

async function cmdResume(): Promise<void> {
  const target = process.argv[3];
  if (!target) {
    console.error('用法: botmux resume <session-id|prefix>');
    console.error('  通过 botmux list 查看活跃会话；resume 仅适用于 status=closed 的会话');
    process.exit(1);
  }

  const sessions = loadSessions();
  const closed = [...sessions.values()].filter(s => s.status === 'closed');
  if (closed.length === 0) {
    console.error('没有已关闭的会话可恢复。');
    process.exit(1);
  }
  const matches = closed.filter(s => s.sessionId.startsWith(target));
  if (matches.length === 0) {
    console.error(`❌ 未找到匹配 "${target}" 的已关闭会话`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`❌ "${target}" 匹配了 ${matches.length} 个会话，请提供更长的 ID 前缀：`);
    for (const s of matches) {
      console.error(`   ${s.sessionId.substring(0, 12)}  ${s.title}`);
    }
    process.exit(1);
  }
  const session = matches[0];

  // Legacy sessions persisted before per-bot files lack larkAppId. Rather
  // than silently routing to "the first online daemon" — which can land on
  // the wrong bot in multi-bot setups and corrupt state — refuse and tell
  // the user what's missing. Single-bot setups still work (we resolve to
  // that lone daemon below).
  if (!session.larkAppId) {
    const online = listOnlineDaemons();
    if (online.length > 1) {
      console.error(`❌ 会话 ${session.sessionId.substring(0, 12)} 缺少 larkAppId，多 bot 部署下无法判定归属。`);
      console.error('   解决办法：手动给该 session 补 larkAppId 后重试，或使用对应 bot 的话题里 ▶️ 恢复会话 按钮。');
      console.error(`   在线 daemon (${online.length}): ${online.map(d => d.larkAppId).join(', ')}`);
      process.exit(1);
    }
    if (online.length === 0) {
      console.error('❌ 没有在线 daemon。请先：botmux start');
      process.exit(1);
    }
    // Single online daemon — safe to use
  }

  const daemon = findDaemon(session.larkAppId);
  if (!daemon) {
    const hint = session.larkAppId
      ? `未找到 daemon (larkAppId=${session.larkAppId})`
      : '未找到任何在线 daemon';
    console.error(`❌ ${hint}。请确认 daemon 正在运行：botmux status`);
    process.exit(1);
  }

  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${daemon.ipcPort}/api/sessions/${encodeURIComponent(session.sessionId)}/resume`,
      { method: 'POST' },
    );
  } catch (err: any) {
    console.error(`❌ 无法连接到 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
    process.exit(1);
  }
  let body: any = {};
  try { body = await res.json(); } catch { /* */ }
  if (res.ok && body?.ok) {
    console.log(`✅ 会话已恢复: ${session.sessionId.substring(0, 12)}  ${session.title}`);
    if (body.workingDir) console.log(`   工作目录: ${body.workingDir}`);
    console.log('   下一条消息会以 --resume 拉起 CLI；已在原话题留通知。');
    return;
  }
  const errCode = body?.error ?? `HTTP ${res.status}`;
  if (errCode === 'anchor_occupied') {
    const occ = body?.activeSessionId ? ` (占用者: ${body.activeSessionId.substring(0, 12)})` : '';
    console.error(`❌ 当前话题已有新的活跃会话${occ}，无法 resume 旧会话。`);
  } else if (errCode === 'not_closed') {
    console.error('❌ 会话当前不是 closed 状态，无需 resume。');
  } else if (errCode === 'not_found') {
    console.error('❌ daemon 中找不到该会话（可能已被清理）。');
  } else if (errCode === 'adopt_unsupported') {
    console.error('❌ adopt 接管会话不支持 resume。');
  } else {
    console.error(`❌ 恢复失败: ${errCode}`);
  }
  process.exit(1);
}

function showHelp(): void {
  console.log(`
botmux v${getVersion()} — IM ↔ AI 编程 CLI 桥接

命令:
  setup       交互式配置（首次使用 / 添加机器人）
  start       启动 daemon
  stop        停止 daemon
  restart     重启 daemon（自动恢复活跃会话）
  logs        查看 daemon 日志（--lines N, --bot <0-based-index|pm2-name|appId>）
  status      查看 daemon 状态
  upgrade     升级到最新版本
  dashboard   打印新的 Web Dashboard 一次性登录 URL（旧 token 同时失效）
  list        列出活跃会话（交互式选择并连接 tmux）
              --plain  纯文本表格输出（管道/脚本场景）
  delete <id>      关闭指定会话（支持 ID 前缀匹配）
  delete all       关闭所有活跃会话
  delete stopped   清理所有进程已退出的僵尸会话
  resume <id>      恢复一个已关闭的会话（支持 ID 前缀匹配）— 会话标记回 active，
                   下条消息会以 --resume 重新拉起 CLI 进程
  autostart enable     注册开机自启（macOS launchd / Linux user systemd，无需 sudo）
  autostart disable    注销开机自启
  autostart status     查看自启状态
  lang [zh|en]         切换 UI 语言（无参 = 查看当前设置）
       --bot N         仅改 bots.json 中第 N 个 bot 的 lang
       --unset         清除（global 或 --bot N 配合）

定时任务（可在 CLI 会话内自动推断 chat）:
  schedule list                        列出所有任务
  schedule add <schedule> <prompt>     添加任务（ex: "30m" / "every 2h" / "每日9:00" / "0 9 * * *"）
  schedule remove <id>                 删除任务
  schedule pause|resume <id>           暂停/恢复
  schedule run <id>                    标记立即执行

飞书消息（在 CLI 会话内自动推断 session）:
  send [content]                       发消息到当前话题（支持 stdin / --content-file）
       --images <path>                 内联图片（可重复）
       --files <path>                  附件（可重复）
       --mention <open_id:name>        @提及（可重复）
       --card | --text                 强制卡片 / 纯文本（默认按 md 语法自动判断）
       --top-level                     发顶层消息（不回复进当前话题）
       --chat-id <oc_xxx>              指定目标群（默认当前话题所在群）
  bots list                            列出当前群聊中的机器人（含 open_id）
  history [--limit N] [--scope session|thread|chat|ambient]
                                       拉取当前会话的消息历史 (JSON)。默认按 session scope：话题/话题群 → 话题内，普通群 → 整群；
                                       thread 会话里可用 --scope ambient 读取 thread 外的群聊上下文
  quoted <message_id>                  拉取被引用的单条消息 (JSON)，message_id 取自 daemon 注入的引用提示行

新建飞书群:
  create-group --bot <name> [--bot ...] [--name "群名"]
                                       用指定 bot 起新群；详见 \`botmux create-group --help\`

配置目录: ~/.botmux/
文档: https://github.com/deepcoldy/botmux
`);
}

// ─── Schedule subcommands ────────────────────────────────────────────────────

/**
 * Walk the process tree looking for a CLI-pid marker written by the botmux
 * worker. Returns the sessionId stored in the marker (or '' if empty/legacy).
 *
 * This mirrors server.ts:findAncestorCliMarker but is local to cli.ts so
 * subcommands invoked from inside an agent session can auto-detect which
 * session they belong to.
 */
function findAncestorSessionId(): string | null {
  const dataDir = resolveDataDir();
  const markersDir = join(dataDir, '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      try { return readFileSync(markerPath, 'utf-8').trim(); } catch { return ''; }
    }
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      pid = parseInt(out, 10);
      if (isNaN(pid)) break;
    } catch { break; }
  }
  return null;
}

interface CurrentSession {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  workingDir?: string;
  larkAppId?: string;
  chatType?: 'group' | 'p2p';
}

/** Detect current session info from ancestor marker + session files. */
function detectCurrentSession(): CurrentSession | null {
  const sid = findAncestorSessionId();
  if (!sid) return null;
  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) return null;
  return {
    sessionId: s.sessionId,
    chatId: s.chatId,
    rootMessageId: s.rootMessageId,
    workingDir: s.workingDir,
    larkAppId: s.larkAppId,
    chatType: s.chatType,
  };
}

/** Pick a value from --flag <value> or --flag=value style args. */
function argValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const f of flags) {
      if (a === f && i + 1 < args.length) return args[i + 1];
      if (a.startsWith(f + '=')) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

function argFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Extract positional args, skipping --flag and the value that follows it
 *  (for --flag <value> style).  --flag=value style is self-contained.
 *  `booleanFlags` lists flags that take no value — without this hint the
 *  parser swallows the *next* arg as the flag's value, which silently eats
 *  positional content (or, worse, a following --flag's value). */
function positionals(args: string[], booleanFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const flagName = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      const isBoolean = booleanFlags.includes(flagName);
      if (!a.includes('=') && !isBoolean && i + 1 < args.length) i++; // skip value
      continue;
    }
    out.push(a);
  }
  return out;
}

async function cmdSchedule(sub: string, rest: string[]): Promise<void> {
  // Ensure SESSION_DATA_DIR points at the daemon's data dir so schedule-store
  // writes to the right file even when invoked outside the daemon env.
  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  const scheduler = await import('./core/scheduler.js');
  const scheduleStore = await import('./services/schedule-store.js');

  if (!sub || sub === 'list' || sub === 'ls') {
    const tasks = scheduleStore.listTasks();
    if (tasks.length === 0) {
      console.log('暂无定时任务。\n\n用法:\n  botmux schedule add "每日17:50" "帮我看AI新闻"\n  botmux schedule add "every 2h" "检查构建"\n  botmux schedule add "0 9 * * *" "每天早安"');
      return;
    }
    const filter = argValue(rest, '--chat-id');
    const filtered = filter ? tasks.filter(t => t.chatId === filter) : tasks;
    console.log(`定时任务 (${filtered.length}${filter ? '/' + tasks.length : ''}):\n`);
    for (const t of filtered) {
      const status = t.enabled ? '✅' : '⏸️';
      const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
      const last = t.lastRunAt ? new Date(t.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
      const display = t.parsed?.display ?? t.schedule;
      const prompt = t.prompt ?? '';
      const chatId = t.chatId ?? '—';
      const rootId = t.rootMessageId ?? '—';
      console.log(`${status} [${t.id}] ${display} | ${t.name}`);
      console.log(`   prompt: ${prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt}`);
      console.log(`   chat: ${chatId.slice(0, 12)}…   thread: ${rootId.slice(0, 16)}…`);
      console.log(`   next: ${next}   last: ${last}${t.lastStatus === 'error' ? ' ❌' : ''}`);
      console.log('');
    }
    return;
  }

  if (sub === 'add') {
    const [rawSchedule, ...promptParts] = positionals(rest);
    if (!rawSchedule) {
      console.error('用法: botmux schedule add <schedule> <prompt> [--name NAME] [--chat-id CHAT] [--root-msg-id ROOT] [--lark-app-id APP] [--workdir DIR]');
      process.exit(1);
    }
    // prompt may come from positional or --prompt flag
    const promptArg = argValue(rest, '--prompt') ?? promptParts.join(' ');
    if (!promptArg) {
      console.error('缺少 prompt。用法: botmux schedule add <schedule> <prompt>');
      process.exit(1);
    }

    const cur = detectCurrentSession();
    const chatId = argValue(rest, '--chat-id') ?? cur?.chatId;
    const rootMessageId = argValue(rest, '--root-msg-id') ?? cur?.rootMessageId;
    const larkAppId = argValue(rest, '--lark-app-id') ?? cur?.larkAppId;
    const workingDir = argValue(rest, '--workdir') ?? cur?.workingDir ?? process.cwd();
    const name = argValue(rest, '--name') ?? (promptArg.length > 20 ? promptArg.slice(0, 20) + '…' : promptArg);
    const deliver = (argValue(rest, '--deliver') as 'origin' | 'local' | undefined) ?? 'origin';

    if (!chatId) {
      console.error('无法推断 chat-id。请加上 --chat-id <CHAT_ID>，或从 Lark 话题内的 CLI 会话中运行本命令。');
      process.exit(1);
    }

    let parsed;
    try { parsed = scheduler.parseSchedule(rawSchedule); }
    catch (err: any) {
      console.error(`无法解析 schedule "${rawSchedule}": ${err.message}`);
      process.exit(1);
    }

    const task = scheduler.addTask({
      name,
      schedule: rawSchedule,
      parsed,
      prompt: promptArg,
      workingDir,
      chatId,
      rootMessageId,
      larkAppId,
      creatorChatId: cur?.chatId,
      creatorRootMessageId: cur?.rootMessageId,
      creatorLarkAppId: cur?.larkAppId,
      chatType: cur?.chatType === 'p2p' ? 'p2p' : 'topic_group',
      deliver,
    });

    const next = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
    console.log(`✅ 已创建定时任务 [${task.id}] ${task.name}`);
    console.log(`   规则: ${parsed.display}`);
    console.log(`   下次执行: ${next}`);
    console.log(`   工作目录: ${workingDir}`);
    console.log(`   话题: ${rootMessageId ?? '(将新开)'}`);
    return;
  }

  const id = positionals(rest)[0];
  if (!id) {
    console.error(`用法: botmux schedule ${sub} <id>`);
    process.exit(1);
  }

  switch (sub) {
    case 'remove':
    case 'rm':
    case 'delete':
    case 'del':
      if (scheduler.removeTask(id)) console.log(`已删除任务 ${id}`);
      else { console.error(`未找到任务 ${id}`); process.exit(1); }
      break;
    case 'pause':
    case 'disable':
      if (scheduler.disableTask(id)) console.log(`已暂停任务 ${id}`);
      else { console.error(`未找到任务 ${id}`); process.exit(1); }
      break;
    case 'resume':
    case 'enable':
      if (scheduler.enableTask(id)) console.log(`已恢复任务 ${id}`);
      else { console.error(`未找到任务 ${id}`); process.exit(1); }
      break;
    case 'run':
      // Running requires the daemon (executeCallback is daemon-side).
      // CLI can only mark a task to run ASAP; daemon's next tick picks it up.
      {
        const task = scheduleStore.getTask(id);
        if (!task) { console.error(`未找到任务 ${id}`); process.exit(1); }
        scheduleStore.updateTask(id, { nextRunAt: new Date().toISOString() });
        console.log(`已标记任务 ${id} 下次 tick 立即执行（< 30s）`);
      }
      break;
    default:
      console.error(`未知子命令: ${sub}\n可用: list | add | remove | pause | resume | run`);
      process.exit(1);
  }
}

/** Resolve a CLI subcommand's larkAppId by walking the session marker. Common
 *  prelude for `history` / `quoted` / similar commands that need to talk to
 *  Lark on behalf of the session that spawned them. Exits with stderr on
 *  failure so callers can stay focused on the happy path. */
async function resolveSessionAppId(sessionIdArg: string | undefined): Promise<{ sid: string; larkAppId: string; session: SessionData }> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题/群里的 CLI 会话中运行，或传 --session-id <id>。');
    process.exit(1);
  }
  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) {
    console.error(`未找到 session ${sid}`);
    process.exit(1);
  }
  if (!s.larkAppId) {
    console.error(`session ${sid} 缺少 larkAppId，无法获取消息`);
    process.exit(1);
  }
  // Ensure bot is registered so getBotClient works
  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  try {
    for (const cfg of loadBotConfigs()) registerBot(cfg);
  } catch { /* ignore */ }
  return { sid, larkAppId: s.larkAppId, session: s };
}

async function cmdHistory(rest: string[]): Promise<void> {
  const limit = parseInt(argValue(rest, '--limit') ?? '50', 10);
  const scopeArg = argValue(rest, '--scope') ?? 'session';
  const sessionIdArg = argValue(rest, '--session-id');
  const { sid, larkAppId: appId, session: s } = await resolveSessionAppId(sessionIdArg);

  const validScopes = new Set(['session', 'thread', 'chat', 'ambient']);
  if (!validScopes.has(scopeArg)) {
    console.error(`无效 --scope: ${scopeArg}。可用: session | thread | chat | ambient`);
    process.exit(1);
  }

  const { getMessageDetail, listAmbientChatMessages, listThreadMessages, listChatMessages } = await import('./im/lark/client.js');
  const { parseApiMessage, cardContentHasUpgradeFallback, resolveMergedCardContent } = await import('./im/lark/message-parser.js');
  const { expandMergeForward } = await import('./im/lark/merge-forward.js');
  try {
    // Chat-scope sessions (普通群整群一会话) have no thread to walk — list the
    // chat container directly and let the caller cap with --limit. Thread-scope
    // sessions walk the thread container by root_id. `--scope chat|ambient`
    // lets a thread-scope session intentionally read outside its thread when
    // it needs the surrounding group conversation (for example `/t` spawned
    // from an ongoing 普通群 discussion).
    const isChatScope = s.scope === 'chat';
    const effectiveScope = scopeArg === 'session'
      ? (isChatScope ? 'chat' : 'thread')
      : scopeArg;

    if (effectiveScope === 'thread' && isChatScope) {
      console.error('当前 session 是 chat-scope，没有 thread 历史可读取。请使用 --scope chat。');
      process.exit(1);
    }

    if (effectiveScope === 'ambient' && isChatScope) {
      console.error('当前 session 是 chat-scope，没有 thread root 可作为 ambient 边界。请使用 --scope chat。');
      process.exit(1);
    }

    let ambientBeforeCreateTime: string | undefined;
    if (effectiveScope === 'ambient') {
      try {
        const detail = await getMessageDetail(appId, s.rootMessageId, { userCardContent: false });
        ambientBeforeCreateTime = detail?.items?.[0]?.create_time;
      } catch {
        // Best-effort only: ambient history should still work if the root
        // message was withdrawn or is otherwise unavailable; it will then fall
        // back to the chat tail with current-thread messages filtered out.
      }
    }

    const raw = effectiveScope === 'chat'
      ? await listChatMessages(appId, s.chatId, limit)
      : effectiveScope === 'ambient'
        ? await listAmbientChatMessages(appId, s.chatId, limit, {
            beforeCreateTime: ambientBeforeCreateTime,
            excludeRootMessageId: s.rootMessageId,
          })
        : await listThreadMessages(appId, s.chatId, s.rootMessageId, limit);
    // Expand merge_forward to <forwarded_messages> XML, mirroring the live event
    // path in daemon.ts. Each merge_forward gets its own numberer (we don't
    // download resources here — only [图片 N] placeholders matter).
    const messages = await Promise.all(raw.map(async (m: any) => {
      let parsed = parseApiMessage(m);
      // `im.v1.message.list` returns Lark's simplified "请升级客户端" fallback for
      // complex cards — the whole body (user-forwarded) or nested sub-cards
      // buried mid-body (Argos alarms). Those are the cards where the list view
      // alone is incomplete, so resolve them by unioning both `im.message.get`
      // representations (server-rendered + full structured). Failures keep the
      // list text. Simple cards (no fallback) already render fully here.
      if (parsed.msgType === 'interactive' && cardContentHasUpgradeFallback(parsed.content)) {
        const merged = await resolveMergedCardContent(appId, parsed.messageId).catch(() => null);
        if (merged) parsed.content = merged.text;
      }
      if (parsed.msgType === 'merge_forward') {
        await expandMergeForward(appId, parsed.messageId, parsed);
      }
      return parsed;
    }));
    console.log(JSON.stringify({
      sessionId: sid,
      chatId: s.chatId,
      scope: effectiveScope,
      sessionScope: isChatScope ? 'chat' : 'thread',
      ...(isChatScope ? {} : { rootMessageId: s.rootMessageId }),
      ...(effectiveScope === 'ambient' ? {
        ambient: {
          source: 'chat',
          beforeCreateTime: ambientBeforeCreateTime,
          excludeRootMessageId: s.rootMessageId,
        },
      } : {}),
      messages,
      total: messages.length,
    }, null, 2));
  } catch (err: any) {
    console.error(`获取消息失败: ${err.message}`);
    process.exit(1);
  }
}


async function cmdQuoted(rest: string[]): Promise<void> {
  const sessionIdArg = argValue(rest, '--session-id');
  // Positional message_id is required. The id comes verbatim from the
  // `[用户引用了消息 用 botmux quoted om_xxx 查看]` prompt prefix the daemon
  // injects when the user used the Lark quote-reply UI. Skip --session-id and
  // its value so `botmux quoted --session-id <uuid> om_xxx` doesn't pick up
  // the uuid as the message id.
  const messageId = firstPositional(rest, ['--session-id']);
  if (!messageId) {
    console.error('用法: botmux quoted <message_id> [--session-id <id>]');
    process.exit(1);
  }

  const { larkAppId: appId } = await resolveSessionAppId(sessionIdArg);

  const { getMessageDetail } = await import('./im/lark/client.js');
  const { expandMergeForward } = await import('./im/lark/merge-forward.js');
  const { renderQuotedMessage } = await import('./cli/quoted-render.js');
  const { resolveMergedCardContent } = await import('./im/lark/message-parser.js');
  try {
    const detail = await getMessageDetail(appId, messageId);
    const msg = detail?.items?.[0];
    if (!msg) {
      console.error(`未找到消息 ${messageId}`);
      process.exit(1);
    }
    const rendered = await renderQuotedMessage(appId, msg, expandMergeForward);
    // Interactive cards: union both im.message.get representations so the quoted
    // view matches history/live (recovers names + sub-card content + options).
    // This single-message path always merges — unlike history (which starts
    // from the hole-bearing list view), the quoted base is the hole-free B view
    // so there's no cheap local signal that a merge would add anything.
    if (rendered.msgType === 'interactive') {
      const merged = await resolveMergedCardContent(appId, messageId).catch(() => null);
      if (merged) rendered.content = merged.text;
    }
    console.log(JSON.stringify(rendered, null, 2));
  } catch (err: any) {
    console.error(`获取被引用消息失败: ${err.message}`);
    process.exit(1);
  }
}

// ─── Send subcommand ─────────────────────────────────────────────────────────

/** Read all of stdin until EOF. Returns '' if stdin is a TTY (no piped data). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/** Collect all values for a repeatable flag: --flag v1 --flag v2 */
function argValues(args: string[], ...flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    for (const f of flags) {
      if (args[i] === f && i + 1 < args.length) { out.push(args[++i]); break; }
      if (args[i].startsWith(f + '=')) { out.push(args[i].slice(f.length + 1)); break; }
    }
  }
  return out;
}

// Card v2 body builder helpers — extracted to im/lark/md-card.ts so the
// daemon's bridge fallback path can produce identical cards. cmdSend
// keeps using `buildCardBodyElements` and `hasMarkdown` from there.
import { buildCardBodyElements, hasMarkdown } from './im/lark/md-card.js';

/**
 * Decide who the reply card should @ in its footer.
 *
 * Non-oncall chats: `发送给: @<owner>`.
 * Oncall chats: `发送给: @<last caller>` (falls back to owner if unknown) —
 *   permission is governed by allowedUsers, so there's no per-chat list to cc.
 */
function buildFooterAddressing(
  s: { ownerOpenId?: string; lastCallerOpenId?: string },
  oncall: { workingDir: string } | undefined,
): { sendTo: string | undefined; cc: string[] } {
  const owner = s.ownerOpenId;
  const caller = s.lastCallerOpenId ?? owner;
  if (!oncall) return { sendTo: owner, cc: [] };
  return { sendTo: caller, cc: [] };
}

async function cmdSend(rest: string[]): Promise<void> {
  // Safety gate: a CLI agent running inside a workflow subagent (Slice F)
  // must not chat-post directly — chat-facing side effects are reserved
  // for `hostExecutor` activities so they can be tracked via
  // `effectAttempted` + reconciled across retries / resumes.  Refuse loud
  // so the agent (and any human reviewing logs) sees the boundary.
  if (process.env.BOTMUX_WORKFLOW === '1') {
    const runId = process.env.BOTMUX_WORKFLOW_RUN_ID ?? '?';
    const nodeId = process.env.BOTMUX_WORKFLOW_NODE_ID ?? '?';
    console.error(
      `botmux send refused inside workflow subagent (run=${runId} node=${nodeId}).\n` +
      `Workflow subagents must return structured output via the WORKFLOW_OUTPUT marker;\n` +
      `chat-facing side effects belong in a hostExecutor activity, not a subagent.`,
    );
    process.exit(2);
  }
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sessionIdArg = argValue(rest, '--session-id');
  const images = argValues(rest, '--image', '--images');
  const files = argValues(rest, '--file', '--files');
  const mentionArgs = argValues(rest, '--mention');  // "open_id:Display Name"
  const contentFile = argValue(rest, '--content-file');
  const forceCard = rest.includes('--card');
  const forceText = rest.includes('--text');
  // Publish-mode flags: post a fresh top-level message in a chat instead of
  // replying into the bound thread. Lets a session "publish" to a different
  // chat (e.g. a public release-notes group) while keeping its own thread
  // for streaming-card / progress UI.
  const sendTopLevel = rest.includes('--top-level');
  const overrideChatId = argValue(rest, '--chat-id');

  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题内的 CLI 会话中运行，或传 --session-id <id>。');
    process.exit(1);
  }

  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) { console.error(`未找到 session ${sid}`); process.exit(1); }
  if (!s.larkAppId) { console.error(`session ${sid} 缺少 larkAppId`); process.exit(1); }

  // Read content from: --content-file > positional arg > stdin
  let content = '';
  if (contentFile) {
    if (!existsSync(contentFile)) { console.error(`文件不存在: ${contentFile}`); process.exit(1); }
    content = readFileSync(contentFile, 'utf-8');
  } else {
    const pos = positionals(rest, ['--card', '--text', '--top-level']);
    if (pos.length > 0) {
      content = pos.join(' ');
    } else {
      content = await readStdin();
    }
  }

  if (!content.trim() && images.length === 0 && files.length === 0) {
    console.error('没有内容可发送。用法:\n  echo "消息" | botmux send\n  botmux send "消息"\n  botmux send --content-file /tmp/msg.md --images /tmp/chart.png');
    process.exit(1);
  }

  // Parse mentions: "open_id:Display Name" or bare "open_id"
  // Bare form appends a trailing <at id=...> to the message and still writes
  // a bot-mention signal — useful when the sender doesn't know the target's
  // display name or just wants to notify without inline substitution.
  const mentions: Array<{ open_id: string; name: string }> = [];
  for (const m of mentionArgs) {
    const idx = m.indexOf(':');
    if (idx > 0) {
      mentions.push({ open_id: m.slice(0, idx), name: m.slice(idx + 1) });
    } else if (m.trim()) {
      mentions.push({ open_id: m.trim(), name: '' });
    }
  }

  // Validate file paths
  for (const p of [...images, ...files]) {
    if (!existsSync(p)) { console.error(`文件不存在: ${p}`); process.exit(1); }
  }

  // Register bots so Lark client works
  const { registerBot, loadBotConfigs, findOncallChatForAnyBot } = await import('./bot-registry.js');
  try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }

  const { sendMessage, replyMessage, uploadImage, uploadFile } = await import('./im/lark/client.js');
  const appId = s.larkAppId!;
  // Effective target chat for top-level mode (defaults to session's chat)
  const targetChatId = overrideChatId ?? s.chatId;
  // Chat-scope sessions (普通群整群一会话) post to chatId without
  // reply_in_thread, otherwise Lark would force every reply into a fresh
  // topic — defeating the whole point of chat-scope routing.
  const isChatScope = s.scope === 'chat';
  // Oncall addressing only meaningful for replies inside the session's own
  // chat — skip when publishing top-level or to a different chat. Treat
  // oncall as chat-level: in multi-daemon setups this session's bot may not
  // be the one that persisted the binding, but users still expect footer
  // addressing to go to the last caller in the shared oncall workspace.
  const oncallEntry = !sendTopLevel && !overrideChatId && s.chatId
    ? findOncallChatForAnyBot(s.chatId) : undefined;
  // Dispatch helper: top-level / chat-scope send vs reply-in-thread, single decision point
  const dispatch = (content: string, msgType: string): Promise<string> =>
    (sendTopLevel || isChatScope)
      ? sendMessage(appId, targetChatId, content, msgType)
      : replyMessage(appId, s.rootMessageId, content, msgType, true);

  try {
    // Upload images in parallel
    const imageKeys: string[] = [];
    if (images.length > 0) {
      const results = await Promise.all(images.map(p => uploadImage(appId, p)));
      imageKeys.push(...results);
    }

    // Try to extract plain text if Claude accidentally sent post JSON as content
    let text = content;
    try {
      const parsed = JSON.parse(text);
      const inner = parsed.zh_cn ?? parsed.en_us ?? parsed;
      if (Array.isArray(inner?.content)) {
        const lines: string[] = [];
        for (const para of inner.content) {
          if (!Array.isArray(para)) continue;
          lines.push(para.filter((n: any) => n.tag === 'text').map((n: any) => n.text).join(''));
        }
        text = lines.join('\n').trim();
      }
    } catch { /* not JSON, use as-is */ }

    // Auto-detect @BotName in text and inject as mentions, using the sender
    // app's cross-ref file for per-app-scoped open_ids. Without this, a plain
    // "@Claude" in text only triggers IPC routing but Lark UI shows it as
    // plain text — confusing the user who thinks the @ didn't fire.
    //
    // bot-to-bot @mention 两条触发入口（显式 --mention / 正文 `@BotName`）都
    // 落到下方的 mentions 数组，单 source of truth：让 Lark 在消息里渲染
    // 真正的 @at 元素。对方 bot 的 daemon 通过 WSClient 原生事件接到（依赖
    // "获取群组中其他机器人和用户@当前机器人的消息"权限），不再走任何本地
    // 转发——botmux 历史上为绕过 Lark 不投递跨 bot 事件搞过 signal-file，
    // 那套已经在该权限上线后整体下线。
    try {
      const dataDir = resolveDataDir();
      const botInfoPath = join(dataDir, 'bots-info.json');
      type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
      const botEntries: BotInfoEntry[] = existsSync(botInfoPath) ? JSON.parse(readFileSync(botInfoPath, 'utf-8')) : [];
      const crossRefPath = join(dataDir, `bot-openids-${appId}.json`);
      const crossRef: Record<string, string> = existsSync(crossRefPath)
        ? JSON.parse(readFileSync(crossRefPath, 'utf-8'))
        : {};
      const alreadyMentioned = new Set(mentions.map(m => m.open_id));
      // Sort by name length desc so longer names ("Claude分身") win over their
      // prefix ("Claude") when both could match — break-on-first-hit otherwise
      // routes "@Claude分身" to Claude.
      const sortedEntries = [...botEntries].sort(
        (a, b) => (b.botName?.length ?? 0) - (a.botName?.length ?? 0),
      );
      for (const entry of sortedEntries) {
        if (!entry.botName || entry.larkAppId === appId) continue;
        const names = [entry.botName, entry.cliId].filter(Boolean) as string[];
        for (const name of names) {
          const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Boundary: lookbehind blocks only ASCII word chars (so `user@Claude`
          // is rejected but `看看@CoCo` is accepted — CJK prefix is normal in
          // Chinese text). Lookahead blocks any Unicode letter/digit so
          // `@Claude2` doesn't match name "Claude" and `@Claude分身好的` doesn't
          // either-half-match.
          const re = new RegExp(`(?<![A-Za-z0-9_])@${escName}(?![\\p{L}\\p{N}_])`, 'iu');
          if (!re.test(text)) continue;
          // Lark open_id is per-app scoped. Use sender-scoped id from cross-ref
          // only — falling back to entry.botOpenId would feed Lark a wrong-scope
          // id (target's self-scoped) and the API would reject it. Skip + warn
          // so the missing cross-ref is observable instead of silently dropped.
          const senderScopedId = crossRef[entry.botName];
          if (!senderScopedId) {
            console.error(`[botmux send] no cross-ref entry for "${entry.botName}" in app ${appId}, skipping auto-mention (cross-ref populates after the sender app first sees the target bot)`);
            break;
          }
          if (alreadyMentioned.has(senderScopedId)) break;
          mentions.push({ open_id: senderScopedId, name: entry.botName });
          alreadyMentioned.add(senderScopedId);
          break;
        }
      }
    } catch { /* best-effort */ }

    // Decide: interactive card (renders markdown) vs. post (plain text).
    // Explicit --card / --text wins; otherwise auto-detect markdown syntax.
    const useCard = forceCard || (!forceText && hasMarkdown(text));

    const mentionMap = new Map<string, string>();
    for (const m of mentions) if (m.name) mentionMap.set(m.name.toLowerCase(), m.open_id);
    const namedMentions = mentions.filter(m => m.name);
    const mentionPattern = namedMentions.length > 0
      ? new RegExp(`@(${namedMentions.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')
      : null;

    // Capture sentAtMs BEFORE dispatch — the worker's bridge fallback gates
    // on `sentAtMs ∈ [turn.markTimeMs, nextTurn.markTimeMs)`. If we recorded
    // it after dispatch (which can take seconds), a slow Lark RTT could push
    // this send's timestamp past the next turn's mark and falsely suppress
    // that turn's fallback emit. Pre-dispatch timestamp captures the moment
    // we committed to sending — that's the boundary the gate cares about.
    const sentAtMs = Date.now();
    let messageId: string;
    if (useCard) {
      // Inline @mention → <at id=open_id></at>; explicit --mention args that
      // weren't inlined are appended to the body. The session owner is
      // rendered in the footer note instead of the body.
      const usedIds = new Set<string>();
      let md = text;
      if (mentionPattern) {
        md = text.replace(mentionPattern, (full: string, name: string) => {
          const openId = mentionMap.get(name.toLowerCase());
          if (!openId) return full;
          usedIds.add(openId);
          return `<at id=${openId}></at>`;
        });
      }
      const trailingAts: string[] = [];
      for (const m of mentions) if (!usedIds.has(m.open_id)) trailingAts.push(`<at id=${m.open_id}></at>`);
      if (trailingAts.length > 0) md = md ? `${md}\n\n${trailingAts.join(' ')}` : trailingAts.join(' ');

      // Inline images into the markdown via ![](img_key). If caller used an
      // `![alt](img:N)` placeholder, substitute by 0-based index; any remaining
      // images get appended at the end so they flow with the text.
      let mdWithImages = md;
      const usedImgIdx = new Set<number>();
      if (imageKeys.length > 0) {
        mdWithImages = mdWithImages.replace(/!\[([^\]]*)\]\(img:(\d+)\)/g, (full, alt: string, idxStr: string) => {
          const idx = Number(idxStr);
          if (idx < 0 || idx >= imageKeys.length) return full;
          usedImgIdx.add(idx);
          return `![${alt}](${imageKeys[idx]})`;
        });
        const trailing = imageKeys
          .map((k, i) => (usedImgIdx.has(i) ? '' : `![](${k})`))
          .filter(Boolean)
          .join('\n\n');
        if (trailing) mdWithImages = mdWithImages ? `${mdWithImages}\n\n${trailing}` : trailing;
      }

      const elements = mdWithImages ? buildCardBodyElements(mdWithImages) : [];

      // Footer: de-emphasized markdown (v2 dropped the `note` tag). Use small
      // text size + grey font tag so it reads like a footnote below the hr.
      // Oncall groups: `发送给` targets whoever triggered this turn (may not
      // be the session owner). Non-oncall: keep owner-only behaviour.
      const footerParts = ['[botmux](https://github.com/deepcoldy/botmux)'];
      // Top-level publish has no specific recipient — drop "发送给/cc" addressing
      // so the message doesn't @ the session owner who isn't even in the target chat.
      const addressing = sendTopLevel
        ? { sendTo: undefined as string | undefined, cc: [] as string[] }
        : buildFooterAddressing(s, oncallEntry);
      if (addressing.sendTo) footerParts.push(`发送给：<at id=${addressing.sendTo}></at>`);
      if (addressing.cc.length > 0) {
        footerParts.push(`cc：${addressing.cc.map(id => `<at id=${id}></at>`).join(' ')}`);
      }
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        text_size: 'notation_small_v2',
        content: `<font color='grey'>${footerParts.join(' · ')}</font>`,
      });

      const cardJson = JSON.stringify({
        schema: '2.0',
        config: { update_multi: true },
        body: { direction: 'vertical', elements },
      });
      messageId = await dispatch(cardJson, 'interactive');
    } else {
      // Plain-text path: build post content, paragraph per line.
      const postContent: any[][] = text ? text.split('\n').map((line: string) => {
        if (!mentionPattern) return [{ tag: 'text', text: line }];
        const nodes: any[] = [];
        let lastIndex = 0;
        for (const match of line.matchAll(mentionPattern)) {
          const openId = mentionMap.get(match[1].toLowerCase());
          if (!openId) continue;
          if (match.index > lastIndex) nodes.push({ tag: 'text', text: line.slice(lastIndex, match.index) });
          nodes.push({ tag: 'at', user_id: openId });
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < line.length) nodes.push({ tag: 'text', text: line.slice(lastIndex) });
        return nodes.length > 0 ? nodes : [{ tag: 'text', text: line }];
      }) : [];

      for (const key of imageKeys) postContent.push([{ tag: 'img', image_key: key }]);

      if (mentions.length > 0) {
        const usedIds = new Set<string>();
        for (const para of postContent) for (const n of para) if (n.tag === 'at') usedIds.add(n.user_id);
        const unused = mentions.filter(m => !usedIds.has(m.open_id));
        if (unused.length > 0) {
          if (postContent.length === 0) postContent.push([]);
          for (const m of unused) postContent[postContent.length - 1].push({ tag: 'at', user_id: m.open_id });
        }
      }

      // Footer: mirror the card layout — a blank paragraph separates the body
      // from the addressing line(s). `发送给: @<caller>` always. Top-level
      // publish has no specific recipient — skip addressing entirely.
      const addressing = sendTopLevel
        ? { sendTo: undefined as string | undefined, cc: [] as string[] }
        : buildFooterAddressing(s, oncallEntry);
      if (addressing.sendTo || addressing.cc.length > 0) {
        if (postContent.length > 0) postContent.push([{ tag: 'text', text: '' }]);
        if (addressing.sendTo) {
          postContent.push([{ tag: 'text', text: '发送给：' }, { tag: 'at', user_id: addressing.sendTo }]);
        }
        if (addressing.cc.length > 0) {
          postContent.push([{ tag: 'text', text: 'cc：' }, ...addressing.cc.map(id => ({ tag: 'at', user_id: id }))]);
        }
      }

      const postJson = JSON.stringify({ zh_cn: { title: '', content: postContent } });
      messageId = await dispatch(postJson, 'post');
    }

    // Bridge fallback marker — append-only jsonl per session. The worker
    // gates its non-adopt transcript-driven fallback on whether any send
    // happened within the current Lark turn's window. Only when this send
    // landed in the session's own thread (not --top-level, not --chat-id
    // override) does it cancel that turn's fallback.
    if (!sendTopLevel && !overrideChatId) {
      try {
        const markerDir = join(resolveDataDir(), 'turn-sends');
        if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
        // sentAtMs was captured pre-dispatch (see above). messageId is the
        // confirmed Lark message id from the now-successful dispatch.
        const line = JSON.stringify({ sentAtMs, messageId }) + '\n';
        appendFileSync(join(markerDir, `${sid}.jsonl`), line);
      } catch { /* best-effort: marker miss only causes a redundant fallback message */ }
    }

    // Send file attachments as separate messages
    const fileIds: string[] = [];
    for (const fp of files) {
      const fileKey = await uploadFile(appId, fp);
      const fid = await dispatch(JSON.stringify({ file_key: fileKey }), 'file');
      fileIds.push(fid);
    }

    // Bot-to-bot 转发依赖飞书"获取群组中其他机器人和用户@当前机器人的消息"权限：
    // 目标 bot 的 daemon 现在能从 WSClient 原生收到 sender_type='app' 的事件，
    // 不需要 botmux 自己再写本地 signal 文件做转发。outgoing 消息里 @BotName /
    // --mention 的 open_id 解析（在上方 mentions 数组里完成）仍然必要，它让
    // Lark 在消息里渲染真正的 @at 元素，从而触发对方 bot 的 WS 事件投递。

    console.log(JSON.stringify({ success: true, messageId, sessionId: sid }));
  } catch (err: any) {
    console.error(`发送失败: ${err.message}`);
    process.exit(1);
  }
}

// ─── Create-group subcommand ─────────────────────────────────────────────────

async function cmdCreateGroup(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`
botmux create-group — 用一组机器人新建飞书群

用法:
  botmux create-group --bot <name|larkAppId> [--bot ...] [--name "群名"]
                      [--working-dir <path>]

参数:
  --bot <ref>     至少一个，可多次。ref 推荐用 bot 显示名（同 botmux send 的 @<name>）或完整 larkAppId；
                  cliId（如 claude-code）仅作 fallback —— 多个 bot 常共用同一个 cliId，重名命中只能取
                  bots.json 中第一个。重名 → 取 bots.json 中第一个匹配，stderr 打 warning。
                  重复 ref → 自动去重保留首次顺序。
  --name <群名>   可选；不传则用飞书默认无名群。
  --working-dir <path>
                 可选；创建成功后，把新群为所有成功入群的 bot 绑定到该目录（等价于逐个 /oncall bind），
                 下次在群里开新话题时直接使用该目录，跳过仓库选择卡片。也可写作 --cwd / --dir。

行为:
  - 第一个解析到的 bot 作为 creator（决定建群身份 + 初始群主 + open_id app scope）。
  - 邀请用户 / 转让群主 / @通知 对象都从 creator 的 resolvedAllowedUsers 取首个 open_id（email 自动转换；
    转不出来或为空则跳过对应步骤，stderr warning）。
  - 不依赖 botmux 会话，任何环境都能跑。
  - --working-dir 会先校验路径存在且是目录；绑定失败不会重复建群，会在 stderr 给出逐 bot 结果。

输出协议（skill 友好）:
  - 成功（即使 transfer/notify 部分失败）：stdout 单行 chatId，exit 0；stderr 打人类提示 + applink。
  - 失败（缺 --bot / 解析失败 / chat.create 抛错）：stdout 空，exit 非零；stderr 打错误。
`);
    return;
  }

  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  const botRefs = argValues(rest, '--bot');
  const name = argValue(rest, '--name');
  const workingDirArg = argValue(rest, '--working-dir', '--cwd', '--dir');

  let bindWorkingDir: string | undefined;
  let bindWorkingDirResolved: string | undefined;
  if (workingDirArg !== undefined) {
    const trimmed = workingDirArg.trim();
    if (!trimmed) {
      console.error('--working-dir 不能为空。');
      process.exit(1);
    }
    const validation = validateWorkingDir(trimmed);
    if (!validation.ok) {
      console.error(`--working-dir ${validation.error}`);
      process.exit(1);
    }
    // Keep the user's spelling in bots.json, matching `/oncall bind`, while
    // still showing the resolved path in CLI output for typo diagnostics.
    bindWorkingDir = trimmed;
    bindWorkingDirResolved = validation.resolvedPath;
  }

  if (botRefs.length === 0) {
    console.error('用法: botmux create-group --bot <name|larkAppId> [--bot ...] [--name "群名"]');
    console.error('至少传一个 --bot。');
    process.exit(1);
  }

  // Load bot configs (bots.json order) and bots-info.json (for botName)
  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  let botConfigs: Array<{ larkAppId: string; cliId: string }>;
  try {
    botConfigs = loadBotConfigs().map(c => ({ larkAppId: c.larkAppId, cliId: c.cliId }));
  } catch (err: any) {
    console.error(`加载 bots.json 失败: ${err?.message ?? err}`);
    process.exit(1);
  }
  const dataDir = resolveDataDir();
  const botInfoPath = join(dataDir, 'bots-info.json');
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let botInfoEntries: BotInfoEntry[] = [];
  try { if (existsSync(botInfoPath)) botInfoEntries = JSON.parse(readFileSync(botInfoPath, 'utf-8')); } catch { /* */ }

  const { resolveBotRefs } = await import('./cli/create-group-resolver.js');
  const resolved = resolveBotRefs(
    botRefs,
    botConfigs,
    botInfoEntries.map(b => ({ larkAppId: b.larkAppId, botName: b.botName })),
  );

  for (const w of resolved.ambiguousWarnings) console.error(`⚠️  ${w}`);
  if (resolved.invalid.length > 0) {
    console.error(`无法解析的 --bot 引用: ${resolved.invalid.join(', ')}`);
    console.error('可用 bot：');
    for (const cfg of botConfigs) {
      const info = botInfoEntries.find(b => b.larkAppId === cfg.larkAppId);
      console.error(`  - ${info?.botName ?? '(unnamed)'}  cliId=${cfg.cliId}  ${cfg.larkAppId}`);
    }
    process.exit(1);
  }
  if (resolved.larkAppIds.length === 0) {
    console.error('未解析到任何 bot，请检查 --bot 引用。');
    process.exit(1);
  }

  const creatorLarkAppId = resolved.larkAppIds[0];

  // Register bots so getBotClient works inside service
  const fullConfigs = loadBotConfigs();
  const needed = new Set(resolved.larkAppIds);
  try {
    for (const cfg of fullConfigs) if (needed.has(cfg.larkAppId)) registerBot(cfg);
  } catch (err: any) {
    console.error(`注册 bot 失败: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Derive user_open_id from creator's allowedUsers (creator app scope only).
  // resolveAllowedUsers converts emails → open_ids via creator's Lark client.
  const creatorCfg = fullConfigs.find(c => c.larkAppId === creatorLarkAppId);
  const allowedRaw = creatorCfg?.allowedUsers ?? [];
  const { resolveAllowedUsers } = await import('./im/lark/client.js');
  let creatorAllowedOpenIds: string[] = [];
  try {
    creatorAllowedOpenIds = await resolveAllowedUsers(creatorLarkAppId, allowedRaw);
  } catch (err: any) {
    console.error(`⚠️  解析 creator allowedUsers 失败: ${err?.message ?? err}（继续创建空群）`);
  }
  const targetOpenId = creatorAllowedOpenIds[0];
  if (!targetOpenId) {
    console.error('⚠️  creator bot 的 allowedUsers 没有可用 open_id — 将创建仅含 bot 的群（跳过邀请/转让/@通知）。');
  }

  const { createGroupWithBots } = await import('./services/group-creator.js');
  let result;
  try {
    result = await createGroupWithBots({
      creatorLarkAppId,
      larkAppIds: resolved.larkAppIds,
      name: name?.trim() || undefined,
      userOpenIds: targetOpenId ? [targetOpenId] : [],
      transferOwnerTo: targetOpenId,
      notifyOwnerOpenId: targetOpenId,
      bindWorkingDir,
    });
  } catch (err: any) {
    console.error(`建群失败: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Always stdout chatId on createChat success — even if transfer/notify
  // partially failed, the chat exists and retrying would create duplicates.
  process.stdout.write(`${result.chatId}\n`);

  // Human-readable summary + warnings → stderr.
  const link = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(result.chatId)}`;
  console.error(`✅ 群已创建：${link}`);
  if (result.invalidBotIds.length > 0) {
    console.error(`⚠️  飞书拒绝邀请的 bot: ${result.invalidBotIds.join(', ')}`);
  }
  if (result.invalidUserIds.length > 0) {
    console.error(`⚠️  飞书拒绝邀请的 user: ${result.invalidUserIds.join(', ')}`);
  }
  if (result.transferError) {
    console.error(`⚠️  群主转让失败 (${result.transferError}) — 当前群主仍为 creator bot`);
  } else if (result.ownerTransferredTo) {
    console.error(`✅ 群主已转让给 ${result.ownerTransferredTo}`);
  }
  if (result.notifyError) {
    console.error(`⚠️  @通知发送失败: ${result.notifyError}`);
  } else if (result.notifyMessageId) {
    console.error(`✅ @通知已发送 (msg ${result.notifyMessageId})`);
  }
  if (bindWorkingDir) {
    const ok = result.oncallBindings.filter(b => b.ok).length;
    const failed = result.oncallBindings.filter(b => !b.ok);
    console.error(`✅ oncall 绑定目录：${bindWorkingDir} → ${bindWorkingDirResolved}（成功 ${ok}/${result.oncallBindings.length}）`);
    for (const b of failed) {
      console.error(`⚠️  ${b.larkAppId} 绑定失败: ${b.error ?? 'unknown'}`);
    }
  }
}

// ─── Bots subcommand ─────────────────────────────────────────────────────────

async function cmdBots(sub: string, rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  if (sub !== 'list' && sub !== 'ls' && sub !== '') {
    console.error('用法: botmux bots list [--session-id ID]');
    process.exit(1);
  }

  const sessionIdArg = argValue(rest, '--session-id');
  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题内的 CLI 会话中运行，或传 --session-id <id>。');
    process.exit(1);
  }

  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) { console.error(`未找到 session ${sid}`); process.exit(1); }
  if (!s.larkAppId) { console.error(`session ${sid} 缺少 larkAppId`); process.exit(1); }

  // Register bots
  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }

  const appId = s.larkAppId!;
  const dataDir = resolveDataDir();
  const botInfoPath = join(dataDir, 'bots-info.json');

  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let botEntries: BotInfoEntry[] = [];
  try { if (existsSync(botInfoPath)) botEntries = JSON.parse(readFileSync(botInfoPath, 'utf-8')); } catch { /* */ }

  try {
    const { listChatBotMembers } = await import('./im/lark/client.js');
    const chatBots = await listChatBotMembers(appId, s.chatId);
    // source: 'configured' = registered in local bots.json (managed by some
    // botmux daemon on this host). 'introduce' = discovered via /introduce
    // collaboration command (external bot, possibly other-tenant). isSelf is
    // retained (not filtered) so the model can still identify itself when needed.
    const result = formatChatBotsForCli(chatBots, appId);
    console.log(JSON.stringify({ sessionId: sid, chatId: s.chatId, bots: result, total: result.length }, null, 2));
  } catch (err: any) {
    // Fallback to bots-info.json
    const result = formatBotInfoEntriesForCli(botEntries, appId);
    console.log(JSON.stringify({ sessionId: sid, bots: result, total: result.length, note: `chat query failed: ${err.message}` }, null, 2));
  }
}

// ─── botmux lang ─────────────────────────────────────────────────────────────

/**
 * `botmux lang [zh|en] [--bot N] [--unset]`
 *
 * No arg → print effective locale + per-bot overrides.
 * `zh|en` → write global `~/.botmux/config.json` (or, with `--bot N`, write
 *   the per-bot `lang` field in `bots.json`).
 * `--unset` → clear the global config's `lang` (or, with `--bot N`, drop
 *   the per-bot override).
 *
 * On any write, hint the user to `botmux restart` so live daemons pick it up.
 */
function cmdLang(args: string[]): void {
  ensureConfigDir();
  const cfg = readGlobalConfig();
  const globalLang: Locale | undefined = cfg.lang;

  const botFlagIdx = args.indexOf('--bot');
  const botFlag = botFlagIdx >= 0 ? parseInt(args[botFlagIdx + 1] ?? '', 10) : NaN;
  const unset = args.includes('--unset');
  const positional = args.filter((a, i) => {
    if (a === '--bot') return false;
    if (i > 0 && args[i - 1] === '--bot') return false;
    if (a === '--unset') return false;
    return true;
  });
  const target = positional[0]?.toLowerCase();

  // No-arg → status
  if (!target && !unset) {
    const bots = loadBotsJson();
    const effective = globalLang ?? 'zh';
    console.log(`Global lang: ${globalLang ?? '(unset, defaults to zh)'}`);
    console.log(`Effective for CLI:    ${effective}`);
    console.log(`Config file:          ${globalConfigPath()}`);
    if (bots.length > 0) {
      console.log('\nPer-bot:');
      bots.forEach((b: any, i: number) => {
        const explicit: string | undefined = isLocale(b.lang) ? b.lang : undefined;
        const eff = explicit ?? effective;
        const tag = explicit ? `${explicit} (explicit override)` : `${eff} (inherits global)`;
        console.log(`  ${i}. ${b.larkAppId} → ${tag}`);
      });
    }
    return;
  }

  // Per-bot operations require an existing bots.json index.
  if (!isNaN(botFlag)) {
    const bots = loadBotsJson();
    if (botFlag < 0 || botFlag >= bots.length) {
      console.error(`--bot index out of range; bots.json has ${bots.length} entry(ies). Use \`botmux lang\` to see indices.`);
      process.exit(1);
    }
    if (unset) {
      delete bots[botFlag].lang;
      writeBotsJsonAtomic(bots);
      console.log(`✅ Cleared per-bot lang for bot ${botFlag} (${bots[botFlag].larkAppId}).`);
    } else {
      if (!isLocale(target)) {
        console.error(`Unknown locale "${target}". Supported: ${SUPPORTED_LOCALES.join(', ')}.`);
        process.exit(1);
      }
      bots[botFlag].lang = target;
      writeBotsJsonAtomic(bots);
      console.log(`✅ Set bot ${botFlag} (${bots[botFlag].larkAppId}) lang → ${target}.`);
    }
    console.log(`Run \`botmux restart\` for changes to take effect.`);
    return;
  }

  // Global operations
  if (unset) {
    setGlobalLocale(null);
    console.log(`✅ Cleared global lang (will default to zh).`);
    console.log(`Run \`botmux restart\` for changes to take effect.`);
    return;
  }

  if (!isLocale(target)) {
    console.error(`Unknown locale "${target}". Supported: ${SUPPORTED_LOCALES.join(', ')}.`);
    console.error(`Usage: botmux lang [zh|en] [--bot N] [--unset]`);
    process.exit(1);
  }
  setGlobalLocale(target);
  console.log(`✅ Set global lang → ${target}.`);
  console.log(`Run \`botmux restart\` for changes to take effect.`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function getVersion(): string {
  const pkgPath = join(PKG_ROOT, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const command = process.argv[2];

// Workflow safety gate (Slice C0): a CLI invoked inside a workflow
// subagent worker (BOTMUX_WORKFLOW=1, set by daemon-spawn) must not
// trigger chat-facing or schedule-mutation side effects.  Those belong
// in `hostExecutor` activities so they get `effectAttempted` tracking +
// reconcile.  Read-only commands (history, quoted, bots list, etc.)
// stay allowed because they're useful for agents to introspect.
if (process.env.BOTMUX_WORKFLOW === '1') {
  const blockedRoot = new Set(['send', 'create-group', 'setup']);
  const isSchedule = command === 'schedule';
  const scheduleSub = isSchedule ? (process.argv[3] ?? '') : '';
  const blockedScheduleSub = new Set([
    'add',
    'rm',
    'remove',
    'del',
    'delete',
    'pause',
    'disable',
    'resume',
    'enable',
    'run',
  ]);
  if (blockedRoot.has(command) || (isSchedule && blockedScheduleSub.has(scheduleSub))) {
    const runId = process.env.BOTMUX_WORKFLOW_RUN_ID ?? '?';
    const nodeId = process.env.BOTMUX_WORKFLOW_NODE_ID ?? '?';
    console.error(
      `botmux ${command}${isSchedule ? ` ${scheduleSub}` : ''} refused inside workflow ` +
      `subagent (run=${runId} node=${nodeId}).  Chat-facing or schedule-mutating ` +
      `effects belong in a hostExecutor activity, not a subagent.`,
    );
    process.exit(2);
  }
}

switch (command) {
  case '--version':
  case '-v':      console.log(getVersion()); break;
  case 'setup':   await cmdSetup(); break;
  case 'start':   await cmdStart(); break;
  case 'stop':    cmdStop(); break;
  case 'restart': await cmdRestart(); break;
  case 'logs':    cmdLogs(); break;
  case 'status':  cmdStatus(); break;
  case 'upgrade': cmdUpgrade(); break;
  case 'dashboard': await cmdDashboard(); break;
  case 'list':
  case 'ls':      await cmdList(); break;
  case 'delete':
  case 'del':
  case 'rm':      cmdDelete(); break;
  case 'resume':  await cmdResume(); break;
  case 'schedule': await cmdSchedule(process.argv[3] ?? '', process.argv.slice(4)); break;
  case 'workflow': {
    const { cmdWorkflow } = await import('./cli/workflow.js');
    await cmdWorkflow(process.argv[3] ?? '', process.argv.slice(4));
    break;
  }
  case 'send':     await cmdSend(process.argv.slice(3)); break;
  case 'create-group': await cmdCreateGroup(process.argv.slice(3)); break;
  case 'bots':     await cmdBots(process.argv[3] ?? 'list', process.argv.slice(4)); break;
  case 'history':  await cmdHistory(process.argv.slice(3)); break;
  case 'quoted':   await cmdQuoted(process.argv.slice(3)); break;
  case 'lang':     cmdLang(process.argv.slice(3)); break;
  case 'thread':   {
    // Removed in favor of `botmux history` (普通群也兼容). Friendly stderr so
    // pre-rename scripts/skills surface the rename instead of "unknown command".
    const sub = process.argv[3] ?? '';
    console.error(
      sub === 'messages' || sub === 'msgs'
        ? `\`botmux thread ${sub}\` 已重命名为 \`botmux history\` (跑普通群和话题群都用它)。`
        : `\`botmux thread\` 已下线，请用 \`botmux history\``,
    );
    process.exit(1);
    break;
  }
  case 'autostart': {
    ensureConfigDir();
    const sub = process.argv[3] ?? 'status';
    const opts = { pkgRoot: PKG_ROOT, configDir: CONFIG_DIR, logDir: LOG_DIR };
    if (sub === 'enable' || sub === 'install') enableAutostart(opts);
    else if (sub === 'disable' || sub === 'uninstall') disableAutostart(opts);
    else if (sub === 'status') autostartStatus(opts);
    else { console.error(`用法: botmux autostart <enable|disable|status>`); process.exit(1); }
    break;
  }
  default:        showHelp(); break;
}
