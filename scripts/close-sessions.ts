#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { loadBotConfigs } from '../src/bot-registry.js';

interface Session {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  title: string;
  status: string;
  createdAt: string;
  larkAppId?: string;
}

const SESSIONS_FILE = join(process.cwd(), 'data', 'sessions.json');

function loadSessions(): Record<string, Session> {
  if (!existsSync(SESSIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function formatAge(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

async function main() {
  const args = process.argv.slice(2);
  const sessions = loadSessions();
  const activeSessions = Object.values(sessions).filter(s => s.status === 'active');

  if (activeSessions.length === 0) {
    console.log('没有活跃的会话。');
    return;
  }

  // Determine which sessions to close
  const closeAll = args.some(a => a.toLowerCase() === 'all');
  const indices = new Set<number>();
  for (const arg of args) {
    for (const part of arg.split(/[,\s]+/).filter(Boolean)) {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n > 0 && n <= activeSessions.length) indices.add(n);
    }
  }

  // No valid selection: show list and usage
  if (!closeAll && indices.size === 0) {
    console.log(`活跃会话 (${activeSessions.length}):\n`);
    activeSessions.forEach((s, i) => {
      console.log(`${i + 1}. ${s.title}`);
      console.log(`   Session: ${s.sessionId}`);
      console.log(`   Bot:     ${s.larkAppId ?? '(unknown)'}`);
      console.log(`   Age:     ${formatAge(s.createdAt)}  Created: ${new Date(s.createdAt).toLocaleString()}`);
      console.log('');
    });
    console.log('用法: pnpm sessions:close [indices|all]');
    console.log('  pnpm sessions:close 1 2 3');
    console.log('  pnpm sessions:close all');
    return;
  }

  const toClose = closeAll
    ? activeSessions
    : Array.from(indices).sort().map(i => activeSessions[i - 1]);

  // Build a per-bot Lark client map. Each session is owned by exactly one bot
  // (session.larkAppId), and that bot's secret lives in bots.json — using the
  // global LARK_APP_ID env var fails in multi-bot setups.
  const botConfigs = loadBotConfigs();
  const secretByAppId = new Map(botConfigs.map(b => [b.larkAppId, b.larkAppSecret]));
  const clientByAppId = new Map<string, Lark.Client>();
  function getClient(appId: string): Lark.Client | null {
    if (!secretByAppId.has(appId)) return null;
    let c = clientByAppId.get(appId);
    if (!c) {
      c = new Lark.Client({ appId, appSecret: secretByAppId.get(appId)! });
      clientByAppId.set(appId, c);
    }
    return c;
  }

  console.log(`关闭 ${toClose.length} 个会话...\n`);

  let ok = 0, fail = 0;
  for (const s of toClose) {
    const tag = `${s.sessionId.substring(0, 8)} (${s.title.slice(0, 30)})`;
    const appId = s.larkAppId;
    if (!appId) {
      console.log(`  ${tag} ✗ session 没有 larkAppId 字段，跳过`);
      fail++;
      continue;
    }
    const client = getClient(appId);
    if (!client) {
      console.log(`  ${tag} ✗ bots.json 里找不到 appId=${appId} 的配置（bot 已下线？），跳过`);
      fail++;
      continue;
    }
    process.stdout.write(`  ${tag}... `);
    try {
      await client.im.message.reply({
        path: { message_id: s.rootMessageId },
        data: {
          content: JSON.stringify({ text: '/close' }),
          msg_type: 'text',
        },
      });
      console.log('✓');
      ok++;
    } catch (err: any) {
      console.log(`✗ ${err.message ?? err}`);
      fail++;
    }
  }

  console.log(`\n✅ 成功 ${ok}，失败 ${fail}。daemon 会处理收到的 /close 命令。`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
