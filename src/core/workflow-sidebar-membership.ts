/**
 * 工作流侧边栏的「本群当前成员」检查（设计 2026-11-03 §11.3，D6）。在 run 主 Bot 的 daemon
 * 里执行：用主 Bot 自己的应用实时查访问者是否在 run 所在群。
 *
 * 复用委托校验已经在用的两步（daemon.ts `targetUserForDelegation`）：union_id 先换成
 * **本应用视角**的 open_id（`resolveTargetAppOpenId`），再与本应用看到的群成员列表比对
 * （`listChatMemberOpenIds`）。open_id 是 app-scoped 的：只有调用方能证明这个 open_id
 * 本来就是主 Bot 应用签发的（例如 H5 免登应用就是主 Bot 应用），才直接拿它比对；
 * 别的应用签发的 ou_ 从不拿来查（见 CLAUDE.md「飞书 owner 身份边界」）。
 *
 * 结论三态：查询失败一律是 `unavailable`，调用方按拒绝处理、也不缓存。
 */

export const WORKFLOW_SIDEBAR_MEMBERSHIP_ROUTE = '/api/workflow-sidebar/chat-membership';

export type WorkflowViewerPrincipal =
  | { unionId: string }
  /** Only when the open_id is known to be issued by the checking (main bot) app. */
  | { openId: string };

export type WorkflowViewerMembership = 'member' | 'not_member' | 'unavailable';

export interface WorkflowSidebarMembershipRequest {
  chatId: string;
  principal: WorkflowViewerPrincipal;
}

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
const UNION_ID_RE = /^on_[A-Za-z0-9_-]{6,128}$/;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{6,128}$/;

/** IPC 请求体的白名单解析：恰好一个身份字段，形状不对就拒绝。 */
export function parseWorkflowSidebarMembershipRequest(raw: unknown): WorkflowSidebarMembershipRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  if (!CHAT_ID_RE.test(chatId)) return null;
  const unionId = typeof body.unionId === 'string' ? body.unionId : undefined;
  const openId = typeof body.openId === 'string' ? body.openId : undefined;
  if (unionId !== undefined && openId !== undefined) return null;
  if (unionId !== undefined) return UNION_ID_RE.test(unionId) ? { chatId, principal: { unionId } } : null;
  if (openId !== undefined) return OPEN_ID_RE.test(openId) ? { chatId, principal: { openId } } : null;
  return null;
}

export interface WorkflowSidebarMembershipDeps {
  /** union_id → 本应用的 open_id（daemon 里就是 `resolveTargetAppOpenId(selfApp, …)`）。 */
  resolveOpenIdByUnionId(unionId: string): Promise<
    | { status: 'resolved'; openId: string }
    | { status: 'transient' }
    | { status: 'definitive' }
  >;
  /** 本应用看到的群成员 open_id（不完整时必须抛错，不能返回半截名单）。 */
  listChatMemberOpenIds(chatId: string): Promise<readonly string[]>;
}

export async function checkWorkflowViewerChatMembership(
  request: WorkflowSidebarMembershipRequest,
  deps: WorkflowSidebarMembershipDeps,
): Promise<WorkflowViewerMembership> {
  let openId: string;
  if ('openId' in request.principal) {
    openId = request.principal.openId;
  } else {
    let resolved: Awaited<ReturnType<WorkflowSidebarMembershipDeps['resolveOpenIdByUnionId']>>;
    try {
      resolved = await deps.resolveOpenIdByUnionId(request.principal.unionId);
    } catch {
      return 'unavailable';
    }
    if (resolved.status === 'definitive') return 'not_member';
    if (resolved.status !== 'resolved') return 'unavailable';
    openId = resolved.openId;
  }
  let members: readonly string[];
  try {
    members = await deps.listChatMemberOpenIds(request.chatId);
  } catch {
    return 'unavailable';
  }
  return members.includes(openId) ? 'member' : 'not_member';
}

/** Same horizon the grant-approver member cache uses (`grant-owner.ts`): a
 *  person removed from the chat loses the sidebar within a minute. */
export const WORKFLOW_SIDEBAR_MEMBERSHIP_TTL_MS = 60_000;
/** A failed lookup is remembered (and denied) this long, so a page that keeps
 *  retrying, or a burst of requests, cannot turn a struggling main bot into a
 *  stream of Feishu contact / member-list calls. */
export const WORKFLOW_SIDEBAR_MEMBERSHIP_UNAVAILABLE_TTL_MS = 5_000;
const MAX_CACHED_VERDICTS = 1_000;

/**
 * Short-lived cache of verdicts per (main bot, chat, principal), with one
 * lookup in flight per key: concurrent requests for the same key share it.
 * Definitive verdicts live {@link WORKFLOW_SIDEBAR_MEMBERSHIP_TTL_MS};
 * `unavailable` only {@link WORKFLOW_SIDEBAR_MEMBERSHIP_UNAVAILABLE_TTL_MS}
 * (and the caller denies either way).
 */
export class WorkflowSidebarMembershipCache {
  private readonly verdicts = new Map<string, { verdict: WorkflowViewerMembership; at: number }>();
  private readonly inFlight = new Map<string, Promise<WorkflowViewerMembership>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly unavailableTtlMs: number;

  constructor(opts: { now?: () => number; ttlMs?: number; unavailableTtlMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? WORKFLOW_SIDEBAR_MEMBERSHIP_TTL_MS;
    this.unavailableTtlMs = opts.unavailableTtlMs ?? WORKFLOW_SIDEBAR_MEMBERSHIP_UNAVAILABLE_TTL_MS;
  }

  check(
    key: { mainLarkAppId: string; chatId: string; principal: WorkflowViewerPrincipal },
    ask: () => Promise<WorkflowViewerMembership>,
  ): Promise<WorkflowViewerMembership> {
    const id = 'openId' in key.principal ? `o:${key.principal.openId}` : `u:${key.principal.unionId}`;
    const cacheKey = `${key.mainLarkAppId}\0${key.chatId}\0${id}`;
    const cached = this.verdicts.get(cacheKey);
    if (cached) {
      const ttl = cached.verdict === 'unavailable' ? this.unavailableTtlMs : this.ttlMs;
      if (this.now() - cached.at < ttl) return Promise.resolve(cached.verdict);
      this.verdicts.delete(cacheKey);
    }
    const running = this.inFlight.get(cacheKey);
    if (running) return running;
    const lookup = (async (): Promise<WorkflowViewerMembership> => {
      let verdict: WorkflowViewerMembership;
      try {
        verdict = await ask();
      } catch {
        verdict = 'unavailable';
      }
      this.verdicts.delete(cacheKey);
      if (this.verdicts.size >= MAX_CACHED_VERDICTS) {
        const oldest = this.verdicts.keys().next();
        if (!oldest.done) this.verdicts.delete(oldest.value);
      }
      this.verdicts.set(cacheKey, { verdict, at: this.now() });
      return verdict;
    })();
    this.inFlight.set(cacheKey, lookup);
    const release = () => { if (this.inFlight.get(cacheKey) === lookup) this.inFlight.delete(cacheKey); };
    lookup.then(release, release);
    return lookup;
  }
}

/** What the daemon's membership IPC route answers (status + JSON body). */
export interface WorkflowSidebarMembershipRouteResult {
  status: number;
  body: { ok: true; member: boolean } | { ok: false; error: string };
}

/**
 * The daemon side of `POST {@link WORKFLOW_SIDEBAR_MEMBERSHIP_ROUTE}`: only a
 * trusted host (the Dashboard, holding the host secret) may ask, only once the
 * daemon knows its own app, and only with a well-formed request. A lookup that
 * fails answers 503 so the Dashboard denies.
 */
export async function workflowSidebarMembershipRoute(
  input: { trustedHost: boolean; selfLarkAppId: string | undefined; body: unknown },
  deps: (selfLarkAppId: string) => WorkflowSidebarMembershipDeps,
): Promise<WorkflowSidebarMembershipRouteResult> {
  if (!input.trustedHost) return { status: 403, body: { ok: false, error: 'trusted_host_required' } };
  if (!input.selfLarkAppId) return { status: 503, body: { ok: false, error: 'larkAppId_not_set' } };
  const request = parseWorkflowSidebarMembershipRequest(input.body);
  if (!request) return { status: 400, body: { ok: false, error: 'invalid_request' } };
  const verdict = await checkWorkflowViewerChatMembership(request, deps(input.selfLarkAppId));
  if (verdict === 'unavailable') return { status: 503, body: { ok: false, error: 'membership_unavailable' } };
  return { status: 200, body: { ok: true, member: verdict === 'member' } };
}
