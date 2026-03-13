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
 *   botmux list           — list all active sessions
 *   botmux delete <id>    — close a session by ID prefix
 *   botmux delete all     — close all active sessions
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Package root is one level up from dist/
const PKG_ROOT = dirname(__dirname);
const CONFIG_DIR = join(homedir(), '.botmux');
const ENV_FILE = join(CONFIG_DIR, '.env');
const DATA_DIR = join(CONFIG_DIR, 'data');
const LOG_DIR = join(CONFIG_DIR, 'logs');
const BOTS_JSON_FILE = join(CONFIG_DIR, 'bots.json');
const PM2_NAME = 'botmux';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureConfigDir(): void {
  for (const dir of [CONFIG_DIR, DATA_DIR, LOG_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function pm2Bin(): string {
  // Use the pm2 bundled with this package
  const local = join(PKG_ROOT, 'node_modules', '.bin', 'pm2');
  if (existsSync(local)) return local;
  // Fallback to global pm2
  return 'pm2';
}

function runPm2(args: string[], inherit = true): void {
  const result = inherit
    ? execSync(`${pm2Bin()} ${args.join(' ')}`, { stdio: 'inherit', env: process.env })
    : execSync(`${pm2Bin()} ${args.join(' ')}`, { env: process.env });
}

function ecosystemConfig(): string {
  const daemonScript = join(PKG_ROOT, 'dist', 'index-daemon.js');
  const cfg = {
    apps: [{
      name: PM2_NAME,
      script: daemonScript,
      cwd: CONFIG_DIR,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: join(LOG_DIR, 'daemon-error.log'),
      out_file: join(LOG_DIR, 'daemon-out.log'),
      merge_logs: true,
      env: {
        SESSION_DATA_DIR: DATA_DIR,
        // .env is loaded by dotenv from CWD (CONFIG_DIR)
      },
    }],
  };
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

function printLarkPermissions(): void {
  console.log('请先在飞书开放平台创建应用: https://open.feishu.cn/app\n');
  console.log('需要的权限:');
  console.log('  - im:message (发送/接收消息)');
  console.log('  - im:message.group_at_msg (群消息)');
  console.log('  - im:resource (文件下载)');
  console.log('  - im:chat (群信息)');
  console.log('  - contact:user.base:readonly (用户信息)\n');
  console.log('启用事件订阅 (WebSocket 模式):');
  console.log('  - im.message.receive_v1');
  console.log('  - card.action.trigger\n');
}

async function promptBotConfig(rl: ReturnType<typeof createInterface>): Promise<Record<string, any>> {
  const appId = await ask(rl, 'LARK_APP_ID: ');
  const appSecret = await ask(rl, 'LARK_APP_SECRET: ');

  console.log('\n支持的 CLI: 1) claude-code  2) aiden  3) coco  4) codex');
  const cliChoice = await ask(rl, 'CLI 适配器 [1]: ');
  const cliIdMap: Record<string, string> = { '1': 'claude-code', '2': 'aiden', '3': 'coco', '4': 'codex' };
  const cliId = cliIdMap[cliChoice] ?? (cliChoice || 'claude-code');
  const workingDir = await ask(rl, '默认工作目录 [~]: ');
  const allowedUsers = await ask(rl, '允许的用户 (邮箱或 open_id，逗号分隔，留空=不限制): ');

  const bot: Record<string, any> = { larkAppId: appId, larkAppSecret: appSecret, cliId };
  if (workingDir) bot.workingDir = workingDir;
  if (allowedUsers) bot.allowedUsers = allowedUsers.split(',').map((s: string) => s.trim()).filter(Boolean);

  return bot;
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
  if (vars.CLI_PATH) bot.cliPathOverride = vars.CLI_PATH;
  if (vars.BACKEND_TYPE) bot.backendType = vars.BACKEND_TYPE;
  if (vars.WORKING_DIR) bot.workingDir = vars.WORKING_DIR;
  if (vars.ALLOWED_USERS) bot.allowedUsers = vars.ALLOWED_USERS.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (vars.PROJECT_SCAN_DIR) bot.projectScanDir = vars.PROJECT_SCAN_DIR;

  return bot;
}

/** Write single-bot .env config (fresh install or reconfigure) */
async function writeSingleBotEnv(): Promise<void> {
  console.log('── 飞书应用配置 ──\n');
  printLarkPermissions();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const bot = await promptBotConfig(rl);
  rl.close();

  const lines: string[] = [
    '# Lark (Feishu) App Credentials',
    `LARK_APP_ID=${bot.larkAppId}`,
    `LARK_APP_SECRET=${bot.larkAppSecret}`,
    '',
    '# Session data directory',
    `SESSION_DATA_DIR=${DATA_DIR}`,
    '',
    '# Daemon settings',
    `CLI_ID=${bot.cliId}`,
    `WORKING_DIR=${bot.workingDir || '~'}`,
  ];

  if (bot.allowedUsers?.length) lines.push(`ALLOWED_USERS=${bot.allowedUsers.join(',')}`);

  writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  console.log(`\n✅ 配置已写入: ${ENV_FILE}`);
  console.log(`\n下一步: botmux start`);
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
    const bots = JSON.parse(readFileSync(BOTS_JSON_FILE, 'utf-8')) as any[];
    console.log(`已配置 ${bots.length} 个机器人：`);
    for (let i = 0; i < bots.length; i++) {
      console.log(`  ${i + 1}. ${bots[i].larkAppId} (${bots[i].cliId ?? 'claude-code'})`);
    }
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const action = await ask(rl, '操作: 1) 添加新机器人  2) 重新配置  (1/2) [1]: ');

    if (action === '2') {
      rl.close();
      renameSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak\n`);
      await writeSingleBotEnv();
      return;
    }

    console.log('\n── 添加新机器人 ──\n');
    printLarkPermissions();
    const newBot = await promptBotConfig(rl);
    rl.close();
    bots.push(newBot);
    writeFileSync(BOTS_JSON_FILE, JSON.stringify(bots, null, 2) + '\n');
    console.log(`\n✅ 已添加机器人 ${newBot.larkAppId}，共 ${bots.length} 个`);
    console.log(`   配置文件: ${BOTS_JSON_FILE}`);
    console.log(`\n下一步: botmux restart`);

  } else if (hasEnv) {
    // --- Single-bot mode (.env exists) ---
    console.log(`当前使用单机器人配置: ${ENV_FILE}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const action = await ask(rl, '操作: 1) 添加新机器人  2) 覆盖当前配置  (1/2): ');

    if (action === '2') {
      rl.close();
      await writeSingleBotEnv();
      return;
    }

    // Migrate .env → bots.json
    const existingBot = parseDotEnvToBotConfig();
    if (!existingBot.larkAppId || !existingBot.larkAppSecret) {
      console.log('\n⚠️  当前 .env 缺少 LARK_APP_ID 或 LARK_APP_SECRET，请先完成基础配置');
      rl.close();
      await writeSingleBotEnv();
      return;
    }
    console.log(`\n当前机器人: ${existingBot.larkAppId} (${existingBot.cliId ?? 'claude-code'})`);
    console.log('\n── 添加新机器人 ──\n');
    printLarkPermissions();
    const newBot = await promptBotConfig(rl);
    rl.close();

    const bots = [existingBot, newBot];
    writeFileSync(BOTS_JSON_FILE, JSON.stringify(bots, null, 2) + '\n');
    renameSync(ENV_FILE, ENV_FILE + '.bak');
    console.log(`\n✅ 已迁移到多机器人配置`);
    console.log(`   配置文件: ${BOTS_JSON_FILE}`);
    console.log(`   旧配置已备份: ${ENV_FILE}.bak`);
    console.log(`\n下一步: botmux restart`);

  } else {
    // --- Fresh install ---
    await writeSingleBotEnv();
  }
}

function cmdStart(): void {
  if (!hasConfig()) {
    console.error('❌ 未找到配置文件');
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  const cfg = ecosystemConfig();
  runPm2(['start', cfg]);
  console.log(`\n✅ daemon 已启动`);
  console.log(`   日志: botmux logs`);
  console.log(`   状态: botmux status`);
}

function cmdStop(): void {
  try {
    runPm2(['stop', PM2_NAME]);
  } catch {
    console.log('daemon 未在运行。');
  }
}

function cmdRestart(): void {
  if (!hasConfig()) {
    console.error('❌ 未找到配置文件');
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  // Delete and re-start to ensure ecosystem config (log paths, env) is up to date
  try { runPm2(['delete', PM2_NAME], false); } catch { /* not running */ }
  const cfg = ecosystemConfig();
  runPm2(['start', cfg]);
}

function cmdLogs(): void {
  const lines = process.argv.includes('--lines')
    ? process.argv[process.argv.indexOf('--lines') + 1] || '50'
    : '50';
  // Use spawn for streaming output
  const child = spawn(pm2Bin(), ['logs', PM2_NAME, '--lines', lines], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', code => process.exit(code ?? 0));
}

function cmdStatus(): void {
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

// ─── Session helpers ──────────────────────────────────────────────────────────

interface SessionData {
  sessionId: string;
  chatId: string;
  chatType?: 'group' | 'p2p';
  rootMessageId: string;
  title: string;
  status: 'active' | 'closed';
  createdAt: string;
  closedAt?: string;
  pid?: number;
  workingDir?: string;
  webPort?: number;
  larkAppId?: string;
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
      if (dir && existsSync(join(dir, 'sessions.json'))) return dir;
    } catch { /* ignore */ }
  }

  return DATA_DIR;
}

function getSessionsFilePath(): string {
  return join(resolveDataDir(), 'sessions.json');
}

function loadSessions(): Map<string, SessionData> {
  const fp = getSessionsFilePath();
  if (!existsSync(fp)) return new Map();
  try {
    const data = JSON.parse(readFileSync(fp, 'utf-8'));
    return new Map(Object.entries(data));
  } catch {
    console.error(`❌ 无法读取会话文件: ${fp}`);
    return new Map();
  }
}

function saveSessions(sessions: Map<string, SessionData>): void {
  const fp = getSessionsFilePath();
  const tmpFp = fp + '.tmp';
  const obj: Record<string, SessionData> = {};
  for (const [k, v] of sessions) {
    obj[k] = v;
  }
  writeFileSync(tmpFp, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
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

function cmdList(): void {
  const sessions = loadSessions();
  const active = [...sessions.values()].filter(s => s.status === 'active');

  if (active.length === 0) {
    console.log('没有活跃会话。');
    return;
  }

  // Detect multi-bot mode: show bot column if bots.json exists or sessions have different larkAppIds
  const botConfigs = loadBotConfigsForDisplay();
  const multiBot = botConfigs.length > 1 || new Set(active.map(s => s.larkAppId).filter(Boolean)).size > 1;

  // Build a larkAppId → short label map (e.g. "bot1 (claude-code)")
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
    const id = padEndDisplay(s.sessionId.substring(0, 8), cols.id);
    const parts = [id];
    if (multiBot) {
      const label = s.larkAppId ? (botLabels.get(s.larkAppId) ?? s.larkAppId.substring(0, 18)) : '-';
      parts.push(padEndDisplay(truncate(label, cols.bot!), cols.bot!));
    }
    const title = padEndDisplay(truncate(s.title || '(untitled)', cols.title), cols.title);
    const dir = padEndDisplay(truncate(s.workingDir || '-', cols.dir), cols.dir);
    const pid = s.pid ? String(s.pid).padEnd(cols.pid) : '-'.padEnd(cols.pid);
    const uptime = formatDuration(Date.now() - new Date(s.createdAt).getTime()).padEnd(cols.uptime);
    const alive = s.pid && isProcessAlive(s.pid);
    const status = (alive ? 'online' : s.pid ? 'stopped' : 'idle').padEnd(cols.status);

    parts.push(title, dir, pid, uptime, status);
    console.log(parts.join(' │ '));
  }

  console.log(separator);
  console.log(`共 ${active.length} 个活跃会话`);
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
    toDelete = active.filter(s => s.pid && !isProcessAlive(s.pid));
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
      execSync(`tmux kill-session -t '${tmuxName}' 2>/dev/null`, { stdio: 'ignore' });
      console.log(`  killed tmux ${tmuxName}`);
    } catch { /* no tmux session */ }

    // Mark session as closed
    s.status = 'closed';
    s.closedAt = new Date().toISOString();
    sessions.set(s.sessionId, s);
    console.log(`✓ ${s.sessionId.substring(0, 8)} ${s.title}`);
  }

  saveSessions(sessions);
  console.log(`\n已关闭 ${toDelete.length} 个会话`);
}

function showHelp(): void {
  console.log(`
botmux — IM ↔ AI 编程 CLI 桥接

命令:
  setup       交互式配置（首次使用 / 添加机器人）
  start       启动 daemon
  stop        停止 daemon
  restart     重启 daemon（自动恢复活跃会话）
  logs        查看 daemon 日志（--lines N）
  status      查看 daemon 状态
  upgrade     升级到最新版本
  list        列出所有活跃会话
  delete <id>      关闭指定会话（支持 ID 前缀匹配）
  delete all       关闭所有活跃会话
  delete stopped   清理所有进程已退出的僵尸会话

配置目录: ~/.botmux/
文档: https://github.com/deepcoldy/botmux
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case 'setup':   await cmdSetup(); break;
  case 'start':   cmdStart(); break;
  case 'stop':    cmdStop(); break;
  case 'restart': cmdRestart(); break;
  case 'logs':    cmdLogs(); break;
  case 'status':  cmdStatus(); break;
  case 'upgrade': cmdUpgrade(); break;
  case 'list':
  case 'ls':      cmdList(); break;
  case 'delete':
  case 'del':
  case 'rm':      cmdDelete(); break;
  default:        showHelp(); break;
}
