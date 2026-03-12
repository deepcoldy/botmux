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

function hasEnvFile(): boolean {
  return existsSync(ENV_FILE);
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdSetup(): Promise<void> {
  ensureConfigDir();

  console.log('\n🤖 botmux 配置向导\n');
  console.log(`配置目录: ${CONFIG_DIR}`);
  console.log(`数据目录: ${DATA_DIR}\n`);

  if (hasEnvFile()) {
    console.log(`⚠️  配置文件已存在: ${ENV_FILE}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await ask(rl, '是否覆盖？(y/N) ');
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('已取消。');
      return;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('── 飞书应用配置 ──');
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

  const appId = await ask(rl, 'LARK_APP_ID: ');
  const appSecret = await ask(rl, 'LARK_APP_SECRET: ');

  console.log('\n── 可选配置 ──');
  console.log('支持的 CLI: 1) claude-code  2) aiden  3) coco  4) codex');
  const cliChoice = await ask(rl, 'CLI 适配器 [1]: ');
  const cliIdMap: Record<string, string> = { '1': 'claude-code', '2': 'aiden', '3': 'coco', '4': 'codex' };
  const cliId = cliIdMap[cliChoice] ?? (cliChoice || 'claude-code');
  const workingDir = await ask(rl, '默认工作目录 [~]: ');
  const allowedUsers = await ask(rl, '允许的用户 (邮箱或 open_id，逗号分隔，留空=不限制): ');
  rl.close();

  const lines: string[] = [
    '# Lark (Feishu) App Credentials',
    `LARK_APP_ID=${appId}`,
    `LARK_APP_SECRET=${appSecret}`,
    '',
    '# Session data directory',
    `SESSION_DATA_DIR=${DATA_DIR}`,
    '',
    '# Daemon settings',
    `CLI_ID=${cliId}`,
    `WORKING_DIR=${workingDir || '~'}`,
  ];

  if (allowedUsers) lines.push(`ALLOWED_USERS=${allowedUsers}`);

  writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  console.log(`\n✅ 配置已写入: ${ENV_FILE}`);
  console.log(`\n下一步: botmux start`);
}

function cmdStart(): void {
  if (!hasEnvFile()) {
    console.error(`❌ 未找到配置文件: ${ENV_FILE}`);
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
  if (!hasEnvFile()) {
    console.error(`❌ 未找到配置文件: ${ENV_FILE}`);
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  // Try restart first; if not running, start fresh
  try {
    runPm2(['restart', PM2_NAME]);
  } catch {
    const cfg = ecosystemConfig();
    runPm2(['start', cfg]);
  }
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
}

function getSessionsFilePath(): string {
  // Check env first, then fallback to default
  const dataDir = process.env.SESSION_DATA_DIR ?? DATA_DIR;
  return join(dataDir, 'sessions.json');
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

function cmdList(): void {
  const sessions = loadSessions();
  const active = [...sessions.values()].filter(s => s.status === 'active');

  if (active.length === 0) {
    console.log('没有活跃会话。');
    return;
  }

  const cols = { id: 10, title: 30, dir: 30, pid: 8, uptime: 8, status: 8 };

  const header = [
    'id'.padEnd(cols.id),
    'title'.padEnd(cols.title),
    'working dir'.padEnd(cols.dir),
    'pid'.padEnd(cols.pid),
    'uptime'.padEnd(cols.uptime),
    'status'.padEnd(cols.status),
  ].join(' │ ');

  const separator = '─'.repeat(displayWidth(header));

  console.log(separator);
  console.log(header);
  console.log(separator);

  for (const s of active) {
    const id = padEndDisplay(s.sessionId.substring(0, 8), cols.id);
    const title = padEndDisplay(truncate(s.title || '(untitled)', cols.title), cols.title);
    const dir = padEndDisplay(truncate(s.workingDir || '-', cols.dir), cols.dir);
    const pid = s.pid ? String(s.pid).padEnd(cols.pid) : '-'.padEnd(cols.pid);
    const uptime = formatDuration(Date.now() - new Date(s.createdAt).getTime()).padEnd(cols.uptime);
    const alive = s.pid && isProcessAlive(s.pid);
    const status = (alive ? 'online' : s.pid ? 'stopped' : 'idle').padEnd(cols.status);

    console.log([id, title, dir, pid, uptime, status].join(' │ '));
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
  setup       交互式配置（首次使用）
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
