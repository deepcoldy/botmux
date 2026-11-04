/**
 * `botmux secretary watch|unwatch|watches` —— 群秘书在自己的会话里登记 / 取消「定期回访某个话题」。
 * 作用域取当前会话所在的 bot 与群（BOTMUX_LARK_APP_ID / BOTMUX_CHAT_ID），不能替别的群登记。
 */
import {
  listSecretaryWatches,
  parseWatchInterval,
  removeSecretaryWatch,
  upsertSecretaryWatch,
} from '../services/group-secretary-watch-store.js';

const USAGE = `用法：
  botmux secretary watch <话题根消息 om_...> [--every 10m] [--note "要盯什么"]
  botmux secretary unwatch <话题根消息 om_...>
  botmux secretary watches`;

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
      upsertSecretaryWatch(appId, { chatId, threadRoot: target, everyMs, createdAt: Date.now(), ...(note ? { note } : {}) });
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
