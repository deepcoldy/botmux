/**
 * `botmux secretary watch|unwatch|watches` —— 群秘书在自己的会话里登记 / 取消「定期回访某个话题」。
 * 作用域取当前会话所在的 bot 与群（BOTMUX_LARK_APP_ID / BOTMUX_CHAT_ID），不能替别的群登记。
 */
import {
  listSecretaryWatches,
  parseWatchInterval,
  removeSecretaryWatch,
  upsertSecretaryWatch,
  DEFAULT_WATCH_TTL_MS,
} from '../services/group-secretary-watch-store.js';
import { LEDGER_STATUSES, listLedger, recordLedger, type LedgerStatus } from '../services/group-secretary-ledger-store.js';

const USAGE = `用法：
  botmux secretary watch <话题根消息 om_...> [--every 10m] [--for 24h] [--note "要盯什么"]
  botmux secretary unwatch <话题根消息 om_...>
  botmux secretary watches
  botmux secretary report --status <${LEDGER_STATUSES.join('|')}> --summary "<一两句话>" [--escalate "<要让 leader 在主群知道的话>"]
      （只在话题巡查回合里用：写本话题的台账；--escalate 交给主群总管去重后上报）
  botmux secretary ledger`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runSecretaryCommand(argv: string[]): Promise<number> {
  const [sub, target] = argv;
  const appId = process.env.BOTMUX_LARK_APP_ID;
  const chatId = process.env.BOTMUX_CHAT_ID;
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return sub ? 0 : 2;
  }
  if (!appId || !chatId?.startsWith('oc_')) {
    process.stderr.write('botmux secretary 只能在群会话里使用（缺少 BOTMUX_LARK_APP_ID / BOTMUX_CHAT_ID）\n');
    return 2;
  }
  try {
    if (sub === 'ledger') {
      process.stdout.write(`${JSON.stringify({ ok: true, ledger: listLedger(appId, chatId) })}\n`);
      return 0;
    }
    if (sub === 'report') {
      const root = process.env.BOTMUX_ROOT_MESSAGE_ID;
      if (!root?.startsWith('om_')) {
        process.stderr.write('botmux secretary report 只能在话题会话（巡查回合）里用：当前会话没有话题根（BOTMUX_ROOT_MESSAGE_ID）。\n');
        return 2;
      }
      const status = flag(argv, '--status')?.trim().toLowerCase();
      const summary = flag(argv, '--summary')?.trim();
      if (!status || !(LEDGER_STATUSES as readonly string[]).includes(status)) {
        process.stderr.write(`--status 只接受 ${LEDGER_STATUSES.join(' | ')}\n`);
        return 2;
      }
      if (!summary || summary.length < 4) {
        process.stderr.write('--summary 必填：一两句话说清楚这个话题现在怎样\n');
        return 2;
      }
      const escalate = flag(argv, '--escalate')?.trim();
      const entry = recordLedger(appId, {
        chatId, threadRoot: root, status: status as LedgerStatus, summary,
        ...(escalate ? { escalate } : {}),
      });
      process.stdout.write(`${JSON.stringify({ ok: true, threadRoot: root, status: entry.status, escalated: !!escalate })}\n`);
      return 0;
    }
    if (sub === 'watches') {
      const mine = listSecretaryWatches(appId).filter(w => w.chatId === chatId);
      process.stdout.write(`${JSON.stringify({ ok: true, watches: mine })}\n`);
      return 0;
    }
    if (!target?.startsWith('om_')) {
      process.stderr.write(`需要话题根消息 id（om_...）\n${USAGE}\n`);
      return 2;
    }
    if (sub === 'watch') {
      const everyMs = parseWatchInterval(flag(argv, '--every'));
      const note = flag(argv, '--note');
      const forMs = parseWatchInterval(flag(argv, '--for'), DEFAULT_WATCH_TTL_MS);
      const createdAt = Date.now();
      upsertSecretaryWatch(appId, { chatId, threadRoot: target, everyMs, createdAt, expiresAt: createdAt + forMs, ...(note ? { note } : {}) });
      process.stdout.write(`${JSON.stringify({ ok: true, watching: target, everyMinutes: Math.round(everyMs / 60_000) })}\n`);
      return 0;
    }
    if (sub === 'unwatch') {
      const removed = removeSecretaryWatch(appId, chatId, target);
      process.stdout.write(`${JSON.stringify({ ok: true, removed })}\n`);
      return 0;
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}
