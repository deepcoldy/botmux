#!/usr/bin/env node
/**
 * CLI entry point for botmux.
 *
 * Usage:
 *   botmux setup          — interactive first-time configuration
 *   botmux setup --no-open-platform-auto — skip Feishu Open Platform automation
 *   botmux start          — start daemon (pm2)
 *   botmux stop           — stop daemon
 *   botmux restart [--include-pm2] — restart daemon (optionally restart PM2 God too)
 *   botmux logs [--lines] — view daemon logs
 *   botmux status         — show daemon status
 *   botmux upgrade        — upgrade to latest version
 *   botmux list           — interactive session picker (TUI), attach to tmux
 *   botmux list --plain   — plain table output (for piping / scripts)
 *   botmux delete <id>    — close a session by ID prefix
 *   botmux delete all     — close all active sessions
 *   botmux autostart enable|disable|status — manage boot-time autostart (launchd / user systemd / Windows Task Scheduler)
 *   botmux whiteboard status|enable|disable|current|list|read|update|write — local project whiteboard
 */
import { execSync, execFileSync, spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, readdirSync, readlinkSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';
import { validateWorkingDir } from './core/working-dir.js';
import { resolveSessionContext } from './core/session-marker.js';
import { parseDispatchBotSpec, buildDispatchMessages, buildRepoPrimeText, buildReportContent, eligibleAutoMentionAliases, offTopicSubBotTopic, resolveReportTarget, resolveSendTarget } from './core/dispatch.js';
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
  assertOwnerWhenChatGroups,
  findInvalidAllowedUserEntries,
  hasOwnerEntry,
  type BotConfigEditInput,
} from './setup/bot-config-editor.js';
import { resolveCliSelection, selectionKeyForBot } from './setup/cli-selection.js';
import { pickCliSelection } from './setup/interactive-select.js';
import { buildPreset, serializePreset, presetFilename } from './setup/agent-preset.js';
import type { CliId } from './adapters/cli/types.js';
import { logger } from './utils/logger.js';
import { invalidWorkingDirs } from './utils/working-dir.js';
import { firstPositional } from './cli/arg-utils.js';
import { dispatchPrimaryMessage, findStdinAliasAttachment, sendFileAttachments } from './cli/send-dispatch.js';
import { buildPm2SpawnCommand } from './cli/pm2-command.js';
import { callDashboard, type DashboardEndpoint, type DashboardResult } from './cli/dashboard-endpoint.js';
import { loadDashboardSecret } from './dashboard/auth.js';
import { rejectLikelyWindowsStdinMojibake } from './cli/stdin-encoding.js';
import {
  formatBotInfoEntriesForCli,
  formatChatBotsForCli,
} from './cli/bots-list-output.js';
import {
  buildFooterAddressing,
  hasKnownBotMention,
  knownBotOpenIdsFromCrossRef,
  orderedFooterRecipients,
  type BotMentionEntry,
} from './utils/bot-routing.js';
import { isLocale, localeForBot, setDefaultLocale, SUPPORTED_LOCALES, t, type Locale } from './i18n/index.js';
import { type Brand, chatAppLink, larkHosts, normalizeBrand, sdkDomain } from './im/lark/lark-hosts.js';
import { mergeGlobalConfig, readGlobalConfig, setGlobalLocale, globalConfigPath } from './global-config.js';
import {
  createWhiteboard,
  ensureDefaultWhiteboard,
  getWhiteboard,
  listWhiteboards,
  readWhiteboard,
  whiteboardEnabled,
  whiteboardPath,
} from './services/whiteboard-store.js';
import { buildBridgeSendMarkerContent } from './services/bridge-fallback-gate.js';
import { writeManualIntentIfAbsentTo } from './services/restart-intent-store.js';
import { stripLegacyPendingCardFields } from './services/session-store.js';

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
  if (process.platform === 'win32') {
    const cmd = join(PKG_ROOT, 'node_modules', '.bin', 'pm2.cmd');
    if (existsSync(cmd)) return cmd;
  }
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
    atomicWriteFileSync(pidFile, `${keepPid}\n`);
  } catch { /* ignore */ }

  console.warn(`⚠️  检测到同一 PM2_HOME (${home}) 下存在多个 PM2 God Daemon，已清理重复实例；保留 pid ${keepPid}，移除: ${dupes.join(', ')}`);
  return true;
}

function runPm2(args: string[], inherit = true, home: string = PM2_HOME, timeoutMs?: number): void {
  const pm2 = buildPm2SpawnCommand(pm2Bin(), args);
  const r = spawnSync(pm2.command, pm2.args, {
    stdio: inherit ? 'inherit' : 'pipe',
    env: pm2Env(home),
    shell: pm2.shell ?? false,
    timeout: timeoutMs,
  });
  if (r.status !== 0) {
    // r.error is set when the process couldn't be spawned/timed out (status null);
    // prefer it so failures don't surface as a bare "status null".
    const detail = r.error?.message ?? `status ${r.status}`;
    throw new Error(`pm2 ${args.join(' ')} failed: ${detail}`);
  }
}

/**
 * Run a pm2 command and capture stdout. Routes through buildPm2SpawnCommand so
 * it works on Windows (where pm2Bin() resolves to a `.cmd` that must run through
 * a shell) as well as macOS/Linux. Throws on non-zero exit / spawn failure.
 */
function pm2Capture(args: string[], home: string = PM2_HOME, timeoutMs = 10_000): string {
  const pm2 = buildPm2SpawnCommand(pm2Bin(), args);
  const r = spawnSync(pm2.command, pm2.args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: pm2Env(home),
    shell: pm2.shell ?? false,
    timeout: timeoutMs,
  });
  if (r.status !== 0) {
    const detail = r.error?.message
      ?? ((r.stderr ? String(r.stderr).trim() : '') || `status ${r.status}`);
    throw new Error(`pm2 ${args.join(' ')} failed: ${detail}`);
  }
  return typeof r.stdout === 'string' ? r.stdout : '';
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
    // A graceful daemon shutdown exits 0 (SIGTERM/SIGINT → drain → process.exit(0)).
    // Tell pm2 that exit 0 is intentional so it does NOT autorestart the daemon
    // while `botmux restart` is tearing the fleet down — otherwise pm2 revives
    // each daemon (after restart_delay) the instant our parallel SIGTERM drains
    // it, and re-deleting those revivals one-by-one re-serializes the teardown
    // (~13s of churn for 31 bots). Crashes (non-zero exit / killed by signal)
    // are NOT in this list, so genuine crash-autorestart is preserved.
    stop_exit_codes: [0],
    // pm2's default kill_timeout (1.6s) is SHORTER than the daemon's own
    // SHUTDOWN_GRACE_MS (3s), so any daemon pm2 has to signal directly gets
    // SIGKILL'd mid-drain → orphaned (ppid=1) workers. Give pm2 headroom past
    // the daemon's graceful-drain budget so it never force-kills mid-shutdown.
    kill_timeout: 3500,
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
    // Same rationale as the bot daemons: don't let pm2 revive on graceful exit-0
    // during a fleet teardown, and don't SIGKILL mid-shutdown. (See baseApp.)
    stop_exit_codes: [0],
    kill_timeout: 3500,
    error_file: join(LOG_DIR, 'dashboard-error.log'),
    out_file: join(LOG_DIR, 'dashboard-out.log'),
    merge_logs: true,
    env: {
      // MUST match the bot daemons' SESSION_DATA_DIR: the dashboard shares
      // pairings/federations/memberships with them via {dataDir}/*.json. Without
      // it the dashboard falls back to an install-relative ../data and reads a
      // DIFFERENT store → /pair「配对码无效」, auto-bind hubsSynced:0,
      // remote-group not_a_member (cross-deployment 拉群 silently broken).
      SESSION_DATA_DIR: DATA_DIR,
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
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      rl.off("error", onError);
      if (err?.code === "EIO") {
        console.warn("\nWarning: interactive input stream closed (EIO); continuing with empty input.");
        resolve("");
        return;
      }
      reject(err);
    };
    rl.once("error", onError);
    rl.question(question, answer => {
      rl.off("error", onError);
      resolve(answer);
    });
  });
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
 * 归一逻辑收口到 lark-hosts 的 {@link normalizeBrand}（单一事实源）。
 */
function botBrand(b: any): Brand {
  return normalizeBrand(b?.brand);
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
  const home = `${larkHosts(brand).openApi}/app/${appId}`;
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

async function finishOpenPlatformSetup(appId: string, brand: 'feishu' | 'lark'): Promise<void> {
  const { parseSetupOpenPlatformAutoFlag, automateOpenPlatformSetup } = await import('./setup/open-platform-automation.js');
  if (!parseSetupOpenPlatformAutoFlag(process.argv.slice(3))) {
    console.log('\n已跳过开放平台自动配置 (--no-open-platform-auto)。');
    printRemainingSteps(appId, brand);
    return;
  }

  console.log('\n── 开放平台自动配置 ──\n');
  console.log('将使用 botmux 内置 Feishu Web QR 登录获取/复用 Web session，自动导入权限、配置 redirect URL 并创建/发布版本。');
  console.log('如失败会自动回退到手动步骤提示，不影响已写入的 botmux 配置。\n');

  const result = await automateOpenPlatformSetup({ appId, brand });
  if (result.ok) {
    console.log('✅ 开放平台自动配置完成');
    console.log(`   Session 来源: ${result.sessionSource}`);
    const skipped = result.skippedScopeCount ?? 0;
    console.log(`   已导入权限数: ${result.scopeCount}${skipped > 0 ? `（另有 ${skipped} 项当前租户目录中没有，已跳过）` : ''}`);
    if (result.scopeWarning) {
      console.log(`   ⚠️ 权限注册未全部成功（部分租户对个别权限有限制）：${result.scopeWarning}`);
      console.log('      可稍后到开放平台「权限管理」手动补齐缺失权限。');
    } else if (result.scopeCount === 0) {
      console.log('   ⚠️ 本次没有成功导入任何权限，请到开放平台「权限管理」手动导入 ~/.botmux/lark-scopes.json。');
    }
    console.log(`   已配置 redirect URL: http://127.0.0.1:9768/callback`);
    if (result.versionId) console.log(`   已提交发布版本: ${result.versionId}`);
    else console.log('   已创建版本；未从响应中解析到 versionId，请到开放平台确认是否需要手动发布。');
    console.log('');
    return;
  }

  console.log(`⚠️  开放平台自动配置失败 (${result.reason}): ${result.message}`);
  if (result.sessionFile) console.log(`   botmux session 文件: ${result.sessionFile}`);
  console.log('   请按下面的手动步骤继续完成开放平台配置。');
  printRemainingSteps(appId, brand);
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
  | { ok: true; appId: string; appSecret: string; brand: Brand; userOpenId?: string }
  | { ok: false; reason: 'cancelled' }
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
      // brand 由扫码 device flow 的 tenant_brand 自动识别（registerApp 内部已
      // 切到对应域名轮询）。feishu / lark 都直接落盘——daemon 链路全程从
      // BotConfig.brand 派生 host（Client / WSClient domain、裸 fetch、深链）。
      console.log(`\n✅ 应用创建成功`);
      console.log(`   App ID: ${result.appId}`);
      console.log(`   租户类型: ${result.brand === 'lark' ? 'Lark 国际版 (larksuite.com)' : '飞书 (feishu.cn)'}`);
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
  }

  // 手动 fallback / 手动选项：扫码路径已用 tenant_brand 自动识别；手动路径
  // 没有这个信号，兜底让用户手选租户类型（决定建应用 / 运行时的域名）。
  console.log('\n租户类型：');
  console.log('  1) 飞书（中国版，open.feishu.cn）');
  console.log('  2) Lark（国际版，open.larksuite.com）');
  const brandChoice = (await ask(rl, '选择 [1]: ')).trim();
  const brand: Brand = brandChoice === '2' ? 'lark' : 'feishu';

  console.log(`\n请在浏览器打开 ${larkHosts(brand).openApi}/app 创建应用，然后回来粘 ID/Secret。\n`);
  const appId = (await ask(rl, 'AppID (cli_xxx): ')).trim();
  const appSecret = (await ask(rl, 'AppSecret: ')).trim();

  if (!appId || !appSecret) {
    console.log('\n❌ AppID/AppSecret 不能为空，setup 中止。');
    return { ok: false, reason: 'cancelled' };
  }
  return { ok: true, appId, appSecret, brand };
}

/**
 * 用新应用自身凭证验证扫码链路拿到的 open_id。
 * 能解析 union_id 时写 on_；没有 union_id 但 open_id 对当前 app 有效时写 ou_。
 * 查询失败或用户不在当前 app 视角时返回 undefined，调用方不得 fallback 写入该 ou_。
 */
async function resolveScannerAllowedUser(
  appId: string,
  appSecret: string,
  openId: string,
  brand: Brand = 'feishu',
): Promise<string | undefined> {
  try {
    const { Client } = await import('@larksuiteoapi/node-sdk');
    // brand → 域名。Lark 扫码人 ou_→on_ 必须打 larksuite.com，否则失败丢掉 cross-app 稳定性。
    const client = new Client({ appId, appSecret, domain: sdkDomain(brand) });
    const res = await (client as any).contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    if (res.code === 0 && res.data?.user) {
      return res.data.user.union_id ?? openId;
    }
  } catch { /* do not trust scanner open_id when verification fails */ }
  return undefined;
}

/**
 * 手动建 bot 时（没有扫码人 open_id）必须指定至少一个 owner.
 * 循环追问直到给出合法条目（邮箱、union_id on_xxx 或 open_id ou_xxx），拒绝裸邮箱前缀与空输入.
 * setup 不允许没有 owner —— 没 owner 的配置一旦叠加 allowedChatGroups 即成权限黑洞.
 */
async function promptRequiredOwner(rl: ReturnType<typeof createInterface>): Promise<string[]> {
  printInputHelp('管理员 (owner)', [
    '必填。至少一个能操作机器人的管理员，多个值用逗号分隔。',
    '推荐格式（优先级高到低）：完整邮箱（alice@example.com）> union_id（on_xxx，跨应用稳定）> open_id（ou_xxx，仅限同一应用）。',
    '注意：必须是完整邮箱，邮箱前缀（如 alice）无法解析、不接受。',
  ]);
  for (;;) {
    const raw = (await ask(rl, '管理员 (owner): ')).trim();
    const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (entries.length === 0) {
      console.log('   ❌ 必须至少指定一个管理员（不能为空）。');
      continue;
    }
    const invalid = findInvalidAllowedUserEntries(entries);
    if (invalid.length > 0) {
      console.log(`   ❌ 以下不是完整邮箱、union_id 或 open_id（邮箱前缀不接受）: ${invalid.join(', ')}`);
      continue;
    }
    if (!hasOwnerEntry(entries)) {
      console.log('   ❌ 至少需要一个完整邮箱、union_id 或 open_id 作为 owner。');
      continue;
    }
    return entries;
  }
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

  // CLI 适配器：可搜索的级联选择器（选 Aiden 可进 × Claude / × Codex，aiden 网关）。
  // 非交互终端自动回退为序号 / ID 文本输入。
  const selKey = await pickCliSelection(rl, { title: '选择 CLI 适配器' });
  let cliId: CliId;
  let wrapperCli: string | undefined;
  try {
    const sel = resolveCliSelection(selKey ?? 'claude-code');
    cliId = sel.cliId;
    wrapperCli = sel.wrapperCli;
  } catch (err: any) {
    console.log(`\n❌ ${err?.message ?? String(err)}`);
    console.log('   不写 bots.json。请重新运行 botmux setup。');
    return null;
  }
  const workingDir = await ask(rl, '默认工作目录 [~]: ');

  const bot: Record<string, any> = {
    larkAppId: creds.appId,
    larkAppSecret: creds.appSecret,
    cliId,
    // aiden × claude/codex 等启动前缀；普通 CLI 不写此字段。
    ...(wrapperCli ? { wrapperCli } : {}),
    // 总是写 workingDir, 留空用 '~'. 用户手动编辑 bots.json 时一眼能看到字段
    // 在哪儿, 不用去 README 查字段名.
    workingDir: workingDir.trim() || '~',
  };
  // brand 落盘：只在国际版 (lark) 时写字段，feishu 留空——保持旧 bots.json 干净，
  // 且 botBrand()/normalizeBrand() 读不到时 default 到 feishu，向后兼容。
  // 下游 finishOpenPlatformSetup(bot, botBrand(bot)) 据此给出正确的 larksuite 深链。
  if (creds.brand === 'lark') {
    bot.brand = 'lark';
  }
  // setup 不再询问 model（用户常选到无权限的 model，setup 完一发消息就 spawn
  // 报错，排查成本高）。需要指定 model 走 /config 卡片或手动编辑 bots.json。
  // 扫码场景默认填扫码人自己，但 registerApp 返回的 open_id 不能直接信任：
  // 只有新 app 自身能验证时才写入 allowedUsers；验证失败则要求手动填写 owner。
  // 手动 fallback 场景没 open_id —— 必须显式指定 owner, 否则配置无 owner:
  // allowedUsers 为空时虽然"全开放", 但一旦后续加了 allowedChatGroups 就会变成
  // "群成员能对话却没人能做敏感操作 / 用 /grant". setup 阶段强制收口, 不允许没 owner.
  if (creds.userOpenId) {
    const owner = await resolveScannerAllowedUser(creds.appId, creds.appSecret, creds.userOpenId, creds.brand);
    if (owner) {
      bot.allowedUsers = [owner];
    } else {
      console.log('⚠️  无法确认扫码人的 open_id 属于当前新应用，请手动填写 owner。');
      bot.allowedUsers = await promptRequiredOwner(rl);
    }
  } else {
    bot.allowedUsers = await promptRequiredOwner(rl);
  }

  if (!ensureBotWorkingDirsExist(bot, '默认工作目录')) return null;

  return normalizeBotConfig(bot);
}

function formatOptionalValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'string' && v) return v;
  return '未设置';
}

/** Render a tri-state optional boolean for the edit prompt, showing the effective
 *  value: explicit true/false when set, else the field's documented default. */
function formatBooleanValue(v: unknown, defaultValue: boolean): string {
  if (typeof v === 'boolean') return String(v);
  return `${defaultValue}（默认）`;
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

  // CLI 适配器：可搜索的级联选择器（选 Aiden 可进 × Claude / × Codex，aiden 网关）。
  printInputHelp('CLI 适配器', [
    '可搜索的交互式选择：输入关键字过滤、↑/↓ 选择、⏎ 确认、Esc 保留当前值。',
    '选 Aiden 进二级菜单：× Claude / × Codex（aiden 网关，无需 wrapper 脚本）。',
    '非交互终端下回退为「输入序号 / 适配器 ID」。',
  ]);
  const currentKey = selectionKeyForBot(bot.cliId ?? 'claude-code', bot.wrapperCli);
  const selKey = await pickCliSelection(rl, { title: 'CLI 适配器', currentKey });
  if (selKey) {
    try {
      const sel = resolveCliSelection(selKey);
      input.cliChoice = sel.cliId;
      input.wrapperCli = sel.wrapperCli ?? null; // 选普通 CLI 时清掉旧的 aiden×* 前缀
    } catch (err: any) {
      console.log(`\n❌ ${err?.message ?? String(err)}（保留当前 CLI）`);
    }
  }
  // selKey 为 null（Esc / 空）→ input.cliChoice 不设 → 保留当前 CLI。

  printInputHelp('CLI 可执行文件路径覆盖', [
    '可选。CLI 入口的绝对路径，用于在原 CLI 外面套一层 wrapper / router。',
    '典型场景：ccr / claude-w 等自定义入口（aiden × claude/codex 选上面那项即可，无需此项）。',
    '留空保留当前值；输入 - 清空覆盖，回到 PATH 查 cliId 对应的默认二进制。',
  ]);
  input.cliPathOverride = await ask(rl, `CLI 可执行文件路径覆盖 [${formatOptionalValue(bot.cliPathOverride)}]: `);

  // setup 不再询问 model（同 promptBotConfig 的理由）。但切换 CLI 时旧 model
  // 是上一个 CLI 的值，套到新 CLI 上没意义甚至直接 spawn 报错，必须强制清空；
  // 未换 CLI 时 input.model 留 undefined，applyBotConfigEdits 保持原值不动。
  const cliChanged = !!resolveCliId(input.cliChoice) && resolveCliId(input.cliChoice) !== bot.cliId;
  if (cliChanged && bot.model) {
    console.log('\n⚠️  已切换 CLI，原 model 字段已清空（如需指定 model 请用 /config 卡片或编辑 bots.json）。');
    input.model = null;
  }

  printInputHelp('会话后端 backendType', [
    '可选。pty 更轻量；tmux 支持 adopt 和 Web Terminal 附着；herdr 支持托管持久会话；zellij 为实验后端（需 zellij >= 0.44）。',
    '留空保留当前值；输入 - 回到自动检测；接受 pty / tmux / herdr / zellij。',
  ]);
  input.backendType = await ask(rl, `会话后端 backendType [${formatOptionalValue(bot.backendType)}]: `);

  printInputHelp('默认工作目录', [
    '可选。新会话默认进入的目录，支持逗号分隔多个候选目录。',
    '留空保留当前值；输入 - 清空并回到默认 ~。',
  ]);
  input.workingDir = await ask(rl, `默认工作目录 [${formatOptionalValue(bot.workingDir)}]: `);

  printInputHelp('允许的用户', [
    '可选。限制哪些飞书用户可以操作机器人，支持完整邮箱（如 alice@example.com）、union_id（on_xxx）或 open_id（ou_xxx），多个值用逗号分隔。',
    '注意：必须是完整邮箱，邮箱前缀（如 alice）无法解析、会被丢弃。',
    '留空保留当前值；输入 - 清空限制。',
  ]);
  input.allowedUsers = await ask(rl, `允许的用户 [${formatOptionalValue(bot.allowedUsers)}]: `);

  printInputHelp('可对话群', [
    '可选。在这些群里任何成员都能与机器人对话（按消息所在群判断，新人进群即生效、退群即失权，无需重启）；多个 chat_id 用逗号分隔。',
    '值通常是 oc_xxx；留空保留当前值；输入 - 清空。等价于 owner 在该群发 /grant（不带 @）。',
    '仅授对话权，不授予 /restart、/close、终端写入等敏感操作（那些仍由 allowedUsers 控制）。',
  ]);
  input.allowedChatGroups = await ask(rl, `允许的群聊组 [${formatOptionalValue(bot.allowedChatGroups)}]: `);

  printInputHelp('平台团队页展示 showInTeam', [
    '可选。绑定中心化平台后，是否在团队页（人→机器→bot）展示这个机器人。',
    '默认 true（展示）；填 false 把内部/工具机器人从团队页隐藏。',
    '留空保留当前值；输入 - 恢复默认（展示）。',
  ]);
  input.showInTeam = await ask(rl, `平台团队页展示 showInTeam [${formatBooleanValue(bot.showInTeam, true)}]: `);

  const edited = applyBotConfigEdits(bot, input);
  // 配了 allowedChatGroups 就必须有 owner，否则敏感操作对所有人关闭。抛错由调用方捕获并中止写盘。
  assertOwnerWhenChatGroups(edited);
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
  await finishOpenPlatformSetup(bot.larkAppId, botBrand(bot));
  console.log(`下一步:`);
  console.log(`  1. botmux start              启动 daemon`);
  console.log(`  2. botmux autostart enable   注册开机自启（推荐：${process.platform === 'darwin' ? 'mac launchd' : process.platform === 'linux' ? 'linux user systemd' : process.platform === 'win32' ? 'Windows Task Scheduler' : '当前平台暂不支持'}，无需 sudo）`);
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
      await finishOpenPlatformSetup(newBot.larkAppId, botBrand(newBot));
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
        await finishOpenPlatformSetup(edited.larkAppId, botBrand(edited));
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
    await finishOpenPlatformSetup(newBot.larkAppId, botBrand(newBot));
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
    await finishOpenPlatformSetup(newBot.larkAppId, botBrand(newBot));
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
              runPm2(['kill'], false, PM2_HOME, 10_000);
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
  await printDashboardHintWithRetry();
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

/** Block the current thread for `ms`. Safe here: the restart CLI is a one-shot
 *  process, so stalling its event loop during the shutdown poll is harmless. */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable → no-op */ }
}

/** Delete all pm2 processes matching botmux / botmux-* under the given PM2_HOME. */
function deleteAllBotmuxProcesses(home: string = PM2_HOME): void {
  let entries: Array<{ name: string; pid: number; online: boolean }>;
  try {
    const apps = JSON.parse(pm2Capture(['jlist'], home)) as any[];
    entries = (Array.isArray(apps) ? apps : [])
      .filter(a => a && (a.name === PM2_NAME || String(a.name).startsWith(`${PM2_NAME}-`)))
      .map(a => ({ name: String(a.name), pid: Number(a.pid) || 0, online: a?.pm2_env?.status === 'online' }));
  } catch (e) {
    console.error(`[restart] pm2 jlist failed (pm2 not running or no apps?): ${e instanceof Error ? e.message : e}`);
    return;
  }
  if (entries.length === 0) return;
  const names = entries.map(e => e.name);

  // Parallel graceful shutdown. pm2's own delete stops apps one-at-a-time
  // (async eachLimit, concurrency 1) and each botmux daemon's drain eats pm2's
  // full kill_timeout (~1.6s) → ~N×1.6s serial (~38s for 31 bots). Instead we
  // SIGTERM every online daemon AT ONCE so their graceful drains overlap (the
  // daemon's SIGTERM handler detaches workers within SHUTDOWN_GRACE_MS), wait
  // once for them all to exit, then let pm2 delete reap the now-dead entries
  // instantly. Orphan-safe: each daemon runs its FULL graceful drain and we wait
  // for real exit before pm2 touches it — avoiding the mid-drain SIGKILL the old
  // path forced (pm2 kill_timeout 1.6s < daemon SHUTDOWN_GRACE_MS 3s).
  const pids = entries.filter(e => e.online && e.pid > 0).map(e => e.pid);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  // Poll until every signalled daemon has exited (bounded). SHUTDOWN_GRACE_MS is
  // 3s; give headroom. Exits early the moment the last one dies.
  const deadline = Date.now() + 5_000;
  let alive = pids.slice();
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSyncMs(50);
    alive = alive.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  }

  // Reap pm2 entries. Processes are already dead → each delete is instant, and
  // ONE batched `pm2 delete name1 name2 …` collapses N pm2 CLI cold-boots
  // (~315ms each) into one. A revived (autorestart, gated by restart_delay)
  // instance is still removed by name.
  const batchTimeout = Math.max(15_000, names.length * 2_500);
  try {
    runPm2(['delete', ...names], false, home, batchTimeout);
    return;
  } catch (e) {
    // pm2's batched delete (async eachLimit) aborts on the first failed name,
    // so a mid-batch failure can leave stragglers. Fall back to the resilient
    // per-name loop that try/catches each name independently.
    console.error(`[restart] batched pm2 delete failed, falling back to per-name: ${e instanceof Error ? e.message : e}`);
  }
  for (const name of names) {
    try {
      runPm2(['delete', name], false, home, 10_000);
    } catch (e) {
      // Don't swallow silently — a failed delete here used to leave the
      // restart half-done with no trace. Surface it (the auto-restart
      // driver captures stderr to ~/.botmux/logs/maintenance-restart.log).
      console.error(`[restart] pm2 delete ${name} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function killPm2GodDaemon(home: string = PM2_HOME): void {
  try {
    runPm2(['kill'], true, home, 15_000);
    return;
  } catch {
    // Fall back to direct pid cleanup below.
  }

  for (const pid of listPm2GodDaemonPids(home)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  for (const pid of listPm2GodDaemonPids(home)) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
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
    const output = pm2Capture(['jlist']);
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
  const includePm2 = process.argv.includes('--include-pm2');
  // Drop a restart-intent breadcrumb so the fresh daemon knows this was an
  // intentional restart and DMs the owner a summary. `IfAbsent` preserves a
  // richer breadcrumb (update / auto-restart) already written by the
  // maintenance timer that spawned this very `botmux restart`. A pm2
  // crash-autorestart bypasses this path → no breadcrumb → silent.
  try {
    const now = Date.now();
    writeManualIntentIfAbsentTo(resolveDataDir(), now, new Date(now).toISOString());
  } catch { /* breadcrumb is best-effort */ }
  killDuplicatePm2GodDaemons();
  preflightNodeSanity();
  await ensureSystemDependencies();
  const cfg = ecosystemConfig();
  cleanupLegacyPm2();
  // Delete all botmux processes (handles both old single-process and new multi-process)
  deleteAllBotmuxProcesses();
  if (includePm2) {
    killPm2GodDaemon();
  }
  // Wipe abandoned dashboard-daemon descriptors left behind by killed daemons.
  cleanupStaleDaemonDescriptors();
  runPm2(['start', cfg]);
  if (refreshAutostart({ pkgRoot: PKG_ROOT, configDir: CONFIG_DIR, logDir: LOG_DIR })) {
    console.log(`autostart unit 已同步到当前 Node/cli.js 路径`);
  }
  await printDashboardHintWithRetry();
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
    const output = pm2Capture(['jlist'], legacyHome);
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

  // Use spawn for streaming output. Windows cannot spawn a .js CLI script
  // directly, so run the bundled pm2 script through the current node.exe.
  const pm2 = buildPm2SpawnCommand(pm2Bin(), ['logs', target, '--lines', lines]);
  const child = spawn(pm2.command, pm2.args, {
    stdio: 'inherit',
    env: pm2Env(),
    shell: pm2.shell ?? false,
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
 * Call one of the dashboard's loopback HMAC `/__cli/*` endpoints. Thin wrapper
 * over {@link callDashboard}, which handles 404 disambiguation and self-heals a
 * stale `.dashboard-port` that points at the wrong service (e.g. daemon IPC).
 * See `src/cli/dashboard-endpoint.ts` for the why.
 */
async function callDashboardEndpoint(path: DashboardEndpoint): Promise<DashboardResult> {
  return callDashboard({
    configDir: CONFIG_DIR,
    defaultPort: 7891,
    envPort: process.env.BOTMUX_DASHBOARD_PORT,
    path,
  });
}

/**
 * Best-effort dashboard hint printed after start/restart. Reads the LIVE link
 * via /__cli/current (non-rotating) so an already-shared URL is preserved.
 * Retries for a few seconds since the dashboard process boots after the daemon;
 * if it still isn't ready, prints a soft fallback so the user isn't blocked.
 */
async function printDashboardHintWithRetry(): Promise<void> {
  const maxWaitMs = 6000;
  const stepMs = 500;
  const started = Date.now();
  let last: Awaited<ReturnType<typeof callDashboardEndpoint>> | null = null;
  while (Date.now() - started < maxWaitMs) {
    last = await callDashboardEndpoint('/__cli/current');
    if (last.ok) {
      console.log(`   面板: botmux dashboard (${last.url})`);
      return;
    }
    // Terminal states — file-backed secret/token won't appear mid-poll, unlike
    // a not-yet-listening port. `wrong-service` means the port file points at a
    // non-dashboard server and discovery already failed to find it, so retrying
    // won't help either. Don't spin on any of them.
    if (last.reason === 'no-secret' || last.reason === 'no-active-token' || last.reason === 'wrong-service') break;
    await new Promise(r => setTimeout(r, stepMs));
  }
  // Soft fallback
  if (last?.reason === 'no-active-token') {
    console.log('   面板: 运行 `botmux dashboard` 获取链接');
  } else if (last?.reason === 'no-secret') {
    console.log('   面板: dashboard 凭证未就绪，启动后可用 `botmux dashboard` 获取链接');
  } else if (last?.reason === 'wrong-service') {
    console.log('   面板: `botmux dashboard`（端口文件可能已失效，必要时 `botmux restart` 刷新）');
  } else {
    console.log('   面板: `botmux dashboard`（daemon 启动中，稍后可获取链接）');
  }
}

/**
 * Print a fresh dashboard URL by HMAC-authing to the dashboard process's
 * loopback rotation endpoint. Each call invalidates the previously-issued
 * token, so sharing a URL is the same as sharing a one-shot session.
 */
async function cmdDashboard(): Promise<void> {
  const r = await callDashboardEndpoint('/__cli/rotate');
  if (r.ok) {
    console.log(r.url);
    return;
  }
  const portFile = join(CONFIG_DIR, '.dashboard-port');
  const recordedPort = (existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '')
    || process.env.BOTMUX_DASHBOARD_PORT
    || '7891';
  if (r.reason === 'no-secret') {
    console.error('Dashboard not initialised. Run `botmux restart` first.');
  } else if (r.reason === 'unreachable') {
    console.error(
      `dashboard process not reachable on 127.0.0.1:${recordedPort} — \`botmux restart\` will start it`,
    );
  } else if (r.reason === 'wrong-service') {
    // 127.0.0.1:<port> answered, but it isn't the dashboard (typically the
    // daemon IPC server holding a port the stale .dashboard-port points at),
    // and rediscovery across the probe range found no dashboard either.
    console.error(
      `127.0.0.1:${recordedPort} 上的服务不是 dashboard（端口文件 ~/.botmux/.dashboard-port 已失效，可能指向了 daemon IPC）。` +
      '运行 `botmux restart` 重启 dashboard 并刷新端口文件。',
    );
    if (r.detail) console.error(`  详情: ${r.detail}`);
  } else {
    // `no-active-token` can't occur on rotate (it always mints); fall through.
    console.error('Rotation failed:', r.detail ?? r.reason);
  }
  process.exit(1);
}

// ─── Session helpers ──────────────────────────────────────────────────────────

interface AdoptedFromData {
  source?: 'tmux' | 'herdr' | 'zellij';
  tmuxTarget?: string;
  zellijSession?: string;
  zellijPaneId?: string;
  herdrSessionName?: string;
  herdrTarget?: string;
  herdrPaneId?: string;
  originalCliPid?: number;
  cwd?: string;
  cliId?: string;
}

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
  creatorOpenId?: string;
  lastCallerOpenId?: string;
  /** Chat-scope quote chain — see Session.quoteTargetId in types.ts. */
  quoteTargetId?: string;
  currentReplyTarget?: { rootMessageId: string; turnId: string; updatedAt: string };
  /** 文档评论入口当前轮回评论落点（见 Session.currentDocCommentTarget in types.ts）。 */
  currentDocCommentTarget?: { fileToken: string; fileType: string; commentId: string; replyToName?: string; replyToOpenId?: string; turnId: string };
  quoteTargetSenderOpenId?: string;
  quoteTargetSenderIsBot?: boolean;
  whiteboardId?: string;
  // Markers that a real CLI ever ran in this session (vs a daemon-command
  // scratch placeholder). Persisted by the daemon; only presence is checked
  // here, so they're typed loosely. Used by cmdList to avoid reporting an
  // unconfirmed /adopt scratch as a crashed CLI session.
  cliId?: string;
  lastCliInput?: string;
  adoptedFrom?: AdoptedFromData;
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
function loadSessionFresh(session: SessionData): SessionData | undefined {
  return loadSessions().get(session.sessionId);
}

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

  // Clean up entries where file key doesn't match the entry's sessionId (data
  // corruption), and strip legacy placeholder-card fields so the file converges
  // to clean (see stripLegacyPendingCardFields in services/session-store).
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === 'object' && 'sessionId' in val && (val as SessionData).sessionId !== key) {
      delete data[key];
      continue;
    }
    if (val && typeof val === 'object') stripLegacyPendingCardFields(val as unknown as Record<string, unknown>);
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
  cols: { id: number; bot?: number; title: number; dir: number; pid: number; uptime: number; status: number; target: number },
): { text: string; alive: boolean } {
  const id = padEndDisplay(s.sessionId.substring(0, 8), cols.id);
  const parts = [id];
  if (multiBot) {
    const label = s.larkAppId ? (botLabels.get(s.larkAppId) ?? s.larkAppId.substring(0, 18)) : '-';
    parts.push(padEndDisplay(truncate(label, cols.bot!), cols.bot!));
  }
  const title = padEndDisplay(truncate((s.title || '(untitled)').replace(/[\r\n]+/g, ' '), cols.title), cols.title);
  const dir = padEndDisplay(truncate(s.workingDir || '-', cols.dir), cols.dir);
  const displayPid = sessionDisplayPid(s);
  const pid = displayPid ? String(displayPid).padEnd(cols.pid) : '-'.padEnd(cols.pid);
  const uptime = formatDuration(Date.now() - new Date(s.createdAt).getTime()).padEnd(cols.uptime);
  const alive = isSessionAliveForList(s);
  const status = padEndDisplay(sessionStatusLabel(s), cols.status);
  const target = padEndDisplay(truncate(sessionTargetLabel(s), cols.target), cols.target);
  parts.push(title, dir, pid, uptime, status, target);
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

  const cols = { id: 10, ...(multiBot ? { bot: 22 } : {}), title: 28, dir: 28, pid: 8, uptime: 8, status: 8, target: 26 };

  const headerParts = ['id'.padEnd(cols.id)];
  if (multiBot) headerParts.push('bot'.padEnd(cols.bot!));
  headerParts.push(
    'title'.padEnd(cols.title),
    'working dir'.padEnd(cols.dir),
    'pid'.padEnd(cols.pid),
    'uptime'.padEnd(cols.uptime),
    'status'.padEnd(cols.status),
    'target'.padEnd(cols.target),
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

function applyTmuxWindowSizeLargest(sessionName: string): void {
  try {
    execFileSync('tmux', ['set-option', '-t', sessionName, 'window-size', 'largest'], {
      stdio: 'ignore',
      timeout: 3000,
      env: tmuxEnv(),
    });
  } catch { /* best-effort: attach can still proceed */ }
}

function isAdoptedSession(s: SessionData): s is SessionData & { adoptedFrom: AdoptedFromData } {
  return !!s.adoptedFrom && typeof s.adoptedFrom === 'object';
}

function adoptedCliPid(s: SessionData): number | undefined {
  const pid = isAdoptedSession(s) ? s.adoptedFrom.originalCliPid : undefined;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

function adoptTargetLabel(s: SessionData): string {
  if (!isAdoptedSession(s)) return '';
  const a = s.adoptedFrom;
  if (a.source === 'zellij' || a.zellijPaneId) {
    const target = a.zellijSession && a.zellijPaneId
      ? `${a.zellijSession}/${a.zellijPaneId}`
      : a.zellijPaneId || a.zellijSession || '?';
    return `adopt: zellij ${target}`;
  }
  if (a.source === 'herdr' || a.herdrSessionName || a.herdrPaneId || a.herdrTarget) {
    const pane = a.herdrTarget ?? a.herdrPaneId ?? '?';
    const target = a.herdrSessionName ? `${a.herdrSessionName}:${pane}` : pane;
    return `adopt: herdr ${target}`;
  }
  return `adopt: tmux ${a.tmuxTarget ?? '?'}`;
}

function sessionDisplayPid(s: SessionData): number | undefined {
  return adoptedCliPid(s) ?? s.pid;
}

function isSessionAliveForList(s: SessionData): boolean {
  const pid = sessionDisplayPid(s);
  return !!(pid && isProcessAlive(pid));
}

function sessionStatusLabel(s: SessionData): string {
  if (isAdoptedSession(s)) {
    const pid = adoptedCliPid(s);
    if (pid) return isProcessAlive(pid) ? 'adopt' : 'stopped';
    return s.pid && isProcessAlive(s.pid) ? 'adopt' : 'idle';
  }
  return s.pid && isProcessAlive(s.pid) ? 'online' : s.pid ? 'stopped' : 'idle';
}

function sessionTargetLabel(s: SessionData, tmuxName?: string, hasTmux?: boolean): string {
  if (isAdoptedSession(s)) return adoptTargetLabel(s);
  if (hasTmux === undefined) {
    const name = tmuxName ?? `bmx-${s.sessionId.substring(0, 8)}`;
    hasTmux = tmuxSessionExists(name);
    tmuxName = name;
  }
  return hasTmux ? `tmux: ${tmuxName}` : '-';
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
  const fixedCols = { id: 10, pid: 8, uptime: 7, status: 7, target: 26 };
  const botW = multiBot ? 18 : 0;
  const numSeps = (multiBot ? 8 : 7) - 1;  // separators between columns
  const fixedTotal = PREFIX + fixedCols.id + botW + fixedCols.pid + fixedCols.uptime + fixedCols.status + fixedCols.target + numSeps * SEP_W;
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
    target: fixedCols.target,
  };

  // Build row data — use shortened paths for TUI
  function buildRows(): Array<{
    session: SessionData;
    text: string;
    alive: boolean;
    tmuxName: string;
    hasTmux: boolean;
    isAdopt: boolean;
    targetLabel: string;
    canAttach: boolean;
  }> {
    return active.map(s => {
      const tmuxName = `bmx-${s.sessionId.substring(0, 8)}`;
      const isAdopt = isAdoptedSession(s);
      const hasTmux = !isAdopt && tmuxSessionExists(tmuxName);
      const targetLabel = sessionTargetLabel(s, tmuxName, hasTmux);
      // Build row text with shortened dir
      const id = padEndDisplay(s.sessionId.substring(0, 8), cols.id);
      const parts = [id];
      if (multiBot) {
        const label = s.larkAppId ? (botLabels.get(s.larkAppId) ?? s.larkAppId.substring(0, 16)) : '-';
        parts.push(padEndDisplay(truncate(label, cols.bot!), cols.bot!));
      }
      const title = padEndDisplay(truncate((s.title || '(untitled)').replace(/[\r\n]+/g, ' '), cols.title), cols.title);
      const dir = padEndDisplay(truncate(shortenPath(s.workingDir || '-'), cols.dir), cols.dir);
      const displayPid = sessionDisplayPid(s);
      const pid = displayPid ? String(displayPid).padEnd(cols.pid) : '-'.padEnd(cols.pid);
      const uptime = formatDuration(Date.now() - new Date(s.createdAt).getTime()).padEnd(cols.uptime);
      const alive = isSessionAliveForList(s);
      const status = padEndDisplay(sessionStatusLabel(s), cols.status);
      const target = padEndDisplay(truncate(targetLabel, cols.target), cols.target);
      parts.push(title, dir, pid, uptime, status, target);

      return { session: s, text: parts.join(' │ '), alive, tmuxName, hasTmux, isAdopt, targetLabel, canAttach: hasTmux && !isAdopt };
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
      'target'.padEnd(cols.target),
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
    const targetHint = selected.isAdopt
      ? `\x1b[33m${selected.targetLabel}\x1b[0m  \x1b[2mEnter 已禁用；请直接使用原 tmux/zellij/herdr 客户端。\x1b[0m`
      : selected.hasTmux
        ? `\x1b[32mtmux: ${selected.tmuxName}\x1b[0m`
        : `\x1b[2mtmux: 无会话\x1b[0m`;
    process.stdout.write(`\n  ${targetHint}\n`);

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
    process.stdout.write(`\n  \x1b[2m↑/↓ 选择  ⏎ ${selected?.canAttach ? '连接' : '不可连接'}  d 删除  q 退出\x1b[0m\n`);
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

      // Kill botmux's worker process. For adopted sessions, never kill the
      // user's original CLI pid if an old record stored it in `pid`.
      const originalPid = adoptedCliPid(s);
      if (s.pid && s.pid !== originalPid && isProcessAlive(s.pid)) {
        killProcess(s.pid);
      }

      // Kill only botmux-owned tmux sessions. Adopted panes belong to the user.
      if (!r.isAdopt && r.hasTmux) {
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
        if (selected.isAdopt) {
          flashMsg = `\x1b[33m这是 adopt 会话；botmux 不 attach 用户 pane。目标: ${selected.targetLabel}\x1b[0m`;
          render();
          return;
        }
        if (!selected.canAttach) {
          flashMsg = '\x1b[33m该会话没有 tmux，无法连接\x1b[0m';
          render();
          return;
        }
        applyTmuxWindowSizeLargest(selected.tmuxName);
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

  // Auto-prune unrecoverable sessions: process dead and no tmux session.
  // Split into two buckets so a never-activated daemon-command scratch (e.g. an
  // unconfirmed /adopt that only posted a picker card, /help, an abandoned
  // /relay picker) isn't reported as a crashed CLI. Such a scratch never forked
  // a worker, so it has no cliId / lastCliInput / adoptedFrom — the same "was it
  // ever a real CLI session" markers isRelayableRealSession uses. Closing it is
  // fine, but the "进程已死且无 tmux session" notice wrongly implies a CLI ran
  // and crashed, which is exactly the confusing output users hit after /adopt.
  const pruned: SessionData[] = [];
  const prunedScratch: SessionData[] = [];
  const live: SessionData[] = [];
  for (const s of active) {
    if (isAdoptedSession(s)) {
      const pid = adoptedCliPid(s);
      if (pid && isProcessAlive(pid)) {
        live.push(s);
      } else if (pid) {
        pruned.push(s);
      } else {
        const hasPid = !!(s.pid && isProcessAlive(s.pid));
        hasPid ? live.push(s) : pruned.push(s);
      }
      continue;
    }

    const hasPid = !!(s.pid && isProcessAlive(s.pid));
    const hasTmux = tmuxSessionExists(`bmx-${s.sessionId.substring(0, 8)}`);
    if (!hasPid && !hasTmux) {
      const everReal = !!(s.cliId || s.lastCliInput || s.adoptedFrom);
      (everReal ? pruned : prunedScratch).push(s);
    } else {
      live.push(s);
    }
  }
  const closeNow = (arr: SessionData[]) => {
    for (const s of arr) {
      s.status = 'closed';
      s.closedAt = new Date().toISOString();
      saveSession(s);
    }
  };
  // Scratches: close silently — they were placeholders, not dead sessions.
  closeNow(prunedScratch);
  if (pruned.length > 0) {
    closeNow(pruned);
    console.log(`已自动清理 ${pruned.length} 个不可恢复的会话（进程已退出或无可恢复后端）`);
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
      if (isAdoptedSession(s)) {
        const pid = adoptedCliPid(s);
        return pid ? !isProcessAlive(pid) : !(s.pid && isProcessAlive(s.pid));
      }
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
    const originalPid = adoptedCliPid(s);

    // Kill botmux's worker process if running. For adopted sessions, never
    // kill the user's original CLI pid.
    if (s.pid && s.pid !== originalPid && isProcessAlive(s.pid)) {
      killProcess(s.pid);
      console.log(`  killed pid ${s.pid}`);
    }

    // Kill associated botmux-owned tmux session if it exists. Adopted panes
    // belong to the user and must be left untouched.
    const tmuxName = `bmx-${s.sessionId.substring(0, 8)}`;
    if (!isAdoptedSession(s)) {
      try {
        execSync(`tmux kill-session -t '${tmuxName}' 2>/dev/null`, { stdio: 'ignore', env: tmuxEnv() });
        console.log(`  killed tmux ${tmuxName}`);
      } catch { /* no tmux session */ }
    }

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

/** `botmux workflow start <runId>` — POST the daemon's v3 start IPC so the run
 *  is daemon-driven (humanGate → 飞书审批卡).  The grill skill calls this after
 *  approve-dag instead of the standalone `botmux v3 run` (which has no card
 *  layer).  Defaults the bot to the grill worker's BOTMUX_LARK_APP_ID env. */
async function cmdWorkflowStart(runId: string | undefined, rest: string[]): Promise<void> {
  if (!runId) {
    console.error('用法: botmux workflow start <runId> [--bot <larkAppId>]');
    process.exit(1);
  }
  const larkAppId = argValue(rest, '--bot') ?? process.env.BOTMUX_LARK_APP_ID;
  const daemon = findDaemon(larkAppId);
  if (!daemon) {
    console.error('❌ 没有在线 daemon；v3 humanGate run 需要 daemon 驱动（审批卡是 daemon 的活）。');
    process.exit(1);
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/v3/runs/${encodeURIComponent(runId)}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch (err: any) {
    console.error(`❌ 无法连接 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
    process.exit(1);
  }
  const txt = await res.text();
  if (!res.ok) {
    console.error(`❌ start 失败 (HTTP ${res.status}): ${txt}`);
    process.exit(1);
  }
  console.log(`✅ v3 run "${runId}" 已交 daemon 驱动；humanGate 会在话题里弹审批卡，点了才继续。`);
}

/** `botmux workflow retry <runId> [--node <id>]` — blocked 节点重试入口（CLI 侧）。
 *  走 daemon 的 retry IPC（journal 写入留在 daemon 进程内，单写者），daemon append
 *  `nodeRetryRequested` 后以新 attempt 重驱动。`resume` 动词归 v0.2，v3 用 retry 避撞。 */
async function cmdWorkflowRetry(runId: string | undefined, rest: string[]): Promise<void> {
  if (!runId) {
    console.error('用法: botmux workflow retry <runId> [--node <nodeId>] [--bot <larkAppId>]');
    process.exit(1);
  }
  const larkAppId = argValue(rest, '--bot') ?? process.env.BOTMUX_LARK_APP_ID;
  const nodeId = argValue(rest, '--node');
  const daemon = findDaemon(larkAppId);
  if (!daemon) {
    console.error('❌ 没有在线 daemon；blocked 重试需要 daemon 驱动。');
    process.exit(1);
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/v3/runs/${encodeURIComponent(runId)}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nodeId ? { nodeId } : {}),
    });
  } catch (err: any) {
    console.error(`❌ 无法连接 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
    process.exit(1);
  }
  const txt = await res.text();
  if (!res.ok) {
    if (txt.includes('loop_node_use_grant')) {
      console.error(`❌ 该受阻的是一个 loop（轮数耗尽），不是节点 attempt——用 \`botmux workflow grant ${runId}\` 追加一轮。`);
    } else {
      console.error(`❌ retry 失败 (HTTP ${res.status}): ${txt}`);
    }
    process.exit(1);
  }
  console.log(`🔄 v3 run "${runId}" 重试已受理，节点将以新 attempt 重跑。`);
}

/** `botmux workflow grant <runId> [--loop <id>]` — 耗尽 loop 追加一轮入口（CLI 侧）。
 *  与 retry 同构：走 daemon 的 grant IPC（单写者），daemon append
 *  `loopIterationGranted` 后重驱动，loop 带上一轮反馈再跑一轮。 */
async function cmdWorkflowGrant(runId: string | undefined, rest: string[]): Promise<void> {
  if (!runId) {
    console.error('用法: botmux workflow grant <runId> [--loop <loopId>] [--bot <larkAppId>]');
    process.exit(1);
  }
  const larkAppId = argValue(rest, '--bot') ?? process.env.BOTMUX_LARK_APP_ID;
  const loopId = argValue(rest, '--loop');
  const daemon = findDaemon(larkAppId);
  if (!daemon) {
    console.error('❌ 没有在线 daemon；loop 追加需要 daemon 驱动。');
    process.exit(1);
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/v3/runs/${encodeURIComponent(runId)}/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loopId ? { loopId } : {}),
    });
  } catch (err: any) {
    console.error(`❌ 无法连接 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
    process.exit(1);
  }
  const txt = await res.text();
  if (!res.ok) {
    console.error(`❌ grant 失败 (HTTP ${res.status}): ${txt}`);
    process.exit(1);
  }
  console.log(`➕ v3 run "${runId}" 已追加一轮，loop 将带上一轮反馈重跑。`);
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

/**
 * `botmux term-link [session-id|prefix]` — get the writable ("可操作") terminal
 * for an active session. The link carries a write token, so rather than print it
 * (where it could land in logs / shell history), the daemon delivers it as a
 * private card to the bot owner(s): an in-chat visible-to-you ephemeral card,
 * auto-falling back to a DM in topic / p2p chats. The CLI only ever sees delivery
 * counts — never the token. The daemon route is loopback-HMAC gated, signed here
 * with .dashboard-secret (same scheme as `botmux dashboard`).
 */
async function cmdTermLink(rest: string[]): Promise<void> {
  const target = rest[0];
  const active = [...loadSessions().values()].filter(s => s.status === 'active');
  if (active.length === 0) {
    console.error('没有活跃会话。可操作终端只能对 status=active 的会话获取（botmux list 查看）。');
    process.exit(1);
  }

  let session: SessionData;
  if (!target) {
    if (active.length === 1) {
      session = active[0];
    } else {
      console.error('用法: botmux term-link <session-id|prefix>');
      console.error(`  当前有 ${active.length} 个活跃会话，请指定其一：`);
      for (const s of active) console.error(`   ${s.sessionId.substring(0, 12)}  ${s.title}`);
      process.exit(1);
    }
  } else {
    const matches = active.filter(s => s.sessionId.startsWith(target));
    if (matches.length === 0) {
      console.error(`❌ 未找到匹配 "${target}" 的活跃会话（resume 已关闭的会话后再试）`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`❌ "${target}" 匹配了 ${matches.length} 个活跃会话，请提供更长的 ID 前缀：`);
      for (const s of matches) console.error(`   ${s.sessionId.substring(0, 12)}  ${s.title}`);
      process.exit(1);
    }
    session = matches[0];
  }

  // Multi-bot larkAppId guard (mirror of cmdResume): a legacy session without
  // larkAppId can't be routed deterministically when >1 daemon is online.
  if (!session.larkAppId) {
    const online = listOnlineDaemons();
    if (online.length > 1) {
      console.error(`❌ 会话 ${session.sessionId.substring(0, 12)} 缺少 larkAppId，多 bot 部署下无法判定归属。`);
      console.error(`   在线 daemon (${online.length}): ${online.map(d => d.larkAppId).join(', ')}`);
      process.exit(1);
    }
    if (online.length === 0) {
      console.error('❌ 没有在线 daemon。请先：botmux start');
      process.exit(1);
    }
  }

  const daemon = findDaemon(session.larkAppId);
  if (!daemon) {
    console.error('❌ 未找到在线 daemon。请确认 daemon 正在运行：botmux status');
    process.exit(1);
  }

  const SECRET_PATH = join(CONFIG_DIR, '.dashboard-secret');
  let secret: string | null;
  try {
    secret = loadDashboardSecret(SECRET_PATH);
  } catch (e) {
    console.error(`❌ 无法读取 .dashboard-secret：${(e as Error).message}`);
    process.exit(1);
  }
  if (!secret) {
    console.error('❌ 缺少或为空 .dashboard-secret（daemon 未初始化）。先 `botmux restart`。');
    process.exit(1);
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const sig = createHmac('sha256', secret).update(`${ts}:${nonce}`).digest('base64url');

  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${daemon.ipcPort}/api/sessions/${encodeURIComponent(session.sessionId)}/write-link-card`,
      { method: 'POST', headers: { 'X-Botmux-Cli-Ts': ts, 'X-Botmux-Cli-Nonce': nonce, 'X-Botmux-Cli-Auth': sig } },
    );
  } catch (err: any) {
    console.error(`❌ 无法连接到 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
    process.exit(1);
  }

  let body: any = {};
  try { body = await res.json(); } catch { /* */ }
  if (res.ok && body?.ok) {
    const chans: string[] = body.channels ?? [];
    const eph = chans.filter(c => c === 'ephemeral').length;
    const dm = chans.filter(c => c === 'dm').length;
    const via = [eph ? `${eph} 条群内私密卡` : '', dm ? `${dm} 条私聊 DM` : ''].filter(Boolean).join(' + ');
    console.log(`✅ 可操作终端卡片已私密发给 owner（${body.delivered}/${body.total}${via ? '：' + via : ''}）`);
    console.log(`   会话: ${session.sessionId.substring(0, 12)}  ${session.title}`);
    console.log('   卡片里「打开终端」即带写 token 进入；链接只走私密通道，不进群、不回显到这里。');
    return;
  }

  const errCode = body?.error ?? `HTTP ${res.status}`;
  if (errCode === 'unauthorized') {
    console.error('❌ 鉴权失败（loopback HMAC）。确认 .dashboard-secret 未变、daemon 已用同一份重启。');
  } else if (errCode === 'session_not_active') {
    console.error('❌ daemon 中该会话非活跃，无法获取可操作终端。');
  } else if (errCode === 'terminal_unavailable') {
    console.error('❌ 该会话终端尚未就绪（worker 未起或缺 token）。等会话起来再试。');
  } else if (errCode === 'no_owner') {
    console.error('❌ 该 bot 未配置 owner（allowedUsers 为空 / 全开放模式），没有可私密投递的对象。');
  } else if (errCode === 'delivery_failed') {
    console.error('❌ 卡片投递失败（ephemeral 与 DM 均失败）。查看 daemon 日志：botmux logs。');
  } else {
    console.error(`❌ 获取失败: ${errCode}`);
  }
  process.exit(1);
}

function showHelp(): void {
  console.log(`
botmux v${getVersion()} — IM ↔ AI 编程 CLI 桥接

命令:
  setup       交互式配置（首次使用 / 添加机器人）
              默认使用 botmux 内置 Feishu Web QR 登录尝试自动导入权限/redirect/发布版本；可加 --no-open-platform-auto 跳过
  start       启动 daemon
  stop        停止 daemon
  restart     重启 daemon（自动恢复活跃会话；--include-pm2 同时重启 PM2 God）
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
  term-link [id]   获取活跃会话的「可操作终端」（带写 token）。不回显链接，改由
                   daemon 把可操作卡片私密发给 owner（群内仅你可见，话题/单聊回退 DM）。
                   单个活跃会话可省略 id
  autostart enable     注册开机自启（macOS launchd / Linux user systemd / Windows Task Scheduler，无需 sudo）
  autostart disable    注销开机自启
  autostart status     查看自启状态
       unset             清除 worker 预算覆盖，恢复按机器 CPU/内存自动推导
  lang [zh|en]         切换 UI 语言（无参 = 查看当前设置）
       --bot N         仅改 bots.json 中第 N 个 bot 的 lang
       --unset         清除（global 或 --bot N 配合）
  voice                配置语音总结（高级功能，独立于 setup）— 交互式填 TTS 引擎+凭证
       voice status    查看当前语音配置（凭证打码）
       voice disable   关闭语音功能（移除配置）
  whiteboard status|enable|disable
                       本地项目白板（默认关闭；enable 只打开能力，不创建白板）
       current --create / list / read / update / write --yes

定时任务（可在 CLI 会话内自动推断 chat）:
  schedule list                        列出所有任务
  schedule add <schedule> <prompt>     添加任务（ex: "30m" / "every 2h" / "每日9:00" / "0 9 * * *"）
       --new-topic                     每次触发在同群开一个新话题、起独立会话（不续旧话题）
  schedule remove <id>                 删除任务
  schedule pause|resume <id>           暂停/恢复
  schedule run <id>                    标记立即执行

飞书消息（在 CLI 会话内自动推断 session）:
  send [content]                       发消息到当前话题（支持 stdin / --content-file）
       --images <path>                 内联图片（可重复）
       --files <path>                  附件（可重复）
       --mention <open_id:name>        @提及（可重复）
       --mention-back                  @回本轮触发消息的发送者（open_id 自动取自会话）
       --no-mention                    明确声明本条不@任何人
       --quote <message_id>            指定引用某条消息（普通群，默认引用本轮触发消息）
       --no-quote                      不引用，发独立消息（普通群）
       --voice "<口语文字>"            合成语音气泡发出（需先 botmux voice 配置 TTS）
       --top-level                     发顶层消息（不回复进当前话题）
       --chat-id <oc_xxx>              指定目标群（默认当前话题所在群）
       --attention[=kind]              举手：发消息的同时把本会话标进 dashboard
                                       「需要你」列并通知你——撞到只有你能解的硬阻碍
                                       （授权/拍板/缺权限）无法继续时用。消息正文即看板
                                       原因。kind=authz|decision|blocked(默认)|help。
                                       仅限回复当前会话，不能与 --top-level/--chat-id/--into
                                       /--voice 混用；用户回复后自动撤下。
       --anyway                        跳过「@ 到活跃子 bot」护栏强发（见下）
    @ 硬门：每条回复须三选一 --mention/--mention-back/--no-mention，否则报错不发。
    按内容价值选：有实质结论要对方看/确认/决策→--mention-back(或--mention点名)；
    纯记录/低优先级进度/简短确认→--no-mention；没信息量的"收到"不如不发。
    （可设 BOTMUX_REQUIRE_MENTION_DECISION=false 关闭硬门）
  bots list                            列出当前群聊中的机器人（含 open_id）
  history [--limit N] [--scope session|thread|chat|ambient]
                                       拉取当前会话的消息历史 (JSON)。默认按 session scope：话题/话题群 → 话题内，普通群 → 整群；
                                       thread 会话里可用 --scope ambient 读取 thread 外的群聊上下文
  quoted <message_id>                  拉取被引用的单条消息 (JSON)，message_id 取自 daemon 注入的引用提示行

新建飞书群:
  create-group --bot <name> [--bot ...] [--name "群名"]
                                       用指定 bot 起新群；详见 \`botmux create-group --help\`

预设分享（导出某 bot 的可分享配置给同事，绝不含密钥）:
  preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]
                                       导出 cliId/model/角色/能力标签 + 接入指引；
                                       默认 team 级角色，--from-chat 取某群角色内容；
                                       缺省写 ./<name或appid>.botmux-preset.json，--out - 走 stdout

配置目录: ~/.botmux/
文档: https://github.com/deepcoldy/botmux
`);
}

// ─── Schedule subcommands ────────────────────────────────────────────────────

/**
 * Resolve which botmux session this subcommand belongs to. Prefers the
 * process-tree CLI-pid marker (carries the fresh turnId); falls back to the
 * inherited BOTMUX_SESSION_ID env when the ancestry is broken (detached/
 * backgrounded/deeply-nested invocations). See resolveSessionContext for why
 * the env fallback is safe.
 */
function findAncestorSessionContext(): { sessionId: string; turnId?: string } | null {
  return resolveSessionContext(resolveDataDir(), process.env.BOTMUX_SESSION_ID);
}

function findAncestorSessionId(): string | null {
  return findAncestorSessionContext()?.sessionId ?? null;
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

/**
 * True when `flag` is present but lacks a usable value — i.e. it's the last
 * token, is followed by another flag, or was given as `--flag=` (empty). Lets
 * callers surface a friendly error instead of silently falling back to a
 * default (e.g. treating a value-less `--from-chat` as "no chat"). `allowDash`
 * permits a bare `-` value (used by `--out -` to mean stdout).
 */
function flagPresentButValueMissing(args: string[], flag: string, allowDash = false): boolean {
  const i = args.findIndex(a => a === flag || a.startsWith(flag + '='));
  if (i < 0) return false; // absent entirely — not "missing a value"
  if (args[i].startsWith(flag + '=')) return args[i].slice(flag.length + 1) === '';
  const next = args[i + 1];
  if (next === undefined) return true;
  if (next.startsWith('-')) return !(allowDash && next === '-');
  return false;
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

function readStdinUtf8(): string {
  // On a TTY, readFileSync(0) blocks waiting for terminal EOF (Ctrl+D) with no
  // prompt — `whiteboard update` with no text and no pipe looked frozen. Treat
  // a TTY as "no stdin input" so the caller's empty-content guard surfaces a
  // real error instead of an indefinite hang.
  if (process.stdin.isTTY) return '';
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

function currentWhiteboardContext(args: string[]): { session?: SessionData; larkAppId?: string; chatId?: string; workingDir?: string; sessionId?: string } {
  const sessionIdArg = argValue(args, '--session-id');
  const sessions = loadSessions();
  const sid = sessionIdArg || findAncestorSessionId() || undefined;
  const session = sid ? sessions.get(sid) : undefined;
  return {
    session,
    sessionId: session?.sessionId ?? sid,
    larkAppId: argValue(args, '--lark-app-id', '--app-id') ?? session?.larkAppId ?? process.env.LARK_APP_ID,
    chatId: argValue(args, '--chat-id') ?? session?.chatId,
    workingDir: argValue(args, '--working-dir', '--repo') ?? session?.workingDir ?? process.cwd(),
  };
}

function requireWhiteboardEnabled(): void {
  if (whiteboardEnabled()) return;
  console.error('Whiteboard is disabled. Enable it with `botmux whiteboard enable` or the dashboard Settings page.');
  process.exit(2);
}

// Boolean flags valid on `read`/`update`/`write` that must NOT be parsed as
// value-taking. Without this hint, `positionals()` treats e.g. a bare `--yes`
// as a value flag and swallows the *following* positional arg as its "value" —
// the content ends up empty and the board is silently blanked (a shared
// current-state snapshot lost with no history). `--create` belongs to
// `current`, `--yes` to `write`, `--json` to `read`; all harmless to declare
// together so content parsing never mis-eats a flag's neighbor.
const WHITEBOARD_BOOLEAN_FLAGS = ['--create', '--yes', '--json'];

function whiteboardContentFromArgs(args: string[], booleanFlags: string[] = []): string {
  const file = argValue(args, '--content-file', '--file');
  if (file) return readFileSync(file, 'utf-8');
  const pos = positionals(args, booleanFlags);
  return pos.length > 0 ? pos.join(' ') : readStdinUtf8();
}

/** Translate store-level whiteboard write errors into friendly CLI exits. The
 *  store throws stable machine codes (whiteboard_cas_mismatch /
 *  whiteboard_empty_content / whiteboard_not_found); map each to a clear,
 *  actionable message so an agent or human reading stderr knows what to do
 *  next instead of seeing a bare code. Always exits. */
function handleWhiteboardWriteError(e: unknown, id: string): never {
  const msg = (e as Error)?.message ?? String(e);
  if (msg === 'whiteboard_cas_mismatch') {
    console.error(
      `Whiteboard was modified since you last read it (CAS mismatch). Re-run ` +
      `\`botmux whiteboard read --id ${id} --json\` to get the latest content ` +
      `+ updatedAt, re-merge your changes against it, then update again with ` +
      `--expected-updated-at <new updatedAt>.`,
    );
    process.exit(2);
  }
  if (msg === 'whiteboard_empty_content') {
    console.error('Refusing to write empty whiteboard content. Pass text as args, pipe stdin, or use --content-file <path>. (The board is a shared current-state snapshot and cannot be blanked.)');
    process.exit(2);
  }
  if (msg === 'whiteboard_not_found') {
    console.error(`Whiteboard not found: ${id}`);
    process.exit(1);
  }
  console.error(`Whiteboard write failed: ${msg}`);
  process.exit(1);
}

async function cmdWhiteboard(sub: string, rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const action = sub || 'status';
  if (action === 'help' || action === '--help' || action === '-h') {
    console.log(`botmux whiteboard <command>

Commands:
  status                       Show whether whiteboard is enabled
  enable | disable             Toggle optional whiteboard feature (does not create boards)
  list                         List local whiteboards (read-only, even when disabled)
  current [--create]           Show current default board; --create ensures it when enabled
  create [--id ID] [--title T] Create a board for current/bound context
  read [--id ID] [--json]      Read board.md (requires enabled). --json emits
                               { id, updatedAt, content } so a caller can CAS on update
  path [--id ID]               Print board/meta/log paths
  update [--id ID] [text...]   Replace board.md current state (or stdin / --content-file).
                               --expected-updated-at <ts> refuses the write if the board
                               changed since that version (CAS); exit 2 with a re-read hint
  write --yes [--id ID] ...    Force-overwrite board.md; --yes required. Also honors
                               --expected-updated-at when supplied

Context flags: --session-id, --lark-app-id, --chat-id, --working-dir/--repo`);
    return;
  }

  if (action === 'status') {
    console.log(JSON.stringify({ enabled: whiteboardEnabled(), count: listWhiteboards().length }, null, 2));
    return;
  }
  if (action === 'enable' || action === 'on') {
    mergeGlobalConfig({ whiteboard: { enabled: true } as any });
    console.log('Whiteboard enabled. No board was created; a board is ensured only when first needed.');
    return;
  }
  if (action === 'disable' || action === 'off') {
    mergeGlobalConfig({ whiteboard: { enabled: false } as any });
    console.log('Whiteboard disabled. Existing boards remain on disk and dashboard can show history read-only.');
    return;
  }
  if (action === 'list' || action === 'ls') {
    const boards = listWhiteboards().map(b => ({ id: b.id, title: b.title, scope: b.scope, larkAppId: b.larkAppId, chatId: b.chatId, workingDir: b.workingDir, updatedAt: b.updatedAt, path: b.path }));
    console.log(JSON.stringify({ enabled: whiteboardEnabled(), boards }, null, 2));
    return;
  }

  if (action === 'current') {
    requireWhiteboardEnabled();
    const id = argValue(rest, '--id');
    if (id) {
      const meta = getWhiteboard(id);
      if (!meta) { console.error(`Whiteboard not found: ${id}`); process.exit(1); }
      console.log(JSON.stringify({ enabled: true, current: meta, path: whiteboardPath(id) }, null, 2));
      return;
    }
    const ctx = currentWhiteboardContext(rest);
    let meta = ctx.session?.whiteboardId ? getWhiteboard(ctx.session.whiteboardId) : undefined;
    if (!meta && argFlag(rest, '--create')) {
      meta = ensureDefaultWhiteboard({ larkAppId: ctx.larkAppId, chatId: ctx.chatId, workingDir: ctx.workingDir, sessionId: ctx.sessionId });
      if (ctx.session) { ctx.session.whiteboardId = meta.id; saveSession(ctx.session); }
    }
    if (!meta) {
      console.log(JSON.stringify({ enabled: true, current: null, hint: 'Run `botmux whiteboard current --create` to ensure the default board.' }, null, 2));
      return;
    }
    console.log(JSON.stringify({ enabled: true, current: meta, path: whiteboardPath(meta.id) }, null, 2));
    return;
  }

  if (action === 'create') {
    requireWhiteboardEnabled();
    const ctx = currentWhiteboardContext(rest);
    const meta = createWhiteboard({ id: argValue(rest, '--id'), title: argValue(rest, '--title'), larkAppId: ctx.larkAppId, chatId: ctx.chatId, workingDir: ctx.workingDir, sessionId: ctx.sessionId });
    if (ctx.session && !ctx.session.whiteboardId) { ctx.session.whiteboardId = meta.id; saveSession(ctx.session); }
    console.log(JSON.stringify({ board: meta, path: whiteboardPath(meta.id) }, null, 2));
    return;
  }

  // Anything reaching here must be one of the file-operating subcommands; the
  // earlier branches (help/status/enable/disable/list/current/create) already
  // returned. Reject unknown actions BEFORE computing an id — otherwise a typo
  // like `post` fell through to the misleading "No whiteboard id" error.
  if (!['read', 'path', 'update', 'write'].includes(action)) {
    console.error(`Unknown whiteboard command: ${action}`);
    process.exit(1);
  }
  if (['read', 'update', 'write'].includes(action)) requireWhiteboardEnabled();

  const explicitId = argValue(rest, '--id');
  const ctx = currentWhiteboardContext(rest);
  let id = explicitId ?? ctx.session?.whiteboardId;
  if (!id && whiteboardEnabled() && action === 'update') {
    const meta = ensureDefaultWhiteboard({ larkAppId: ctx.larkAppId, chatId: ctx.chatId, workingDir: ctx.workingDir, sessionId: ctx.sessionId });
    id = meta.id;
    if (ctx.session) { ctx.session.whiteboardId = id; saveSession(ctx.session); }
  }
  if (!id) { console.error('No whiteboard id. Pass --id or run `botmux whiteboard current --create`.'); process.exit(1); }

  if (action === 'read') {
    requireWhiteboardEnabled();
    // Default: stream raw board.md to stdout (back-compat for agents/skills
    // that treat stdout as the board content). `--json` returns
    // { id, updatedAt, content } so an agent can capture the version it read
    // and pass it back as --expected-updated-at on update — the compare-and-set
    // that turns the read→merge→update flow from blind last-writer-wins into a
    // conflict-detecting update.
    if (argFlag(rest, '--json')) {
      const meta = getWhiteboard(id);
      if (!meta) { console.error(`Whiteboard not found: ${id}`); process.exit(1); }
      console.log(JSON.stringify({ id: meta.id, updatedAt: meta.updatedAt, content: readWhiteboard(id) }));
    } else {
      process.stdout.write(readWhiteboard(id));
    }
    return;
  }
  if (action === 'path') {
    const meta = getWhiteboard(id);
    if (!meta) { console.error(`Whiteboard not found: ${id}`); process.exit(1); }
    console.log(JSON.stringify({ board: meta, path: whiteboardPath(id) }, null, 2));
    return;
  }
  if (action === 'update') {
    requireWhiteboardEnabled();
    const content = whiteboardContentFromArgs(rest, WHITEBOARD_BOOLEAN_FLAGS);
    if (!content.trim()) {
      console.error('Refusing to write empty whiteboard content. Pass text as args, pipe stdin, or use --content-file <path>. (The board is a shared current-state snapshot and cannot be blanked.)');
      process.exit(2);
    }
    // Optional CAS: the agent passes the updatedAt it observed at read time.
    // If the board changed in between, the store refuses with
    // whiteboard_cas_mismatch → friendly exit 2 so the agent re-reads/merges
    // instead of silently clobbering the other writer's update.
    const expectedUpdatedAt = argValue(rest, '--expected-updated-at');
    const { writeWhiteboard } = await import('./services/whiteboard-store.js');
    try {
      const meta = writeWhiteboard(id, content, { actor: ctx.sessionId, kind: 'update', expectedUpdatedAt });
      console.log(JSON.stringify({ ok: true, board: meta }, null, 2));
    } catch (e) {
      handleWhiteboardWriteError(e, id);
    }
    return;
  }
  if (action === 'write') {
    requireWhiteboardEnabled();
    if (!argFlag(rest, '--yes')) {
      console.error('Refusing to overwrite whiteboard without --yes. Prefer `botmux whiteboard update` for current-state updates.');
      process.exit(2);
    }
    const content = whiteboardContentFromArgs(rest, WHITEBOARD_BOOLEAN_FLAGS);
    if (!content.trim()) {
      console.error('Refusing to write empty whiteboard content. Pass text as args, pipe stdin, or use --content-file <path>. (The board is a shared current-state snapshot and cannot be blanked.)');
      process.exit(2);
    }
    // `write --yes` is the human force-overwrite escape hatch, but if a CAS
    // version is supplied we still honor it — a conscious writer that knows
    // the base version should still get a conflict signal rather than clobber.
    const expectedUpdatedAt = argValue(rest, '--expected-updated-at');
    const { writeWhiteboard } = await import('./services/whiteboard-store.js');
    try {
      const meta = writeWhiteboard(id, content, { actor: ctx.sessionId, expectedUpdatedAt });
      console.log(JSON.stringify({ ok: true, board: meta }, null, 2));
    } catch (e) {
      handleWhiteboardWriteError(e, id);
    }
    return;
  }

  console.error(`Unknown whiteboard command: ${action}`);
  process.exit(1);
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
    const [rawSchedule, ...promptParts] = positionals(rest, ['--new-topic']);
    if (!rawSchedule) {
      console.error('用法: botmux schedule add <schedule> <prompt> [--name NAME] [--chat-id CHAT] [--root-msg-id ROOT] [--lark-app-id APP] [--workdir DIR] [--new-topic]');
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
    // --new-topic: every fire opens a brand-new topic in a fresh session.
    const deliver: 'origin' | 'local' | 'new-topic' = rest.includes('--new-topic')
      ? 'new-topic'
      : ((argValue(rest, '--deliver') as 'origin' | 'local' | 'new-topic' | undefined) ?? 'origin');

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
    console.log(`   话题: ${deliver === 'new-topic' ? '(每次新开话题，独立会话)' : rootMessageId ?? '(将新开)'}`);
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
// keeps using `buildImageCardElements` from there.
import { buildImageCardElements, brandFooterSegment } from './im/lark/md-card.js';
import { applyInlineMentions } from './im/lark/inline-mentions.js';
import { resolveBrandLabel } from './bot-registry.js';
import { config } from './config.js';
import { resolveQuoteTarget, validateMentionDecision, parseAttentionFlag, attentionUsageError } from './services/send-policy.js';

/**
 * Sandbox relay mode for `botmux send`. Inside a file-sandbox the CLI cannot
 * read bots.json or reach Lark directly (creds are deliberately absent), so we
 * hand the send to the daemon-side outbox watcher (adapters/backend/sandbox.ts
 * startOutboxWatcher), which re-runs `send` OUTSIDE the sandbox with the
 * worker's creds. Forward the argv verbatim (content via a file in the shared
 * outbox), then block on the response file and mirror its result.
 */
async function relaySend(rest: string[], relayDir: string): Promise<void> {
  const sid = argValue(rest, '--session-id') ?? process.env.BOTMUX_SESSION_ID;
  if (!sid) { console.error('relay: 无法确定 session-id'); process.exit(1); }
  // Resolve content with the same precedence as cmdSend (content-file > positional > stdin)
  const contentFile = argValue(rest, '--content-file');
  let content = '';
  if (contentFile) {
    content = existsSync(contentFile) ? readFileSync(contentFile, 'utf-8') : '';
  } else {
    const pos = positionals(rest, ['--card', '--text', '--top-level', '--no-quote', '--mention-back', '--no-mention', '--anyway', '--voice']);
    content = pos.length > 0 ? pos.join(' ') : await readStdin();
  }
  const id = randomBytes(8).toString('hex');
  // Structured request: the daemon-side watcher rebuilds the argv from these
  // validated fields (it NEVER executes raw argv — see buildRelayHostArgs).
  // Content + attachments are written into the shared outbox as plain
  // basenames; the watcher validates they stay inside the outbox, allowlists
  // the flags, and forces the session-id. This is what keeps creds out of the
  // sandbox: the sandbox can't make the host read an arbitrary path.
  const contentBase = `${id}.content`;
  const cfile = join(relayDir, contentBase);
  writeFileSync(cfile, content);

  // Copy any --image/--file attachment into the outbox; carry only basenames.
  const attachments: string[] = [];
  for (const p of argValues(rest, '--image', '--images', '--file', '--files')) {
    if (!p || !existsSync(p)) continue;
    const base = `${id}-${randomBytes(4).toString('hex')}-${basename(p)}`;
    try { writeFileSync(join(relayDir, base), readFileSync(p)); attachments.push(base); } catch { /* skip unreadable */ }
  }

  // Forward only presentation flags (must match the watcher's allowlist); path,
  // routing (--chat-id/--into/--top-level) and --session-id flags are dropped —
  // content/attachments come from the outbox and session-id is forced host-side.
  const FLAGS_NOVAL = new Set(['--mention-back', '--no-mention', '--no-quote', '--voice']);
  const FLAGS_VAL = new Set(['--mention', '--quote']);
  const flags: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (FLAGS_NOVAL.has(tok)) flags.push(tok);
    else if (FLAGS_VAL.has(tok) && i + 1 < rest.length) flags.push(tok, rest[++i]);
    // else dropped
  }
  // 原子写：req.json 是 host watcher 的触发文件，rename 让它「完整出现」，
  // watcher 永远不会读到半截 JSON（tmp 后缀不匹配 .req.json 过滤）。
  atomicWriteFileSync(join(relayDir, `${id}.req.json`), JSON.stringify({ contentFile: contentBase, attachments, flags }));

  const resPath = join(relayDir, `${id}.res.json`);
  const deadlineMs = Date.now() + 120_000;
  while (Date.now() < deadlineMs) {
    if (existsSync(resPath)) {
      try {
        const res = JSON.parse(readFileSync(resPath, 'utf-8')) as { code?: number; stdout?: string; stderr?: string };
        try { unlinkSync(resPath); } catch { /* */ }
        try { unlinkSync(cfile); } catch { /* */ }
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.code ?? 0);
      } catch { /* partial write — retry next tick */ }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.error('relay: 等待 daemon 投递超时（120s）');
  process.exit(1);
}

async function cmdSend(rest: string[]): Promise<void> {
  // Sandbox relay: a file-sandboxed session has no creds/bots.json, so route
  // the send through the daemon-side outbox instead of delivering directly.
  const relayDir = process.env.BOTMUX_SEND_RELAY;
  if (relayDir) { await relaySend(rest, relayDir); return; }
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
  // stdin can't be both the message body (which `botmux send` reads from it) and
  // a `--file`/`--image` attachment — the second read sees EOF and the upload
  // fails *after* the message is already sent, leaving the caller to resend.
  // Reject up front so exit≠0 reliably means "nothing was sent".
  const stdinAlias = findStdinAliasAttachment([...images, ...files]);
  if (stdinAlias) {
    console.error(
      `不能把 stdin（${stdinAlias}）当作 --file/--image 附件：botmux send 已从 stdin 读取消息正文，\n` +
      `同一个 stdin 没法既当正文又当附件（第二次读到的是 EOF）。\n` +
      `要发送管道内容，先落到临时文件：  数据来源 > /tmp/x && botmux send --files /tmp/x …`,
    );
    process.exit(1);
  }
  const mentionArgs = argValues(rest, '--mention');  // "open_id:Display Name"
  const contentFile = argValue(rest, '--content-file');
  // 回复一律走交互卡片。`--card` / `--text` 是隐藏的旧脚本兼容 no-op：纯文本
  // post 路径已删除，只有卡片能承载「🔊 语音总结」按钮，且守护进程兜底也一直只发卡片。
  // Publish-mode flags: post a fresh top-level message in a chat instead of
  // replying into the bound thread. Lets a session "publish" to a different
  // chat (e.g. a public release-notes group) while keeping its own thread
  // for streaming-card / progress UI.
  const sendTopLevel = rest.includes('--top-level');
  const overrideChatId = argValue(rest, '--chat-id');
  // --into <话题根id>: reply this send into a specific topic (a sub-bot's topic,
  // another thread, etc.) instead of the session's own location. Wins over the
  // auto/scope default; `dispatch` opens topics, `send --into` posts into them.
  const sendInto = argValue(rest, '--into');
  // --voice: synthesize the content into a Feishu voice bubble instead of a
  // text/card message. The content should be spoken-style prose (the 🔊 button
  // injects a condense-first instruction before the model calls this).
  const asVoice = rest.includes('--voice');
  // Quote chain (chat scope): --quote <message_id> overrides the auto target,
  // --no-quote forces a plain (un-quoted) send.
  const explicitQuote = argValue(rest, '--quote');
  const noQuote = rest.includes('--no-quote');
  // @ hard-gate: every reply must explicitly choose one of these.
  const mentionBack = rest.includes('--mention-back');
  const noMention = rest.includes('--no-mention');
  // --attention[=kind]: raise a hand — post this message AND light the dashboard
  // needs-you column for this session. Parsed specially (not argValue) so a bare
  // `--attention "我卡住了"` doesn't eat the message as the flag value.
  const attention = parseAttentionFlag(rest);

  const ancestorCtx = findAncestorSessionContext();
  const sid = sessionIdArg ?? ancestorCtx?.sessionId ?? null;
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题内的 CLI 会话中运行，或传 --session-id <id>。');
    process.exit(1);
  }

  const sessions = loadSessions();
  const currentTurnId = ancestorCtx?.turnId ?? process.env.BOTMUX_TURN_ID;
  const s = sessions.get(sid);
  if (!s) { console.error(`未找到 session ${sid}`); process.exit(1); }
  if (!s.larkAppId) { console.error(`session ${sid} 缺少 larkAppId`); process.exit(1); }

  // Read content from: --content-file > positional arg > stdin
  let content = '';
  if (contentFile) {
    if (!existsSync(contentFile)) { console.error(`文件不存在: ${contentFile}`); process.exit(1); }
    content = readFileSync(contentFile, 'utf-8');
  } else {
    const pos = positionals(rest, ['--card', '--text', '--top-level', '--no-quote', '--mention-back', '--no-mention', '--anyway', '--voice', '--attention']);
    if (pos.length > 0) {
      content = pos.join(' ');
    } else {
      content = await readStdin();
    }
  }
  if (!contentFile) rejectLikelyWindowsStdinMojibake(content);

  if (!content.trim() && images.length === 0 && files.length === 0) {
    console.error('没有内容可发送。用法:\n  echo "消息" | botmux send\n  botmux send "消息"\n  botmux send --content-file /tmp/msg.md --images /tmp/chart.png');
    process.exit(1);
  }

  // --attention guard: only valid replying into the current session with a text
  // reason (clear-on-reply binds to this anchor; dashboard needs a reason).
  const attentionErr = attentionUsageError({
    requested: attention.requested,
    sendTopLevel,
    overrideChatId,
    sendInto,
    asVoice,
    hasText: !!content.trim(),
  });
  if (attentionErr) { console.error(`botmux send: ${attentionErr}`); process.exit(2); }

  // ── Voice mode ──────────────────────────────────────────────────────────
  // Synthesize the (already-condensed, colloquial) content into a Feishu voice
  // bubble and return. Deliberately bypasses the text/card path's mentions,
  // footer, and @-hard-gate — a voice bubble addresses nobody. Lands in the
  // same thread/chat the session would normally reply to.
  if (asVoice) {
    if (!content.trim()) { console.error('--voice 需要要朗读的文字'); process.exit(1); }
    const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
    try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
    const { uploadFile, sendMessage, replyMessage } = await import('./im/lark/client.js');
    const { synthesizeVoiceOpus } = await import('./services/voice/index.js');
    const { rmSync } = await import('node:fs');
    const appId = s.larkAppId!;
    const targetChatId = overrideChatId ?? s.chatId;
    const target = resolveSendTarget({ into: sendInto, topLevel: sendTopLevel, chatScope: s.scope === 'chat', chatId: targetChatId, rootMessageId: s.rootMessageId, replyTargetRootId: s.currentReplyTarget?.rootMessageId, replyTargetTurnId: s.currentReplyTarget?.turnId, currentTurnId });
    const sendAudio = (fileKey: string): Promise<string> =>
      target.mode === 'plain'
        ? sendMessage(appId, target.chatId, JSON.stringify({ file_key: fileKey }), 'audio')
        : replyMessage(appId, target.rootMessageId, JSON.stringify({ file_key: fileKey }), 'audio', true);
    let dir: string | undefined;
    try {
      const out = await synthesizeVoiceOpus(appId, content);
      dir = out.dir;
      const fileKey = await uploadFile(appId, out.path, { duration: out.durationMs });
      const sentAtMs = Date.now();
      const messageId = await sendAudio(fileKey);
      // 语音也是一次回复：写 bridge fallback marker，否则本轮会被判为"没发 botmux send"
      // 而触发兜底，多补一张文本卡。与文本/卡片路径同口径：仅同话题回复才记。
      if (!sendTopLevel && !overrideChatId && !sendInto) {
        try {
          const markerDir = join(resolveDataDir(), 'turn-sends');
          if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
          appendFileSync(join(markerDir, `${sid}.jsonl`), JSON.stringify({ sentAtMs, messageId }) + '\n');
        } catch { /* best-effort：漏记只多一条兜底，不致命 */ }
      }
      console.error(`✓ 已发送语音 ${messageId} ｜ ${Math.round(out.durationMs / 1000)}s`);
      console.log(JSON.stringify({ success: true, messageId, sessionId: sid, kind: 'voice', durationMs: out.durationMs }));
    } catch (e: any) {
      console.error(`语音发送失败：${e?.message ?? e}`);
      if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
      process.exit(1);
    }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
    return;
  }

  // ── 文档评论入口分流（/subscribe-lark-doc）──────────────────────────────────
  // 本轮若由飞书文档评论触发（daemon 已把落点写进 session.currentDocCommentTarget），
  // 把用户可见回复发表为飞书文档评论，而非发回飞书会话。绕过 @ 硬门（评论不 @ 飞书
  // 用户）。显式改路由（--top-level / --chat-id / --into）时不分流，让模型仍能主动
  // 「磁盘上有 currentDocCommentTarget」即权威信号=本轮是文档评论轮（beginNewTurn
  // 在飞书轮已清盘）。故只看 docTarget 存在 + 无显式改路由，不再卡 turnId 相等
  // （之前 currentTurnId 取自 cliPidMarker，文档轮里取值不稳导致误判落到 @ 硬门）。
  const docTarget = s.currentDocCommentTarget;
  if (docTarget && !sendTopLevel && !overrideChatId && !sendInto) {
    const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
    try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
    const { replyToDocComment, chunkCommentText } = await import('./im/lark/doc-comment.js');
    const appId = s.larkAppId!;
    const loc = localeForBot(appId);
    try {
      // @ 落点：--mention-back → 回 @ 原评论人；--mention <open_id[:name]> → @ 指定人；
      // 否则（--no-mention / 无）不 @。文档评论里靠 person 元素渲染 @，仅首块加。
      let docMentionOpenId: string | undefined;
      if (mentionBack) docMentionOpenId = docTarget.replyToOpenId;
      else if (mentionArgs.length > 0) {
        const first = mentionArgs[0];
        const idx = first.indexOf(':');
        docMentionOpenId = (idx > 0 ? first.slice(0, idx) : first).trim() || undefined;
      }
      // 嵌套回复到用户那条评论 thread（已挂其下，无需 ↪ 前缀）。
      const chunks = chunkCommentText(content);
      for (let i = 0; i < chunks.length; i++) {
        await replyToDocComment(appId, { fileToken: docTarget.fileToken, fileType: docTarget.fileType }, docTarget.commentId, chunks[i], i === 0 ? docMentionOpenId : undefined);
      }
      // 写 bridge send marker → 抑制 worker 的 final_output 兜底（否则会再补一条评论）。
      try {
        const markerDir = join(resolveDataDir(), 'turn-sends');
        if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
        appendFileSync(join(markerDir, `${sid}.jsonl`), JSON.stringify({ sentAtMs: Date.now(), messageId: `doc:${docTarget.commentId}`, contentLength: content.length }) + '\n');
      } catch { /* best-effort：漏记只多一条兜底 */ }
      console.error(`✓ 已回复文档评论 ${docTarget.commentId.slice(0, 12)}（${chunks.length} 条）`);
      console.log(JSON.stringify({ success: true, commentId: docTarget.commentId, sessionId: sid, kind: 'doc-comment', chunks: chunks.length }));
    } catch (e: any) {
      console.error(`文档评论发送失败：${e?.message ?? e}`);
      process.exit(1);
    }
    return;
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

  // @ hard-gate (config.send.requireMentionDecision, default on): force the
  // model to make an explicit @ decision before sending. --top-level publish
  // is exempt. The error text adapts to who is being replied to (人 / bot).
  const mentionGate = validateMentionDecision({
    enabled: config.send.requireMentionDecision,
    sendTopLevel,
    hasMentionArgs: mentionArgs.length > 0,
    mentionBack,
    noMention,
    hasQuoteTargetSender: !!s.quoteTargetSenderOpenId,
  });
  if (!mentionGate.ok) { console.error(mentionGate.error); process.exit(2); }

  // --mention-back: @ the sender of the message this turn is replying to
  // (open_id from the session — model needn't know it). Bare-name form so it
  // renders as a trailing <at>.
  if (mentionBack && s.quoteTargetSenderOpenId
      && !mentions.some(m => m.open_id === s.quoteTargetSenderOpenId)) {
    mentions.push({ open_id: s.quoteTargetSenderOpenId, name: '' });
  }

  // Validate file paths
  for (const p of [...images, ...files]) {
    if (!existsSync(p)) { console.error(`文件不存在: ${p}`); process.exit(1); }
  }

  // Register bots so Lark client works
  const { registerBot, loadBotConfigs, findOncallChatForAnyBot } = await import('./bot-registry.js');
  try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }

  const { sendMessage, replyMessage, uploadImage, uploadFile, MessageWithdrawnError } = await import('./im/lark/client.js');
  const appId = s.larkAppId!;
  // Effective target chat for top-level mode (defaults to session's chat)
  const targetChatId = overrideChatId ?? s.chatId;
  // Chat-scope sessions (普通群整群一会话) post to chatId without
  // reply_in_thread, otherwise Lark would force every reply into a fresh
  // topic — defeating the whole point of chat-scope routing.
  const isChatScope = s.scope === 'chat';

  // ── Footgun guard: orchestrator → sub-bot ──
  // A dispatched sub-bot's session lives in its sub-topic; @-ing it from the main
  // chat spawns a fresh, context-less one. The check is computed ONCE and applied
  // at BOTH mention sources: explicit --mention/--mention-back (blocked here) AND
  // the prose @Name auto-injection further down (dropped there) — so a prose
  // `@OtherSubBot` can't slip past after this explicit guard already ran.
  let dispatchReg: Record<string, { orchChatId?: string; bots?: string[] }> = {};
  try {
    const regPath = join(resolveDataDir(), 'orchestrate-dispatch.json');
    if (existsSync(regPath)) dispatchReg = JSON.parse(readFileSync(regPath, 'utf-8'));
  } catch { /* no/!corrupt registry → no guard */ }
  const dispatchActiveSeeds = new Set<string>();
  if (Object.keys(dispatchReg).length > 0) {
    for (const sess of loadSessions().values()) {
      if (sess.status === 'active' && sess.scope !== 'chat' && sess.rootMessageId) {
        dispatchActiveSeeds.add(sess.rootMessageId);
      }
    }
  }
  // Sub-topic seed if `openId` is a dispatched sub-bot in an active topic that is
  // NOT reachable in the current conversation; else null. The bot I'm replying to
  // here (quoteTargetSenderOpenId) is reachable, so it's never treated as off-topic.
  const offTopicSubBotSeed = (openId: string): string | null =>
    offTopicSubBotTopic({ mentionOpenId: openId, quoteTargetSenderOpenId: s.quoteTargetSenderOpenId, chatId: targetChatId, registry: dispatchReg, activeSeeds: dispatchActiveSeeds });
  // Explicit --mention / --mention-back of an off-topic sub-bot → block + point to
  // the right command (--anyway overrides). Prose @Name injection is filtered
  // (dropped, not blocked) at its own site below.
  // Inform, don't block: if @-ing a bot whose session lives in a sub-topic, this
  // send lands a NEW conversation at the current location. To reply into that
  // topic instead, use `--into <seed>`. The model picks the destination — no hard
  // block (that was too aggressive; @-ing a bot in the group to start a fresh
  // conversation is a legitimate, common intent).
  for (const m of mentions) {
    const seed = offTopicSubBotSeed(m.open_id);
    if (seed) {
      console.error(`ℹ️ ${m.open_id}${m.name ? `（${m.name}）` : ''} 在子话题 ${seed} 里也有会话；本条发到当前位置（新对话）。要发进那个话题改用 --into ${seed}。`);
    }
  }

  // Oncall addressing only meaningful for replies inside the session's own
  // chat — skip when publishing top-level or to a different chat. Treat
  // oncall as chat-level: in multi-daemon setups this session's bot may not
  // be the one that persisted the binding, but users still expect footer
  // addressing to go to the last caller in the shared oncall workspace.
  const oncallEntry = !sendTopLevel && !overrideChatId && !sendInto && s.chatId
    ? findOncallChatForAnyBot(s.chatId) : undefined;

  const hookContext = {
    sessionId: sid,
    chatId: s.chatId,
    rootMessageId: s.rootMessageId,
    title: s.title,
  };
  // Dispatch helper: top-level / chat-scope send vs reply-in-thread, single
  // decision point. Used for file attachments (always plain in chat scope).
  const sendTarget = resolveSendTarget({ into: sendInto, topLevel: sendTopLevel, chatScope: isChatScope, chatId: targetChatId, rootMessageId: s.rootMessageId, replyTargetRootId: s.currentReplyTarget?.rootMessageId, replyTargetTurnId: s.currentReplyTarget?.turnId, currentTurnId });
  const dispatch = (content: string, msgType: string): Promise<string> =>
    sendTarget.mode === 'plain'
      ? sendMessage(appId, sendTarget.chatId, content, msgType, undefined, hookContext)
      : replyMessage(appId, sendTarget.rootMessageId, content, msgType, true, undefined, hookContext);
  const recordBridgeSendMarker = (sentAtMs: number, messageId: string, sentContent: string): void => {
    try {
      const markerDir = join(resolveDataDir(), 'turn-sends');
      if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
      const marker: Record<string, unknown> = { sentAtMs, messageId };
      Object.assign(marker, buildBridgeSendMarkerContent(sentContent));
      const line = JSON.stringify(marker) + '\n';
      appendFileSync(join(markerDir, `${sid}.jsonl`), line);
    } catch { /* best-effort: marker miss only causes a redundant fallback message */ }
  };

  const shouldRecordBridgeMarker = !sendTopLevel && !overrideChatId && !sendInto;

  // Quote chain (普通群): the primary message replies to the turn's target so
  // Lark renders a 引用 chain. --quote overrides, --no-quote opts out. Thread
  // scope and --top-level never quote. Withdrawn target → fall back to plain.
  const quoteTargetId = sendInto || sendTarget.mode === 'thread' ? undefined : resolveQuoteTarget({
    isChatScope, sendTopLevel, noQuote, explicitQuote,
    sessionQuoteTargetId: s.quoteTargetId,
  });
  let primaryQuotedId: string | null = null;
  const dispatchPrimary = async (content: string, msgType: string): Promise<string> => {
    const result = await dispatchPrimaryMessage(
      { sendMessage, replyMessage },
      {
        appId,
        targetChatId,
        quoteTargetId,
        content,
        msgType,
        hookContext,
        MessageWithdrawnError,
        dispatch,
        onQuoteWithdrawn: (id) => {
          console.error(`引用目标 ${id} 已撤回，改为普通发送`);
        },
      },
    );
    primaryQuotedId = result.primaryQuotedId;
    return result.messageId;
  };

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
    let botEntries: BotMentionEntry[] = [];
    let crossRef: Record<string, string> = {};
    try {
      const dataDir = resolveDataDir();
      const botInfoPath = join(dataDir, 'bots-info.json');
      botEntries = existsSync(botInfoPath) ? JSON.parse(readFileSync(botInfoPath, 'utf-8')) : [];
      const crossRefPath = join(dataDir, `bot-openids-${appId}.json`);
      crossRef = existsSync(crossRefPath)
        ? JSON.parse(readFileSync(crossRefPath, 'utf-8'))
        : {};
      // --no-mention 显式不 @ 任何人：跳过正文 @BotName 的自动注入，否则正文里
      // 出现的 @名字 仍会被注入成 <at>，破坏 --no-mention 语义、还可能误触发对方
      // bot（正是要避免的循环 @）。botEntries/crossRef 仍需加载供 footer 寻址用。
      if (!noMention) {
      const alreadyMentioned = new Set(mentions.map(m => m.open_id));
      // Sort by name length desc so longer names ("Claude分身") win over their
      // prefix ("Claude") when both could match — break-on-first-hit otherwise
      // routes "@Claude分身" to Claude.
      const sortedEntries = [...botEntries].sort(
        (a, b) => (b.botName?.length ?? 0) - (a.botName?.length ?? 0),
      );
      const selfAliases = new Set(
        botEntries
          .filter(entry => entry.larkAppId === appId)
          .flatMap(entry => [entry.botName, entry.cliId])
          .filter((name): name is string => !!name)
          .map(name => name.toLowerCase()),
      );
      // Bots actively in THIS conversation (thread root for thread-scope, chat for
      // chat-scope). Used to gate the type-generic `cliId` alias so prose "@codex"
      // resolves to the codex bot collaborating HERE, not every same-type bot
      // (the fan-out that pulled all Codex-named bots into a topic). See
      // eligibleAutoMentionAliases.
      const convoBotAppIds = new Set<string>();
      for (const sess of loadSessions().values()) {
        if (sess.status !== 'active' || !sess.larkAppId) continue;
        const here = isChatScope
          ? sess.chatId === s.chatId
          : (!!s.rootMessageId && sess.rootMessageId === s.rootMessageId);
        if (here) convoBotAppIds.add(sess.larkAppId);
      }
      for (const entry of sortedEntries) {
        if (!entry.botName || entry.larkAppId === appId) continue;
        const names = eligibleAutoMentionAliases({
          botName: entry.botName,
          cliId: entry.cliId ?? undefined,
          larkAppId: entry.larkAppId ?? undefined,
          selfAliases,
          convoBotAppIds,
        });
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
          // Prose `@OtherBot` auto-injection: inject normally. (The off-topic
          // sub-bot guard used to DROP this; we now let the model @ freely and
          // pick the destination with --into instead of being silently dropped.)
          mentions.push({ open_id: senderScopedId, name: entry.botName });
          alreadyMentioned.add(senderScopedId);
          break;
        }
      }
      }
    } catch { /* best-effort */ }

    const explicitKnownBotMention = hasKnownBotMention(text, mentions, botEntries, crossRef, appId);
    const knownBotOpenIds = knownBotOpenIdsFromCrossRef(crossRef, botEntries, appId);
    // --no-mention 显式不 @ 任何人 → 连 footer 的"发送给/cc"寻址 <at> 也清空，
    // 否则 footer 仍会 @ 人，与 --no-mention 语义和"未@任何人"输出自相矛盾
    // （Codex review P2）。--top-level 同样无特定收件人。
    const footerAddressing = (sendTopLevel || noMention)
      ? { sendTo: undefined as string | undefined, cc: [] as string[] }
      : buildFooterAddressing(s, {
          isOncall: !!oncallEntry,
          hasExplicitBotMention: explicitKnownBotMention,
          knownBotOpenIds,
        });

    // Capture sentAtMs BEFORE dispatch — the worker's bridge fallback gates
    // on `sentAtMs ∈ [turn.markTimeMs, nextTurn.markTimeMs)`. If we recorded
    // it after dispatch (which can take seconds), a slow Lark RTT could push
    // this send's timestamp past the next turn's mark and falsely suppress
    // that turn's fallback emit. Pre-dispatch timestamp captures the moment
    // we committed to sending — that's the boundary the gate cares about.
    const sentAtMs = Date.now();
    let messageId: string;
    {
      // 回复一律卡片（纯文本 post 路径已删）。
      // Inline `@Name` → `<at id=…>` at the exact spot it's written (CJK-name
      // aware, see applyInlineMentions); any --mention not inlined here is
      // rendered on the footer `发送给：` line below, not the body.
      const { text: md, usedIds } = applyInlineMentions(text, mentions);
      // Non-inlined mentions are no longer dangled as a trailing @ block at the
      // body bottom — they're consolidated onto the footer `发送给：` line below
      // (human addressee first, then explicit targets). See orderedFooterRecipients.

      // Resolve image placeholders into card elements. A single-index
      // `![alt](img:N)` inlines a full-width image; a grouped `![](img:0,1[,2…])`
      // renders one row of images side by side (2/row, 3/row …); any image not
      // referenced by a placeholder is appended full-width at the end.
      const elements = (md || imageKeys.length > 0) ? buildImageCardElements(md, imageKeys) : [];

      // Footer: de-emphasized markdown (v2 dropped the `note` tag). Use small
      // text size + grey font tag so it reads like a footnote below the hr.
      // Oncall groups usually address whoever triggered this turn (may not be
      // the session owner). Bot recipients are filtered out so footer chrome
      // cannot accidentally wake a sibling bot.
      // Brand segment honours this bot's configured brandLabel (unset →
      // default botmux, '' → suppressed, else custom). Same resolver/rule as
      // the daemon's card builders so both send paths render identically.
      const footerParts: string[] = [];
      const brandSeg = brandFooterSegment(resolveBrandLabel(appId));
      if (brandSeg) footerParts.push(brandSeg);
      // All real mentions land on one footer line: human addressee first, then
      // explicit @ targets (incl. handoff bots), then cc. Ids already inlined in
      // the body prose are skipped. Top-level publish keeps sendTo empty.
      const footerRecipients = orderedFooterRecipients({
        sendTo: footerAddressing.sendTo,
        mentionIds: mentions.map(m => m.open_id),
        cc: footerAddressing.cc,
        inlinedIds: usedIds,
      });
      if (footerRecipients.length > 0) {
        footerParts.push(`${t('card.sent_to', undefined, localeForBot(appId))}${footerRecipients.map(id => `<at id=${id}></at>`).join(' ')}`);
      }
      // Footer line (brand 个性签名 + 发送给) and the optional 🔊 语音总结 button
      // share ONE row: footer text on the left (weighted, fills), button pinned
      // to the far right (auto width). When voice isn't configured the footer
      // renders alone, as before. Button only on a reply (not --top-level).
      // v2 cards put buttons inside column_set/column — never the 1.x
      // `tag:'action'` container (Feishu rejects it, error 200861).
      let voiceOn = false;
      if (!sendTopLevel) {
        try {
          const { isVoiceConfigured } = await import('./services/voice/index.js');
          voiceOn = isVoiceConfigured(appId);
        } catch { /* voice module/config unavailable → no button */ }
      }
      const footerContent = footerParts.length > 0
        ? `<font color='grey'>${footerParts.join(' · ')}</font>`
        : '';
      if (footerContent || voiceOn) {
        elements.push({ tag: 'hr' });
        if (voiceOn) {
          const anchorId = (isChatScope ? s.chatId : s.rootMessageId) ?? s.chatId;
          elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            horizontal_spacing: 'default',
            columns: [
              {
                tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
                elements: [{ tag: 'markdown', text_size: 'notation_small_v2', content: footerContent || ' ' }],
              },
              {
                tag: 'column', width: 'auto', vertical_align: 'center',
                elements: [{
                  tag: 'button',
                  text: { tag: 'plain_text', content: '🔊 语音总结' },
                  type: 'default',
                  behaviors: [{
                    type: 'callback',
                    value: { action: 'voice_summary', session_id: sid, root_id: anchorId, lark_app_id: appId, chat_id: targetChatId },
                  }],
                }],
              },
            ],
          });
        } else {
          elements.push({
            tag: 'markdown',
            text_size: 'notation_small_v2',
            content: footerContent,
          });
        }
      }

      const cardJson = JSON.stringify({
        schema: '2.0',
        config: { update_multi: true },
        body: { direction: 'vertical', elements },
      });
      messageId = await dispatchPrimary(cardJson, 'interactive');
    }

    // Bridge fallback marker — append-only jsonl per session. Same-thread
    // sends can suppress transcript fallback when their content appears to
    // cover the same final answer; detoured sends suppress only when they
    // closed a pending response card for this turn.
    if (shouldRecordBridgeMarker) recordBridgeSendMarker(sentAtMs, messageId, text);

    // Send file attachments as separate messages — best-effort. The primary
    // message is already delivered above; a failing attachment must not throw
    // out to the catch below (which would report total failure / exit 1 for an
    // already-sent message and make the caller resend). Warn instead, and list
    // the failures in the success JSON.
    const { failed: failedAttachments } = await sendFileAttachments(
      { uploadFile, dispatch }, appId, files,
    );
    for (const f of failedAttachments) {
      console.error(`⚠️ 附件未发送（主消息已送达 ${messageId}，请勿重发）: ${f.path} — ${f.error}`);
    }

    // Bot-to-bot 转发依赖飞书"获取群组中其他机器人和用户@当前机器人的消息"权限：
    // 目标 bot 的 daemon 现在能从 WSClient 原生收到 sender_type='app' 的事件，
    // 不需要 botmux 自己再写本地 signal 文件做转发。outgoing 消息里 @BotName /
    // --mention 的 open_id 解析（在上方 mentions 数组里完成）仍然必要，它让
    // Lark 在消息里渲染真正的 @at 元素，从而触发对方 bot 的 WS 事件投递。

    const atSummary = mentions.length > 0
      ? `@${mentions.map(m => m.name || m.open_id).join(',')}`
      : '未@任何人';
    console.error(`✓ 已发送 ${messageId} ｜ ${primaryQuotedId ? `引用 ${primaryQuotedId}` : '未引用'} ｜ ${atSummary}`);

    // --attention: message is already delivered above; now flip the dashboard
    // needs-you state via the daemon (botmux send is direct-to-Lark, so the
    // daemon-held ds.agentAttention must be set out-of-band). Best-effort: a
    // failure here must NOT fail the send (else the agent retries → duplicate
    // messages) — warn on stderr and surface in the JSON for log observability.
    let attentionRaised: boolean | undefined;
    let attentionError: string | undefined;
    if (attention.requested) {
      try {
        const daemon = findDaemon(appId);
        if (!daemon) throw new Error(`找不到 daemon (larkAppId=${appId})`);
        const res = await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/attention`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, larkAppId: appId, action: 'raise', kind: attention.kind, reason: text.trim() }),
        });
        if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
        attentionRaised = true;
        console.error(`🙋 已举手：本会话已进 dashboard「需要你」列（用户回复后自动撤下）`);
      } catch (err) {
        attentionRaised = false;
        attentionError = err instanceof Error ? err.message : String(err);
        console.error(`⚠️ 消息已发送，但举手(needs-you)置位失败（不影响消息）：${attentionError}`);
      }
    }
    console.log(JSON.stringify({
      success: true,
      messageId,
      sessionId: sid,
      quotedMessageId: primaryQuotedId,
      mentioned: mentions.map(m => ({ open_id: m.open_id, name: m.name })),
      ...(attention.requested ? { attentionRaised, attentionError } : {}),
      ...(failedAttachments.length > 0
        ? { failedAttachments: failedAttachments.map(f => f.path) }
        : {}),
    }));
  } catch (err: any) {
    console.error(`发送失败: ${err.message}`);
    process.exit(1);
  }
}

// ─── Dispatch subcommand (Phase 0: open a sub-project thread + assign bots) ───

async function cmdDispatch(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`botmux dispatch — 开子项目话题、把 bot 拉进去协作（含 repo 预设 / 待命 / 追加）

用法:
  新开话题派活:
    botmux dispatch --title "子项目标题" --bot <open_id[:名字[:角色]]> [--bot ...] \\
        [--brief "简报" | --brief-file <path>] [--repo <工作目录>] [--standby]
  往已有话题追加（激活待命 bot / 追加协调）:
    botmux dispatch --into <话题根消息id> --bot <spec> [--bot ...] (--brief ... | --brief-file ...)

说明:
  新开话题: 发一条顶层「子项目」种子消息，在它线程里把 bot @ 进来各起独立会话。
  --repo:   先用 /repo 给每个子 bot 定好工作目录——spawn 时不弹「选仓库」卡、不用手点。
  --standby: 配合 --repo——只把 bot 拉起来定好目录待命（不派简报），之后用 --into 派具体任务。
  --into:   不建种子，直接回到已有话题线程 @ bot 追加一条。
  返回 JSON（含 seedMessageId / threadRootId），供编排者登记 子项目↔话题。

选项:
  --title <t>           子项目标题（新开话题时必填）
  --bot <spec>          指派的 bot，可重复；spec = open_id[:名字[:角色]]
  --brief <text>        子项目简报 / 追加内容
  --brief-file <path>   从文件读取简报
  --repo <path>         预设子 bot 工作目录（绝对路径，需在子 bot 所在机器上存在）
  --standby             仅 --repo 待命，不派简报
  --into <root_id>      回到已有话题线程追加（与 --title/种子互斥）
  --chat-id <id>        覆盖目标群（默认当前会话所在群）
  --session-id <id>     指定来源会话（默认自动推断）`);
    return;
  }

  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sessionIdArg = argValue(rest, '--session-id');
  const title = argValue(rest, '--title') ?? '';
  const briefFile = argValue(rest, '--brief-file');
  const overrideChatId = argValue(rest, '--chat-id');
  const repo = argValue(rest, '--repo');
  const intoRoot = argValue(rest, '--into');
  const standby = rest.includes('--standby');
  const botSpecs = argValues(rest, '--bot');

  let brief = argValue(rest, '--brief') ?? '';
  if (briefFile) {
    if (!existsSync(briefFile)) { console.error(`文件不存在: ${briefFile}`); process.exit(1); }
    brief = readFileSync(briefFile, 'utf-8');
  }

  // Append the report-back protocol so the dispatched sub-bot reports via
  // `botmux report` (which routes to the orchestrator's OWN session) rather than
  // @-ing the orchestrator in its sub-topic — which has no orchestrator session
  // and would spawn a fresh, context-less one. Skipped for --standby (no brief).
  if (brief.trim()) {
    brief = brief.trimEnd() +
      '\n\n— 完成回报 —\n' +
      '干完后在本话题运行 `botmux report "子项目完成 + 产出位置/摘要"` 把结果回报给主编排会话；' +
      '不要在本话题 @ 主bot（那会另起一个没有上下文的新会话）。';
  }

  // ── Flag validation ──
  if (botSpecs.length === 0) {
    console.error('至少要用 --bot 指派一个 bot。用法见 botmux dispatch --help');
    process.exit(1);
  }
  if (standby && !repo) {
    console.error('--standby 需要配合 --repo（先定好工作目录把 bot 拉起待命）。');
    process.exit(1);
  }
  if (standby && intoRoot) {
    console.error('--standby 与 --into 不能同用。');
    process.exit(1);
  }
  if (!standby && !brief.trim()) {
    console.error('缺少简报。用 --brief 或 --brief-file 指定（仅 --standby 模式可省略）。');
    process.exit(1);
  }
  if (!intoRoot && !title.trim()) {
    console.error('新开话题需要 --title。往已有话题追加请用 --into <root_id>。');
    process.exit(1);
  }

  let bots;
  try {
    bots = botSpecs.map(parseDispatchBotSpec);
  } catch (err: any) {
    console.error(`--bot 解析失败: ${err.message}`);
    process.exit(1);
  }

  let built;
  try {
    built = buildDispatchMessages({ title: title.trim() || '子项目', brief, bots });
  } catch (err: any) {
    console.error(`dispatch 构建失败: ${err.message}`);
    process.exit(1);
  }

  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题内的 CLI 会话中运行，或传 --session-id <id>。');
    process.exit(1);
  }
  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) { console.error(`未找到 session ${sid}`); process.exit(1); }
  if (!s.larkAppId) { console.error(`session ${sid} 缺少 larkAppId`); process.exit(1); }

  const targetChatId = overrideChatId ?? s.chatId;
  if (!targetChatId) { console.error(`session ${sid} 缺少 chatId，且未提供 --chat-id`); process.exit(1); }

  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
  const { sendMessage, replyMessage } = await import('./im/lark/client.js');
  const appId = s.larkAppId!;
  const briefJson = JSON.stringify({ zh_cn: { title: '', content: built.threadContent } });

  try {
    // --into: append into an existing thread (activate standby bots / coordinate).
    if (intoRoot) {
      const kickoffId = await replyMessage(appId, intoRoot, briefJson, 'post', true);
      console.log(JSON.stringify({
        success: true, mode: 'into', threadRootId: intoRoot,
        kickoffMessageId: kickoffId, chatId: targetChatId, bots: built.mentionedOpenIds,
      }));
      return;
    }

    // New-thread mode.
    // 1. Seed (thread root) — top-level header; gives the thread something to hang off.
    const seedId = await sendMessage(appId, targetChatId, built.seedText, 'text');

    // Record the orchestrator's coords for this sub-topic, keyed by the seed
    // (which becomes every dispatched sub-bot's session.rootMessageId). The
    // sub-bot's `botmux report` looks this up to route its report back into the
    // orchestrator's OWN session. Lives in the shared data dir so every bot's
    // daemon (one-per-bot) can read it. Best-effort — report-back degrades to a
    // clear error if absent.
    try {
      const regPath = join(resolveDataDir(), 'orchestrate-dispatch.json');
      let reg: Record<string, unknown> = {};
      try { if (existsSync(regPath)) reg = JSON.parse(readFileSync(regPath, 'utf-8')); } catch { /* corrupt → reset */ }
      reg[seedId] = {
        orchRoot: s.rootMessageId ?? '',
        orchChatId: s.chatId,
        orchScope: s.scope ?? 'thread',
        orchAppId: s.larkAppId,
        title: title.trim(),
        bots: built.mentionedOpenIds,
      };
      // 原子写：共享 data dir，其它 bot 的 daemon 会并发读这个注册表。
      atomicWriteFileSync(regPath, JSON.stringify(reg, null, 2));
    } catch { /* registry is best-effort */ }

    // 2. Optional repo prime — a plain TEXT message "@bot /repo <path>" (like a
    //    human types) so each sub-bot spawns idle in that dir (no repo-select
    //    card). Text goes through resolveMentions cleanly; a structured post
    //    drops the /repo arg in the live event. `/repo` is an existing command,
    //    so this needs no change on the receiving bot's daemon.
    let primeId: string | undefined;
    if (repo) {
      const prime = buildRepoPrimeText({ path: repo, bots });
      primeId = await replyMessage(appId, seedId, prime.text, 'text', true);
    }

    // 3. Brief kickoff — reply_in_thread @-ing the bots so each spawns its own
    //    thread-scoped session. Skipped in --standby (bots wait for a later --into).
    let kickoffId: string | undefined;
    if (!standby) {
      kickoffId = await replyMessage(appId, seedId, briefJson, 'post', true);
    }

    console.log(JSON.stringify({
      success: true,
      mode: standby ? 'standby' : 'dispatch',
      seedMessageId: seedId,
      threadRootId: seedId,
      primeMessageId: primeId,
      kickoffMessageId: kickoffId,
      repo: repo ?? null,
      chatId: targetChatId,
      bots: built.mentionedOpenIds,
    }));
  } catch (err: any) {
    console.error(`dispatch 失败: ${err.message}`);
    process.exit(1);
  }
}

/**
 * `botmux report` — a dispatched sub-bot reports progress/completion back to the
 * orchestrator that dispatched it.
 *
 * In 多话题协作模式 the sub-bot lives in its own sub-topic, where the orchestrator
 * has no session; @-ing the orchestrator there would spawn a fresh, context-less
 * one (申晗's #1 bug). Instead this routes the report INTO the orchestrator's own
 * thread (recorded by `botmux dispatch` in orchestrate-dispatch.json) and @-s the
 * orchestrator there, so its existing, context-rich session is the one that wakes.
 *
 * Coords: orchestrator open_id = the sub-bot session's quoteTargetSenderOpenId
 * (the dispatcher of the turn that opened this sub-topic); orchestrator thread =
 * the registry entry keyed by this sub-bot's session.rootMessageId (== the seed).
 */
async function cmdReport(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`botmux report — 把子项目进展/完成回报给派活的主编排会话

用法:
  botmux report "子项目X 完成，产出在 …"
  botmux report --content-file <path>

说明:
  「多话题协作模式」里你（子 bot）干完后不要在本话题 @ 主bot——本话题没有主bot的会话，
  @ 会另起一个无上下文的新会话。本命令把回报发回主编排会话所在的话题、并 @ 主编排 bot，
  使其带完整上下文继续聚合。仅在被 botmux dispatch 派活的子项目会话里可用。

选项:
  --content-file <path>  从文件读取回报内容
  --session-id <id>      指定来源会话（默认自动推断）`);
    return;
  }

  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sessionIdArg = argValue(rest, '--session-id');

  let content = '';
  const contentFile = argValue(rest, '--content-file');
  if (contentFile) {
    if (!existsSync(contentFile)) { console.error(`文件不存在: ${contentFile}`); process.exit(1); }
    content = readFileSync(contentFile, 'utf-8');
  } else {
    const pos = positionals(rest);
    content = pos.length ? pos.join(' ') : await readStdin();
  }
  if (!contentFile) rejectLikelyWindowsStdinMojibake(content);
  if (!content.trim()) {
    console.error('没有回报内容。用法: botmux report "子项目X 完成 + 产出位置"');
    process.exit(1);
  }

  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断 session-id。请在被 dispatch 派活的会话里运行，或传 --session-id <id>。');
    process.exit(1);
  }
  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) { console.error(`未找到 session ${sid}`); process.exit(1); }
  if (!s.larkAppId) { console.error(`session ${sid} 缺少 larkAppId`); process.exit(1); }

  // Resolve where the report goes + who to @. Same-machine: the dispatch registry
  // (keyed by this sub-bot's thread root) carries the orchestrator's exact coords.
  // CROSS-MACHINE: the orchestrator is on another machine, so its registry isn't
  // on THIS one — resolveReportTarget falls back to this sub-bot's own session
  // (report top-level into its chat, @ the dispatcher via creatorOpenId). See
  // resolveReportTarget / Session.creatorOpenId.
  const regPath = join(resolveDataDir(), 'orchestrate-dispatch.json');
  let reg: Record<string, any> = {};
  try { if (existsSync(regPath)) reg = JSON.parse(readFileSync(regPath, 'utf-8')); } catch { /* */ }
  const entry = s.rootMessageId ? reg[s.rootMessageId] : undefined;
  const tgt = resolveReportTarget({
    registryEntry: entry,
    sessionChatId: s.chatId,
    creatorOpenId: s.creatorOpenId,
    ownerOpenId: s.ownerOpenId,
    quoteTargetSenderOpenId: s.quoteTargetSenderOpenId,
  });
  if (!tgt.orchOpenId || !tgt.orchChatId) {
    console.error(
      '找不到主编排坐标：本会话没记录派活者（creatorOpenId/ownerOpenId 都空）或缺 chatId——大概不是被 botmux dispatch 派活的会话。\n' +
      '若确需回报，请改用 `botmux send` 或显式 @ 对应的人/ bot。');
    process.exit(1);
  }

  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
  const { sendMessage, replyMessage } = await import('./im/lark/client.js');
  const appId = s.larkAppId!;

  const paras = buildReportContent({ orchOpenId: tgt.orchOpenId, content });
  const postJson = JSON.stringify({ zh_cn: { title: '', content: paras } });

  try {
    let msgId: string;
    if (tgt.orchScope === 'chat' || !tgt.orchRoot) {
      // Orchestrator at chat scope, or cross-machine fallback → post top-level
      // into the chat (the sub-topic's chat = the orchestrator's chat).
      msgId = await sendMessage(appId, tgt.orchChatId, postJson, 'post');
    } else {
      // Same-machine thread-scope orchestrator → reply into its thread so its
      // existing context-rich session (anchored on orchRoot) receives the report.
      msgId = await replyMessage(appId, tgt.orchRoot, postJson, 'post', true);
    }
    console.log(JSON.stringify({
      success: true,
      reportedTo: tgt.orchRoot || tgt.orchChatId,
      orchestrator: tgt.orchOpenId,
      viaRegistry: !!entry,
      messageId: msgId,
    }));
  } catch (err: any) {
    console.error(`report 失败: ${err.message}`);
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
  const link = chatAppLink(result.chatId, botBrand(creatorCfg));
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

// ─── botmux ask v0.1.7 ───────────────────────────────────────────────────────
//
// CLI agent inside a botmux-spawned session calls `botmux ask buttons
// --options "..." "<prompt>"`. Daemon sends a Lark card; user clicks; CLI
// process unblocks with the selected key (or exit 124 on timeout, exit 3 if
// the daemon dies). See /tmp/botmux-ask.md (or design memory).

/**
 * postAsk: 找到 daemon → POST /api/asks → 返回 AskResult。
 * 连接失败 / HTTP 错误时抛出带 exitCode 属性的 Error：
 *   - exitCode=3：daemon 不可达或 HTTP 错误
 */
async function postAsk(body: Record<string, unknown>): Promise<import('./core/ask-types.js').AskResult> {
  type AskResult = import('./core/ask-types.js').AskResult;

  const larkAppId = body.larkAppId as string;
  const daemon = findDaemon(larkAppId);
  if (!daemon) {
    const err = new Error(
      `botmux ask: 找不到 daemon (larkAppId=${larkAppId})。daemon 已停？exit 3.`,
    ) as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/asks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // No client-side timeout — broker enforces `timeoutMs` and will respond
      // with `kind:'timedOut'` so this fetch always settles.
    });
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const err = new Error(
      `botmux ask: 无法连接 daemon (port=${daemon.ipcPort}): ${msg}`,
    ) as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }

  if (!res.ok) {
    let errBody = '';
    try { errBody = (await res.text()).slice(0, 200); } catch { /* */ }
    const err = new Error(`botmux ask: daemon HTTP ${res.status}: ${errBody}`) as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }

  try {
    return (await res.json()) as AskResult;
  } catch (jsonErr) {
    const err = new Error(`botmux ask: daemon 返回非 JSON: ${jsonErr}`) as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }
}

async function cmdAsk(sub: string, rest: string[]): Promise<void> {
  // Workflow-subagent safety gate (same posture as cmdSend): a CLI running
  // inside a workflow subagent (Slice F) must not surface chat UI. Workflow
  // approvals belong in humanGate / decision nodes so the choice is part of
  // the run's event log; an ad-hoc `botmux ask` would bypass that audit
  // trail entirely.
  if (process.env.BOTMUX_WORKFLOW === '1') {
    const runId = process.env.BOTMUX_WORKFLOW_RUN_ID ?? '?';
    const nodeId = process.env.BOTMUX_WORKFLOW_NODE_ID ?? '?';
    console.error(
      `botmux ask refused inside workflow subagent (run=${runId} node=${nodeId}).\n` +
        `Workflow subagents must surface approvals via humanGate / decision nodes\n` +
        `so the resolution is recorded in the run's event log; ask would bypass it.`,
    );
    process.exit(2);
  }

  // Only `buttons` shipped in v0.1.7. The bare alias (`botmux ask --options`)
  // routes here with sub='' — accept it and behave identically. `ask text` /
  // `ask confirm` are reserved for later versions.
  if (sub && sub !== 'buttons') {
    console.error(
      `botmux ask: 未知 subcommand "${sub}"（v0.1.7 仅支持 \`buttons\` 或省略）`,
    );
    process.exit(2);
  }

  const { findMissingAskEnv, parseAskOptions, parseAskTimeoutSeconds, AskArgsError } =
    await import('./core/ask-args.js');
  type AskJsonOutput = import('./core/ask-types.js').AskJsonOutput;
  const { toLegacySelected } = await import('./core/ask-types.js');

  const missing = findMissingAskEnv(process.env);
  if (missing) {
    console.error(
      `botmux ask: 缺少必需环境变量 ${missing}。` +
        ` 请在 botmux daemon spawn 的 CLI 会话内运行。`,
    );
    process.exit(2);
  }

  const optionsRaw = argValue(rest, '--options');
  const timeoutRaw = argValue(rest, '--timeout');
  const useJson = rest.includes('--json');
  const positionalArgs = positionals(rest, ['--json']);

  let options;
  let timeoutMs;
  try {
    options = parseAskOptions(optionsRaw);
    timeoutMs = parseAskTimeoutSeconds(timeoutRaw);
  } catch (err) {
    if (err instanceof AskArgsError) {
      console.error(`botmux ask: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const prompt = positionalArgs.join(' ').trim();
  if (!prompt) {
    console.error(
      'botmux ask: 缺少 prompt。用法: botmux ask buttons --options "yes,no" "继续发版吗？"',
    );
    process.exit(2);
  }

  const larkAppId = process.env.BOTMUX_LARK_APP_ID!;
  const body = {
    sessionId: process.env.BOTMUX_SESSION_ID!,
    chatId: process.env.BOTMUX_CHAT_ID!,
    larkAppId,
    rootMessageId: process.env.BOTMUX_ROOT_MESSAGE_ID || null,
    options,
    prompt,
    timeoutMs,
  };

  let result;
  try {
    result = await postAsk(body);
  } catch (err) {
    const code = (err as any).exitCode ?? 3;
    console.error((err as Error).message);
    process.exit(code);
  }

  // result.kind==='answered' 时用 toLegacySelected 取回旧的 string（单问单选）
  const selected = toLegacySelected(result);

  if (useJson) {
    const out: AskJsonOutput = {
      selected,
      answers: result.kind === 'answered' ? (result.answers as string[][]) : null,
      by: result.kind === 'answered' ? result.by : null,
      comment: result.kind === 'answered' ? result.comment : null,
      timedOut: result.kind === 'timedOut',
    };
    process.stdout.write(JSON.stringify(out) + '\n');
  } else if (result.kind === 'answered') {
    // 非 JSON 模式：输出 selected key（单问单选），多选/多问输出空字符串
    process.stdout.write((selected ?? '') + '\n');
  }

  switch (result.kind) {
    case 'answered':
      process.exit(0);
    case 'timedOut':
      console.error(`botmux ask: 超时（${timeoutMs / 1000}s），无回复`);
      process.exit(124);
    case 'invalidated':
      console.error(`botmux ask: 已失效 (${result.reason})`);
      process.exit(3);
  }
}

// ─── botmux hook <cliId> ──────────────────────────────────────────────────────
//
// hook 模式：各 CLI hook 配置调用 `botmux hook <cliId>`，stdin 注入 hook payload，
// 本命令解析问题 → POST /api/asks → 等结果 → 写 directive 到 stdout。
// 任何失败（daemon 不可达、env 缺失、解析错误）均输出 passthrough directive 并 exit 0，
// 绝不挂死，保证 CLI 可以继续原生终端提问。

/**
 * runHook: hook 命令的纯业务逻辑，接受已解析的 payload/env/postAskFn，
 * 返回应写到 stdout 的字符串。通过依赖注入使单元测试无需真实 daemon/env。
 *
 * @param payload              已经 JSON.parse 的 hook payload 对象
 * @param env                  包含 BOTMUX_* 环境变量的字典
 * @param postAskFn            替代真实 postAsk 的可注入函数（测试用）
 * @param cliId                CLI 适配器 ID
 * @param resolveAdoptRouteFn  可选：替代真实 adopt 路由解析的注入函数（测试用）；
 *                             缺省时使用真实 resolveAdoptRoute（查祖先 PID → daemon）
 * @returns                    { stdout: string } 应写到 stdout 的内容
 */
export async function runHook(
  payload: unknown,
  env: Record<string, string | undefined>,
  postAskFn: (body: Record<string, unknown>) => Promise<import('./core/ask-types.js').AskResult>,
  cliId: string,
  resolveAdoptRouteFn?: () => Promise<import('./adapters/adopt-route.js').AdoptRoute | null>,
): Promise<{ stdout: string }> {
  const { getHookAdapter } = await import('./core/ask-hook/registry.js');

  // 未知 cliId → 无 adapter，输出空字符串静默放行
  const adapter = getHookAdapter(cliId);
  if (!adapter) {
    return { stdout: '' };
  }

  // Workflow-subagent 安全门：workflow 子 agent 内直接 passthrough
  if (env.BOTMUX_WORKFLOW === '1') {
    return { stdout: adapter.passthrough(payload) };
  }

  // 解析问题：非 askUserQuestion 类事件 → passthrough 放行
  const parsed = adapter.parseQuestions(payload);
  if (!parsed) {
    return { stdout: adapter.passthrough(payload) };
  }

  // 检查必需的 BOTMUX_* env
  const sessionId = env.BOTMUX_SESSION_ID;
  const chatId = env.BOTMUX_CHAT_ID;
  const larkAppId = env.BOTMUX_LARK_APP_ID;

  // 路由变量：优先用 env，env 缺失时尝试 adopt 路由
  let routeSessionId = sessionId;
  let routeChatId = chatId;
  let routeLarkAppId = larkAppId;
  let routeRoot: string | null = env.BOTMUX_ROOT_MESSAGE_ID || null;

  if (!sessionId || !chatId || !larkAppId) {
    // env 缺失 → 尝试通过祖先 PID 匹配在线 adopt 会话
    const resolver = resolveAdoptRouteFn ?? (() => {
      // 延迟 import 避免冷启动开销
      return import('./adapters/adopt-route.js').then(({ resolveAdoptRoute, queryAdoptSession }) =>
        resolveAdoptRoute({
          startPid: process.pid,
          listDaemons: listOnlineDaemons,
          queryDaemon: queryAdoptSession,
        }),
      );
    });
    let adopt: import('./adapters/adopt-route.js').AdoptRoute | null = null;
    try {
      adopt = await resolver();
    } catch {
      // 解析失败 → 视作真非 botmux 会话，passthrough 放行
    }
    if (!adopt) {
      // 真非 botmux 会话 → passthrough 放行
      return { stdout: adapter.passthrough(payload) };
    }
    // adopt 命中 → 使用 adopt 路由信息
    routeSessionId = adopt.sessionId;
    routeChatId = adopt.chatId;
    routeLarkAppId = adopt.larkAppId;
    routeRoot = adopt.rootMessageId;
  }

  // 解析 timeoutMs：默认 1 小时，可由 BOTMUX_ASK_TIMEOUT_MS 覆盖
  const DEFAULT_TIMEOUT_MS = 3_600_000;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const timeoutEnv = env.BOTMUX_ASK_TIMEOUT_MS;
  if (timeoutEnv) {
    const parsed_timeout = parseInt(timeoutEnv, 10);
    if (Number.isInteger(parsed_timeout) && parsed_timeout > 0) {
      timeoutMs = parsed_timeout;
    }
  }

  const body: Record<string, unknown> = {
    sessionId: routeSessionId,
    chatId: routeChatId,
    larkAppId: routeLarkAppId,
    rootMessageId: routeRoot,
    questions: parsed.questions,
    timeoutMs,
  };

  let result: import('./core/ask-types.js').AskResult;
  try {
    result = await postAskFn(body);
  } catch {
    // 任何失败（daemon 不可达、HTTP 错误等）→ passthrough 放行
    return { stdout: adapter.passthrough(payload) };
  }

  if (result.kind === 'answered') {
    return { stdout: adapter.formatAnswer(result.answers, parsed, result.comment) };
  }

  // timedOut / invalidated → passthrough 放行
  return { stdout: adapter.passthrough(payload) };
}

/**
 * cmdHook: `botmux hook <cliId>` 入口。
 * 读取 stdin 全文 → JSON.parse → runHook → 写 stdout，exit 0。
 */
async function cmdHook(cliId: string): Promise<void> {
  // 读取 stdin 全文
  let stdinText = '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    stdinText = Buffer.concat(chunks).toString('utf-8');
  } catch {
    // stdin 读取失败 → 无法处理，静默退出
    process.exit(0);
  }

  // JSON.parse 失败 → 输出空并退出（不挂死）
  let payload: unknown;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    process.exit(0);
  }

  const { getHookAdapter } = await import('./core/ask-hook/registry.js');
  const adapter = getHookAdapter(cliId);
  // 未知 cliId → 静默放行
  if (!adapter) {
    process.exit(0);
  }

  const env = process.env as Record<string, string | undefined>;
  const result = await runHook(payload, env, postAsk, cliId);
  if (result.stdout) {
    console.log(result.stdout);
  }
  process.exit(0);
}

// ─── botmux session-ready ─────────────────────────────────────────────────────
//
// Claude 家族（claude/seed）的 SessionStart hook 客户端。Claude 在 TUI 输入框
// 真正渲染就绪时（startup / resume / clear / compact）触发本命令；它通知 daemon
// 「CLI 真就绪」，放行 worker 端被 ready-gate 门控的首条 prompt——绕开 cjadk 之类
// 自定义 launcher 启动选择器的 ❯ 误命中 readyPattern、把首条消息整条吞掉的 bug。
//
// 会话归属只靠 hook 子进程继承的 env（worker spawn 时设的 BOTMUX_SESSION_ID /
// BOTMUX_LARK_APP_ID）。任何失败（env 缺失=adopt/非 botmux 会话、daemon 不可达）
// 都静默 exit 0：绝不挂死 CLI 启动；信号丢了 worker 有超时兜底。
async function cmdSessionReady(): Promise<void> {
  // 排空 stdin：Claude 把 SessionStart payload 写到这里。我们只取 source 字段
  // （诊断用），但务必消费掉，避免 CLI 端写满管道阻塞。best-effort。
  let payloadText = '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    payloadText = Buffer.concat(chunks).toString('utf-8');
  } catch { /* stdin 读不到也无所谓 */ }
  let source: string | undefined;
  try {
    const p = JSON.parse(payloadText);
    if (p && typeof p.source === 'string') source = p.source;
  } catch { /* 非 JSON / 空 → 不带 source */ }

  const sessionId = process.env.BOTMUX_SESSION_ID;
  const larkAppId = process.env.BOTMUX_LARK_APP_ID;
  // env 缺失 → adopt / 非 botmux 会话；就绪门控对它们不适用，静默放行。
  if (!sessionId || !larkAppId) process.exit(0);

  const daemon = findDaemon(larkAppId);
  if (daemon) {
    try {
      await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/session-ready`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, source }),
      });
    } catch { /* daemon 不可达 → 放弃，worker 走超时兜底 */ }
  }
  process.exit(0);
}

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

/** Notify every online daemon to hot-reload its UI locale from disk, so a
 *  `botmux lang` change takes effect on live cards without a restart. Best
 *  effort: unreachable daemons pick up the new value when they next restart. */
async function notifyDaemonsReloadLocale(): Promise<{ notified: number; failed: number }> {
  const daemons = listOnlineDaemons();
  let notified = 0;
  let failed = 0;
  await Promise.all(daemons.map(async (d) => {
    try {
      const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/locale/reload`, { method: 'POST' });
      if (r.ok) notified++;
      else failed++;
    } catch { failed++; }
  }));
  return { notified, failed };
}

/** Fan the locale change out to live daemons and tell the user whether it took
 *  effect immediately or will apply on next daemon start. */
async function reportLocaleApplied(): Promise<void> {
  const { notified, failed } = await notifyDaemonsReloadLocale();
  if (notified > 0) {
    console.log(`✅ Applied live to ${notified} running daemon(s) — no restart needed.`);
  } else {
    console.log(`No running daemon to notify; the change applies when daemons next start.`);
  }
  if (failed > 0) {
    console.log(`(${failed} daemon(s) did not acknowledge; they'll pick it up on restart.)`);
  }
}

/**
 * `botmux lang [zh|en] [--bot N] [--unset]`
 *
 * No arg → print effective locale + per-bot overrides.
 * `zh|en` → write global `~/.botmux/config.json` (or, with `--bot N`, write
 *   the per-bot `lang` field in `bots.json`).
 * `--unset` → clear the global config's `lang` (or, with `--bot N`, drop
 *   the per-bot override).
 *
 * On any write, notify online daemons to hot-reload the locale (no restart) —
 * cards switch language on the next message; the change still persists for
 * future restarts.
 */
async function cmdLang(args: string[]): Promise<void> {
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
    await reportLocaleApplied();
    return;
  }

  // Global operations
  if (unset) {
    setGlobalLocale(null);
    console.log(`✅ Cleared global lang (will default to zh).`);
    await reportLocaleApplied();
    return;
  }

  if (!isLocale(target)) {
    console.error(`Unknown locale "${target}". Supported: ${SUPPORTED_LOCALES.join(', ')}.`);
    console.error(`Usage: botmux lang [zh|en] [--bot N] [--unset]`);
    process.exit(1);
  }
  setGlobalLocale(target);
  console.log(`✅ Set global lang → ${target}.`);
  await reportLocaleApplied();
}

// ─── botmux preset ────────────────────────────────────────────────────────────

/**
 * `botmux preset <sub>` dispatcher. Currently only `export`.
 */
async function cmdPreset(sub: string, rest: string[]): Promise<void> {
  switch (sub) {
    case 'export':
      await cmdPresetExport(rest);
      break;
    default:
      console.error('用法: botmux preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]');
      process.exit(1);
  }
}

/**
 * `botmux preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]`
 *
 * Export a bot's **shareable, secret-free** preset (cliId / model / team role /
 * capability + an embedded guide) so a teammate's agent can self-configure a
 * matching bot. Never emits credentials or deployment fields — see
 * agent-preset.ts:buildPreset for the allow-list guarantee.
 *
 * Role source: team-level by default; `--from-chat <chatId>` exports that
 * group's role content instead (the chatId itself is dropped). Both role and
 * capability resolve under the effective data dir: this fn sets
 * `SESSION_DATA_DIR ??= resolveDataDir()` (SESSION_DATA_DIR → ~/.botmux
 * breadcrumb → default), and reads it via config.session.dataDir's lazy getter —
 * correct in agent sessions and bare-shell runs alike.
 */
async function cmdPresetExport(rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  const USAGE = '用法: botmux preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]';
  const selection = firstPositional(rest, ['--from-chat', '--out']);
  if (!selection) {
    console.error(USAGE);
    console.error('  <bot>  进程名 (botmux-xxx) 或 larkAppId');
    process.exit(1);
    return;
  }

  const bots = loadBotsJson();
  if (bots.length === 0) {
    console.error('❌ 没有可用的 bot：未找到 bots.json 或其中为空。先跑 `botmux setup`。');
    process.exit(1);
    return;
  }

  const idx = parseBotSelection(selection, bots);
  if (idx === undefined) {
    console.error(`❌ 找不到 bot "${selection}"。可选：`);
    bots.forEach((b: any, i: number) => {
      const appId = typeof b.larkAppId === 'string' ? b.larkAppId : '(无 larkAppId)';
      console.error(`   - ${botProcessName(b, i)}  (${appId})`);
    });
    process.exit(1);
    return;
  }

  const bot: any = bots[idx];
  const appId: string = typeof bot.larkAppId === 'string' ? bot.larkAppId : '';
  if (!appId) {
    console.error(`❌ bot "${selection}" 缺少 larkAppId，无法解析角色/能力。`);
    process.exit(1);
    return;
  }
  if (!bot.cliId || typeof bot.cliId !== 'string') {
    console.error(`❌ bot "${selection}" 缺少 cliId，无法导出预设。`);
    process.exit(1);
    return;
  }

  // Fail loudly when a flag was given without a value, instead of silently
  // exporting as if it weren't passed (e.g. a value-less `--from-chat` would
  // otherwise quietly fall back to the team role).
  if (flagPresentButValueMissing(rest, '--from-chat')) {
    console.error('❌ --from-chat 需要一个 chatId（如 oc_xxx）。');
    console.error(USAGE);
    process.exit(1);
    return;
  }
  if (flagPresentButValueMissing(rest, '--out', true)) {
    console.error('❌ --out 需要一个文件路径，或用 `--out -` 输出到 stdout。');
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const fromChat = argValue(rest, '--from-chat');
  const out = argValue(rest, '--out');
  const skipConfirm = argFlag(rest, '--yes') || argFlag(rest, '-y');

  // capability + role read the SAME data dir. config.session.dataDir is a lazy
  // getter, so the SESSION_DATA_DIR set at the top of this fn (= resolveDataDir())
  // is honored — correct for both agent sessions AND bare-shell runs (no longer
  // the frozen packaged default).
  const dataDir = config.session.dataDir;
  const { resolveTeamRoleFile, resolveRoleFile } = await import('./core/role-resolver.js');
  const { getBotCapability } = await import('./services/bot-profile-store.js');

  let teamRole: string | null;
  if (fromChat) {
    teamRole = resolveRoleFile(appId, fromChat);
    if (teamRole === null) {
      console.error(`⚠️  群 ${fromChat} 下没有为该 bot 配置角色；导出将不含 teamRole（仍含 cliId/model/capability）。`);
    }
  } else {
    teamRole = resolveTeamRoleFile(appId);
    if (teamRole === null) {
      console.error('⚠️  该 bot 没有 team 级角色；导出将不含 teamRole。可加 `--from-chat <chatId>` 导出某群的角色内容。');
    }
  }

  const capability = getBotCapability(dataDir, appId);
  const sourceName = typeof bot.name === 'string' && bot.name.trim() ? bot.name.trim() : undefined;

  const preset = buildPreset({
    cliId: bot.cliId,
    model: typeof bot.model === 'string' ? bot.model : undefined,
    teamRole,
    capability,
    sourceName,
  });
  const json = serializePreset(preset);

  // Confirm before writing — the role may carry internal info. --yes skips.
  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      console.error('❌ 角色内容可能含内部信息，导出前需确认；非交互环境（如 agent 调用）请加 `--yes` 跳过确认。');
      process.exit(1);
      return;
    }
    if (teamRole || capability) {
      console.error('\n即将导出以下内容，请确认不含敏感/内部信息：');
      console.error('────────────────────────────────────────');
      if (teamRole) console.error(`[角色 teamRole]\n${teamRole}`);
      if (capability) console.error(`[能力标签 capability] ${capability}`);
      console.error('────────────────────────────────────────');
    } else {
      console.error('\n（无角色 / 能力标签内容，仅导出 cliId/model）');
    }
    // Prompt on stderr so a piped stdout (--out -) stays clean.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await ask(rl, '确认导出？输入 y 继续，其它取消: ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.error('已取消，未写入任何文件。');
      process.exit(1);
      return;
    }
  }

  // stdout mode: the JSON must own stdout; all chatter goes to stderr.
  if (out === '-') {
    process.stdout.write(json);
    console.error('✅ 已输出到 stdout。本文件不含任何密钥（larkAppId/secret/allowedUsers 等均未包含）。');
    return;
  }

  const outPath = out ?? `./${presetFilename(sourceName, appId)}`;
  try {
    writeFileSync(outPath, json, 'utf-8');
  } catch (err: any) {
    console.error(`❌ 写入 ${outPath} 失败: ${err?.message ?? String(err)}`);
    process.exit(1);
    return;
  }
  console.error(`✅ 已导出预设到 ${outPath}`);
  console.error('   本文件不含任何密钥（larkAppId/secret/allowedUsers/workingDir 等均未包含），可安全分享。');
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

/**
 * `botmux voice` — standalone voice-summary configuration (advanced feature,
 * intentionally NOT folded into `botmux setup`). Writes the global `voice`
 * block to ~/.botmux/config.json. Subcommands: (none)=interactive setup,
 * `status`=show masked config, `disable`=remove.
 */
async function cmdVoiceSetup(args: string[]): Promise<void> {
  const sub = (args[0] ?? '').toLowerCase();
  const { readGlobalConfig, mergeGlobalConfig } = await import('./global-config.js');
  const { DEFAULT_SAMI_SPEAKER, DEFAULT_OPENAI_SPEAKER } = await import('./services/voice/index.js');
  const mask = (s?: string) => (s ? `${s.slice(0, 4)}***` : '(未设)');

  if (sub === 'status') {
    const v = readGlobalConfig().voice;
    if (!v) { console.log('语音功能未配置。运行 `botmux voice` 配置。'); return; }
    console.log('当前语音配置（全局 ~/.botmux/config.json）:');
    console.log(`  引擎: ${v.engine ?? '(自动)'}`);
    console.log(`  音色: ${v.speaker ?? '(默认)'}`);
    if (typeof v.rate === 'number') console.log(`  语速: ${v.rate}`);
    if (v.sami) console.log(`  SAMI: accessKey=${mask(v.sami.accessKey)} secretKey=${mask(v.sami.secretKey)} appkey=${v.sami.appkey ?? '(未设)'}${v.sami.tokenUrl ? ` tokenUrl=${v.sami.tokenUrl}` : ''}`);
    if (v.openai) console.log(`  OpenAI: baseUrl=${v.openai.baseUrl ?? '(未设)'} model=${v.openai.model ?? '(未设)'} apiKey=${mask(v.openai.apiKey)}`);
    return;
  }
  if (sub === 'disable' || sub === 'off') {
    mergeGlobalConfig({ voice: null });
    console.log('✅ 已移除全局语音配置（回复卡片不再显示「🔊 语音总结」按钮）。重启 daemon 生效。');
    return;
  }
  if (sub && sub !== 'setup') {
    console.error('用法: botmux voice [status|disable]（无参 = 交互式配置）');
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('🔊 配置语音总结（高级功能）。写入全局 ~/.botmux/config.json，重启后生效。\n');
    const eng = (await ask(rl, '选择 TTS 引擎  [1] SAMI（需 AK/SK/appkey）  [2] OpenAI 兼容（自带 baseUrl/key）: ')).trim();
    const voice: Record<string, any> = {};
    if (eng === '2' || /openai/i.test(eng)) {
      voice.engine = 'openai';
      const baseUrl = (await ask(rl, 'baseUrl（如 https://api.openai.com/v1，自托管如 http://127.0.0.1:8880/v1）: ')).trim();
      const apiKey = (await ask(rl, 'apiKey（无则留空）: ')).trim();
      const model = (await ask(rl, 'model（如 tts-1 / kokoro）: ')).trim();
      if (!baseUrl || !model) { console.error('❌ baseUrl 和 model 必填，未写入。'); return; }
      voice.openai = { baseUrl, apiKey, model };
      const sp = (await ask(rl, `音色 voice（留空=默认 ${DEFAULT_OPENAI_SPEAKER}）: `)).trim();
      if (sp) voice.speaker = sp;
    } else {
      voice.engine = 'sami';
      const accessKey = (await ask(rl, 'SAMI accessKey: ')).trim();
      const secretKey = (await ask(rl, 'SAMI secretKey: ')).trim();
      const appkey = (await ask(rl, 'SAMI appkey: ')).trim();
      if (!accessKey || !secretKey || !appkey) { console.error('❌ accessKey/secretKey/appkey 都必填，未写入。'); return; }
      voice.sami = { accessKey, secretKey, appkey };
      const sp = (await ask(rl, `音色 speaker（留空=默认灿灿 ${DEFAULT_SAMI_SPEAKER}）: `)).trim();
      if (sp) voice.speaker = sp;
      const adv = (await ask(rl, '自定义 SAMI 端点？一般不用，回车跳过 (y/N): ')).trim().toLowerCase();
      if (adv === 'y') {
        const tokenUrl = (await ask(rl, 'tokenUrl（留空用默认）: ')).trim();
        const wsUrl = (await ask(rl, 'wsUrl（留空用默认）: ')).trim();
        if (tokenUrl) voice.sami.tokenUrl = tokenUrl;
        if (wsUrl) voice.sami.wsUrl = wsUrl;
      }
    }
    const rate = (await ask(rl, '语速倍率（留空=1.1）: ')).trim();
    if (rate && !Number.isNaN(Number(rate))) voice.rate = Number(rate);

    mergeGlobalConfig({ voice: voice as any });
    console.log('\n✅ 已写入 voice 配置。`botmux restart` 后，配了语音的机器人回复卡片底部会出现「🔊 语音总结」按钮。');
    console.log('   查看：`botmux voice status`  关闭：`botmux voice disable`');

    // 语音合成产物要编码成飞书语音气泡用的 opus，依赖系统的 opusenc(opus-tools)。
    // 缺了就当场帮用户装（沿用 ensure-tmux 的包管理器/sudo 机制）。
    const { ensureOpusTools, probeOpusenc } = await import('./setup/ensure-opus.js');
    if (!probeOpusenc()) {
      console.log('\n⚠️  未检测到 opus 编码器（opus-tools）——语音合成需要它把音频转成飞书语音格式。');
      const yes = (await ask(rl, '现在自动安装 opus-tools？(Y/n): ')).trim().toLowerCase();
      if (yes === '' || yes === 'y' || yes === 'yes') {
        const r = await ensureOpusTools();
        if (r.installed) console.log(`✅ opus-tools 就绪${r.version ? `（${r.version}）` : ''}`);
        else {
          console.log(`未能自动安装：${r.reason ?? ''}`);
          console.log(`请手动安装后再用语音：${r.manualCommand ?? 'apt-get install -y opus-tools / brew install opus-tools'}`);
        }
      } else {
        console.log('已跳过。记得手动安装：Debian/Ubuntu `sudo apt-get install -y opus-tools`，macOS `brew install opus-tools`。');
      }
    }
  } finally {
    rl.close();
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
  case 'bind': {
    // `botmux bind <code>` — 把本机绑定到中心化平台
    const { cmdBind } = await import('./platform/bind.js');
    await cmdBind(process.argv.slice(3));
    break;
  }
  case 'list':
  case 'ls':      await cmdList(); break;
  case 'delete':
  case 'del':
  case 'rm':      cmdDelete(); break;
  case 'resume':  await cmdResume(); break;
  case 'term-link': await cmdTermLink(process.argv.slice(3)); break;
  case 'schedule': await cmdSchedule(process.argv[3] ?? '', process.argv.slice(4)); break;
  case 'ask': {
    // `botmux ask buttons --options ...` → sub='buttons', rest=['--options', ...]
    // `botmux ask --options ...`         → sub='',        rest=['--options', ...]  (bare alias)
    const { normalizeAskDispatch } = await import('./core/ask-args.js');
    const { sub, rest } = normalizeAskDispatch(process.argv.slice(3));
    await cmdAsk(sub, rest);
    break;
  }
  case 'skill': {
    const { runSkillSessionCommand } = await import('./core/skills/cli-session-command.js');
    const result = runSkillSessionCommand(process.argv.slice(3));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
    break;
  }
  case 'skills': {
    const { runSkillsAdminCommand } = await import('./core/skills/cli-admin-command.js');
    const result = runSkillsAdminCommand(process.argv.slice(3));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
    break;
  }
  case 'hook': {
    // `botmux hook <cliId>` — hook 客户端，stdin 读 payload，stdout 写 directive
    const cliId = process.argv[3] ?? '';
    await cmdHook(cliId);
    break;
  }
  case 'session-ready': {
    // `botmux session-ready` — Claude 家族 SessionStart hook 客户端，通知 daemon
    // 「CLI 真就绪」，放行被门控的首条 prompt。
    await cmdSessionReady();
    break;
  }
  case 'workflow': {
    const wfSub = process.argv[3] ?? '';
    if (wfSub === 'start') {
      // `botmux workflow start <runId>` — kick a daemon-driven v3 run (so
      // humanGate posts approval cards).  Needs a live daemon; findDaemon is
      // cli.ts-local so this case handles it instead of cmdWorkflow.
      await cmdWorkflowStart(process.argv[4], process.argv.slice(5));
      break;
    }
    if (wfSub === 'retry') {
      // v3 blocked-node retry (the `resume` verb belongs to v0.2).
      await cmdWorkflowRetry(process.argv[4], process.argv.slice(5));
      break;
    }
    if (wfSub === 'grant') {
      // v3 exhausted-loop grant (+1 iteration).
      await cmdWorkflowGrant(process.argv[4], process.argv.slice(5));
      break;
    }
    const { cmdWorkflow } = await import('./cli/workflow.js');
    await cmdWorkflow(wfSub, process.argv.slice(4));
    break;
  }
  case 'v3': {
    // `botmux v3 run <dag.json>` — run a hand-written next-gen (v3) DAG on the
    // real ephemeral worker pool, daemon-independent (dogfood path).
    const { cmdV3 } = await import('./workflows/v3/cli-run.js');
    await cmdV3(process.argv[3] ?? '', process.argv.slice(4));
    break;
  }
  case 'send':     await cmdSend(process.argv.slice(3)); break;
  case 'dispatch': await cmdDispatch(process.argv.slice(3)); break;
  case 'report': await cmdReport(process.argv.slice(3)); break;
  case 'create-group': await cmdCreateGroup(process.argv.slice(3)); break;
  case 'bots':     await cmdBots(process.argv[3] ?? 'list', process.argv.slice(4)); break;
  case 'preset':   await cmdPreset(process.argv[3] ?? '', process.argv.slice(4)); break;
  case 'history':  await cmdHistory(process.argv.slice(3)); break;
  case 'quoted':   await cmdQuoted(process.argv.slice(3)); break;
  case 'lang':     await cmdLang(process.argv.slice(3)); break;
  case 'voice':    await cmdVoiceSetup(process.argv.slice(3)); break;
  case 'whiteboard':
  case 'wb':       await cmdWhiteboard(process.argv[3] ?? 'status', process.argv.slice(4)); break;
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
