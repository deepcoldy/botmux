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
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Package root is one level up from dist/
const PKG_ROOT = dirname(__dirname);
const CONFIG_DIR = join(homedir(), '.botmux');
const ENV_FILE = join(CONFIG_DIR, '.env');
const DATA_DIR = join(CONFIG_DIR, 'data');
const LOG_DIR = join(CONFIG_DIR, 'logs');
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
  for (const dir of [CONFIG_DIR, DATA_DIR, LOG_DIR, PM2_HOME]) {
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

function runPm2(args: string[], inherit = true, home: string = PM2_HOME): void {
  execSync(`${pm2Bin()} ${args.join(' ')}`, {
    stdio: inherit ? 'inherit' : 'pipe',
    env: pm2Env(home),
  });
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

async function promptBotConfig(rl: ReturnType<typeof createInterface>): Promise<Record<string, any>> {
  const appId = await ask(rl, 'LARK_APP_ID: ');
  const appSecret = await ask(rl, 'LARK_APP_SECRET: ');

  console.log('\n支持的 CLI: 1) claude-code  2) aiden  3) coco  4) codex  5) gemini  6) opencode');
  const cliChoice = await ask(rl, 'CLI 适配器 [1]: ');
  const cliIdMap: Record<string, string> = { '1': 'claude-code', '2': 'aiden', '3': 'coco', '4': 'codex', '5': 'gemini', '6': 'opencode' };
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

/** Write single-bot config to bots.json (fresh install or reconfigure) */
async function writeSingleBotConfig(): Promise<void> {
  console.log('── 飞书应用配置 ──\n');
  printLarkPermissions();

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
      console.log(`  ${i + 1}. ${bots[i].larkAppId} (${bots[i].cliId ?? 'claude-code'})`);
    }
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const action = await ask(rl, '操作: 1) 添加新机器人  2) 重新配置  (1/2) [1]: ');

    if (action === '2') {
      renameSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak\n`);
      console.log('\n── 重新配置 ──\n');
      printLarkPermissions();
      const newBot = await promptBotConfig(rl);
      rl.close();
      writeFileSync(BOTS_JSON_FILE, JSON.stringify([newBot], null, 2) + '\n');
      console.log(`\n✅ 配置已写入: ${BOTS_JSON_FILE}`);
      console.log(`\n下一步: botmux restart`);
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
  cleanupLegacyPm2();
  const cfg = ecosystemConfig();
  runPm2(['start', cfg]);
  const bots = loadBotsJson();
  const count = bots.length || 1;
  console.log(`\n✅ daemon 已启动${count > 1 ? ` (${count} 个机器人, 每个独立进程)` : ''}`);
  console.log(`   日志: botmux logs`);
  console.log(`   状态: botmux status`);
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
  if (!stopped) console.log('daemon 未在运行。');
}

function cmdRestart(): void {
  if (!hasConfig()) {
    console.error('❌ 未找到配置文件');
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  cleanupLegacyPm2();
  // Delete all botmux processes (handles both old single-process and new multi-process)
  deleteAllBotmuxProcesses();
  const cfg = ecosystemConfig();
  runPm2(['start', cfg]);
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
  warnIfLegacyBotmuxAlive();
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
    env: pm2Env(),
  });
  child.on('exit', code => process.exit(code ?? 0));
}

function cmdStatus(): void {
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

function showHelp(): void {
  console.log(`
botmux v${getVersion()} — IM ↔ AI 编程 CLI 桥接

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
  bots list                            列出当前群聊中的机器人（含 open_id）
  thread messages [--limit N]          拉取当前话题的消息历史 (JSON)

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
 *  (for --flag <value> style).  --flag=value style is self-contained. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (!a.includes('=') && i + 1 < args.length) i++; // skip value
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

async function cmdThreadMessages(rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const limit = parseInt(argValue(rest, '--limit') ?? '50', 10);
  const sessionIdArg = argValue(rest, '--session-id');

  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题内的 CLI 会话中运行，或传 --session-id <id>。');
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

  const { listThreadMessages } = await import('./im/lark/client.js');
  const { parseApiMessage } = await import('./im/lark/message-parser.js');
  try {
    const raw = await listThreadMessages(s.larkAppId, s.chatId, s.rootMessageId, limit);
    const messages = raw.map(parseApiMessage);
    console.log(JSON.stringify({ sessionId: sid, threadId: s.rootMessageId, messages, total: messages.length }, null, 2));
  } catch (err: any) {
    console.error(`获取话题消息失败: ${err.message}`);
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

/** Feishu card markdown element doesn't render ATX headings → promote to bold. */
function transformHeadings(md: string): string {
  return md.replace(/^#{1,6}\s+(.+)$/gm, (_m, c: string) => `**${c.trim()}**`);
}

/** Parse a contiguous pipe-table block into a Feishu card v2 `table` element. */
function parseTableBlock(block: string): any | null {
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const rows = lines.map(l => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  const sepIdx = rows.findIndex(r => r.length > 0 && r.every(c => /^:?-{2,}:?$/.test(c)));
  const header = rows[0];
  const body = sepIdx === 1 ? rows.slice(2) : rows.slice(1);
  if (header.length === 0) return null;
  const columns = header.map((h, i) => ({
    name: `c${i}`,
    display_name: h || ' ',
    data_type: 'lark_md',
    width: 'auto',
  }));
  const tableRows = body.map(r => {
    const o: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) o[`c${i}`] = r[i] ?? '';
    return o;
  });
  return {
    tag: 'table',
    page_size: Math.min(10, Math.max(1, tableRows.length || 1)),
    row_height: 'low',
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'default',
      bold: true,
      lines: 1,
    },
    columns,
    rows: tableRows,
  };
}

/**
 * Split markdown into card v2 body elements: pipe-table blocks become native
 * `table` elements, remaining prose becomes `markdown` elements (with ATX
 * headings promoted to bold since the markdown element doesn't render `#`).
 */
function buildCardBodyElements(md: string): any[] {
  const elements: any[] = [];
  const re = /(?:^[ \t]*\|.+\|[ \t]*\r?\n?){2,}/gm;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(md)) !== null) {
    const pre = md.slice(cursor, match.index).replace(/\s+$/, '');
    if (pre) elements.push({ tag: 'markdown', content: transformHeadings(pre) });
    const table = parseTableBlock(match[0]);
    if (table) elements.push(table);
    else elements.push({ tag: 'markdown', content: transformHeadings(match[0]) });
    cursor = match.index + match[0].length;
  }
  const tail = md.slice(cursor).replace(/^\s+/, '').replace(/\s+$/, '');
  if (tail) elements.push({ tag: 'markdown', content: transformHeadings(tail) });
  return elements;
}

/**
 * Heuristic: does `text` contain markdown syntax that renders badly as plain
 * text in Feishu (code fences, headings, lists, bold, inline code, links,
 * tables, blockquotes, hr)? If so, `cmdSend` switches to an interactive card
 * so Feishu can render it properly.
 */
function hasMarkdown(text: string): boolean {
  if (!text) return false;
  return (
    /```/.test(text) ||
    /^#{1,6}\s/m.test(text) ||
    /^\s{0,3}[-*+]\s+\S/m.test(text) ||
    /^\s{0,3}\d+\.\s+\S/m.test(text) ||
    /\*\*[^*\n]+\*\*/.test(text) ||
    /(^|[^`])`[^`\n]+`([^`]|$)/.test(text) ||
    /\[[^\]\n]+\]\([^)\n]+\)/.test(text) ||
    /^\s*\|.+\|\s*$/m.test(text) ||
    /^>\s/m.test(text) ||
    /^(?:---|\*\*\*|___)\s*$/m.test(text)
  );
}

async function cmdSend(rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sessionIdArg = argValue(rest, '--session-id');
  const images = argValues(rest, '--image', '--images');
  const files = argValues(rest, '--file', '--files');
  const mentionArgs = argValues(rest, '--mention');  // "open_id:Display Name"
  const contentFile = argValue(rest, '--content-file');
  const forceCard = rest.includes('--card');
  const forceText = rest.includes('--text');

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
    const pos = positionals(rest);
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

  // Parse mentions: "open_id:Display Name"
  const mentions: Array<{ open_id: string; name: string }> = [];
  for (const m of mentionArgs) {
    const idx = m.indexOf(':');
    if (idx > 0) {
      mentions.push({ open_id: m.slice(0, idx), name: m.slice(idx + 1) });
    }
  }

  // Validate file paths
  for (const p of [...images, ...files]) {
    if (!existsSync(p)) { console.error(`文件不存在: ${p}`); process.exit(1); }
  }

  // Register bots so Lark client works
  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }

  const { replyMessage, uploadImage, uploadFile } = await import('./im/lark/client.js');
  const appId = s.larkAppId!;

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

    // Decide: interactive card (renders markdown) vs. post (plain text).
    // Explicit --card / --text wins; otherwise auto-detect markdown syntax.
    const useCard = forceCard || (!forceText && hasMarkdown(text));

    const mentionMap = new Map<string, string>();
    for (const m of mentions) mentionMap.set(m.name.toLowerCase(), m.open_id);
    const mentionPattern = mentions.length > 0
      ? new RegExp(`@(${mentions.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')
      : null;

    let messageId: string;
    if (useCard) {
      // Inline @mention → <at id=open_id></at>; unused + owner appended at end.
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
      if (s.ownerOpenId) trailingAts.push(`<at id=${s.ownerOpenId}></at>`);
      if (trailingAts.length > 0) md = md ? `${md}\n\n${trailingAts.join(' ')}` : trailingAts.join(' ');

      const elements: any[] = md ? buildCardBodyElements(md) : [];
      for (const key of imageKeys) {
        elements.push({
          tag: 'img',
          img_key: key,
          alt: { tag: 'plain_text', content: '' },
          scale_type: 'fit_horizontal',
          preview: true,
        });
      }
      const cardJson = JSON.stringify({
        schema: '2.0',
        config: { update_multi: true },
        body: { direction: 'vertical', elements },
      });
      messageId = await replyMessage(appId, s.rootMessageId, cardJson, 'interactive', true);
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

      if (s.ownerOpenId) {
        if (postContent.length === 0) postContent.push([]);
        postContent[postContent.length - 1].push({ tag: 'at', user_id: s.ownerOpenId });
      }

      const postJson = JSON.stringify({ zh_cn: { title: '', content: postContent } });
      messageId = await replyMessage(appId, s.rootMessageId, postJson, 'post', true);
    }

    // Send file attachments as separate messages
    const fileIds: string[] = [];
    for (const fp of files) {
      const fileKey = await uploadFile(appId, fp);
      const fid = await replyMessage(appId, s.rootMessageId, JSON.stringify({ file_key: fileKey }), 'file', true);
      fileIds.push(fid);
    }

    // Bot-to-bot mention signals
    const dataDir = resolveDataDir();
    const botInfoPath = join(dataDir, 'bots-info.json');
    type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
    let botEntries: BotInfoEntry[] = [];
    try { if (existsSync(botInfoPath)) botEntries = JSON.parse(readFileSync(botInfoPath, 'utf-8')); } catch { /* */ }

    const openIdToAppId = new Map<string, string>();
    for (const e of botEntries) if (e.botOpenId) openIdToAppId.set(e.botOpenId, e.larkAppId);
    try {
      for (const file of readdirSync(dataDir)) {
        if (!file.startsWith('bot-openids-') || !file.endsWith('.json')) continue;
        try {
          const crossRef: Record<string, string> = JSON.parse(readFileSync(join(dataDir, file), 'utf-8'));
          for (const [botName, crossOpenId] of Object.entries(crossRef)) {
            const entry = botEntries.find(e => e.botName?.toLowerCase() === botName.toLowerCase());
            if (entry) openIdToAppId.set(crossOpenId, entry.larkAppId);
          }
        } catch { /* */ }
      }
    } catch { /* */ }

    const targetAppIds = new Set<string>();
    for (const m of mentions) {
      const ta = openIdToAppId.get(m.open_id);
      if (ta && ta !== appId) targetAppIds.add(ta);
    }
    if (text && botEntries.length > 0) {
      for (const entry of botEntries) {
        if (!entry.botOpenId || entry.larkAppId === appId) continue;
        const names = [entry.botName, entry.cliId].filter(Boolean) as string[];
        for (const name of names) {
          if (new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
            targetAppIds.add(entry.larkAppId); break;
          }
        }
      }
    }
    if (targetAppIds.size > 0) {
      const signalDir = join(dataDir, 'bot-mentions');
      if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true });
      for (const targetApp of targetAppIds) {
        const te = botEntries.find(e => e.larkAppId === targetApp);
        const signal = {
          rootMessageId: s.rootMessageId, chatId: s.chatId, chatType: s.chatType,
          senderAppId: appId, targetBotOpenId: te?.botOpenId ?? targetApp,
          content: text, messageId, timestamp: Date.now(),
        };
        writeFileSync(join(signalDir, `${Date.now()}-${(te?.botOpenId ?? targetApp).slice(-8)}.json`), JSON.stringify(signal));
      }
    }

    console.log(JSON.stringify({ success: true, messageId, sessionId: sid }));
  } catch (err: any) {
    console.error(`发送失败: ${err.message}`);
    process.exit(1);
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

  const botByCli = new Map<string, BotInfoEntry>();
  for (const b of botEntries) botByCli.set(b.cliId, b);

  try {
    const { listChatBotMembers } = await import('./im/lark/client.js');
    const chatBots = await listChatBotMembers(appId, s.chatId);
    const result = chatBots.map(cb => {
      const info = botByCli.get(cb.name);
      return { name: cb.displayName, openId: cb.openId, isSelf: info?.larkAppId === appId };
    });
    console.log(JSON.stringify({ sessionId: sid, chatId: s.chatId, bots: result, total: result.length }, null, 2));
  } catch (err: any) {
    // Fallback to bots-info.json
    const result = botEntries.filter(b => b.botOpenId).map(b => ({
      name: b.botName ?? b.cliId, openId: b.botOpenId!, isSelf: b.larkAppId === appId,
    }));
    console.log(JSON.stringify({ sessionId: sid, bots: result, total: result.length, note: `chat query failed: ${err.message}` }, null, 2));
  }
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

switch (command) {
  case '--version':
  case '-v':      console.log(getVersion()); break;
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
  case 'schedule': await cmdSchedule(process.argv[3] ?? '', process.argv.slice(4)); break;
  case 'send':     await cmdSend(process.argv.slice(3)); break;
  case 'bots':     await cmdBots(process.argv[3] ?? 'list', process.argv.slice(4)); break;
  case 'thread':   {
    const sub = process.argv[3] ?? '';
    if (sub === 'messages' || sub === 'msgs') await cmdThreadMessages(process.argv.slice(4));
    else { console.error(`用法: botmux thread messages [--limit N] [--session-id ID]`); process.exit(1); }
    break;
  }
  default:        showHelp(); break;
}
