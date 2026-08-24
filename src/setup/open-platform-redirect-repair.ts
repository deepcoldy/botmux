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
  OpenPlatformApiError,
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
 * • `fixed`      — 白名单被改写（含全集被拒、退到最小集的兜底写）
 * • `unchanged`  — 想要的地址线上全有，幂等短路，一次写请求都没发
 * • `not_owned`  — 当前登录账号不是该应用的协作者，换账号扫码才能修
 * • `failed`     — 其余失败（网络 / console 报错 / 不是可修复的目标 bot）
 */
export type RedirectRepairStatus = 'fixed' | 'unchanged' | 'not_owned' | 'failed';

export interface RedirectRepairItem {
  appId: string;
  status: RedirectRepairStatus;
  /** 失败原因，或 `fixed` 时的补充说明（如「退到最小集」）。成功且无话可说时省略。 */
  message?: string;
  /** 本次落地（或确认已在线上）的白名单全集，供 UI 展示与排障。仅 fixed/unchanged 有。 */
  redirectUrls?: string[];
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
       */
      reason: 'login_required' | 'in_flight' | 'network';
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

/** 当前是否有一批修复在跑（路由/诊断用）。 */
export function isRepairOpenPlatformRedirectsInFlight(): boolean {
  return inFlight !== null;
}

export async function repairOpenPlatformRedirects(
  opts: RepairOpenPlatformRedirectsOptions = {},
): Promise<RepairOpenPlatformRedirectsResult> {
  if (inFlight) {
    return { ok: false, reason: 'in_flight', message: '已有一批 redirect 白名单修复在执行，请等它跑完再试' };
  }
  const run = runRepair(opts);
  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

async function runRepair(
  opts: RepairOpenPlatformRedirectsOptions,
): Promise<RepairOpenPlatformRedirectsResult> {
  const prepareSession = opts.prepareSession ?? prepareFeishuWebSession;
  const clientFactory = opts.clientFactory
    ?? ((cookies: StoredCookie[]) => createOpenPlatformApiClient(cookies, { fetchImpl: opts.fetchImpl }));
  const listBots = opts.loadBots ?? loadBotConfigs;
  const collectWanted = opts.collectWanted ?? collectBotmuxRedirectUrls;

  // 先算目标集：没有可修的 bot 就别去动登录态（也就不会白白弹「请扫码」）。
  const targets = resolveTargets(listBots, opts.appIds);
  if (targets.repairable.length === 0) {
    return { ok: true, results: targets.rejected, wanted: [] };
  }

  const prepared = await prepareSession({
    sessionFilePath: opts.sessionFilePath,
    fetchImpl: opts.fetchImpl,
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

  for (const bot of targets.repairable) {
    results.push(await repairOne(clientResult.client.postJson, bot.larkAppId, wanted));
  }

  const summary = countByStatus(results);
  logger.info(
    `[redirect-repair] ${results.length} bot(s): `
    + `fixed=${summary.fixed} unchanged=${summary.unchanged} not_owned=${summary.not_owned} failed=${summary.failed}`,
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
    if (written.status === 'unchanged') {
      return { appId, status: 'unchanged', redirectUrls: written.redirectUrls };
    }
    return {
      appId,
      status: 'fixed',
      redirectUrls: written.redirectUrls,
      message: written.status === 'updated_fallback'
        ? '完整地址列表被开放平台拒绝，已退回「线上现值 + 本机回调」最小集写入'
        : undefined,
    };
  } catch (err) {
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
  const counts: Record<RedirectRepairStatus, number> = { fixed: 0, unchanged: 0, not_owned: 0, failed: 0 };
  for (const item of results) counts[item.status] += 1;
  return counts;
}

/**
 * 「这个 app 不属于当前登录账号」的判别。
 *
 * console 对非协作者回 403 + `code=10003`（`automateOpenPlatformSetup` 的
 * `owner_session_mismatch`、改名链路的 `no_access` 用的都是同一个信号）。
 *
 * ⚠️ 必须顺 `cause` 链找：`writeRedirectWhitelist` 在「全集被拒 → 最小集兜底也被拒」
 * 时抛的是一个包装过的普通 `Error`，原始 `OpenPlatformApiError` 挂在 `cause` 上。
 * 而「配了 oauthRedirectBase（wanted 不止一条）+ 换了账号」恰恰就会走进那条兜底
 * 分支——只认最外层就会把 not_owned 误报成 failed，正好在这个功能最常见的场景上。
 */
function isOwnerAccessDenied(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof OpenPlatformApiError) {
      const code = (current.payload as { code?: unknown } | null | undefined)?.code;
      if (current.status === 403 || code === 10003) return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
