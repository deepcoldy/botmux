/**
 * 机器人首次成功上线后私聊 owner 的欢迎语（bots.json `welcomeMessage`）。
 *
 * 只发一次：发送成功后在 daemon 数据目录写 `welcome-sent/<appId>.json`
 * （含 sentAt）。记录不写回 bots.json —— daemon 自己改配置文件会和配置热加载 /
 * 用户手工编辑抢写。发送失败不写记录、不影响启动，下次启动自然重试。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function welcomeSentMarkerPath(dataDir: string, larkAppId: string): string {
  return join(dataDir, 'welcome-sent', `${larkAppId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/** 已发送时返回发送时间（ISO 字符串），未发送或记录损坏返回 undefined。 */
export function readWelcomeSentAt(dataDir: string, larkAppId: string): string | undefined {
  const file = welcomeSentMarkerPath(dataDir, larkAppId);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { sentAt?: unknown };
    return typeof parsed.sentAt === 'string' ? parsed.sentAt : undefined;
  } catch {
    return undefined;
  }
}

function writeWelcomeSentAt(dataDir: string, larkAppId: string, sentAt: string, recipient: string): void {
  const file = welcomeSentMarkerPath(dataDir, larkAppId);
  mkdirSync(join(dataDir, 'welcome-sent'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sentAt, recipient }) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export type WelcomeDeliveryResult =
  | { status: 'sent'; recipient: string; sentAt: string }
  | { status: 'already_sent'; sentAt: string }
  | { status: 'no_message' }
  | { status: 'no_recipient' }
  | { status: 'failed'; recipient: string; error: string };

export async function deliverWelcomeMessageOnce(options: {
  dataDir: string;
  larkAppId: string;
  message: string | undefined;
  /** owner 的 open_id（ou_）；拿不到时不发，下次启动再试。 */
  recipient: string | undefined;
  send: (openId: string, text: string) => Promise<unknown>;
  now?: () => Date;
}): Promise<WelcomeDeliveryResult> {
  const message = options.message?.trim();
  if (!message) return { status: 'no_message' };
  const sentAt = readWelcomeSentAt(options.dataDir, options.larkAppId);
  if (sentAt) return { status: 'already_sent', sentAt };
  const recipient = options.recipient;
  if (!recipient || !recipient.startsWith('ou_')) return { status: 'no_recipient' };
  try {
    await options.send(recipient, message);
  } catch (err) {
    return { status: 'failed', recipient, error: err instanceof Error ? err.message : String(err) };
  }
  const at = (options.now ?? (() => new Date()))().toISOString();
  // 消息已发出：记录写失败只会导致下次启动重发一次，不抛给调用方。
  try {
    writeWelcomeSentAt(options.dataDir, options.larkAppId, at, recipient);
  } catch { /* best effort */ }
  return { status: 'sent', recipient, sentAt: at };
}
