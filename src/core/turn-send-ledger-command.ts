import { resolveBotmuxDataDir } from './data-dir.js';
import { TurnSendLedger, type TurnSendLedgerInspection } from '../services/turn-send-ledger.js';
import { logger } from '../utils/logger.js';

const USAGE = `用法:
  botmux turn-send-ledger inspect [--session-id <id>] [--turn-id <id>] [--app-id <id>] [--json]
  botmux turn-send-ledger resolve --session-id <id> --turn-id <id>
      [--app-id <id>] --outcome delivered|not-delivered --yes

说明:
  inspect  将哈希文件还原为 session/turn 和分块进度。
  resolve  仅处理“provider 响应未知”的文档评论分块：
    delivered      已确认该块已投递，后续重试从下一块继续；
    not-delivered  已确认该块未投递，后续重试会重新发送该块。
  请先在飞书文档中核对实际评论，再使用 resolve。命令不会直接重发内容。`;

interface CommandDeps {
  dataDir?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return undefined;
  if (argv[index].startsWith(`${flag}=`)) return argv[index].slice(flag.length + 1) || undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function formatRecord(record: TurnSendLedgerInspection): string {
  const head = `${record.larkAppId}  ${record.sessionId} / ${record.turnId}`;
  if (record.state === 'completed') {
    return `${head}\n  已完成: ${record.messageId} (${new Date(record.deliveredAtMs).toISOString()})`;
  }
  if (record.state === 'in_flight') {
    return `${head}\n  第 ${record.inFlightStep}/${record.stepCount} 块响应未知，已确认 ${record.completedSteps} 块，目标 ${record.target}`;
  }
  return `${head}\n  待继续: 已确认 ${record.completedSteps}/${record.stepCount} 块，目标 ${record.target}`;
}

export async function runTurnSendLedgerCommand(
  argv: string[],
  deps: CommandDeps = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => { console.log(line); });
  const err = deps.stderr ?? ((line: string) => { console.error(line); });
  const [sub, ...rest] = argv;
  const valueFlags = ['--session-id', '--turn-id', '--app-id', '--outcome'];
  const knownFlags = new Set([...valueFlags, '--json', '--yes']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (arg.startsWith('--') && !knownFlags.has(flag)) {
      err(`未知参数: ${arg}`);
      err(USAGE);
      return 1;
    }
    if (valueFlags.includes(arg)) {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) {
        err(`${arg} 需要一个值。`);
        err(USAGE);
        return 1;
      }
      i++;
    } else if (valueFlags.includes(flag) && arg.endsWith('=')) {
      err(`${flag} 需要一个值。`);
      err(USAGE);
      return 1;
    }
  }

  if (sub === undefined || sub === 'help' || sub === '--help') {
    out(USAGE);
    return 0;
  }

  const sessionId = flagValue(rest, '--session-id');
  const turnId = flagValue(rest, '--turn-id');
  const larkAppId = flagValue(rest, '--app-id');
  const ledger = new TurnSendLedger(deps.dataDir ?? resolveBotmuxDataDir());
  try {
    if (sub === 'inspect') {
      const records = ledger.inspect({ sessionId, turnId, larkAppId });
      if (rest.includes('--json')) {
        out(JSON.stringify({ ok: true, records }));
        return 0;
      }
      if (records.length === 0) {
        out('没有匹配的 turn-send ledger 记录。');
        return 0;
      }
      for (const record of records) out(formatRecord(record));
      if (records.some(record => record.state === 'in_flight')) {
        out('请核对文档中的实际分块，再执行 `botmux turn-send-ledger resolve ... --outcome delivered|not-delivered --yes`。');
      }
      return 0;
    }

    if (sub === 'resolve') {
      const outcome = flagValue(rest, '--outcome');
      if (!sessionId || !turnId || (outcome !== 'delivered' && outcome !== 'not-delivered')) {
        err('resolve 必须提供 --session-id、--turn-id 和 --outcome delivered|not-delivered。');
        err(USAGE);
        return 1;
      }
      const matches = ledger.inspect({ sessionId, turnId, larkAppId });
      if (matches.length === 0) {
        err('没有匹配的 turn-send ledger 记录，未做任何修改。');
        return 1;
      }
      if (matches.length > 1) {
        err('匹配到多个 Bot 的记录；请追加 --app-id 精确指定，未做任何修改。');
        return 1;
      }
      if (!rest.includes('--yes')) {
        err(`本操作会把第 ${matches[0].state === 'in_flight' ? matches[0].inFlightStep : '?'} 块标记为 ${outcome}。`);
        err('请先核对飞书文档中的实际评论；确认后追加 --yes 重新执行。');
        return 1;
      }
      const key = { larkAppId: matches[0].larkAppId, sessionId, turnId };
      const resolved = await ledger.resolveUnknownStep(key, outcome);
      logger.warn(`[turn-send-ledger] operator resolved ${sessionId}/${turnId} app=${key.larkAppId} outcome=${outcome}`);
      if (resolved.state !== 'completed' && resolved.completedSteps < resolved.stepCount) {
        out(`已记录人工判定；重新执行原 botmux send --response-kind final，将从第 ${resolved.completedSteps + 1}/${resolved.stepCount} 块继续。`);
      } else {
        out('已记录人工判定；重新执行原 botmux send --response-kind final，以完成 ledger 和 Typing reaction 收尾。');
      }
      return 0;
    }

    err(USAGE);
    return 1;
  } catch (error) {
    err(`turn-send-ledger 命令失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
