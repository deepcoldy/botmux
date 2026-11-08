/**
 * 本 bot 的飞书名片（名称 / 头像）刷新器：开放平台 `/bot/v3/info` 是 Bot 显示名的
 * **唯一权威来源**，本模块负责「什么时候去拉、拉到变化后通知谁」。
 *
 * 为什么需要：此前名字只在 daemon 启动时由 `probeBotOpenId` 拉一次（且 open_id 已知
 * 就直接返回），在开放平台后台改名后，bots-info.json / dashboard descriptor /
 * SessionRow.botName 以及从它们派生的所有展示处都要等下一次重启才更新。
 *
 * 刷新时机：
 *  - 启动后立即一次（替代原来的一次性启动探测）；
 *  - 之后每 `intervalMs` 一次（失败也照常排下一次——原注释说「由心跳重试」其实没有）；
 *  - `requestRefresh()`：外部发现改名迹象时（例如收到 @本 bot 的消息里 mention 名与
 *    当前名不一致）提前拉一次，按 `minTriggerGapMs` 节流。
 *
 * 不变量：
 *  - 只改展示字段 `botName` / `botAvatarUrl`。`botOpenId` 只在**尚未知道**时补上，绝不
 *    覆盖——它是 @ 判定与路由身份，刷新不应改变任何鉴权/路由输入的身份部分。
 *  - 拉取失败（网络 / token / 飞书错误 / 超时）时保留旧值，不抛出，只记 debug。
 *  - 本进程自己改了名/头像（dashboard ✎，`noteLocalWrite()`）后的两个周期内，
 *    拉回来的值若与本地写入不同就不采信：要么是改名前就已发出的在途请求，要么是
 *    新版本还没传播到 `/bot/v3/info`。窗口过后以开放平台为准。
 *  - 派生写（onChange）抛错时，下一次拉取成功会再派生一次，直到成功为止。
 */
import { logger } from '../utils/logger.js';

export interface FetchedBotProfile {
  openId: string;
  name?: string;
  avatarUrl?: string;
}

/** 被刷新的可变状态（生产里就是 BotState）。 */
export interface BotProfileState {
  botOpenId?: string;
  botName?: string;
  botAvatarUrl?: string;
}

export interface BotProfileChange {
  /** 本进程第一次拉取成功（即使名字没变也要落盘 bots-info，补齐 open_id）。 */
  first: boolean;
  nameChanged: boolean;
  avatarChanged: boolean;
  previousName?: string;
}

export interface BotProfileRefresherDeps {
  larkAppId: string;
  fetchProfile: () => Promise<FetchedBotProfile>;
  state: () => BotProfileState;
  /** 首次成功或名称/头像变化后调用：负责派生缓存（bots-info / descriptor / SessionRow）。 */
  onChange: (change: BotProfileChange) => void;
  intervalMs?: number;
  minTriggerGapMs?: number;
  /** noteLocalWrite 之后不采信不同拉取值的时长，默认两个周期。 */
  localWriteHoldMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export interface BotProfileRefresher {
  start(): void;
  stop(): void;
  /** 立即拉一次（并发调用共用同一次请求）。返回本次是否成功。 */
  refreshNow(reason: string): Promise<boolean>;
  /** 有改名迹象时请求提前刷新；距上次尝试不足 minTriggerGapMs 时忽略。 */
  requestRefresh(reason: string): void;
  /** 本进程刚在开放平台改了名/头像并已写入 state：在 holdMs 内不让拉取结果覆盖它。 */
  noteLocalWrite(): void;
}

export const BOT_PROFILE_REFRESH_INTERVAL_MS = 10 * 60_000;
export const BOT_PROFILE_TRIGGER_MIN_GAP_MS = 60_000;

/** 按 appId 散开各 bot 的周期，避免整个 fleet 同一时刻打飞书。 */
function spreadOffset(larkAppId: string, intervalMs: number): number {
  let h = 0;
  for (let i = 0; i < larkAppId.length; i++) h = (h * 31 + larkAppId.charCodeAt(i)) >>> 0;
  return h % Math.max(1, Math.floor(intervalMs / 5));
}

export function createBotProfileRefresher(deps: BotProfileRefresherDeps): BotProfileRefresher {
  const intervalMs = deps.intervalMs ?? BOT_PROFILE_REFRESH_INTERVAL_MS;
  const minGapMs = deps.minTriggerGapMs ?? BOT_PROFILE_TRIGGER_MIN_GAP_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  // Two periods: covers the in-flight read plus the next scheduled one.
  const holdMs = deps.localWriteHoldMs ?? 2 * intervalMs;

  let timer: unknown = null;
  /** start() 后、stop() 前：排周期定时器、接受 requestRefresh。 */
  let running = false;
  /** stop() 过：在途拉取结果一律丢弃。 */
  let disposed = false;
  let inflight: Promise<boolean> | null = null;
  let lastAttemptAt = -Infinity;
  let succeededOnce = false;
  /** 首次派生（或之后某次派生）还没成功落地：下一次成功拉取无论有无变化都要再派生。 */
  let fanOutPending = true;
  let localWriteEpoch = 0;
  let localHoldUntil = -Infinity;

  const schedule = (): void => {
    if (!running) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void refreshNow('periodic');
    }, intervalMs + spreadOffset(deps.larkAppId, intervalMs));
  };

  const attempt = async (reason: string): Promise<boolean> => {
    lastAttemptAt = now();
    const epochAtStart = localWriteEpoch;
    let profile: FetchedBotProfile;
    try {
      profile = await deps.fetchProfile();
    } catch (err) {
      logger.debug(`[${deps.larkAppId}] bot profile refresh (${reason}) failed, keeping cached name: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    if (disposed) return false;
    const state = deps.state();
    const previousName = state.botName;
    // A local rename/avatar change that happened during this fetch, or so
    // recently that the published version may not be visible yet, wins.
    const holdLocal = epochAtStart !== localWriteEpoch || now() < localHoldUntil;
    const name = !holdLocal && profile.name?.trim() ? profile.name : undefined;
    const avatar = !holdLocal && profile.avatarUrl ? profile.avatarUrl : undefined;
    const nameChanged = !!name && name !== state.botName;
    const avatarChanged = !!avatar && avatar !== state.botAvatarUrl;
    if (!state.botOpenId && profile.openId) state.botOpenId = profile.openId;
    if (nameChanged) state.botName = name;
    if (avatarChanged) state.botAvatarUrl = avatar;
    const first = !succeededOnce;
    succeededOnce = true;
    if (nameChanged && previousName) {
      logger.info(`[${deps.larkAppId}] bot renamed on open platform: ${previousName} → ${name} (${reason})`);
    }
    if (fanOutPending || nameChanged || avatarChanged) {
      try {
        deps.onChange({ first, nameChanged, avatarChanged, ...(previousName ? { previousName } : {}) });
        fanOutPending = false;
      } catch (err) {
        fanOutPending = true;
        logger.warn(`[${deps.larkAppId}] bot profile fan-out failed (retried on next refresh): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return true;
  };

  const refreshNow = (reason: string): Promise<boolean> => {
    if (inflight) return inflight;
    inflight = attempt(reason).finally(() => {
      inflight = null;
      schedule();
    });
    return inflight;
  };

  return {
    start() {
      if (running || disposed) return;
      running = true;
      void refreshNow('startup');
    },
    stop() {
      running = false;
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    refreshNow,
    requestRefresh(reason) {
      if (!running || inflight) return;
      if (now() - lastAttemptAt < minGapMs) return;
      void refreshNow(reason);
    },
    noteLocalWrite() {
      localWriteEpoch += 1;
      localHoldUntil = now() + holdMs;
    },
  };
}
