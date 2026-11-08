/**
 * 机器人首次成功上线后私聊 owner 的欢迎语（bots.json `welcomeMessage`）。
 *
 * 投递记录在 daemon 数据目录 `welcome-sent/<appId>.json`，不写回 bots.json ——
 * daemon 自己改配置文件会和配置热加载 / 用户手工编辑抢写。记录有三种状态：
 *   sending  已认领、正在发送；认领超过 WELCOME_CLAIM_TTL_MS 视为认领方已经不在
 *   sent     已发出，之后不再发
 *   failed   发送失败、已释放认领，下次启动重试
 * 读记录、判定和写认领在同一把文件锁里完成，发送在锁外，所以共享同一数据目录的
 * 多个 daemon 同时启动也只有一个能认领。锁文件是 `<appId>.json.lock`，正常释放后
 * 即删除，崩溃残留由 file-lock 的 stale-break 回收，不是垃圾文件也不是投递记录。
 *
 * 「飞书已收到、记录还没落盘进程就被杀」本地无法判定，靠固定的飞书消息 uuid 兜底：
 * uuid 只由 appId 派生，1 小时内的重复请求飞书只投递一次（见 im/lark/client.ts）。
 * 删掉记录文件可以让欢迎语重发，但距上次发送不足 1 小时的会被飞书去重。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DurableCoordinationMode } from './durable-coordination-runtime.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';

/** 一次发送（含飞书 api-gate 的重试与退避）最多等这么久，超时按失败释放认领。 */
export const WELCOME_SEND_BUDGET_MS = 30_000;
/** 必须大于发送预算：正在发送的认领不会过期被别人抢走。 */
export const WELCOME_CLAIM_TTL_MS = 60_000;
/** 认领被别的启动占着时，等它过期再看几次。 */
const CLAIM_HELD_MAX_RECHECKS = 2;

export function welcomeSentMarkerPath(dataDir: string, larkAppId: string): string {
  return join(dataDir, 'welcome-sent', `${larkAppId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/** 飞书消息幂等键（≤ 50 字符）：只由 appId 派生、不含时间，每次启动算出来都一样。 */
export function welcomeMessageUuid(larkAppId: string): string {
  return `wm_${createHash('sha256').update(`botmux-welcome-message:${larkAppId}`).digest('hex').slice(0, 47)}`;
}

export type WelcomeRecord =
  | { status: 'sent'; sentAt: string; recipient: string }
  | { status: 'sending'; claimedAt: string; recipient: string; token: string }
  | { status: 'failed'; failedAt: string; error: string };

/** 读投递记录；不存在或损坏返回 undefined，按未发送处理。 */
export function readWelcomeRecord(dataDir: string, larkAppId: string): WelcomeRecord | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(welcomeSentMarkerPath(dataDir, larkAppId), 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const str = (key: string) => (typeof parsed[key] === 'string' ? parsed[key] as string : undefined);
  const sentAt = str('sentAt');
  const claimedAt = str('claimedAt');
  const failedAt = str('failedAt');
  const recipient = str('recipient');
  const token = str('token');
  if (parsed.status === 'sent' && sentAt && recipient) return { status: 'sent', sentAt, recipient };
  if (parsed.status === 'sending' && claimedAt && recipient && token) {
    return { status: 'sending', claimedAt, recipient, token };
  }
  if (parsed.status === 'failed' && failedAt) return { status: 'failed', failedAt, error: str('error') ?? '' };
  return undefined;
}

function writeWelcomeRecord(file: string, record: WelcomeRecord): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

type ClaimDecision =
  | { kind: 'already_sent'; sentAt: string }
  | { kind: 'held'; claimedAt: string; recheckInMs: number }
  | { kind: 'no_recipient' }
  | { kind: 'claimed'; token: string; staleClaimAt?: string };

function claimDelivery(
  dataDir: string,
  larkAppId: string,
  recipient: string | undefined,
  nowMs: number,
): ClaimDecision {
  const file = welcomeSentMarkerPath(dataDir, larkAppId);
  mkdirSync(dirname(file), { recursive: true });
  return withFileLockSync(file, (): ClaimDecision => {
    const current = readWelcomeRecord(dataDir, larkAppId);
    if (current?.status === 'sent') return { kind: 'already_sent', sentAt: current.sentAt };
    if (current?.status === 'sending') {
      const age = nowMs - Date.parse(current.claimedAt);
      // 时钟回拨会让认领落在未来：TTL 内照样视为占用，超出 TTL 的不可能是活着的持有者。
      if (Math.abs(age) < WELCOME_CLAIM_TTL_MS) {
        return { kind: 'held', claimedAt: current.claimedAt, recheckInMs: WELCOME_CLAIM_TTL_MS - age + 1_000 };
      }
    }
    if (!recipient) return { kind: 'no_recipient' };
    const token = randomUUID();
    writeWelcomeRecord(file, { status: 'sending', claimedAt: new Date(nowMs).toISOString(), recipient, token });
    return { kind: 'claimed', token, staleClaimAt: current?.status === 'sending' ? current.claimedAt : undefined };
  });
}

/** 只释放自己的认领：认领已过期被别的启动接管、或已经发出时不动。 */
function releaseClaim(dataDir: string, larkAppId: string, token: string, failedAt: string, error: string): void {
  const file = welcomeSentMarkerPath(dataDir, larkAppId);
  withFileLockSync(file, () => {
    const current = readWelcomeRecord(dataDir, larkAppId);
    if (current?.status !== 'sending' || current.token !== token) return;
    writeWelcomeRecord(file, { status: 'failed', failedAt, error });
  });
}

function markSent(dataDir: string, larkAppId: string, sentAt: string, recipient: string): void {
  const file = welcomeSentMarkerPath(dataDir, larkAppId);
  withFileLockSync(file, () => writeWelcomeRecord(file, { status: 'sent', sentAt, recipient }));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unrefSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref?.());
}

/** 发送超过预算即放弃等待（send 不理会 signal 也一样），让认领在过期前落定。 */
async function sendWithinBudget(send: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overBudget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error(`welcome message send exceeded ${WELCOME_SEND_BUDGET_MS}ms`);
      controller.abort(reason);
      reject(reason);
    }, WELCOME_SEND_BUDGET_MS);
  });
  const sending = Promise.resolve().then(() => send(controller.signal));
  sending.catch(() => { /* settled via the race below */ });
  try {
    await Promise.race([sending, overBudget]);
  } finally {
    clearTimeout(timer);
  }
}

export type WelcomeDeliveryResult =
  | { status: 'sent'; recipient: string; sentAt: string; recordError?: string }
  | { status: 'already_sent'; sentAt: string }
  | { status: 'no_message' }
  | { status: 'no_recipient' }
  | { status: 'claim_held'; claimedAt: string }
  | { status: 'failed'; recipient: string; error: string }
  | { status: 'error'; error: string };

export async function deliverWelcomeMessageOnce(options: {
  dataDir: string;
  larkAppId: string;
  message: string | undefined;
  /** owner 的 open_id（ou_）；拿不到时不发，下次启动再试。 */
  recipient: string | undefined;
  send: (openId: string, text: string, request: { uuid: string; signal: AbortSignal }) => Promise<unknown>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WelcomeDeliveryResult> {
  const message = options.message?.trim();
  if (!message) return { status: 'no_message' };
  const { dataDir, larkAppId } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? unrefSleep;
  const recipient = options.recipient?.startsWith('ou_') ? options.recipient : undefined;
  const tag = `[${larkAppId}] welcome message`;

  for (let recheck = 0; ; recheck++) {
    let decision: ClaimDecision;
    try {
      decision = claimDelivery(dataDir, larkAppId, recipient, now().getTime());
    } catch (err) {
      const error = errorMessage(err);
      logger.warn(`${tag} not sent: delivery record unavailable (will retry on next start): ${error}`);
      return { status: 'error', error };
    }
    if (decision.kind === 'already_sent') return { status: 'already_sent', sentAt: decision.sentAt };
    if (decision.kind === 'no_recipient') {
      logger.warn(`${tag} pending: no owner open_id resolved yet (will retry on next start)`);
      return { status: 'no_recipient' };
    }
    if (decision.kind === 'held') {
      if (recheck >= CLAIM_HELD_MAX_RECHECKS) {
        logger.warn(`${tag} not sent by this start: still claimed by another start (claimed at ${decision.claimedAt})`);
        return { status: 'claim_held', claimedAt: decision.claimedAt };
      }
      logger.info(`${tag} claim held by another start (claimed at ${decision.claimedAt}); re-checking in ${Math.ceil(decision.recheckInMs / 1000)}s`);
      await sleep(decision.recheckInMs);
      continue;
    }

    const owner = recipient!;
    logger.info(`${tag} claimed for owner ${owner.slice(0, 12)}${decision.staleClaimAt ? ` (took over expired claim from ${decision.staleClaimAt})` : ''}`);
    try {
      await sendWithinBudget(signal => options.send(owner, message, { uuid: welcomeMessageUuid(larkAppId), signal }));
    } catch (err) {
      const error = errorMessage(err);
      try {
        releaseClaim(dataDir, larkAppId, decision.token, now().toISOString(), error);
        logger.warn(`${tag} DM failed, claim released (will retry on next start): ${error}`);
      } catch (releaseErr) {
        logger.warn(`${tag} DM failed and the claim could not be released; a start after ${WELCOME_CLAIM_TTL_MS / 1000}s retries: ${error}; release: ${errorMessage(releaseErr)}`);
      }
      return { status: 'failed', recipient: owner, error };
    }
    const sentAt = now().toISOString();
    try {
      markSent(dataDir, larkAppId, sentAt, owner);
    } catch (err) {
      const recordError = errorMessage(err);
      logger.warn(`${tag} sent to owner ${owner.slice(0, 12)} but the delivery record was not saved; a later start may send it again (Feishu dedupes repeats within 1 hour): ${recordError}`);
      return { status: 'sent', recipient: owner, sentAt, recordError };
    }
    logger.info(`${tag} sent to owner ${owner.slice(0, 12)}`);
    return { status: 'sent', recipient: owner, sentAt };
  }
}

export interface WelcomeBotConfig {
  larkAppId: string;
  welcomeMessage?: string;
  apiOnly?: boolean;
}

export type WelcomeStartupPlan =
  | { action: 'deliver'; larkAppId: string; message: string; recipient: string | undefined }
  | { action: 'skip'; larkAppId: string; reason: 'api_only' | 'multi_replica' };

/** daemon 启动时每个配了欢迎语的 bot 怎么处理；没配的不出现在结果里。 */
export function planStartupWelcomeMessages(
  bots: readonly WelcomeBotConfig[],
  context: {
    coordinationMode: DurableCoordinationMode;
    resolvedOwnerOpenId: (larkAppId: string) => string | undefined;
    configuredOwnerOpenId: (larkAppId: string) => string | undefined;
  },
): WelcomeStartupPlan[] {
  const plans: WelcomeStartupPlan[] = [];
  for (const bot of bots) {
    const message = bot.welcomeMessage?.trim();
    if (!message) continue;
    if (bot.apiOnly) {
      plans.push({ action: 'skip', larkAppId: bot.larkAppId, reason: 'api_only' });
      continue;
    }
    // primary 多副本各用各的数据目录，投递记录不共享，保证不了只发一次。shadow 不在此列：
    // shadow 只在现有路由旁多一份镜像，daemon 照常对用户回复，欢迎语照发。
    if (context.coordinationMode === 'primary') {
      plans.push({ action: 'skip', larkAppId: bot.larkAppId, reason: 'multi_replica' });
      continue;
    }
    plans.push({
      action: 'deliver',
      larkAppId: bot.larkAppId,
      message,
      // 允许名单一个 ou_ 都没解析出来（解析降级）时，退回建应用时记下的 ownerOpenId。
      // 这只决定欢迎语发给谁，不是授权判定。
      recipient: context.resolvedOwnerOpenId(bot.larkAppId) ?? context.configuredOwnerOpenId(bot.larkAppId),
    });
  }
  return plans;
}
