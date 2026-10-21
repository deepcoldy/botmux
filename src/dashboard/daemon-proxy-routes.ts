/**
 * 表驱动的「纯转发」路由：Dashboard 把 `/api/bots/:appId/<x>` 原样转给目标 bot 的
 * daemon IPC（`/api/bot-<x>` 等），再把上游 status 与文本原样回写。
 *
 * 只有**没有任何额外逻辑**的路由才进表：不查 owner、不做鉴权/校验、不改写 body、
 * 不改写响应。带额外逻辑的转发（如 quota-fallback 的本地兜底、sessions/schedules 的
 * owner 解析、roles 的矩阵快照失效）继续留在 dashboard.ts 里手写。
 *
 * 读 body 的方式在原实现之间本来就不一致（有无上限、空 body 的默认值、是否经 JSON
 * 解析），这里用 {@link ProxyBody} 的字段逐个表达，**不统一行为**。
 *
 * 顺序约束：表按「先匹配先处理」逐条检查；调用点必须放在原来那批手写块所在的位置。
 * 表内各条的 path 两两互斥（同路径不同方法才会共享正则），所以表内顺序不影响结果。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES } from '../im/lark/ask-option-layout.js';
import { REPLY_STYLE_REQUEST_MAX_BYTES } from './reply-style.js';

export type ProxyMethod = 'GET' | 'PUT' | 'POST';

/** 请求 body 的读取与转发方式。 */
export type ProxyBody =
  /** 无 body，init 只带 method。`jsonHeader` 仅为复刻 session-group-tag-status 历史上
   *  GET 也带 content-type 头的写法，其余 GET 不带。 */
  | { kind: 'none'; jsonHeader?: true }
  /** 读成 utf8 文本后原样转发；空 body 回落为 `emptyAs`（默认 `'{}'`）。
   *  `cap` 存在时边读边数字节，超限立刻 413 `{ ok:false, error: cap.error }`（不回落、不转发）。 */
  | { kind: 'raw'; emptyAs?: string; cap?: { maxBytes: number; error: string } }
  /** 经 `readJsonBody(req, maxBytes)` 校验后 `JSON.stringify` 再转发；
   *  超限 413 `body_too_large`，其余解析失败 400 `bad_json`。 */
  | { kind: 'json'; maxBytes: number };

export interface ProxyRoute {
  method: ProxyMethod;
  /** 匹配 `url.pathname`；第 1 个捕获组恒为目标 bot 的 larkAppId（URL 编码态）。 */
  path: RegExp;
  /** 上游 daemon IPC 路径；函数形态用于改写路径段或透传 query。 */
  upstream: string | ((match: RegExpMatchArray, url: URL) => string);
  body: ProxyBody;
  /** 原手写块里 `decodeURIComponent(appId)` 的时机。仅在 appId 含非法 `%` 序列（抛 URIError）
   *  时可观测，这里按路由逐字复刻，不统一：
   *  - 缺省：method 与 path 都命中后、读 body 之前（绝大多数路由）；
   *  - `'after-body'`：读完 body 之后（oncall-group、chat-feedback、sandbox-network-policy）；
   *  - `'on-path-match'`：path 命中即解码、先于 method 判定（原先多方法共享一个正则的块：
   *    blocked-users、session-group-tag-*），方法不符的请求也会因此抛 URIError。 */
  decodeAppId?: 'after-body' | 'on-path-match';
}

export interface DaemonProxyDeps {
  proxyToDaemon(larkAppId: string, daemonPath: string, init: RequestInit): Promise<Response>;
  readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  /** `readJsonBody` 因超限抛出的错误（映射 413），其余错误一律 400。 */
  isBodyTooLarge(err: unknown): boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** 默认：无上限读取，空 body → `'{}'`。 */
const RAW: ProxyBody = { kind: 'raw' };
const NO_BODY: ProxyBody = { kind: 'none' };

const botPath = (segment: string): RegExp => new RegExp(`^/api/bots/([^/]+)/${segment}$`);

/** `PUT /api/bots/:appId/<segment>` → `PUT /api/bot-<segment>`，body 原样转发。 */
const putBotConfig = (segment: string, body: ProxyBody = RAW): ProxyRoute => ({
  method: 'PUT',
  path: botPath(segment),
  upstream: `/api/bot-${segment}`,
  body,
});

export const BOT_PROXY_ROUTES: readonly ProxyRoute[] = [
  // working-dir-mode：`{ mode: 'off'|'default'|'oncall', workingDir }`，三选一互斥的默认目录模式。
  putBotConfig('working-dir-mode'),
  // agent：`{ cliId, model }`，cliId 是 dashboard 的选择键。
  putBotConfig('agent'),
  // skills：`{ action:'attach'|'detach', name }` 或 `{ action:'set', policy|null }`。
  putBotConfig('skills'),
  // brand-label：`{ brandLabel: string | null }`（'' = 关，null = 默认）。
  putBotConfig('brand-label'),
  // reply-style：稀疏回复卡样式覆盖；校验、原子落盘 bots.json 与内存热更新都在 daemon。
  putBotConfig('reply-style', { kind: 'json', maxBytes: REPLY_STYLE_REQUEST_MAX_BYTES }),
  // ask-option-layout：per-bot ask 选项布局；ask 卡在 daemon 进程渲染，下一张卡生效。
  putBotConfig('ask-option-layout', { kind: 'json', maxBytes: ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES }),
  // startup-commands：`{ startupCommands: string }`（逗号/换行分隔，'' = 清除）。
  putBotConfig('startup-commands'),
  // custom-passthrough：`{ customPassthroughCommands: string }`（逗号/空格分隔，'' = 清除）。
  putBotConfig('custom-passthrough'),
  // cantalk-daemon-commands：`{ canTalkDaemonCommands: string }`（逗号/空格分隔，'' = 清除）。
  putBotConfig('cantalk-daemon-commands'),
  // launch-shell：`{ launchShell: string }`（shell 名或绝对路径；'' = 清除，回 $SHELL）。
  putBotConfig('launch-shell'),
  { ...putBotConfig('oncall-group'), decodeAppId: 'after-body' },
  putBotConfig('feedback'),
  {
    method: 'PUT',
    path: /^\/api\/bots\/([^/]+)\/chats\/([^/]+)\/feedback$/,
    upstream: m => `/api/chat-feedback/${encodeURIComponent(decodeURIComponent(m[2]))}`,
    body: RAW,
    decodeAppId: 'after-body',
  },
  {
    method: 'GET',
    path: botPath('feedback/effective'),
    upstream: (_m, url) => `/api/feedback-effective${url.search}`,
    body: NO_BODY,
  },
  // env：`{ env: string }`（原始 JSON 文本，'' = 清除）。
  putBotConfig('env'),
  putBotConfig('env-policy'),
  putBotConfig('codex-auth-sync'),
  // Trigger-user CLI auth：开关（PUT）+ 状态（GET），校验路径由 daemon 统一持有。
  putBotConfig('trigger-user-auth'),
  putBotConfig('lark-tool-binding'),
  {
    method: 'GET',
    path: botPath('trigger-user-auth-status'),
    upstream: '/api/bot-trigger-user-auth-status',
    body: NO_BODY,
  },
  // riff：`{ riff: string }`（原始 JSON 文本，'' = 清除）。
  putBotConfig('riff'),
  // herdr：`{ herdr: string }`（原始 JSON 文本，'' = 清除）。
  putBotConfig('herdr'),
  // sandbox-network-policy：与其它 PUT 不同，空 body 不回落为 '{}'，原样转发空串。
  {
    ...putBotConfig('sandbox-network-policy', { kind: 'raw', emptyAs: '' }),
    decodeAppId: 'after-body',
  },
  // sandbox-paths：`{ readWrite?: string[]; readOnly?: string[]; deny?: string[] }`。
  putBotConfig('sandbox-paths'),
  // sandbox：`{ enabled: boolean }`。
  putBotConfig('sandbox'),
  // read-isolation：`{ enabled: boolean }`。
  putBotConfig('read-isolation'),
  // backend-type：`{ backendType: 'pty'|'tmux'|'herdr'|'zellij'|'zmx'|'' }`（''/'auto' 清除覆盖）。
  putBotConfig('backend-type'),
  // card-prefs：任意子集的 per-bot 行为布尔 / prompt 字符串。
  putBotConfig('card-prefs'),
  // substitute-mode：`{ enabled, targets, disclosure }`。
  putBotConfig('substitute-mode'),
  // substitute-targets/resolve：只预览解析单个 target、不落盘，供 dashboard 自动补全。
  {
    method: 'POST',
    path: botPath('substitute-targets/resolve'),
    upstream: '/api/bot-substitute-targets/resolve',
    body: RAW,
  },
  // summary-range：`{ limit, sinceHours }`，更新显式 /summary 的范围。
  putBotConfig('summary-range'),
  // 会话群标签授权（Dashboard 一站式）：state 必须驻留在生成链接的进程内，故代理到对应 bot 的 daemon。
  // status 的 GET 历史上带 content-type 头（其余 GET 不带），用 jsonHeader 原样保留。
  {
    method: 'GET',
    path: botPath('session-group-tag-status'),
    upstream: '/api/session-group-tag-status',
    body: { kind: 'none', jsonHeader: true },
    decodeAppId: 'on-path-match',
  },
  {
    method: 'POST',
    path: botPath('session-group-tag-auth'),
    upstream: '/api/session-group-tag-auth',
    body: RAW,
    decodeAppId: 'on-path-match',
  },
  {
    method: 'PUT',
    path: botPath('session-group-tag-config'),
    upstream: '/api/session-group-tag-config',
    body: RAW,
    decodeAppId: 'on-path-match',
  },
  // p2p-mode：`{ p2pMode: 'chat'|'thread'|'group' }`（其余值清回扁平连续 chat 默认）。
  putBotConfig('p2p-mode'),
  // envelope-injection：`{ envelopeInjection: 'auto'|'off'|'' }`（#794：hook 注入 per-turn 上下文）。
  putBotConfig('envelope-injection'),
  putBotConfig('prompt-injection'),
  // topic-unavailable-policy：per-bot 原话题不可用策略，沿用既有 config store。
  putBotConfig('topic-unavailable-policy'),
  // reply-delivery：`{ replyDelivery: 'transcript'|'send'|'' }`（最终回复投递方式）。
  putBotConfig('reply-delivery'),
  // skill-injection：`{ skillInjection: 'global'|'prompt'|'off'|'' }`（内置 skill 如何到达 global-skillsDir 的 CLI）。
  putBotConfig('skill-injection'),
  // grant-prefs：任意子集的 restrictGrantCommands / autoGrantRequestCards / p2pOpen /
  // grantRequestToOwnerDm / messageQuotaDefaultLimit / grantDefaultDurationMs。
  putBotConfig('grant-prefs'),
  // rename：`{ name }`；daemon 先走开放平台自动化，失败回落为 botmux 侧显示名并带 `warning`。
  putBotConfig('rename'),
  // description：GET 取开放平台的多语言描述；PUT `{ descriptions: Record<lang, string> }` 重新发布。
  // 校验/发布/语言集语义全在 daemon，这里只转发并给 PUT body 设上限，防恶意客户端无限缓冲。
  {
    method: 'GET',
    path: botPath('description'),
    upstream: '/api/bot-description',
    body: NO_BODY,
  },
  // 描述很小（≤20 种语言 × ≤120 字符），超过 64KB 直接 413。
  putBotConfig('description', { kind: 'raw', cap: { maxBytes: 64 * 1024, error: 'body_too_large' } }),
  // avatar：`{ imageBase64: string }`（Web UI 已规整为 512×512 PNG 的 base64，远小于 4MB）。
  // daemon 走开放平台自动化（上传图标 + base_info + 发版），无本地兜底。
  putBotConfig('avatar', { kind: 'raw', cap: { maxBytes: 4_000_000, error: 'image_too_large' } }),
  // max-live-workers：`{ maxLiveWorkers: number | null }`（null = 回落内置默认 30）。
  putBotConfig('max-live-workers'),
  // no-progress-notify：`{ noProgressNotify: { enabled?, timeoutMs? } | null }`（null = 默认开启 + 90s）。
  putBotConfig('no-progress-notify'),
  // idle-suspend-minutes：`{ idleSuspendMinutes: number | null }`（null = 关闭空闲 TTL）。
  putBotConfig('idle-suspend-minutes'),
  // session-owner-reminder：per-bot 周期性 owner 提醒策略；owning daemon 校验、落盘并热更新。
  putBotConfig('session-owner-reminder'),
  // 成员授权 / 黑名单 / 整群授权：管理写路径，不在 PUBLIC_READ_PATHS，非 manager 已在
  // resolveDashboardRequestGate 被 deny401。
  {
    method: 'GET',
    path: botPath('blocked-users'),
    upstream: '/api/blocked-users',
    body: NO_BODY,
    decodeAppId: 'on-path-match',
  },
  {
    method: 'PUT',
    path: botPath('blocked-users'),
    upstream: '/api/blocked-users',
    body: RAW,
    decodeAppId: 'on-path-match',
  },
  {
    method: 'POST',
    path: botPath('grants/chat'),
    upstream: '/api/grants/chat',
    body: RAW,
  },
  {
    method: 'PUT',
    path: botPath('chat-group-grant'),
    upstream: '/api/chat-group-grant',
    body: RAW,
  },
];

async function readRawBody(
  req: IncomingMessage,
  res: ServerResponse,
  body: Extract<ProxyBody, { kind: 'raw' }>,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  if (body.cap) {
    let received = 0;
    for await (const c of req) {
      received += (c as Buffer).length;
      if (received > body.cap.maxBytes) {
        res.writeHead(413, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: body.cap.error }));
        return null;
      }
      chunks.push(c as Buffer);
    }
  } else {
    for await (const c of req) chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8') || (body.emptyAs ?? '{}');
}

/**
 * 在 `routes` 里找第一条 method + path 都匹配的路由并完成转发；命中返回 true
 * （响应已写完），未命中返回 false 且不消费 body，调用方继续往下匹配别的路由。
 */
export async function handleDaemonProxyRoute(
  routes: readonly ProxyRoute[],
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DaemonProxyDeps,
): Promise<boolean> {
  for (const route of routes) {
    const methodMatches = req.method === route.method;
    if (!methodMatches && route.decodeAppId !== 'on-path-match') continue;
    const match = url.pathname.match(route.path);
    if (!match) continue;

    let appId = route.decodeAppId === 'after-body' ? '' : decodeURIComponent(match[1]);
    if (!methodMatches) continue;
    const body = route.body;

    let init: RequestInit;
    if (body.kind === 'none') {
      init = body.jsonHeader
        ? { method: route.method, headers: { ...JSON_HEADERS } }
        : { method: route.method };
    } else {
      let raw: string | null;
      if (body.kind === 'raw') {
        raw = await readRawBody(req, res, body);
        if (raw === null) return true;
      } else {
        try {
          raw = JSON.stringify(await deps.readJsonBody(req, body.maxBytes));
        } catch (err) {
          const status = deps.isBodyTooLarge(err) ? 413 : 400;
          res.writeHead(status, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: status === 413 ? 'body_too_large' : 'bad_json' }));
          return true;
        }
      }
      init = { method: route.method, headers: { ...JSON_HEADERS }, body: raw };
    }
    if (route.decodeAppId === 'after-body') appId = decodeURIComponent(match[1]);
    // 路径段改写放在读 body 之后：chat-feedback 的 chatId 解码原实现就在 body 读完后求值。
    const upstreamPath = typeof route.upstream === 'function' ? route.upstream(match, url) : route.upstream;

    const upstream = await deps.proxyToDaemon(appId, upstreamPath, init);
    res.writeHead(upstream.status, JSON_HEADERS);
    res.end(await upstream.text());
    return true;
  }
  return false;
}
