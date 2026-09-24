/**
 * 批量修复存量 bot 的开放平台 redirect 白名单 —— 「升级后仍然 20029」的补救入口。
 *
 * 背景：redirect 白名单只在建 bot / 权限自愈跑 {@link automateOpenPlatformSetup}
 * 时才写。对**已经导全 scope 的存量 bot**，今天没有任何路径会去补白名单
 * （daemon 启动时的 `tryAutoFixScopes` 只在缺 critical scope 时才触发，而
 * `im:feed_group_v1:*` 不在 `BOTMUX_REQUIRED_SCOPES` 里），于是升级到支持群聊模式
 * 的版本后，authorize 依旧报 20029：白名单里没有那条回调地址，用户连飞书授权页
 * 都进不去。本模块把「一次扫码 → 全部存量 bot 补齐」做成一个显式动作。
 *
 * 链路（模板 = `probeVcMeetingEventSubscription`）：
 *   1. `prepareFeishuWebSession({disableQrLogin:true})` —— 只复用缓存，**绝不**在
 *      这里弹第二个二维码；没有可用登录态就回 `login_required`，由 dashboard 走
 *      已有的 `FeishuLoginManager` 扫码流程（两者读写同一份
 *      `~/.botmux/feishu-session.json`）后重试。
 *   2. `createOpenPlatformApiClient` —— **一个 client 打整批 appId**。它的 referer
 *      是通用的 `<origin>/app`，与具体 appId 无关（`listOpenPlatformApps` /
 *      `fetchOpenPlatformAppSecret` / 改名链路都已这么用）。
 *      ⚠️ 不能复用 `automateOpenPlatformSetup` 内联的那份 postJson——它的 referer
 *      绑死 `<origin>/app/<appId>`，天然只能服务单个 app。
 *   3. 逐 bot 串行调 {@link writeRedirectWhitelist}（读→合并→写，绝不删用户已有
 *      条目）。串行而非并发：整批共用一份 web session，并发打同租户 N 个 app 容易
 *      撞限流，而这本就是个低频的后台动作，快几秒没有价值。
 *
 * 逐 bot 独立 try/catch：某个 app 不属于当前登录账号（console 403 / code=10003）
 * 只把**这一个** app 记成 `not_owned`（提示换账号扫码），不让它拖垮整批——
 * 多租户混挂时这是常态，不是异常。
 */
import { loadBotConfigs, type BotConfig } from '../bot-registry.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';
import {
  collectBotmuxRedirectUrls,
  createOpenPlatformApiClient,
  missingRedirectUrls,
  OpenPlatformApiError,
  openPlatformWebSessionExpired,
  prepareFeishuWebSession,
  safeErrorMessage,
  writeRedirectWhitelist,
  type FeishuWebSessionOptions,
  type FeishuWebSessionPrepareResult,
  type OpenPlatformClientResult,
  type OpenPlatformPostJson,
  type StoredCookie,
} from './open-platform-automation.js';
import { logger } from '../utils/logger.js';

/**
 * • `fixed`      — 白名单被改写，且 `wanted` 的每一条都确实落在线上
 * • `unchanged`  — 想要的地址线上全有，幂等短路，一次写请求都没发
 * • `partial`    — 写成功了，但 `wanted` 里仍有条目没落地（典型：全集被拒、退到最小集
 *                  兜底写，把 `oauthRedirectBase` 那条丢了）。**不是成功**：缺的那条
 *                  正是用户这次要用的回调地址时，authorize 照样 20029。
 * • `not_owned`  — 当前登录账号不是该应用的协作者，换账号扫码才能修
 * • `failed`     — 其余失败（网络 / console 报错 / 读不到现值 / 不是可修复的目标 bot）
 */
export type RedirectRepairStatus = 'fixed' | 'unchanged' | 'partial' | 'not_owned' | 'failed';

export interface RedirectRepairItem {
  appId: string;
  status: RedirectRepairStatus;
  /** 失败原因，或 `partial` 时「缺了哪几条」的说明。成功且无话可说时省略。 */
  message?: string;
  /** 本次落地（或确认已在线上）的白名单全集，供 UI 展示与排障。仅 fixed/unchanged/partial 有。 */
  redirectUrls?: string[];
  /** `partial` 时仍未落地的 wanted 条目。 */
  missingRedirectUrls?: string[];
}

export type RepairOpenPlatformRedirectsResult =
  | {
      ok: true;
      results: RedirectRepairItem[];
      /** 本次期望写入的 botmux 侧地址集合（整批共用一份，便于 UI 解释「补了什么」）。 */
      wanted: string[];
    }
  | {
      ok: false;
      /**
       * • `login_required` — 没有可用登录态 / 登录态已过期，需要扫码后重试
       * • `in_flight`      — 已有一批在跑（见下方 single-flight）
       * • `network`        — 拿 console 页面就失败了，整批没开始
       * • `timeout`        — 整批超过服务端截止时间（见 {@link REPAIR_BATCH_DEADLINE_MS}）
       */
      reason: 'login_required' | 'in_flight' | 'network' | 'timeout';
      message: string;
    };

/** 测试注入缝：session、console client、bot 列表都可替换。 */
export interface RepairOpenPlatformRedirectsDeps {
  prepareSession?: (opts: FeishuWebSessionOptions) => Promise<FeishuWebSessionPrepareResult>;
  clientFactory?: (cookies: StoredCookie[]) => Promise<OpenPlatformClientResult>;
  loadBots?: () => BotConfig[];
  /** 期望写入的地址集合。缺省 = {@link collectBotmuxRedirectUrls}。 */
  collectWanted?: () => string[];
}

export interface RepairOpenPlatformRedirectsOptions extends RepairOpenPlatformRedirectsDeps {
  /** 只修这些 appId；缺省 = 全部可修复的 bot。不在可修目标里的 appId 会单独回一条 `failed`。 */
  appIds?: string[];
  /** 透传给默认 session/client 工厂（测试用）。 */
  sessionFilePath?: string;
  fetchImpl?: typeof fetch;
  /** 整批截止时间，缺省 {@link REPAIR_BATCH_DEADLINE_MS}。测试用来把 60s 压到毫秒级。 */
  deadlineMs?: number;
}

/**
 * 模块级 single-flight。
 *
 * 服务端此前对开放平台批量操作**零并发保护**——VC preflight 那条「一次只允许一个
 * bot」是纯前端 useState，改名链路的队列是 per-app 的。整批修复会连续抢同一份
 * `feishu-session.json` 与 csrf，两次点击同时跑既浪费配额又容易互相踩到限流，所以
 * 在服务侧兜住：第二次直接回 `in_flight`（由路由翻成 409），而不是排队等——用户点
 * 两下不该等上一批跑完。
 */
let inFlight: Promise<RepairOpenPlatformRedirectsResult> | null = null;

/**
 * 整批修复的服务端截止时间。
 *
 * 没有它，一个挂住的 console 请求会把 single-flight 永久锁死：前端那 15s 超时只放开
 * 浏览器这一侧，服务端的 `inFlight` 还在，之后每一次点击都吃 409，只能重启 daemon。
 * 60s 量级：整批是逐 bot 串行的 console 往返，十几个 bot 的正常批次远小于它，真到点
 * 基本可以断定卡死而不是慢。
 */
export const REPAIR_BATCH_DEADLINE_MS = 60_000;

/**
 * 批次代际。
 *
 * 超时释放 `inFlight` 时，旧批**可能还活着**——注入的依赖（测试桩、以及任何不认
 * AbortSignal 的下游）收不到取消信号。只清 `inFlight` 就放行下一批，等于让两批同时
 * 往 console 写，比锁死更糟。所以每批领一个 generation，**写提交前**先确认自己仍是
 * 当前代：超时批次之后的任何写都会在真正打出去之前被拒。
 */
let batchGeneration = 0;

/** 当前是否有一批修复在跑（路由/诊断用）。 */
export function isRepairOpenPlatformRedirectsInFlight(): boolean {
  return inFlight !== null;
}

/** 一个批次跑完/超时之前，`runRepair` 需要的运行期上下文。 */
interface RepairBatchContext {
  /** 传给真实下游 fetch 的取消信号（默认 session/client 工厂会接到底）。 */
  signal: AbortSignal;
  /** 本批仍是当前代 = 还允许写。 */
  isCurrent: () => boolean;
}

export async function repairOpenPlatformRedirects(
  opts: RepairOpenPlatformRedirectsOptions = {},
): Promise<RepairOpenPlatformRedirectsResult> {
  if (inFlight) {
    return { ok: false, reason: 'in_flight', message: '已有一批 redirect 白名单修复在执行，请等它跑完再试' };
  }
  const deadlineMs = opts.deadlineMs ?? REPAIR_BATCH_DEADLINE_MS;
  const generation = ++batchGeneration;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RepairOpenPlatformRedirectsResult>(resolve => {
    timer = setTimeout(() => {
      // 关键一步：**当场**推进代际，让这一批立刻不再是当前代。只等下一批来 ++ 是不够的
      // ——超时后到下一次点击之间，旧批随时可能自己醒过来继续往 console 写。
      batchGeneration += 1;
      // 再 abort：真实下游（默认 session/client 工厂）会当场断开连接；不认 abort 的
      // 注入依赖则由上面那次代际推进兜住，之后任何写提交都会被 fence 拒掉。
      controller.abort(new Error('redirect 白名单批量修复超时'));
      resolve({
        ok: false,
        reason: 'timeout',
        message: `redirect 白名单修复超过 ${Math.round(deadlineMs / 1000)}s 仍未完成，已中止本批；可稍后重试`,
      });
    }, deadlineMs);
  });

  const run = runRepair(opts, { signal: controller.signal, isCurrent: () => batchGeneration === generation });
  // 超时后没人再 await run：它日后无论 resolve 还是 reject 都不该变成
  // unhandledRejection 把进程带崩。这个空 catch 不影响下面 race 对 run 的接收。
  run.catch(() => {});
  inFlight = run;
  try {
    return await Promise.race([run, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    // 超时时这里会在旧批还活着的情况下放行下一批 —— 安全性由代际 fence 兜底：
    // 下一批 ++batchGeneration 之后，旧批的 isCurrent() 恒为 false，写不进去。
    if (inFlight === run) inFlight = null;
  }
}

/**
 * 把整批的截止信号真正接进下游 fetch。
 *
 * 默认的 `prepareFeishuWebSession` / `createOpenPlatformApiClient` 都只暴露
 * `fetchImpl` 这一个缝，底层 `MutableCookieJar.fetchRaw` 会把 init 原样透传，
 * 所以在这里包一层就等于给「登录态校验 + console 取页 + 每一次 postJson」全都装上
 * 同一个 AbortSignal，而不用给一路函数加 signal 参数。
 */
function withDeadlineSignal(fetchImpl: typeof fetch | undefined, signal: AbortSignal): typeof fetch {
  const base = fetchImpl ?? fetch;
  return ((input: any, init?: RequestInit) => base(input, { ...init, signal: init?.signal ?? signal })) as typeof fetch;
}

/**
 * 代际围栏：把 postJson 包一层，本批一旦不是当前代就**在请求打出去之前**拒绝。
 *
 * 拦读也拦写（不只拦 update）：读被拒会让 {@link writeRedirectWhitelist} 走
 * 「读不到 → 零写入」，等于双保险；而且能让超时批次的循环尽快自己停下来。
 */
function fenceStalePostJson(postJson: OpenPlatformPostJson, isCurrent: () => boolean): OpenPlatformPostJson {
  return async (path: string, body?: unknown) => {
    if (!isCurrent()) throw new Error(`redirect 白名单修复批次已中止，拒绝继续调用 ${path}`);
    return postJson(path, body);
  };
}

async function runRepair(
  opts: RepairOpenPlatformRedirectsOptions,
  ctx: RepairBatchContext,
): Promise<RepairOpenPlatformRedirectsResult> {
  const fetchImpl = withDeadlineSignal(opts.fetchImpl, ctx.signal);
  const prepareSession = opts.prepareSession ?? prepareFeishuWebSession;
  const clientFactory = opts.clientFactory
    ?? ((cookies: StoredCookie[]) => createOpenPlatformApiClient(cookies, { fetchImpl }));
  const listBots = opts.loadBots ?? loadBotConfigs;
  const collectWanted = opts.collectWanted ?? collectBotmuxRedirectUrls;

  // 先算目标集：没有可修的 bot 就别去动登录态（也就不会白白弹「请扫码」）。
  const targets = resolveTargets(listBots, opts.appIds);
  if (targets.repairable.length === 0) {
    return { ok: true, results: targets.rejected, wanted: [] };
  }

  const prepared = await prepareSession({
    sessionFilePath: opts.sessionFilePath,
    fetchImpl,
    // 只复用缓存：这条链路可能由 dashboard 的一次 HTTP 请求触发，不能在服务器
    // 终端上默默打印一个没人看得到的二维码，更不能与 FeishuLoginManager 抢扫码。
    disableQrLogin: true,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      reason: 'login_required',
      message: `没有可用的飞书开放平台登录态（${prepared.reason}）：${prepared.message}`,
    };
  }

  const clientResult = await clientFactory(prepared.cookies);
  if (!clientResult.ok) {
    // missing_csrf = cookie 还在但开放平台侧已失效，和「没登录」是同一种人工处置
    // （重新扫码），归到 login_required；network 是本机/网络问题，重试即可。
    return clientResult.reason === 'missing_csrf'
      ? { ok: false, reason: 'login_required', message: `飞书登录态已失效：${clientResult.message}` }
      : { ok: false, reason: 'network', message: clientResult.message };
  }

  // 整批共用同一份 wanted：它读 global-config / platform.json / 环境变量，逐 bot
  // 重算既浪费又可能在中途配置变更时让同一批 bot 拿到不一致的白名单。
  const wanted = collectWanted();
  const results: RedirectRepairItem[] = [...targets.rejected];
  // 整批共用一份带围栏的 postJson：本批一旦被超时判死，剩下的 bot 一个都不会再写。
  const postJson = fenceStalePostJson(clientResult.client.postJson, ctx.isCurrent);

  for (const bot of targets.repairable) {
    // 超时后循环立刻停：结果已经没人接收，继续打 console 只是白白消耗配额。
    if (!ctx.isCurrent()) break;
    try {
      results.push(await repairOne(postJson, bot.larkAppId, wanted));
    } catch (err) {
      if (!openPlatformWebSessionExpired(err)) throw err;
      return {
        ok: false,
        reason: 'login_required',
        message: `飞书开放平台登录态已失效，请重新扫码后重试：${safeErrorMessage(err)}`,
      };
    }
  }

  const summary = countByStatus(results);
  logger.info(
    `[redirect-repair] ${results.length} bot(s): `
    + `fixed=${summary.fixed} unchanged=${summary.unchanged} partial=${summary.partial} `
    + `not_owned=${summary.not_owned} failed=${summary.failed}`,
  );
  return { ok: true, results, wanted };
}

async function repairOne(
  postJson: OpenPlatformPostJson,
  appId: string,
  wanted: string[],
): Promise<RedirectRepairItem> {
  try {
    const written = await writeRedirectWhitelist(postJson, appId, wanted);
    if (written.status === 'skipped_unreadable') {
      // 读不到线上现值 → 一次写请求都没发（盲写会清掉用户自己配的回调地址）。
      // 什么都没修好，就不能报成功。
      return { appId, status: 'failed', message: written.warning };
    }
    if (written.status === 'unchanged') {
      return { appId, status: 'unchanged', redirectUrls: written.redirectUrls };
    }
    // 成功与否看**实际落盘的白名单是否覆盖 wanted**，而不是「写请求返回了 200」。
    // 最小集兜底恰恰是「写成功了但想要的没写全」：丢掉的那条正是这次要用的回调地址
    // 时，authorize 照样 20029，报 fixed 等于把 partial 藏起来。
    //
    // 判据收口在 {@link missingRedirectUrls}：`automateOpenPlatformSetup` 的
    // `redirectConfigured` 消费的是同一个纯函数，两处各写一份必然漂移（automation
    // 曾经漏判 `updated_fallback`，这边却判对了）。
    const missing = missingRedirectUrls(wanted, written.redirectUrls);
    if (missing.length > 0) {
      return {
        appId,
        status: 'partial',
        redirectUrls: written.redirectUrls,
        missingRedirectUrls: missing,
        message: written.status === 'updated_fallback'
          ? `完整地址列表被开放平台拒绝，已退回「线上现值 + 本机回调」最小集写入；仍缺: ${missing.join('、')}`
          : `写入已提交，但以下回调地址仍未生效: ${missing.join('、')}`,
      };
    }
    return { appId, status: 'fixed', redirectUrls: written.redirectUrls };
  } catch (err) {
    // 登录态是整批 bot 共用的；不能把它压成某个 app 的 failed，
    // 否则 dashboard 看不到 login_required，也就不会弹扫码框。
    if (openPlatformWebSessionExpired(err)) throw err;
    if (isOwnerAccessDenied(err)) {
      return {
        appId,
        status: 'not_owned',
        message: '当前扫码登录的飞书账号不是该应用的协作者，请换成该应用的开发者账号重新扫码后再修复',
      };
    }
    logger.warn(`[redirect-repair] ${appId} failed: ${safeErrorMessage(err)}`);
    return { appId, status: 'failed', message: safeErrorMessage(err) };
  }
}

/**
 * 目标集 = `loadBotConfigs()` 里 `!apiOnly` 且 brand 为 feishu 的 bot；传了 appIds
 * 就再取一次交集。
 *
 * • `apiOnly`（core-only）bot 没有任何飞书身份，`larkAppId` 是合成的 `local_*`，
 *   拿它去调 console 只会 404。
 * • `lark`（国际版）租户没有这套 `/developers/v1/*` console 自动化，
 *   `automateOpenPlatformSetup` 同样直接 `unsupported_brand` 返回。
 * • brand 缺省视为 feishu（见 {@link normalizeBrand}），旧 bots.json 才能被修到。
 *
 * 显式点名却不可修的 appId **不静默丢掉**：用户点名要修 X，就得听到 X 的回音，
 * 否则「点了没反应」和「修好了」在 UI 上长得一模一样。
 */
function resolveTargets(
  listBots: () => BotConfig[],
  appIds: string[] | undefined,
): { repairable: BotConfig[]; rejected: RedirectRepairItem[] } {
  let bots: BotConfig[];
  try {
    bots = listBots();
  } catch (err) {
    // bots.json 缺失/损坏：当作没有目标，由上层回「没有可修复的 bot」。
    logger.warn(`[redirect-repair] loadBotConfigs failed: ${safeErrorMessage(err)}`);
    return { repairable: [], rejected: [] };
  }

  const eligible = new Map<string, BotConfig>();
  for (const bot of bots) {
    if (bot.apiOnly) continue;
    if (normalizeBrand(bot.brand) !== 'feishu') continue;
    if (!bot.larkAppId || eligible.has(bot.larkAppId)) continue;
    eligible.set(bot.larkAppId, bot);
  }

  // 只有**完全没传** appIds 才等于「修全部」。显式传了数组就是精确点名，哪怕是
  // 空数组也当「一个都不修」——批量写是要改整个 fleet 的开放平台配置，前端一个
  // 「空选中态也发请求」的 bug 不该被翻译成全量改写。
  if (appIds === undefined) {
    return { repairable: [...eligible.values()], rejected: [] };
  }
  const requested = appIds.map(id => id.trim()).filter(Boolean);

  const repairable: BotConfig[] = [];
  const rejected: RedirectRepairItem[] = [];
  const seen = new Set<string>();
  for (const appId of requested) {
    if (seen.has(appId)) continue;
    seen.add(appId);
    const bot = eligible.get(appId);
    if (bot) {
      repairable.push(bot);
      continue;
    }
    rejected.push({ appId, status: 'failed', message: rejectionReason(bots, appId) });
  }
  return { repairable, rejected };
}

function rejectionReason(bots: BotConfig[], appId: string): string {
  const bot = bots.find(item => item.larkAppId === appId);
  if (!bot) return '这个 appId 不在 bots.json 里';
  if (bot.apiOnly) return 'core-only（apiOnly）bot 没有飞书应用，无需也无法配置 redirect 白名单';
  if (normalizeBrand(bot.brand) !== 'feishu') return '开放平台自动配置当前只支持 feishu.cn 租户';
  return '这个 bot 不在可修复目标里';
}

function countByStatus(results: RedirectRepairItem[]): Record<RedirectRepairStatus, number> {
  const counts: Record<RedirectRepairStatus, number> = {
    fixed: 0, unchanged: 0, partial: 0, not_owned: 0, failed: 0,
  };
  for (const item of results) counts[item.status] += 1;
  return counts;
}

/**
 * 「这个 app 不属于当前登录账号」的判别。
 *
 * console 对非协作者回 403 **且** `code=10003`。两个条件缺一不可，与仓库既有判据
 * 完全一致（`automateOpenPlatformSetup` 的 `openPlatformOwnerAccessDenied` →
 * `owner_session_mismatch`、改名链路的 `no_access`）。
 *
 * ⚠️ 曾经写成 `status === 403 || code === 10003`，把两个信号放宽成任取其一：
 *   • 任意 403（限流、CSRF 失效、租户策略拦截）都会被报成「换个账号扫码」，
 *     用户照做也修不好；
 *   • 任意带 `code:10003` 的响应，哪怕不是 403，也会被同样误导。
 * 只有明确的 403+10003 才是「这个 app 不属于当前登录账号」，其余一律归 failed 并
 * 带上原始报错，让用户看到真正的原因。
 *
 * 仍然顺 `cause` 链找：`writeRedirectWhitelist` 在「全集被拒 → 最小集兜底也被拒」
 * 时抛的是包装过的普通 `Error`，原始 `OpenPlatformApiError` 挂在 `cause` 上。
 * （403 现在不再触发兜底重试，所以最常见的情形是最外层就是它；顺链只是防御。）
 */
function isOwnerAccessDenied(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof OpenPlatformApiError) {
      const code = (current.payload as { code?: unknown } | null | undefined)?.code;
      if (current.status === 403 && code === 10003) return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
