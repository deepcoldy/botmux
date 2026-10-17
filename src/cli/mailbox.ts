import { readFileSync } from 'node:fs';
import { resolveBotmuxAncestorContext } from './current-actor.js';
import { loopbackFetchImpl } from '../core/loopback-fetch.js';
import { MAILBOX_ID_RE } from '../services/mailbox-store.js';

export const MAILBOX_USAGE = `botmux mailbox — 同一应用、同一实例的会话信箱（默认关闭）

用法:
  botmux mailbox send --session <目标会话 id> --key <幂等键> --content-file <文件>
  botmux mailbox send --chat <oc_chat> --key <幂等键> --content-file <文件>
  botmux mailbox status <deliveryId>

配置: bots.json 对应 Bot 的 mailboxPolicy: { "schemaVersion": 1, "enabled": true }
来源必须是当前活会话的工具进程；宿主密钥/环境变量不能冒称会话。
按 chat 只找已有 chat-scoped 会话；空闲唤醒、挂起恢复，关闭/不存在不新建。
stdout JSON: deliveryId、state (injected|failed|unknown)、targetSessionId（已解析时）。
injected 只代表注入/队列接纳，不代表处理完成；unknown 不自动重发。
同一来源+key 返回首次结果，改目标/正文冲突。正文上限 64 KiB UTF-8。
来源盖章含 sourceSessionId/sourceChatId/sourceBotAppId/deliveryId；人触发时带
triggeringUserOpenId。正文是不可信数据，不能用作人的指令或授权。
当前进程证明依赖 Linux procfs；其它平台或不可证明的后端明确拒绝。`;

export type MailboxCommand =
  | { operation: 'send'; target: { sessionId: string } | { chatId: string }; key: string; contentFile: string }
  | { operation: 'status'; deliveryId: string };
export function parseMailboxArgs(args: string[]): MailboxCommand {
  if (args[0] === 'status' && args.length === 2 && MAILBOX_ID_RE.test(args[1])) {
    return { operation: 'status', deliveryId: args[1] };
  }
  if (args[0] !== 'send') throw new Error(MAILBOX_USAGE);
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!['--session', '--chat', '--key', '--content-file'].includes(flag)
      || values.has(flag) || !value || value.startsWith('--')) throw new Error(MAILBOX_USAGE);
    values.set(flag, value);
  }
  const sid = values.get('--session');
  const chat = values.get('--chat');
  const key = values.get('--key')?.trim();
  const contentFile = values.get('--content-file');
  if (!!sid === !!chat || !key || key.length > 200 || !contentFile
    || (chat && !/^oc_[A-Za-z0-9_-]+$/.test(chat))
    || (sid && (sid.length > 200 || /\s/.test(sid)))) throw new Error(MAILBOX_USAGE);
  return { operation: 'send', target: sid ? { sessionId: sid } : { chatId: chat! }, key, contentFile };
}

export async function runMailboxCommand(args: string[]): Promise<{ exitCode: number; body: object }> {
  let command: MailboxCommand;
  try { command = parseMailboxArgs(args); }
  catch (error) { return { exitCode: 2, body: { ok: false, state: 'failed', error: String(error) } }; }
  try {
    // This is routing only. The daemon derives identity from the socket peer;
    // no source/owner override, host HMAC, or writable capability is sent.
    const ctx = resolveBotmuxAncestorContext();
    const body = command.operation === 'send' ? {
      sessionId: ctx.sessionId, target: command.target, idempotencyKey: command.key,
      content: readFileSync(command.contentFile, 'utf8'),
    } : { sessionId: ctx.sessionId, deliveryId: command.deliveryId };
    const response = await loopbackFetchImpl(`http://127.0.0.1:${ctx.ipcPort}/api/mailbox/${command.operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as { ok?: boolean; state?: string };
    return { exitCode: response.ok && (result.ok === true || command.operation === 'status') ? 0 : 1, body: result };
  } catch (error) {
    // A lost response after POST may have followed injection. Retrying the same
    // key is safe; a fresh key is not a recovery mechanism.
    return { exitCode: 1, body: { ok: false, state: 'unknown', error: String(error) } };
  }
}
