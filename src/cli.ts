#!/usr/bin/env node
/**
 * CLI entry point for claude-code-robot.
 *
 * Usage:
 *   claude-code-robot setup          — interactive first-time configuration
 *   claude-code-robot start          — start daemon (pm2)
 *   claude-code-robot stop           — stop daemon
 *   claude-code-robot restart        — restart daemon (auto-restores sessions)
 *   claude-code-robot logs [--lines] — view daemon logs
 *   claude-code-robot status         — show daemon status
 *   claude-code-robot upgrade        — upgrade to latest version
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Package root is one level up from dist/
const PKG_ROOT = dirname(__dirname);
const CONFIG_DIR = join(homedir(), '.claude-code-robot');
const ENV_FILE = join(CONFIG_DIR, '.env');
const DATA_DIR = join(CONFIG_DIR, 'data');
const LOG_DIR = join(CONFIG_DIR, 'logs');
const PM2_NAME = 'claude-code-robot';

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

  console.log('\n🤖 claude-code-robot 配置向导\n');
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
  const chatId = await ask(rl, 'LARK_DEFAULT_CHAT_ID (话题群 ID): ');

  console.log('\n── 可选配置 ──');
  const model = await ask(rl, 'Claude 模型 (opus/sonnet/haiku) [opus]: ');
  const claudePath = await ask(rl, 'Claude CLI 路径 [claude]: ');
  const workingDir = await ask(rl, '默认工作目录 [~]: ');
  const allowedUsers = await ask(rl, '允许的用户 open_id (逗号分隔，留空=不限制): ');
  const externalHost = await ask(rl, '外部 IP/域名 (终端链接用，留空=自动检测): ');
  rl.close();

  const lines: string[] = [
    '# Lark (Feishu) App Credentials',
    `LARK_APP_ID=${appId}`,
    `LARK_APP_SECRET=${appSecret}`,
    `LARK_DEFAULT_CHAT_ID=${chatId}`,
    '',
    '# Session data directory',
    `SESSION_DATA_DIR=${DATA_DIR}`,
    '',
    '# Daemon settings',
    `LARK_BRIDGE_MODEL=${model || 'opus'}`,
    `CLAUDE_PATH=${claudePath || 'claude'}`,
    `CLAUDE_WORKING_DIR=${workingDir || '~'}`,
  ];

  if (allowedUsers) lines.push(`ALLOWED_USERS=${allowedUsers}`);
  if (externalHost) lines.push(`WEB_EXTERNAL_HOST=${externalHost}`);

  writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  console.log(`\n✅ 配置已写入: ${ENV_FILE}`);
  console.log(`\n下一步: claude-code-robot start`);
}

function cmdStart(): void {
  if (!hasEnvFile()) {
    console.error(`❌ 未找到配置文件: ${ENV_FILE}`);
    console.error('   请先运行: claude-code-robot setup');
    process.exit(1);
  }
  ensureConfigDir();
  const cfg = ecosystemConfig();
  runPm2(['start', cfg]);
  console.log(`\n✅ daemon 已启动`);
  console.log(`   日志: claude-code-robot logs`);
  console.log(`   状态: claude-code-robot status`);
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
    console.error('   请先运行: claude-code-robot setup');
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
    execSync('npm install -g @byted/claude-code-robot@latest', { stdio: 'inherit' });
    console.log('\n✅ 升级完成。运行 claude-code-robot restart 以应用更新。');
  } catch {
    console.error('❌ 升级失败，请手动运行: npm install -g @byted/claude-code-robot@latest');
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
claude-code-robot — 飞书话题 ↔ Claude Code 桥接

命令:
  setup       交互式配置（首次使用）
  start       启动 daemon
  stop        停止 daemon
  restart     重启 daemon（自动恢复活跃会话）
  logs        查看 daemon 日志（--lines N）
  status      查看 daemon 状态
  upgrade     升级到最新版本

配置目录: ~/.claude-code-robot/
文档: https://github.com/anthropics/claude-code-robot
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
  default:        showHelp(); break;
}
