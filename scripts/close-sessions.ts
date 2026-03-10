#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from '../src/config.js';

interface Session {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  title: string;
  status: string;
  createdAt: string;
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
      console.log(`   Age: ${formatAge(s.createdAt)}  Created: ${new Date(s.createdAt).toLocaleString()}`);
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

  // Send /close command to each thread via Lark API
  // Daemon will pick it up and properly close the session
  const larkClient = new Lark.Client({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
  });

  console.log(`关闭 ${toClose.length} 个会话...\n`);

  for (const s of toClose) {
    process.stdout.write(`  ${s.sessionId.substring(0, 8)} (${s.title})... `);
    try {
      await larkClient.im.message.reply({
        path: { message_id: s.rootMessageId },
        data: {
          content: JSON.stringify({ text: '/close' }),
          msg_type: 'text',
        },
      });
      console.log('✓');
    } catch (err: any) {
      console.log(`✗ ${err.message}`);
    }
  }

  console.log(`\n✅ 已向 ${toClose.length} 个话题发送 /close 命令，daemon 将自动处理。`);
}

main().catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
