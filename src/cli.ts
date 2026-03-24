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
 */
import { execSync, spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
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

function loadBotsJson(): any[] {
  if (existsSync(BOTS_JSON_FILE)) {
    try { return JSON.parse(readFileSync(BOTS_JSON_FILE, 'utf-8')); } catch { return []; }
  }
  return [];
}

function ecosystemConfig(): string {
  const daemonScript = join(PKG_ROOT, 'dist', 'index-daemon.js');
  const bots = loadBotsJson();

  const baseApp = {
    script: daemonScript,
    cwd: CONFIG_DIR,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  };

  const apps = bots.map((_bot: any, i: number) => ({
    ...baseApp,
    name: `${PM2_NAME}-${i}`,
    error_file: join(LOG_DIR, `daemon-${i}-error.log`),
    out_file: join(LOG_DIR, `daemon-${i}-out.log`),
    env: { SESSION_DATA_DIR: DATA_DIR, BOTMUX_BOT_INDEX: String(i) },
  }));

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

/** Inner prompt: given a known im type, collect the rest of the bot config fields. */
async function promptBotConfig_inner(rl: ReturnType<typeof createInterface>, im: 'lark' | 'weixin'): Promise<Record<string, any>> {
  let appId: string | undefined;
  let appSecret: string | undefined;

  if (im === 'lark') {
    appId = await ask(rl, 'LARK_APP_ID: ');
    appSecret = await ask(rl, 'LARK_APP_SECRET: ');
  }

  console.log('\n支持的 CLI: 1) claude-code  2) aiden  3) coco  4) codex  5) gemini  6) opencode');
  const cliChoice = await ask(rl, 'CLI 适配器 [1]: ');
  const cliIdMap: Record<string, string> = { '1': 'claude-code', '2': 'aiden', '3': 'coco', '4': 'codex', '5': 'gemini', '6': 'opencode' };
  const cliId = cliIdMap[cliChoice] ?? (cliChoice || 'claude-code');
  const workingDir = await ask(rl, '默认工作目录 [~]: ');
  const allowedUsers = await ask(rl, '允许的用户 (邮箱或 open_id，逗号分隔，留空=不限制): ');

  const bot: Record<string, any> = { im, cliId };
  if (im === 'lark') {
    bot.larkAppId = appId;
    bot.larkAppSecret = appSecret;
  }
  if (workingDir) bot.workingDir = workingDir;
  if (allowedUsers) bot.allowedUsers = allowedUsers.split(',').map((s: string) => s.trim()).filter(Boolean);

  return bot;
}

async function promptBotConfig(rl: ReturnType<typeof createInterface>): Promise<Record<string, any>> {
  const imChoice = await ask(rl, 'IM 类型: 1) 飞书  2) 微信 [1]: ');
  const im = imChoice === '2' ? 'weixin' : 'lark';

  if (im === 'lark') {
    printLarkPermissions();
  }

  return promptBotConfig_inner(rl, im);
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

/** Write single-bot config to bots.json (fresh install or reconfigure) */
async function writeSingleBotConfig(): Promise<void> {
  console.log('── 机器人配置 ──\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const bot = await promptBotConfig(rl);
  rl.close();

  writeFileSync(BOTS_JSON_FILE, JSON.stringify([bot], null, 2) + '\n');
  console.log(`\n✅ 配置已写入: ${BOTS_JSON_FILE}`);
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
      const label = bots[i].im === 'weixin' ? `weixin` : (bots[i].larkAppId ?? '(unknown)');
      console.log(`  ${i + 1}. ${label} (${bots[i].cliId ?? 'claude-code'})`);
    }
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const action = await ask(rl, '操作: 1) 添加新机器人  2) 重新配置  (1/2) [1]: ');

    if (action === '2') {
      renameSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak\n`);
      console.log('\n── 重新配置 ──\n');
      const newBot = await promptBotConfig(rl);
      rl.close();
      writeFileSync(BOTS_JSON_FILE, JSON.stringify([newBot], null, 2) + '\n');
      console.log(`\n✅ 配置已写入: ${BOTS_JSON_FILE}`);
      console.log(`\n下一步: botmux restart`);
      return;
    }

    console.log('\n── 添加新机器人 ──\n');
    const newBot = await promptBotConfig(rl);
    rl.close();
    bots.push(newBot);
    writeFileSync(BOTS_JSON_FILE, JSON.stringify(bots, null, 2) + '\n');
    const newBotLabel = newBot.im === 'weixin' ? `weixin` : newBot.larkAppId;
    console.log(`\n✅ 已添加机器人 ${newBotLabel}，共 ${bots.length} 个`);
    console.log(`   配置文件: ${BOTS_JSON_FILE}`);
    console.log(`\n下一步: botmux restart`);

  } else if (hasEnv) {
    // --- Single-bot mode (.env exists) ---
    console.log(`当前使用单机器人配置: ${ENV_FILE}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const action = await ask(rl, '操作: 1) 添加新机器人  2) 覆盖当前配置  (1/2): ');

    if (action === '2') {
      rl.close();
      await writeSingleBotConfig();
      renameSync(ENV_FILE, ENV_FILE + '.bak');
      console.log(`   旧 .env 已备份: ${ENV_FILE}.bak`);
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

    const bots = [existingBot, newBot];
    writeFileSync(BOTS_JSON_FILE, JSON.stringify(bots, null, 2) + '\n');
    renameSync(ENV_FILE, ENV_FILE + '.bak');
    console.log(`\n✅ 已迁移到多机器人配置`);
    console.log(`   配置文件: ${BOTS_JSON_FILE}`);
    console.log(`   旧配置已备份: ${ENV_FILE}.bak`);
    console.log(`\n下一步: botmux restart`);

  } else {
    // --- Fresh install ---
    await writeSingleBotConfig();
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
  const bots = loadBotsJson();
  const count = bots.length || 1;
  console.log(`\n✅ daemon 已启动${count > 1 ? ` (${count} 个机器人, 每个独立进程)` : ''}`);
  console.log(`   日志: botmux logs`);
  console.log(`   状态: botmux status`);
}

/** Delete all pm2 processes matching botmux / botmux-* */
function deleteAllBotmuxProcesses(): void {
  try {
    const output = execSync(`${pm2Bin()} jlist`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const apps = JSON.parse(output) as any[];
    for (const app of apps) {
      if (app.name === PM2_NAME || app.name.startsWith(`${PM2_NAME}-`)) {
        try { execSync(`${pm2Bin()} delete ${app.name}`, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { /* */ }
      }
    }
  } catch { /* pm2 not running or no apps */ }
}

function cmdStop(): void {
  let stopped = false;
  try {
    const output = execSync(`${pm2Bin()} jlist`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const apps = JSON.parse(output) as any[];
    for (const app of apps) {
      if (app.name === PM2_NAME || app.name.startsWith(`${PM2_NAME}-`)) {
        try { runPm2(['stop', app.name]); stopped = true; } catch { /* */ }
      }
    }
  } catch { /* */ }
  if (!stopped) console.log('daemon 未在运行。');
}

function cmdRestart(): void {
  if (!hasConfig()) {
    console.error('❌ 未找到配置文件');
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  // Delete all botmux processes (handles both old single-process and new multi-process)
  deleteAllBotmuxProcesses();
  const cfg = ecosystemConfig();
  runPm2(['start', cfg]);
}

function cmdLogs(): void {
  const lines = process.argv.includes('--lines')
    ? process.argv[process.argv.indexOf('--lines') + 1] || '50'
    : '50';

  const bots = loadBotsJson();
  // Support --bot <index> to filter specific bot logs
  const botIdx = process.argv.includes('--bot')
    ? process.argv[process.argv.indexOf('--bot') + 1]
    : undefined;

  let target: string;
  if (botIdx !== undefined) {
    target = `${PM2_NAME}-${botIdx}`;
  } else {
    // Show all botmux logs via pm2 regex match
    target = `/^${PM2_NAME}/`;
  }

  // Use spawn for streaming output
  const child = spawn(pm2Bin(), ['logs', target, '--lines', lines], {
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
  imBotId?: string;
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
  if (existsSync(legacyFp)) {
    try {
      const data = JSON.parse(readFileSync(legacyFp, 'utf-8'));
      for (const [k, v] of Object.entries(data)) sessions.set(k, v as SessionData);
    } catch { /* ignore */ }
  }

  // Read per-bot session files (sessions-{appId}.json)
  try {
    for (const file of readdirSync(dataDir)) {
      if (file.startsWith('sessions-') && file.endsWith('.json')) {
        try {
          const data = JSON.parse(readFileSync(join(dataDir, file), 'utf-8'));
          for (const [k, v] of Object.entries(data)) sessions.set(k, v as SessionData);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return sessions;
}

/** Save a single session back to its appropriate file based on larkAppId. */
function saveSession(session: SessionData): void {
  const dataDir = resolveDataDir();
  const fileName = session.imBotId ? `sessions-${session.imBotId}.json` : 'sessions.json';
  const fp = join(dataDir, fileName);

  // Read current file, update session, write back
  let data: Record<string, SessionData> = {};
  if (existsSync(fp)) {
    try { data = JSON.parse(readFileSync(fp, 'utf-8')); } catch { /* start fresh */ }
  }
  data[session.sessionId] = session;

  const tmpFp = fp + '.tmp';
  writeFileSync(tmpFp, JSON.stringify(data, null, 2), 'utf-8');
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
    const label = s.imBotId ? (botLabels.get(s.imBotId) ?? s.imBotId.substring(0, 18)) : '-';
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
  const multiBot = botConfigs.length > 1 || new Set(active.map(s => s.imBotId).filter(Boolean)).size > 1;
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
    execSync(`tmux has-session -t ${name} 2>/dev/null`, { stdio: 'ignore' });
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
  const multiBot = botConfigs.length > 1 || new Set(active.map(s => s.imBotId).filter(Boolean)).size > 1;
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
        const label = s.imBotId ? (botLabels.get(s.imBotId) ?? s.imBotId.substring(0, 16)) : '-';
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
        try { execSync(`tmux kill-session -t '${r.tmuxName}' 2>/dev/null`, { stdio: 'ignore' }); } catch { /* */ }
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
    if (s.pid && !hasPid && !hasTmux) {
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
    saveSession(s);
    console.log(`✓ ${s.sessionId.substring(0, 8)} ${s.title}`);
  }
  console.log(`\n已关闭 ${toDelete.length} 个会话`);
}

async function cmdWeixinAuth(): Promise<void> {
  ensureConfigDir();
  const { loadToken, validateToken, getQrCode, pollQrCodeStatus, saveToken } = await import('./im/weixin/auth.js');

  const existing = loadToken();
  if (existing) {
    const valid = await validateToken(existing.bot_token);
    if (valid) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await ask(rl, '已有有效 token。重新认证？[y/N] ');
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        console.log('保留现有 token。');
        return;
      }
    } else {
      console.log('现有 token 已失效，需要重新认证。');
    }
  }

  console.log('正在获取微信登录二维码...');
  const { qrcode, qrcode_img_content } = await getQrCode();

  // Print QR code to terminal
  const qrcodeTerminal = await import('qrcode-terminal');
  (qrcodeTerminal.default || qrcodeTerminal).generate(qrcode_img_content || qrcode, { small: true });
  console.log('\n请用微信扫描上方二维码');

  console.log('等待扫码...');
  const token = await pollQrCodeStatus(qrcode);
  saveToken(token);

  console.log(`\n✅ 认证成功！Bot ID: ${token.bot_id}`);
  console.log('Token 已保存到 ~/.botmux/weixin-token.json');
  console.log('\n下一步: botmux restart');
}

function showHelp(): void {
  console.log(`
botmux — IM ↔ AI 编程 CLI 桥接

命令:
  setup       交互式配置（首次使用 / 添加机器人）
  start       启动 daemon
  stop        停止 daemon
  restart     重启 daemon（自动恢复活跃会话）
  logs        查看 daemon 日志（--lines N, --bot <index>）
  status      查看 daemon 状态
  upgrade     升级到最新版本
  list        列出活跃会话（交互式选择并连接 tmux）
              --plain  纯文本表格输出（管道/脚本场景）
  delete <id>      关闭指定会话（支持 ID 前缀匹配）
  delete all       关闭所有活跃会话
  delete stopped   清理所有进程已退出的僵尸会话
  weixin-auth 微信扫码认证（获取 iLink Bot Token）

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
  case 'ls':      await cmdList(); break;
  case 'delete':
  case 'del':
  case 'rm':      cmdDelete(); break;
  case 'weixin-auth': await cmdWeixinAuth(); break;
  default:        showHelp(); break;
}
