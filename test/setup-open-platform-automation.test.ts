/**
 * Unit tests for Open Platform setup automation helpers.
 *
 * Run: pnpm vitest run test/setup-open-platform-automation.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  automateOpenPlatformSetup,
  BOT_BASELINE_APP_EVENTS,
  BOT_BASELINE_CALLBACKS,
  BOT_OPTIONAL_APP_EVENTS,
  LONG_CONNECTION_EVENT_MODE,
  VC_MEETING_APP_EVENTS,
  VC_MEETING_USER_EVENTS,
  BOTMUX_REDIRECT_URL,
  botmuxFeishuSessionFilePath,
  buildFeishuQrPayload,
  buildPrivilegeAppAvailabilityContent,
  buildPrivilegeUpdatePayload,
  buildSafeSettingPayload,
  buildScopeUpdatePayload,
  cancelPendingReviewVersion,
  canFillPrivilegeWithAppAvailability,
  collectBotmuxRedirectUrls,
  createFeishuOpenPlatformApp,
  createOpenPlatformApiClient,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformPrivileges,
  extractOpenPlatformRedirectUrls,
  extractOpenPlatformSessionIdentity,
  extractOpenPlatformScopeEntries,
  fetchApprovalFlowPrediction,
  filterScopeManifest,
  findInReviewVersionId,
  findUncommittedDraftVersionId,
  getCookieHeader,
  isPrivilegeRangeNarrowed,
  isVersionCommitted,
  mapFeishuQrPollingStatus,
  mapManifestScopesToOpenPlatformIds,
  readDefaultScopeManifest,
  missingRedirectUrls,
  OpenPlatformApiError,
  parseSetupOpenPlatformAutoFlag,
  predictApprovalFlow,
  prepareFeishuWebSession,
  probeVcMeetingEventSubscription,
  readStoredCookiesFromSessionFile,
  safeErrorMessage,
  selectPrivilegesNeedingAppAvailability,
  type OpenPlatformApiClient,
  type StoredCookie,
  vcListenerEventGateError,
  writeRedirectWhitelist,
  writeStoredCookiesToSessionFile,
} from '../src/setup/open-platform-automation.js';
import { classifySetupOpenPlatformOutcome } from '../src/setup/open-platform-outcome.js';

function cookie(overrides: Partial<StoredCookie> = {}): StoredCookie {
  return {
    name: 'session',
    value: 'secret-cookie-value',
    domain: '.feishu.cn',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

const openPlatformPage = (csrf = 'csrf_create') => `<script>
window.csrfToken="${csrf}";
window.user={"id":"u_1","name":"Alice","email":"alice@example.com","tenantId":"t_1","tenantName":"Example","tenantDisplayName":{"value":"Example"}};
</script>`;

/**
 * 有状态的事件/回调订阅 mock:read 返回当前订阅,operation:add 增量写入,
 * 与开放平台 console 的增量契约同形。automateOpenPlatformSetup 现在会回读
 * 确认核心事件/回调,mock 不落库就会 fail-closed。
 */
function openPlatformSubscriptionMock(appId: string, opts: {
  failEventUpdate?: boolean;
  failCallbackUpdate?: boolean;
  /** callback/switch 直接报错。 */
  failCallbackSwitch?: boolean;
  /** callback/switch 返回成功但 mode 实际不变(回读兜底用例)。 */
  callbackSwitchNoop?: boolean;
  /** event/update 中包含这些事件时整批被拒(逐个重试时对应单个失败)。 */
  rejectEventNames?: string[];
  initial?: { appEvents?: string[]; userEvents?: string[]; callbacks?: string[]; callbackMode?: number; eventMode?: number; redirectUrls?: string[] };
  /**
   * safe_setting 读接口读不出白名单（返回体里没有 redirectURL）。默认可读——
   * automateOpenPlatformSetup 现在「读不到就零写入」，默认不可读会让所有只关心
   * 别的步骤的用例都莫名少一次白名单写入。
   */
  redirectUnreadable?: boolean;
  /** visible/online 响应体（不给时用「全员可见」的现行契约形态）。 */
  visibleOnline?: unknown;
} = {}) {
  const state = {
    eventMode: opts.initial?.eventMode ?? 4,
    appEvents: [...(opts.initial?.appEvents ?? [])],
    userEvents: [...(opts.initial?.userEvents ?? [])],
    callbackMode: opts.initial?.callbackMode ?? 1,
    callbacks: [...(opts.initial?.callbacks ?? [])],
    redirectUrls: [...(opts.initial?.redirectUrls ?? [])],
  };
  const updateBodies: Array<Record<string, unknown>> = [];
  const redirectWrites: Array<Record<string, unknown>> = [];
  const handle = (href: string, init?: RequestInit): Response | null => {
    // redirect 白名单同样是「读现值 → 合并 → 写」的有状态接口：读不回真实形态的话，
    // 生产代码会判成「读不出来」并跳过写入，用例就再也看不到 safe_setting/update。
    if (href.endsWith(`/developers/v1/safe_setting/update/${appId}`)) {
      const body = JSON.parse(String(init?.body));
      // 单独记账：`updateBodies` 被「事件/回调幂等」用例断言为空数组，白名单写入
      // 不属于那件事，混进去会让那条用例误红。
      redirectWrites.push(body);
      state.redirectUrls = [...((body.redirectURL as string[] | undefined) ?? [])];
      return Response.json({ code: 0 });
    }
    if (href.endsWith(`/developers/v1/safe_setting/${appId}`)) {
      return opts.redirectUnreadable
        ? Response.json({ code: 0 })
        : Response.json({ code: 0, data: { redirectURL: [...state.redirectUrls] } });
    }
    if (href.endsWith(`/developers/v1/event/update/${appId}`)) {
      const body = JSON.parse(String(init?.body));
      updateBodies.push(body);
      const requested: string[] = [...(body.appEvents ?? []), ...(body.userEvents ?? [])];
      if (opts.failEventUpdate || requested.some(name => (opts.rejectEventNames ?? []).includes(name))) {
        return Response.json({ code: 1, msg: 'event update rejected' });
      }
      state.appEvents.push(...(body.appEvents ?? []));
      state.userEvents.push(...(body.userEvents ?? []));
      return Response.json({ code: 0 });
    }
    if (href.endsWith(`/developers/v1/event/${appId}`)) {
      return Response.json({
        code: 0,
        data: {
          eventMode: state.eventMode,
          events: [...state.appEvents, ...state.userEvents],
          appEventDetails: [{ items: state.appEvents.map(id => ({ id })) }],
          userEventDetails: [{ items: state.userEvents.map(id => ({ id })) }],
        },
      });
    }
    if (href.endsWith(`/developers/v1/callback/switch/${appId}`)) {
      if (opts.failCallbackSwitch) return Response.json({ code: 1, msg: 'callback switch rejected' });
      const body = JSON.parse(String(init?.body));
      if (!opts.callbackSwitchNoop) state.callbackMode = body.callbackMode;
      return Response.json({ code: 0 });
    }
    if (href.endsWith(`/developers/v1/callback/update/${appId}`)) {
      const body = JSON.parse(String(init?.body));
      updateBodies.push(body);
      if (opts.failCallbackUpdate) return Response.json({ code: 1, msg: 'callback update rejected' });
      state.callbacks.push(...(body.callbacks ?? []));
      return Response.json({ code: 0 });
    }
    if (href.endsWith(`/developers/v1/callback/${appId}`)) {
      return Response.json({ code: 0, data: { callbackMode: state.callbackMode, callbacks: [...state.callbacks] } });
    }
    if (href.endsWith(`/developers/v1/visible/online/${appId}`)) {
      return Response.json(opts.visibleOnline ?? {
        code: 0,
        data: {
          whiteList: { departments: [], members: [], groups: [], isAll: 1 },
          blackList: { departments: [], members: [], groups: [], isAll: 0 },
        },
      });
    }
    return null;
  };
  return { state, updateBodies, redirectWrites, handle };
}

describe('parseSetupOpenPlatformAutoFlag', () => {
  it('is enabled by default, supports explicit skip, and keeps --open-platform-auto compatible', () => {
    expect(parseSetupOpenPlatformAutoFlag([])).toBe(true);
    expect(parseSetupOpenPlatformAutoFlag(['--open-platform-auto'])).toBe(true);
    expect(parseSetupOpenPlatformAutoFlag(['--no-open-platform-auto'])).toBe(false);
    expect(parseSetupOpenPlatformAutoFlag(['--open-platform-auto', '--no-open-platform-auto'])).toBe(false);
    expect(parseSetupOpenPlatformAutoFlag(['--no-open-platform-auto', '--open-platform-auto'])).toBe(true);
  });
});

describe('botmux Feishu session cookie adapter', () => {
  it('writes private botmux cookie jar and builds scoped cookie headers without expired cookies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const file = join(dir, 'feishu_session.json');
    writeStoredCookiesToSessionFile(file, [
      cookie(),
      cookie({ name: 'expired', value: 'gone', expiresAt: Date.now() - 10 }),
      cookie({ name: 'askOnly', value: 'nope', domain: 'ask.feishu.cn', hostOnly: true }),
    ]);

    const cookies = readStoredCookiesFromSessionFile(file);
    expect(cookies?.map(c => c.name)).toEqual(['session', 'askOnly']);
    expect(getCookieHeader(cookies ?? [], 'https://open.feishu.cn/app/cli_x/auth')).toBe('session=secret-cookie-value');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('resolves botmux session path under config dir', () => {
    expect(botmuxFeishuSessionFilePath('/tmp/botmux-config')).toBe('/tmp/botmux-config/feishu-session.json');
  });
});

describe('Open Platform payload helpers', () => {
  it('builds Feishu QR payload and maps polling status', () => {
    expect(buildFeishuQrPayload('qr-token')).toBe(JSON.stringify({ qrlogin: { token: 'qr-token' } }));
    expect(mapFeishuQrPollingStatus(2)).toBe('已经扫码，等待手机确认');
    expect(mapFeishuQrPollingStatus(5)).toBe('二维码已过期');
    expect(mapFeishuQrPollingStatus(null)).toBe('等待飞书扫码');
  });

  it('extracts window.csrfToken from page HTML', () => {
    expect(extractOpenPlatformCsrfToken('<script>window.csrfToken = "csrf_123"</script>')).toBe('csrf_123');
  });

  it('extracts the account and tenant identity shown before cached-session creation', () => {
    expect(extractOpenPlatformSessionIdentity(openPlatformPage())).toEqual({
      userId: 'u_1',
      userName: 'Alice',
      email: 'alice@example.com',
      tenantId: 't_1',
      tenantName: 'Example',
    });
  });

  it('maps tenant/user scope names to Open Platform IDs and builds payloads', () => {
    const entries = extractOpenPlatformScopeEntries({
      data: {
        appScopeList: [{ id: 101, name: 'im:message' }],
        userScopeList: [{ scopeId: '202', scopeName: 'auth:user_access_token:read' }],
      },
    });
    const mapped = mapManifestScopesToOpenPlatformIds(
      { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
      entries,
    );

    expect(mapped).toEqual({
      tenantScopeIds: ['101'],
      userScopeIds: ['202'],
      missingTenantScopes: [],
      missingUserScopes: [],
    });
    expect(buildScopeUpdatePayload('cli_x', mapped)).toMatchObject({
      clientId: 'cli_x',
      appScopeIDs: ['101'],
      userScopeIDs: ['202'],
      operation: 'add',
      isDeveloperPanel: true,
    });
    expect(buildSafeSettingPayload('cli_x').redirectURL).toEqual(['http://127.0.0.1:9768/callback']);
  });
});

describe('filterScopeManifest — 只申请缺失项，避免全量 manifest 过度申请', () => {
  const manifest = {
    scopes: {
      tenant: [
        'im:message',
        'im:resource',
        'calendar:calendar:read',
        'application:application:self_manage',
      ],
      user: [
        'im:message',
        'im:feed_group_v1:read',
        'im:feed_group_v1:write',
        'docs:document:readonly',
      ],
    },
  };

  it('保留点名的权限并沿用 manifest 的 tenant/user 分桶归属', () => {
    // im:feed_group_v1:* 只在 user 桶；im:resource 只在 tenant 桶——分桶必须来自
    // manifest，不能自己猜。
    const filtered = filterScopeManifest(manifest, [
      'im:feed_group_v1:read',
      'im:feed_group_v1:write',
      'im:resource',
    ]);
    expect(filtered).toEqual({
      scopes: {
        tenant: ['im:resource'],
        user: ['im:feed_group_v1:read', 'im:feed_group_v1:write'],
      },
    });
  });

  it('同名权限同时落两桶时两桶都保留', () => {
    const filtered = filterScopeManifest(manifest, ['im:message']);
    expect(filtered).toEqual({ scopes: { tenant: ['im:message'], user: ['im:message'] } });
  });

  it('不点名的权限一律不申请（日历/文档等不再被连带带上）', () => {
    const filtered = filterScopeManifest(manifest, ['application:application:self_manage']);
    expect(filtered.scopes?.tenant).toEqual(['application:application:self_manage']);
    expect(filtered.scopes?.user).toEqual([]);
    // 关键回归点：manifest 里的 calendar/docs 权限不会被带进申请集合。
    expect(filtered.scopes?.tenant).not.toContain('calendar:calendar:read');
    expect(filtered.scopes?.user).not.toContain('docs:document:readonly');
  });

  it('manifest 里不存在的名字直接落空（交给 catalog 映射记 skipped）', () => {
    const filtered = filterScopeManifest(manifest, ['im:nonexistent:scope']);
    expect(filtered).toEqual({ scopes: { tenant: [], user: [] } });
  });

  it('空缺失列表 → 空申请集合', () => {
    expect(filterScopeManifest(manifest, [])).toEqual({ scopes: { tenant: [], user: [] } });
  });

  /**
   * 裁剪之后 `scopeCount` 的语义变了：从「整份清单导入了多少」变成「**缺失的那几项
   * 里成功了多少**」。所以 `0` 不再等于「本来就齐」，反而最常见的成因是「一项都没
   * 补上」——调用方（event-dispatcher.tryAutoFixScopes）据此措辞，说反了就会在全部
   * 失败时谎报「所有必需权限已在应用清单中」，而这句话同时进管理员 DM。
   *
   * 这里跑真实的 automation 拿到真实的 `scopeCount / skippedScopeCount /
   * scopeWarning` 三元组，验证三种成因**确实可区分**——否则调用方无论怎么写文案都
   * 只能靠猜。
   */
  it('三种 scopeCount===0 成因在结果里可区分（调用方措辞的依据）', async () => {
    const FEED = ['im:feed_group_v1:read', 'im:feed_group_v1:write'];
    const narrowed = filterScopeManifest(readDefaultScopeManifest(), FEED);

    const run = async (label: string, opts: {
      catalog: { appScopeList: any[]; userScopeList: any[] };
      rejectScopeUpdate?: boolean;
      manifest?: any;
    }) => {
      const dir = mkdtempSync(join(tmpdir(), `scope0-${label}-`));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = openPlatformSubscriptionMock('cli_s');
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/app/cli_s/auth')) return new Response('<script>window.csrfToken="c"</script>', { status: 200 });
        if (href.includes('/scope/all/')) return Response.json({ code: 0, data: opts.catalog });
        if (href.includes('/scope/update/')) {
          return opts.rejectScopeUpdate
            ? Response.json({ code: 1, msg: 'scope not grantable for tenant' })
            : Response.json({ code: 0 });
        }
        if (href.includes('/app_version/list/')) return Response.json({ code: 0, data: { versions: [{ appVersion: '1.0.0' }] } });
        if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;
      const r = await automateOpenPlatformSetup({
        appId: 'cli_s', sessionFilePath: sessionFile, fetchImpl, disableQrLogin: true,
        scopeManifest: opts.manifest ?? narrowed,
      });
      expect(r.ok, `${label}: ok=false reason=${(r as any).reason}`).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      return { scopeCount: r.scopeCount, skipped: r.skippedScopeCount, warned: Boolean(r.scopeWarning) };
    };

    const catalogWithFeed = {
      appScopeList: [{ id: 't1', name: 'im:message' }],
      userScopeList: [{ id: 'u1', name: 'im:feed_group_v1:read' }, { id: 'u2', name: 'im:feed_group_v1:write' }],
    };
    const catalogWithoutFeed = {
      appScopeList: [{ id: 't1', name: 'im:message' }, { id: 't2', name: 'im:resource' }],
      userScopeList: [{ id: 'u1', name: 'im:message' }],
    };

    // ① 成功落地：scopeCount>0 —— 调用方说「N 项权限已导入」
    expect(await run('applied', { catalog: catalogWithFeed }))
      .toEqual({ scopeCount: 2, skipped: 0, warned: false });

    // ② 租户目录里根本没有这两项 → 一个 id 都映射不出来，scope/update 都不会发。
    //    scopeCount=0 但 skipped>0 —— 必须说「不在租户目录、需手动开通」。
    expect(await run('not-in-catalog', { catalog: catalogWithoutFeed }))
      .toEqual({ scopeCount: 0, skipped: 2, warned: false });

    // ③ 目录里有、但开放平台整批拒了 → scopeCount 被归零且带 scopeWarning。
    //    必须说「开放平台拒绝了申请」，不能说「已齐全」。
    expect(await run('rejected', { catalog: catalogWithFeed, rejectScopeUpdate: true }))
      .toEqual({ scopeCount: 0, skipped: 0, warned: true });

    // ④ 真的无事可做（申请集合为空）才是「所有必需权限已在应用清单中」：
    //    三个信号全为零/假，与 ②③ 明确可区分。
    expect(await run('nothing-missing', {
      catalog: catalogWithFeed, manifest: { scopes: { tenant: [], user: [] } },
    })).toEqual({ scopeCount: 0, skipped: 0, warned: false });
  });
});

/**
 * 「权限可访问的数据范围」自动填成「与应用的可用范围一致」。
 *
 * 这是**独立于 scope/update 的第二条链路**：权限点进了清单，其中一部分还各带一份
 * 「这个权限能看到哪些数据」的表单。botmux 历史上完全没碰它，于是每次自动发版都
 * 带着「未配置」提审——而这些权限都是「需审核」档，租户审批规则明写申请全员数据
 * 范围要「视情况加签至 CEO-2」。
 *
 * 下面的 fixture 是从**线上真实响应**（`privilege/all`）里摘出来的原样结构，不是
 * 手写的理想形状：
 *   • `vc/meeting.meetingid` —— 单个 select_staff 字段，isRequired，真实待配对象
 *   • `security_and_compliance/dlp_execute_log` —— 同为 SelectionExpression + 内部
 *     组织，但字段里混了一个 `data_source.type==='url'` 的「工作地点」。这正是
 *     `availability_of_app`（成员范围语义）塞不进去的形态，必须整条跳过。
 */
describe('privilege 数据范围 —— 自动填「与应用的可用范围一致」', () => {
  /** 线上 `privilege/all` 的真实条目（结构原样，只裁掉与判定无关的字段）。 */
  const VC_PRIVILEGE = {
    bizId: 'vc',
    resource: 'meeting.meetingid',
    name: '会议号查询会议信息',
    isRequired: true,
    content: '',
    privilegeStatus: 3,
    schemaType: 1,
    organizationType: 1,
    schemaContent: {
      selectionExpressionSchemaContent: {
        fields: [{
          id: 'owner_scope',
          name: '会议的归属者',
          type: 'object',
          multi: false,
          operators: ['in'],
          data_source: { type: 'select_staff', val: '' },
        }],
        select_mode_options: ['all', 'part', 'null'],
        fallback_value: { mode: 'all' },
      },
    },
  };
  /** 同样 needsDataRange，但含一个非选人字段（工作地点）——不可自动填。 */
  const DLP_PRIVILEGE = {
    bizId: 'security_and_compliance',
    resource: 'dlp_execute_log',
    name: 'DLP执行日志',
    isRequired: true,
    content: '',
    schemaType: 1,
    organizationType: 1,
    schemaContent: {
      selectionExpressionSchemaContent: {
        fields: [
          { id: 'member_range', name: '用户范围', operators: ['in', 'notIn'], data_source: { type: 'select_staff', val: '' } },
          { id: 'place', name: '工作地点', operators: ['in', 'notIn'], data_source: { type: 'url', val: '/oapi/…/places/query' } },
        ],
        select_mode_options: ['all', 'part', 'null'],
        fallback_value: { mode: 'all' },
      },
    },
  };
  const payloadOf = (privileges: any[], scopeBiz: any[] = [{ bizId: 'vc', bizName: '视频会议' }]) =>
    ({ code: 0, data: { privileges, scopeBiz } });

  it('解析出条目、业务分类名与字段定义', () => {
    const state = extractOpenPlatformPrivileges(payloadOf([VC_PRIVILEGE]));
    expect(state.privileges).toHaveLength(1);
    const [p] = state.privileges;
    expect(p).toMatchObject({
      bizId: 'vc', resource: 'meeting.meetingid', name: '会议号查询会议信息',
      bizName: '视频会议', isRequired: true, content: '', schemaType: 1, organizationType: 1,
    });
    expect(p.fields).toEqual([{ id: 'owner_scope', name: '会议的归属者', selectStaff: true, supportsIn: true }]);
  });

  it('字段定义缺结构化那份时回退解析原始 schema 字符串', () => {
    // 线上响应同时给 schemaContent（已解析）和 schema（JSON 字符串，内层 key 首字母
    // 大写）。前者不保证一直在，回退路径必须真能解析出字段——否则会静默降级成
    // 「没有字段」→ 整条跳过 → 又变回从不配置。
    const { schemaContent, ...withoutStructured } = VC_PRIVILEGE as any;
    const state = extractOpenPlatformPrivileges(payloadOf([{
      ...withoutStructured,
      schema: JSON.stringify({
        biz_id: 'vc',
        schema_content: {
          SelectionExpressionSchemaContent: schemaContent.selectionExpressionSchemaContent,
        },
      }),
    }]));
    expect(state.privileges[0].fields)
      .toEqual([{ id: 'owner_scope', name: '会议的归属者', selectStaff: true, supportsIn: true }]);
    expect(canFillPrivilegeWithAppAvailability(state.privileges[0])).toBe(true);
  });

  it('只对「SelectionExpression + 内部组织 + 全字段可选人」放行', () => {
    const fill = (p: any) =>
      canFillPrivilegeWithAppAvailability(extractOpenPlatformPrivileges(payloadOf([p])).privileges[0]);
    expect(fill(VC_PRIVILEGE)).toBe(true);
    // 混了非选人字段（工作地点）——availability_of_app 是成员范围语义，塞不进去。
    expect(fill(DLP_PRIVILEGE)).toBe(false);
    // console 的两个判据各自都是必要条件。
    expect(fill({ ...VC_PRIVILEGE, schemaType: 3 })).toBe(false);
    expect(fill({ ...VC_PRIVILEGE, organizationType: 2 })).toBe(false);
    // 没有字段定义 → 不猜。
    expect(fill({ ...VC_PRIVILEGE, schemaContent: { selectionExpressionSchemaContent: { fields: [] } } })).toBe(false);
    // 字段不支持「包含」(in) → 不猜。
    expect(fill({
      ...VC_PRIVILEGE,
      schemaContent: {
        selectionExpressionSchemaContent: {
          fields: [{ id: 'owner_scope', name: 'x', operators: ['notIn'], data_source: { type: 'select_staff' } }],
        },
      },
    })).toBe(false);
  });

  it('content 与 console 手工配置的结果逐字节相同', () => {
    // 基准串取自**线上一个由人在 console 上手点「与应用的可用范围一致」的应用**，
    // 原样粘过来。自己写的 builder 与它逐字节一致，才说明我们没在猜格式。
    const CONSOLE_WRITTEN = '{"biz_id":"vc","mode":"part","resource":"meeting.meetingid","filters":[{"field":"owner_scope","value":"[{\\"mode\\":\\"availability_of_app\\",\\"members\\":[],\\"departments\\":[],\\"groups\\":[]}]","operator":"in"}],"expression":"1","description":"视频会议 - 会议号查询会议信息\\n\\t会议的归属者 包含 与应用的可用范围一致 \\n"}';
    const [p] = extractOpenPlatformPrivileges(payloadOf([VC_PRIVILEGE])).privileges;
    expect(buildPrivilegeAppAvailabilityContent(p)).toBe(CONSOLE_WRITTEN);
  });

  it('多字段时逐字段生成 filter，expression 用 1-based 序号 and 连接', () => {
    const [p] = extractOpenPlatformPrivileges(payloadOf([{
      ...VC_PRIVILEGE,
      schemaContent: {
        selectionExpressionSchemaContent: {
          fields: [
            { id: 'a', name: '甲', operators: ['in'], data_source: { type: 'select_staff' } },
            { id: 'b', name: '乙', operators: ['in'], data_source: { type: 'select_staff' } },
          ],
        },
      },
    }])).privileges;
    const parsed = JSON.parse(buildPrivilegeAppAvailabilityContent(p));
    expect(parsed.filters.map((f: any) => f.field)).toEqual(['a', 'b']);
    expect(parsed.expression).toBe('1 and 2');
    // filter value 是**再套一层 JSON 字符串**的数组，不是对象——写错这层服务端不报错，
    // 但 console 上会显示成未配置。
    expect(JSON.parse(parsed.filters[0].value)).toEqual([
      { mode: 'availability_of_app', members: [], departments: [], groups: [] },
    ]);
  });

  it('只挑「isRequired 且还没收敛」的，已收敛到具体范围的一律不覆盖', () => {
    const state = extractOpenPlatformPrivileges(payloadOf([
      VC_PRIVILEGE,
      // 非必填 → console 自己的 gate 也不强制，不碰。
      { ...VC_PRIVILEGE, resource: 'meeting.participant', isRequired: false },
      // 已经收敛到具体范围 → 可能是人手精心配的，覆盖它比不配更糟。
      { ...VC_PRIVILEGE, resource: 'vc.record', content: '{"mode":"part","filters":[{"field":"owner_scope","value":"[]","operator":"in"}]}' },
      // 必填但不可自动填 → 留给人手配。
      DLP_PRIVILEGE,
    ]));
    expect(selectPrivilegesNeedingAppAvailability(state).map(p => p.resource))
      .toEqual(['meeting.meetingid']);
  });

  /**
   * 🔴 生产回归（live 实测发现）：「一键创建智能体」模板建出来的应用，这两条数据
   * 范围**出生就带 `{"mode":"all"}`**（console 上显示选中「全部」）——正是审批规则里
   * 要补充理由、视情况加签至 CEO-2 的那一档。
   *
   * 第一版守卫写的是「有 content 就算配过、不覆盖」（本意是别覆盖人手配的范围），
   * 而模板塞的默认值刚好满足「有 content」⟹ 被当成用户的选择跳过，
   * `privilegeRangeCount` 恒为 0，整个改动空转。下面两个 fixture 是**线上抓下来的
   * 原文**，不是构造的。
   */
  const TEMPLATE_DEFAULT_ALL_VC = {
    ...VC_PRIVILEGE,
    privilegeStatus: 2,
    // 线上原文。`\n` 必须是 JSON 里的转义序列（`\\n` 在 JS 源码里），不是真换行——
    // 真换行会让这串不是合法 JSON，从而走进「读不懂 → 保守视为已配置」的分支，
    // 把这个测试变成假绿。
    content: '{"biz_id":"vc","resource":"meeting.meetingid","mode":"all","description":"视频会议 - 会议号查询会议信息\\n\\t全部\\n"}',
  };

  it('模板默认的 mode:"all" 视为待收窄（不是"已配置"）', () => {
    const state = extractOpenPlatformPrivileges(payloadOf([TEMPLATE_DEFAULT_ALL_VC]));
    expect(isPrivilegeRangeNarrowed(state.privileges[0])).toBe(false);
    // 这一条是整个改动的成败所在：漏了它，新建 bot 永远带「全部」提审。
    expect(selectPrivilegesNeedingAppAvailability(state).map(p => p.resource))
      .toEqual(['meeting.meetingid']);
    // 收窄后的目标形态：按条件筛选 + 与应用的可用范围一致。
    const rewritten = JSON.parse(buildPrivilegeAppAvailabilityContent(state.privileges[0]));
    expect(rewritten.mode).toBe('part');
    expect(JSON.parse(rewritten.filters[0].value)[0].mode).toBe('availability_of_app');
  });

  it('已收敛的判据是「mode 不是 all」，不是「content 非空」', () => {
    const narrowed = (content: string) =>
      isPrivilegeRangeNarrowed(extractOpenPlatformPrivileges(payloadOf([{ ...VC_PRIVILEGE, content }])).privileges[0]);
    expect(narrowed('')).toBe(false);                                  // 未配置
    expect(narrowed('{"mode":"all"}')).toBe(false);                    // 模板默认「全部」
    expect(narrowed('{"mode":""}')).toBe(false);                       // 空 mode 同样不算收敛
    expect(narrowed('{"resource":"x"}')).toBe(false);                  // mode 整个缺失
    expect(narrowed('{"mode":"null"}')).toBe(false);                   // console 的「无」
    expect(narrowed('{"mode":"part","filters":[{"field":"owner_scope","value":"[]","operator":"in"}]}')).toBe(true);
    // 我们自己写过的也算收敛 —— 重复跑权限自愈不该反复重写同一条。
    expect(narrowed(buildPrivilegeAppAvailabilityContent(
      extractOpenPlatformPrivileges(payloadOf([VC_PRIVILEGE])).privileges[0]))).toBe(true);
    // content 存在但读不懂 → 保守视为已配置：覆盖一个读不懂的值风险更大。
    expect(narrowed('{oops')).toBe(true);
  });

  /**
   * 与 console 自己的「是否配置好」谓词 `XC()` 对齐：它要求
   * `mode === 'all' || (Array.isArray(filters) && filters.length > 0)`。
   * 也就是说 `mode:'part'` 但 filters 为空，在 console 眼里**不算配置好**（UI 上显示
   * 「暂未配置筛选条件」）。这是又一个「看着配过、其实是空的」中间态——放过它就是
   * 重犯 `mode:"all"` 那个空转 bug 的同类错误。
   */
  it('mode:part 但 filters 为空同样视为未收敛（对齐 console 的 XC()）', () => {
    const state = extractOpenPlatformPrivileges(payloadOf([{
      ...VC_PRIVILEGE,
      content: '{"biz_id":"vc","mode":"part","resource":"meeting.meetingid","filters":[],"expression":""}',
    }]));
    expect(isPrivilegeRangeNarrowed(state.privileges[0])).toBe(false);
    expect(selectPrivilegesNeedingAppAvailability(state).map(p => p.resource)).toEqual(['meeting.meetingid']);
  });

  it('写入 payload 只带本次要填的条目，并保留原始字段', () => {
    const state = extractOpenPlatformPrivileges(payloadOf([VC_PRIVILEGE, DLP_PRIVILEGE]));
    const payload = buildPrivilegeUpdatePayload('cli_x', selectPrivilegesNeedingAppAvailability(state));
    expect(payload.clientId).toBe('cli_x');
    // 增量合并语义（实测：服务端按 (bizId,resource) 合并）——不必回传全部条目。
    expect(payload.privileges).toHaveLength(1);
    const [entry] = payload.privileges as any[];
    expect(entry.content).toBe(buildPrivilegeAppAvailabilityContent(state.privileges[0]));
    // 原始字段原样回传：服务端还会读 schema / privilegeStatus 等，丢了它们就等于
    // 拿一个残缺条目去覆盖。
    expect(entry).toMatchObject({
      bizId: 'vc', resource: 'meeting.meetingid', isRequired: true, privilegeStatus: 3,
      schemaType: 1, organizationType: 1,
    });
    expect(entry.schemaContent).toEqual(VC_PRIVILEGE.schemaContent);
  });

  it('没有待填的条目时一个写请求都不发', () => {
    const state = extractOpenPlatformPrivileges(payloadOf([DLP_PRIVILEGE]));
    expect(selectPrivilegesNeedingAppAvailability(state)).toEqual([]);
  });

  it('响应结构异常/为空时安全降级为「没有条目」', () => {
    expect(extractOpenPlatformPrivileges(null).privileges).toEqual([]);
    expect(extractOpenPlatformPrivileges({ code: 0 }).privileges).toEqual([]);
    expect(extractOpenPlatformPrivileges({ data: { privileges: 'nope' } }).privileges).toEqual([]);
    // 缺 bizId 就拼不出合并键，写回去也定位不到条目 → 丢弃而不是硬塞。
    expect(extractOpenPlatformPrivileges(payloadOf([{ resource: 'x', isRequired: true }])).privileges).toEqual([]);
    // schema 不是合法 JSON → 当作没有字段，由 canFill… 跳过，不抛。
    const bad = extractOpenPlatformPrivileges(payloadOf([{ ...VC_PRIVILEGE, schemaContent: undefined, schema: '{oops' }]));
    expect(bad.privileges[0].fields).toEqual([]);
    expect(canFillPrivilegeWithAppAvailability(bad.privileges[0])).toBe(false);
  });

  /**
   * 上面全是纯函数。这里跑**真实的 automation**，验证接线本身：请求真的发出去了、
   * 落在 `app_version/create` 之前（否则本次发版仍带「未配置」提审，等于没修）、
   * 失败时不阻塞建 bot。纯函数全绿但没接上线，是这类改动最典型的空转。
   */
  it('automation 真的发出 privilege/update，且在发版之前', async () => {
    const run = async (label: string, opts: { privilegeAll?: unknown; failRead?: boolean; failWrite?: boolean }) => {
      const dir = mkdtempSync(join(tmpdir(), `privrange-${label}-`));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = openPlatformSubscriptionMock('cli_p');
      const calls: string[] = [];
      const writes: any[] = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/app/cli_p/auth')) return new Response('<script>window.csrfToken="c"</script>', { status: 200 });
        const path = href.replace(/^https:\/\/[^/]+/, '');
        if (path.startsWith('/developers/')) calls.push(path);
        if (path.includes('/scope/all/')) {
          return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
        }
        if (path.includes('/privilege/all/')) {
          if (opts.failRead) return Response.json({ code: 1, msg: 'privilege read denied' });
          return Response.json(opts.privilegeAll ?? payloadOf([VC_PRIVILEGE]));
        }
        if (path.includes('/privilege/update/')) {
          if (opts.failWrite) return Response.json({ code: 1, msg: 'privilege write rejected' });
          writes.push(JSON.parse(String(init?.body)));
          return Response.json({ code: 0 });
        }
        if (path.includes('/app_version/list/')) return Response.json({ code: 0, data: { versions: [{ appVersion: '1.0.0' }] } });
        if (path.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;
      const r = await automateOpenPlatformSetup({
        appId: 'cli_p', sessionFilePath: sessionFile, fetchImpl, disableQrLogin: true,
        scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      });
      expect(r.ok, `${label}: ok=false reason=${(r as any).reason}`).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      return { calls, writes, count: r.privilegeRangeCount, warning: r.privilegeRangeWarning };
    };

    // ① 有待配的 → 写请求发出，内容是「与应用的可用范围一致」
    const applied = await run('applied', {});
    expect(applied.count).toBe(1);
    expect(applied.warning).toBeUndefined();
    expect(applied.writes).toHaveLength(1);
    expect(applied.writes[0].clientId).toBe('cli_p');
    expect(JSON.parse(applied.writes[0].privileges[0].content).filters[0].value)
      .toContain('availability_of_app');
    // 顺序判据：数据范围必须在**本次发版之前**写完，否则这一版仍带「未配置」提审。
    const writeAt = applied.calls.findIndex(p => p.includes('/privilege/update/'));
    const versionAt = applied.calls.findIndex(p => p.includes('/app_version/create/'));
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(versionAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeLessThan(versionAt);
    // 也必须在 scope/update 之后：权限点还没进清单时，它带的数据范围条目也还不在。
    expect(applied.calls.findIndex(p => p.includes('/scope/update/'))).toBeLessThan(writeAt);

    // ② 没有待配的 → 一个写请求都不发，且 count=0 不带 warning（调用方据此区分成因）
    const noop = await run('noop', { privilegeAll: payloadOf([DLP_PRIVILEGE]) });
    expect(noop.writes).toEqual([]);
    expect(noop.calls.some(p => p.includes('/privilege/update/'))).toBe(false);
    expect({ count: noop.count, warned: Boolean(noop.warning) }).toEqual({ count: 0, warned: false });

    // ③ 读失败 / ④ 写失败 → 非致命：ok:true 照常发版建 bot，但 count=0 且**带
    //    warning**，与②明确可区分（不带 warning 会被读成「本来就没有待配的」）。
    for (const [label, opts] of [['read-fail', { failRead: true }], ['write-fail', { failWrite: true }]] as const) {
      const failed = await run(label, opts);
      expect({ label, count: failed.count, warned: Boolean(failed.warning) })
        .toEqual({ label, count: 0, warned: true });
      expect(failed.calls.some(p => p.includes('/app_version/create/')), `${label}: 仍应发版`).toBe(true);
    }
  });
});

/**
 * 未提交审核的草稿会**永久**卡死权限自愈。线上实测：3 台 bot 各自留下一个
 * `versionStatus=0` 的草稿后，`app_version/create` 每次都回
 * `code=10043 版本已创建，请刷新`，于是每次 daemon 重启都重跑一遍必败请求、
 * 重发一遍「缺 N 项权限」的 DM（一天各 5 次，其中一台还是别人的 bot）。
 */
describe('未提交草稿卡死发版', () => {
  const versionsPayload = (versions: Array<Record<string, unknown>>) =>
    ({ code: 0, data: { Head: { RespFormat: 0 }, versions } });

  it('findUncommittedDraftVersionId 只认草稿(0)，绝不碰审核中(1)/已上线(2,100)', () => {
    // console 与公开 API 的枚举不一样（实测对照：console 0/1/2/100 ↔ 公开 4/3/1/1）。
    // 这里读的是 console 的 versionStatus。
    expect(findUncommittedDraftVersionId(versionsPayload([
      { appVersion: '1.0.1', versionId: 'draft-1', versionStatus: 0 },
      { appVersion: '1.0.0', versionId: 'live-1', versionStatus: 2 },
    ]))).toBe('draft-1');

    // 🔴 最关键的边界：审核中的版本是别人真的提交上去、正在排队的东西。自动流程
    // 去动它等于把人家的审批干掉——线上就有 2 台处于审核中且不属于本机 owner。
    expect(findUncommittedDraftVersionId(versionsPayload([
      { appVersion: '1.0.5', versionId: 'in-review', versionStatus: 1 },
      { appVersion: '1.0.4', versionId: 'live-1', versionStatus: 2 },
    ]))).toBeUndefined();

    // 全是历史已上线 → 没有草稿，走正常建版本
    expect(findUncommittedDraftVersionId(versionsPayload([
      { appVersion: '1.0.1', versionId: 'a', versionStatus: 100 },
      { appVersion: '1.0.0', versionId: 'b', versionStatus: 2 },
    ]))).toBeUndefined();
    // 畸形/空 → undefined，不抛
    expect(findUncommittedDraftVersionId(versionsPayload([]))).toBeUndefined();
    expect(findUncommittedDraftVersionId({ code: 0 })).toBeUndefined();
    expect(findUncommittedDraftVersionId(null)).toBeUndefined();
    // 草稿但没有 versionId → 拼不出合并键，当作没有
    expect(findUncommittedDraftVersionId(versionsPayload([{ appVersion: '1.0.1', versionStatus: 0 }]))).toBeUndefined();
  });

  it('isVersionCommitted：仍是草稿=false，已提交=true，查不到=false(保守)', () => {
    const payload = versionsPayload([
      { appVersion: '1.0.2', versionId: 'still-draft', versionStatus: 0 },
      { appVersion: '1.0.1', versionId: 'in-review', versionStatus: 1 },
      { appVersion: '1.0.0', versionId: 'live', versionStatus: 2 },
    ]);
    expect(isVersionCommitted(payload, 'still-draft')).toBe(false);
    expect(isVersionCommitted(payload, 'in-review')).toBe(true);
    expect(isVersionCommitted(payload, 'live')).toBe(true);
    // 查不到就是无法证明它已提交 → false。宁可多一句 warning，也别重复
    // 「拿 code=0 当已发布」那个错。
    expect(isVersionCommitted(payload, 'who-knows')).toBe(false);
    expect(isVersionCommitted({ code: 0 }, 'x')).toBe(false);
  });

  /**
   * 接线验证：纯函数全绿但没接上线是这类改动最典型的空转，所以这里跑**真实的
   * automation**，并让 `app_version/create` 像线上那样对草稿存在的情况回 10043。
   */
  it('automation 撞上草稿时提交草稿而不是建新版本(10043 不再发生)', async () => {
    const run = async (label: string, opts: {
      versions: Array<Record<string, unknown>>;
      /** commit 后回读时该版本是否已离开草稿态 */
      commitTakesEffect?: boolean;
    }) => {
      const dir = mkdtempSync(join(tmpdir(), `draft-${label}-`));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = openPlatformSubscriptionMock('cli_d');
      const calls: string[] = [];
      let committed: string | undefined;
      let created: string | undefined;
      let listCount = 0;
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/app/cli_d/auth')) return new Response('<script>window.csrfToken="c"</script>', { status: 200 });
        const path = href.replace(/^https:\/\/[^/]+/, '');
        if (path.startsWith('/developers/')) calls.push(path);
        if (path.includes('/scope/all/')) {
          return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
        }
        if (path.includes('/privilege/all/')) return Response.json({ code: 0, data: { privileges: [], scopeBiz: [] } });
        if (path.includes('/app_version/list/')) {
          listCount += 1;
          // 第二次 list 是 commit 后的回读。真实的开放平台会把刚建的版本也列出来，
          // 所以这里必须把 created 的版本并进列表——不然回读查不到它，
          // isVersionCommitted 会保守判 false，测出来的失败是**夹具的**、不是代码的。
          const listed = [...opts.versions, ...(created ? [{ appVersion: '1.0.2', versionId: created, versionStatus: 0 }] : [])];
          if (listCount > 1 && committed && opts.commitTakesEffect !== false) {
            return Response.json(versionsPayload(listed.map(v =>
              (v.versionId === committed ? { ...v, versionStatus: 2 } : v))));
          }
          return Response.json(versionsPayload(listed));
        }
        if (path.includes('/app_version/create/')) {
          // 线上真实行为：存在未提交草稿时，建版本一律被拒。
          if (opts.versions.some(v => v.versionStatus === 0)) {
            return Response.json({ code: 10043, msg: '版本已创建，请刷新' });
          }
          created = 'v-new';
          return Response.json({ code: 0, data: { versionId: 'v-new' } });
        }
        if (path.includes('/publish/commit/')) {
          committed = path.split('/').pop();
          return Response.json({ code: 0, data: { isOk: true } });
        }
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;
      const r = await automateOpenPlatformSetup({
        appId: 'cli_d', sessionFilePath: sessionFile, fetchImpl, disableQrLogin: true,
        scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      });
      return { r, calls, committed };
    };

    // ① 有草稿 → 直接提交它，**一次 create 都不发**（所以永远撞不到 10043）
    const withDraft = await run('with-draft', {
      versions: [
        { appVersion: '1.0.1', versionId: 'draft-1', versionStatus: 0 },
        { appVersion: '1.0.0', versionId: 'live-1', versionStatus: 2 },
      ],
    });
    expect(withDraft.r.ok, `ok=false reason=${(withDraft.r as any).reason} msg=${(withDraft.r as any).message}`).toBe(true);
    expect(withDraft.calls.some(p => p.includes('/app_version/create/')), '有草稿时不该建新版本').toBe(false);
    expect(withDraft.committed).toBe('draft-1');
    if (withDraft.r.ok) {
      expect(withDraft.r.versionId).toBe('draft-1');
      expect(withDraft.r.versionReused).toBe(true);
      expect(withDraft.r.versionWarning).toBeUndefined();
    }

    // ② 无草稿 → 原样建新版本并提交（不改既有行为）
    const noDraft = await run('no-draft', {
      versions: [{ appVersion: '1.0.0', versionId: 'live-1', versionStatus: 2 }],
    });
    expect(noDraft.r.ok).toBe(true);
    expect(noDraft.calls.some(p => p.includes('/app_version/create/'))).toBe(true);
    expect(noDraft.committed).toBe('v-new');
    if (noDraft.r.ok) {
      expect(noDraft.r.versionId).toBe('v-new');
      expect(noDraft.r.versionReused).toBe(false);
      expect(noDraft.r.versionWarning).toBeUndefined();
    }

    // ③ commit 返回 code=0 但版本仍是草稿 → **不许**宣称已发布，必须带 versionWarning。
    //    这正是线上那条假日志（"version …098 published" 而它其实是草稿）的成因。
    const silentNoop = await run('silent-noop', {
      versions: [
        { appVersion: '1.0.1', versionId: 'draft-1', versionStatus: 0 },
        { appVersion: '1.0.0', versionId: 'live-1', versionStatus: 2 },
      ],
      commitTakesEffect: false,
    });
    expect(silentNoop.r.ok).toBe(true);
    if (silentNoop.r.ok) {
      expect(silentNoop.r.versionWarning, 'commit 空转必须带 warning').toBeTruthy();
      expect(silentNoop.r.versionWarning).toMatch(/草稿|未提交/);
    }
  });

  /**
   * 审核中（`code=10046 审核中, 请刷新`）是**另一种**永久空转，与草稿的 10043 无关：
   * 审核期间开放平台把应用配置整体写锁（实测 `scope/update` / `robot/switch` /
   * `safe_setting/update` / `base_info` 全拒，读接口照常），历史行为把它当普通
   * api_error 硬失败，于是每次重启重跑整条链路 + 反复提示（线上两台各撞 8 次），
   * 而正确处置是**等审批通过**——它会自己好。
   */
  it('应用审核中(10046) 单独归因，不当成配置错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'under-review-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_r');
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/app/cli_r/auth')) return new Response('<script>window.csrfToken="c"</script>', { status: 200 });
      const path = href.replace(/^https:\/\/[^/]+/, '');
      if (path.startsWith('/developers/')) calls.push(path);
      if (path.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (path.includes('/privilege/all/')) return Response.json({ code: 0, data: { privileges: [], scopeBiz: [] } });
      // 审核中：所有写操作被拒（这里覆盖到本函数第一个撞上它的写：robot/switch）
      if (/\/(scope|privilege|safe_setting)\/update\/|\/robot\/switch\/|\/base_info\//.test(path)) {
        return Response.json({ code: 10046, msg: '审核中, 请刷新' });
      }
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;
    const r = await automateOpenPlatformSetup({
      appId: 'cli_r', sessionFilePath: sessionFile, fetchImpl, disableQrLogin: true,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    // 独立 reason：调用方靠它区分「等就行」和「真的配错了」。归到 api_error 时
    // 上层只会反复报「开放平台 API 错误」并把权限深链推给管理员——而审核期间那些
    // 链接点了也写不进去，是**错误建议**。
    expect(r.reason).toBe('app_under_review');
    expect(r.message).toMatch(/审核中/);
    // 不该在审核中还去建版本/发布：这一步之后的写操作都会被同样拒掉
    expect(calls.some(p => p.includes('/app_version/create/'))).toBe(false);
    expect(calls.some(p => p.includes('/publish/commit/'))).toBe(false);
  });

  /**
   * 撤回审核中版本：端点 `publish/cancel_commit/<appId>/<versionId>` 是从 console
   * 实测抓来的（版本详情页 Withdraw 按钮），不是猜的。
   */
  it('findInReviewVersionId 只认审核中(1)，不碰草稿(0)/已上线(2,100)', () => {
    const payload = (versions: Array<Record<string, unknown>>) =>
      ({ code: 0, data: { versions } });
    expect(findInReviewVersionId(payload([
      { appVersion: '1.0.5', versionId: 'rev-1', versionStatus: 1 },
      { appVersion: '1.0.4', versionId: 'live-1', versionStatus: 2 },
    ]))).toBe('rev-1');
    // 草稿不该走撤回路径——它要的是 commit（见上一个 describe），撤回会白烧一次不可逆操作
    expect(findInReviewVersionId(payload([
      { appVersion: '1.0.1', versionId: 'draft-1', versionStatus: 0 },
      { appVersion: '1.0.0', versionId: 'live-1', versionStatus: 2 },
    ]))).toBeUndefined();
    expect(findInReviewVersionId(payload([
      { appVersion: '1.0.1', versionId: 'a', versionStatus: 100 },
    ]))).toBeUndefined();
    expect(findInReviewVersionId(payload([]))).toBeUndefined();
    expect(findInReviewVersionId(null)).toBeUndefined();
  });

  it('cancelPendingReviewVersion 打对端点，并回读确认真的撤了', async () => {
    // ① 正常：撤回后回读已不在审核中
    const calls: Array<{ path: string; body: unknown }> = [];
    let cancelled = false;
    const okPost = async (path: string, body?: unknown) => {
      calls.push({ path, body });
      if (path.includes('/publish/cancel_commit/')) { cancelled = true; return { code: 0 }; }
      return { code: 0, data: { versions: cancelled
        ? [{ appVersion: '1.0.5', versionId: 'rev-1', versionStatus: 2 }]
        : [{ appVersion: '1.0.5', versionId: 'rev-1', versionStatus: 1 }] } };
    };
    await expect(cancelPendingReviewVersion(okPost, 'cli_w', 'rev-1')).resolves.toEqual({ ok: true });
    expect(calls[0]).toEqual({ path: '/developers/v1/publish/cancel_commit/cli_w/rev-1', body: {} });
    // 必须回读确认：`cancel_commit` 回 code=0 不等于状态真变了（publish/commit 已栽过一次）
    expect(calls[1].path).toBe('/developers/v1/app_version/list/cli_w');

    // ② code=0 但状态没变 → 判失败，别谎报撤回成功
    const noopPost = async (path: string) => path.includes('/publish/cancel_commit/')
      ? { code: 0 }
      : { code: 0, data: { versions: [{ appVersion: '1.0.5', versionId: 'rev-1', versionStatus: 1 }] } };
    const noop = await cancelPendingReviewVersion(noopPost, 'cli_w', 'rev-1');
    expect(noop.ok).toBe(false);
    expect(noop.message).toMatch(/仍是「审核中」/);

    // ③ 撤回请求本身报错 → 失败且带原因
    const failPost = async (path: string) => {
      if (path.includes('/publish/cancel_commit/')) throw new Error('code=10046 msg=审核中, 请刷新');
      return { code: 0, data: { versions: [] } };
    };
    const failed = await cancelPendingReviewVersion(failPost, 'cli_w', 'rev-1');
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/撤回审核中版本失败/);
  });

});

/**
 * 「提交后会不会秒过」的预判：`approval_nodes/get`。判据落在
 * `data.applyInstanceInfo.applyNodes` 的 `nodeType` 上。
 */
describe('审核中：不自动撤回，只带出节流用的 versionId', () => {
  /**
   * 🔴 自动撤回已删（前提被推翻：**触发审批说明有配置不合规**，撤回重提会被同一条规则
   * 再拦一次 ⟹ 用不可逆动作驱动死循环）。这里锁三件事：
   *   ① 一次 `publish/cancel_commit` 都不许发
   *   ② 带出 `inReviewVersionId` 供上层节流
   *   ③ 读版本列表失败时**不许**把 app_under_review 覆盖成别的 reason
   */
  const runUnderReview = async (label: string, opts: { versionListFails?: boolean; hasInReview?: boolean }) => {
    const dir = mkdtempSync(join(tmpdir(), `ur-${label}-`));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_ur');
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/app/cli_ur/auth')) return new Response('<script>window.csrfToken="c"</script>', { status: 200 });
      const path = href.replace(/^https:\/\/[^/]+/, '');
      if (path.startsWith('/developers/')) calls.push(path);
      if (path.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (path.includes('/privilege/all/')) return Response.json({ code: 0, data: { privileges: [], scopeBiz: [] } });
      // 写锁：robot/switch 抛 10046 → 走 under_review 分支
      if (/\/(scope|privilege|safe_setting)\/update\/|\/robot\/switch\//.test(path)) {
        return Response.json({ code: 10046, msg: '审核中, 请刷新' });
      }
      if (path.includes('/app_version/list/')) {
        if (opts.versionListFails) return Response.json({ code: 1, msg: 'list denied' });
        return Response.json({ code: 0, data: { versions: opts.hasInReview === false
          ? [{ appVersion: '1.0.0', versionId: 'live', versionStatus: 2 }]
          : [{ appVersion: '1.0.5', versionId: 'rev-1', versionStatus: 1 }] } });
      }
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;
    const r = await automateOpenPlatformSetup({
      appId: 'cli_ur', sessionFilePath: sessionFile, fetchImpl, disableQrLogin: true,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });
    return { r, calls };
  };

  it('🔴 一次 cancel_commit 都不发，并带出 inReviewVersionId 做节流 key', async () => {
    const { r, calls } = await runUnderReview('normal', {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('app_under_review');
    // ① 绝不自动撤回
    expect(calls.some(p => p.includes('/publish/cancel_commit/')), '不许自动撤回').toBe(false);
    // ② 带出节流 key
    expect(r.inReviewVersionId).toBe('rev-1');
    // 文案必须说清「不会自己通过」+ 给人工路径，不能说「等审批通过就好」
    expect(r.message).toMatch(/配置不合规/);
    expect(r.message).toMatch(/撤回/);
    expect(r.message).not.toMatch(/审批通过后 botmux 会在下次启动时自动补齐/);
  });

  it('没有待审版本时 inReviewVersionId 为空（上层据此不节流）', async () => {
    const { r } = await runUnderReview('none', { hasInReview: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('app_under_review');
    expect(r.inReviewVersionId).toBeUndefined();
  });

  it('🔴 读版本列表失败只丢 versionId，不许污染 app_under_review 这个主信号', async () => {
    // 分类是主信号，versionId 只是节流用的上下文；上下文取不到不能反过来把结论
    // 改成 network / api_error —— 那会让管理员收到完全错误的诊断。
    const { r } = await runUnderReview('list-fails', { versionListFails: true });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('app_under_review');
    expect(r.inReviewVersionId).toBeUndefined();
  });
});

describe('审批流程预判（秒过 vs 要人审）', () => {
  const flow = (nodes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    ({ code: 0, data: { applyInstanceInfo: { applyNodes: nodes }, ...extra } });
  const approver = (name: string) => ({ approver: { name, id: 'u1' } });

  it('全自动通过 + 零真人审批人 → autoApproved', () => {
    // 逐字复刻 Modern审核(Claude@cn1) 的线上返回形态
    const r = predictApprovalFlow(flow([
      { nodeName: '发起', nodeType: '', nodeUser: [approver('申晗')] },
      { nodeName: '仅协作者免审策略', nodeType: '自动通过', nodeUser: [] },
      { nodeName: '仅协作者免审抄送', nodeType: '', nodeCcUser: [approver('某抄送人')], nodeUser: [] },
      { nodeName: '结束', nodeType: '', nodeUser: [] },
    ], { canAutoApproval: false }));
    expect(r).toEqual({ known: true, autoApproved: true, humanApprovers: [] });
  });

  it('🔴 绝不能用同响应的 canAutoApproval 当判据（会判反）', () => {
    // 线上实测：Modern审核 是 canAutoApproval:false 而流程写着「自动通过」（上一个用例），
    // 另一台反而 canAutoApproval:true 却根本算不出流程。所以这个字段与「会不会秒过」
    // 无关——两个方向都钉一下，防止有人图省事改回去读它。
    const autoFalse = predictApprovalFlow(flow([
      { nodeName: '仅协作者免审策略', nodeType: '自动通过', nodeUser: [] },
    ], { canAutoApproval: false }));
    expect(autoFalse.autoApproved, 'canAutoApproval:false 不该压过节点里的「自动通过」').toBe(true);

    const autoTrue = predictApprovalFlow(flow([
      { nodeName: '安全审批', nodeType: '', nodeUser: [approver('某审批人')] },
    ], { canAutoApproval: true }));
    expect(autoTrue.autoApproved, 'canAutoApproval:true 不该压过真人审批人').toBe(false);
    expect(autoTrue.humanApprovers).toEqual(['某审批人']);
  });

  it('有真人审批关卡 → 不算秒过，并列出审批人（抄送人不算）', () => {
    const r = predictApprovalFlow(flow([
      { nodeName: '发起', nodeType: '', nodeUser: [approver('申晗')] },
      { nodeName: '数据安全审批', nodeType: '', nodeUser: [approver('审批人A'), approver('审批人B')] },
      { nodeName: '知会', nodeType: '', nodeCcUser: [approver('抄送人C')], nodeUser: [] },
      { nodeName: '结束', nodeType: '', nodeUser: [] },
    ]));
    expect(r.known).toBe(true);
    expect(r.autoApproved).toBe(false);
    // 抄送只知会、不阻塞；算进来会把本可自动提交的版本误判成要人工
    expect(r.humanApprovers).toEqual(['审批人A', '审批人B']);
  });

  it('自动通过与人工关卡混合 → 不算秒过（有一关要人就得等人）', () => {
    const r = predictApprovalFlow(flow([
      { nodeName: '免审策略', nodeType: '自动通过', nodeUser: [] },
      { nodeName: '安全复核', nodeType: '', nodeUser: [approver('审批人A')] },
    ]));
    expect(r.autoApproved).toBe(false);
    expect(r.humanApprovers).toEqual(['审批人A']);
  });

  it('空流程 / 结构不认识 → known:false，调用方必须 fail-closed', () => {
    // 空的正常成因是「没有待发布版本，无流程可算」——不是可以自动提交的意思。
    for (const payload of [flow([]), { code: 0, data: {} }, { code: 0 }, null, 'nonsense']) {
      const r = predictApprovalFlow(payload);
      expect({ known: r.known, auto: r.autoApproved }).toEqual({ known: false, auto: false });
    }
    // 只有「发起/结束」没有任何关卡 → 也判不出来（不能当秒过）
    const noGate = predictApprovalFlow(flow([
      { nodeName: '发起', nodeType: '', nodeUser: [approver('申晗')] },
      { nodeName: '结束', nodeType: '', nodeUser: [] },
    ]));
    expect(noGate.known).toBe(false);
    expect(noGate.autoApproved).toBe(false);
  });

  it('英文环境的 Auto approved / Initiate / End 同样认', () => {
    const r = predictApprovalFlow(flow([
      { nodeName: 'Initiate', nodeType: '', nodeUser: [approver('Shen Han')] },
      { nodeName: 'Collaborator-only auto policy', nodeType: 'Auto approved', nodeUser: [] },
      { nodeName: 'End', nodeType: '', nodeUser: [] },
    ]));
    expect(r).toEqual({ known: true, autoApproved: true, humanApprovers: [] });
  });

  it('fetchApprovalFlowPrediction 带全 body（只传 {} 会被开放平台拒 code=10001）', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const post = async (path: string, body?: unknown) => {
      calls.push({ path, body });
      return flow([{ nodeName: '免审策略', nodeType: '自动通过', nodeUser: [] }]);
    };
    const vis = {
      visibleSuggest: { departments: ['d1'], members: ['m1'], groups: [], isAll: 0 },
      blackVisibleSuggest: { departments: [], members: [], groups: [], isAll: 0 },
    };
    const r = await fetchApprovalFlowPrediction(post, 'cli_a', 'v9', vis);
    expect(r.autoApproved).toBe(true);
    expect(calls[0].path).toBe('/developers/v1/approval_nodes/get/cli_a');
    // 缺字段会被拒，所以逐个钉住
    expect(calls[0].body).toEqual({
      visibleSuggest: vis.visibleSuggest,
      blackVisibleSuggest: vis.blackVisibleSuggest,
      b2cShareSplitConfigSuggest: {
        b2cGroupChatShareEnable: false,
        b2cP2PChatShareEnable: false,
        b2cP2PChatNeedAudit: false,
      },
      versionId: 'v9',
      notCalculateFlow: false,
    });

    // 接口报错 → known:false + 原因，绝不冒充任一结论
    const boom = await fetchApprovalFlowPrediction(
      async () => { throw new Error('code=10001 msg=请求错误，请刷新页面后重试'); },
      'cli_a', 'v9', vis,
    );
    expect(boom.known).toBe(false);
    expect(boom.autoApproved).toBe(false);
    expect(boom.reason).toMatch(/10001/);
  });

  it('automation 在提交前查流程，并把秒过/要人审带回调用方', async () => {
    const run = async (label: string, nodes: Array<Record<string, unknown>>) => {
      const dir = mkdtempSync(join(tmpdir(), `flow-${label}-`));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = openPlatformSubscriptionMock('cli_f');
      const calls: string[] = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/app/cli_f/auth')) return new Response('<script>window.csrfToken="c"</script>', { status: 200 });
        const path = href.replace(/^https:\/\/[^/]+/, '');
        if (path.startsWith('/developers/')) calls.push(path);
        if (path.includes('/scope/all/')) {
          return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
        }
        if (path.includes('/privilege/all/')) return Response.json({ code: 0, data: { privileges: [], scopeBiz: [] } });
        if (path.includes('/approval_nodes/get/')) return Response.json(flow(nodes));
        if (path.includes('/app_version/list/')) {
          return Response.json({ code: 0, data: { versions: [{ appVersion: '1.0.0', versionId: 'live', versionStatus: 2 }] } });
        }
        if (path.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v-new' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;
      const r = await automateOpenPlatformSetup({
        appId: 'cli_f', sessionFilePath: sessionFile, fetchImpl, disableQrLogin: true,
        scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      });
      return { r, calls };
    };

    const auto = await run('auto', [{ nodeName: '免审策略', nodeType: '自动通过', nodeUser: [] }]);
    expect(auto.r.ok, `ok=false ${(auto.r as any).message}`).toBe(true);
    if (auto.r.ok) {
      expect(auto.r.approvalAutoPassed).toBe(true);
      expect(auto.r.approvalHumanApprovers).toBeUndefined();
    }
    // 顺序判据：查流程必须在 commit **之前**（提交后再查等于没用上）
    const flowAt = auto.calls.findIndex(p => p.includes('/approval_nodes/get/'));
    const commitAt = auto.calls.findIndex(p => p.includes('/publish/commit/'));
    expect(flowAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(flowAt);

    const manual = await run('manual', [{ nodeName: '安全审批', nodeType: '', nodeUser: [approver('审批人A')] }]);
    expect(manual.r.ok).toBe(true);
    if (manual.r.ok) {
      expect(manual.r.approvalAutoPassed).toBe(false);
      expect(manual.r.approvalHumanApprovers).toEqual(['审批人A']);
      // 要人审**照样提交**（既有行为不变），只是如实告知在等谁
      expect(manual.calls.some(p => p.includes('/publish/commit/'))).toBe(true);
    }
  });
});



describe('redirect 白名单读→合并→写', () => {
  /** postJson 桩：读接口返回 `read`（或抛错），写接口按 `writeResults` 顺序成功/失败。 */
  function stubPostJson(opts: {
    read?: unknown;
    readThrows?: boolean;
    writeErrors?: Array<Error | null>;
  }) {
    const reads: string[] = [];
    const writes: Array<{ path: string; body: any }> = [];
    let writeIndex = 0;
    const postJson = async (path: string, body?: unknown): Promise<unknown> => {
      if (path.includes('/safe_setting/update/')) {
        writes.push({ path, body });
        const err = (opts.writeErrors ?? [])[writeIndex++];
        if (err) throw err;
        return { code: 0 };
      }
      reads.push(path);
      if (opts.readThrows) throw new Error('safe_setting read endpoint missing');
      return opts.read;
    };
    return { postJson, reads, writes };
  }

  const readPayload = (redirectURL: unknown) => ({
    code: 0,
    data: { Head: { RespFormat: 0 }, allowRefreshToken: true, ipWhiteList: [], redirectURL, safeServerDomain: [] },
  });

  it('parses the live safe_setting shape and tells "empty list" apart from "unreadable"', () => {
    // 实测形态（feishu.cn 租户）：data.redirectURL 是字符串数组。
    expect(extractOpenPlatformRedirectUrls(readPayload([
      'http://127.0.0.1:9768/callback',
      'http://10.1.2.3:7891/oauth/callback',
    ]))).toEqual(['http://127.0.0.1:9768/callback', 'http://10.1.2.3:7891/oauth/callback']);
    // 未包 data 的扁平返回也认。
    expect(extractOpenPlatformRedirectUrls({ redirectURL: ['https://a.example.com/oauth/callback'] }))
      .toEqual(['https://a.example.com/oauth/callback']);
    // 去空白 + 去重 + 丢掉非字符串项。
    expect(extractOpenPlatformRedirectUrls(readPayload([' https://a/cb ', 'https://a/cb', 42, null])))
      .toEqual(['https://a/cb']);
    // 读到了、但线上一条都没配 → 空数组（可以放心合并）。
    expect(extractOpenPlatformRedirectUrls(readPayload([]))).toEqual([]);
    // 读不出来 → null（只能退化成覆盖写）。畸形与端点不存在都归到这一类。
    expect(extractOpenPlatformRedirectUrls(readPayload('not-an-array'))).toBeNull();
    expect(extractOpenPlatformRedirectUrls({ code: 0 })).toBeNull();
    expect(extractOpenPlatformRedirectUrls({ code: 0, data: {} })).toBeNull();
    expect(extractOpenPlatformRedirectUrls(null)).toBeNull();
    expect(extractOpenPlatformRedirectUrls('nonsense')).toBeNull();
  });

  it('merges with the live whitelist instead of overwriting the user\'s own entries', async () => {
    const stub = stubPostJson({ read: readPayload(['https://console.example.com/my-own-callback']) });
    const result = await writeRedirectWhitelist(stub.postJson, 'cli_x', [
      BOTMUX_REDIRECT_URL,
      'https://m-abc.example.com/oauth/callback',
    ]);

    expect(stub.reads).toEqual(['/developers/v1/safe_setting/cli_x']);
    expect(result.status).toBe('updated');
    expect(stub.writes).toHaveLength(1);
    // 用户自己配的那条必须原样留着——历史实现的全量覆盖会把它静默清掉。
    expect(stub.writes[0].body.redirectURL).toEqual([
      BOTMUX_REDIRECT_URL,
      'https://console.example.com/my-own-callback',
      'https://m-abc.example.com/oauth/callback',
    ]);
    expect(stub.writes[0].body.clientId).toBe('cli_x');
  });

  it('short-circuits without any write when every wanted URL is already live', async () => {
    const stub = stubPostJson({
      read: readPayload([BOTMUX_REDIRECT_URL, 'https://m-abc.example.com/oauth/callback', 'https://other/cb']),
    });
    const result = await writeRedirectWhitelist(stub.postJson, 'cli_x', [
      BOTMUX_REDIRECT_URL,
      'https://m-abc.example.com/oauth/callback',
    ]);

    expect(result.status).toBe('unchanged');
    expect(stub.writes).toEqual([]);
  });

  it('读不到线上现值时零写入，并回一条明确的 warning', async () => {
    const stub = stubPostJson({ readThrows: true });
    const result = await writeRedirectWhitelist(stub.postJson, 'cli_x', [
      BOTMUX_REDIRECT_URL,
      'https://m-abc.example.com/oauth/callback',
    ]);

    // safe_setting 是全量覆盖语义：读失败还照写 = 拿 botmux 自己那几条把用户
    // 手配的回调地址整批清掉。一次写请求都不许发。
    expect(stub.writes).toEqual([]);
    expect(result.status).toBe('skipped_unreadable');
    expect(result.existing).toBeNull();
    expect(result.redirectUrls).toEqual([]);
    expect(result.warning).toContain('读不到');
    expect(result.warning).toContain('未写入');
  });

  it('读接口返回体结构不认识（不是抛错）同样零写入', async () => {
    // 端点还在、HTTP 200，但没有可识别的 redirectURL 数组——一样属于「不知道线上有什么」。
    const stub = stubPostJson({ read: { code: 0, data: {} } });
    const result = await writeRedirectWhitelist(stub.postJson, 'cli_x', [BOTMUX_REDIRECT_URL]);

    expect(stub.writes).toEqual([]);
    expect(result.status).toBe('skipped_unreadable');
  });

  it('只有显式 allowBlindWrite（调用方能证明 app 刚创建）才允许读失败后覆盖写', async () => {
    const stub = stubPostJson({ readThrows: true });
    const result = await writeRedirectWhitelist(
      stub.postJson,
      'cli_x',
      [BOTMUX_REDIRECT_URL, 'https://m-abc.example.com/oauth/callback'],
      { allowBlindWrite: true },
    );

    // 刚建出来的应用白名单必然为空，覆盖不掉任何用户条目，这时才值得保住 botmux 自己的链路。
    expect(result.existing).toBeNull();
    expect(result.status).toBe('updated');
    expect(stub.writes).toHaveLength(1);
    expect(stub.writes[0].body.redirectURL).toEqual([
      BOTMUX_REDIRECT_URL,
      'https://m-abc.example.com/oauth/callback',
    ]);
  });

  it('网络类写失败不触发最小集兜底（重发只会再失败一次）', async () => {
    const networkError = new TypeError('fetch failed');
    (networkError as any).cause = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    const stub = stubPostJson({
      read: readPayload(['https://console.example.com/my-own-callback']),
      writeErrors: [networkError],
    });

    await expect(writeRedirectWhitelist(stub.postJson, 'cli_x', [
      BOTMUX_REDIRECT_URL,
      'https://m-abc.example.com/oauth/callback',
    ])).rejects.toThrow('fetch failed');
    // 最小集与被拒全集并不相同，历史实现会在这里再写一次；网络故障时那一次毫无意义。
    expect(stub.writes).toHaveLength(1);
  });

  it('403 写失败不触发最小集兜底，且原始 OpenPlatformApiError 原样抛出', async () => {
    const denied = new OpenPlatformApiError(
      'HTTP 403 /developers/v1/safe_setting/update/cli_x: code=10003',
      { code: 10003, msg: 'no permission' },
      403,
    );
    const stub = stubPostJson({
      read: readPayload(['https://console.example.com/my-own-callback']),
      writeErrors: [denied],
    });

    // 鉴权失败与「白名单里有条非法 URL」无关，改小再写一次同样会被拒。
    await expect(writeRedirectWhitelist(stub.postJson, 'cli_x', [
      BOTMUX_REDIRECT_URL,
      'https://m-abc.example.com/oauth/callback',
    ])).rejects.toBe(denied);
    expect(stub.writes).toHaveLength(1);
  });

  it('retries once with the minimal set when the merged write is rejected', async () => {
    const stub = stubPostJson({
      read: readPayload(['https://console.example.com/my-own-callback']),
      writeErrors: [new Error('code=1 msg=invalid redirect url'), null],
    });
    const result = await writeRedirectWhitelist(stub.postJson, 'cli_x', [
      BOTMUX_REDIRECT_URL,
      'http://badly-formatted-host/oauth/callback',
    ]);

    expect(result.status).toBe('updated_fallback');
    expect(stub.writes).toHaveLength(2);
    // 兜底集 = 线上现值 ∪ 127.0.0.1：保住核心那条，同时仍不删用户的。
    expect(stub.writes[1].body.redirectURL).toEqual([
      BOTMUX_REDIRECT_URL,
      'https://console.example.com/my-own-callback',
    ]);
  });

  it('does not resend an identical payload when the minimal set equals the rejected one', async () => {
    const stub = stubPostJson({
      read: readPayload([]),
      writeErrors: [new Error('code=1 msg=rejected')],
    });

    await expect(writeRedirectWhitelist(stub.postJson, 'cli_x', [BOTMUX_REDIRECT_URL]))
      .rejects.toThrow('rejected');
    expect(stub.writes).toHaveLength(1);
  });

  // ── redirect 完整性判据（automation 与批量修复共用同一个纯函数）─────────────
  describe('missingRedirectUrls', () => {
    it('按落盘结果逐条核对 wanted，不看 status', () => {
      // 全落盘（顺序无关、线上多出的条目无所谓）→ 一条不缺。
      expect(missingRedirectUrls(
        [BOTMUX_REDIRECT_URL, 'https://a.example.com/oauth/callback'],
        ['https://a.example.com/oauth/callback', 'https://user-own/cb', BOTMUX_REDIRECT_URL],
      )).toEqual([]);
      // 最小集兜底的典型形态：wanted 里超出「线上现值 ∪ 本机回调」的那条被丢了。
      expect(missingRedirectUrls(
        [BOTMUX_REDIRECT_URL, 'https://a.example.com/oauth/callback'],
        [BOTMUX_REDIRECT_URL, 'https://user-own/cb'],
      )).toEqual(['https://a.example.com/oauth/callback']);
      // 一次写请求都没发（skipped_unreadable 的 redirectUrls）→ wanted 全缺。
      expect(missingRedirectUrls([BOTMUX_REDIRECT_URL], [])).toEqual([BOTMUX_REDIRECT_URL]);
      // 空白 / 重复条目不该被算成「缺了一条」。
      expect(missingRedirectUrls([BOTMUX_REDIRECT_URL, BOTMUX_REDIRECT_URL, ''], [BOTMUX_REDIRECT_URL])).toEqual([]);
    });
  });

  // ── 兜底重写的判据：主题词 AND 拒绝词双命中 ─────────────────────────────────
  // 历史实现是一张 OR 关键词表，任一命中就再改一次线上安全设置；下面三条负例在旧
  // 判据下都会误触发第二次写。
  const rejectedByConsole = (err: unknown) => stubPostJson({
    // 现值与 wanted 都非空，最小集 ≠ 全集：兜底一旦触发就一定看得到第二次写。
    read: readPayload(['https://console.example.com/my-own-callback']),
    writeErrors: [err],
  });
  const twoWanted = [BOTMUX_REDIRECT_URL, 'https://m-abc.example.com/oauth/callback'];

  it('URL 格式类拒绝（中英）才触发一次最小集兜底', async () => {
    for (const msg of [
      'code=1 msg=redirect url format invalid',
      'code=1 msg=重定向 URL 非法',
      // 复数形态仍算主题命中（词边界允许结尾一个 s），否则这类文案会白白丢掉兜底。
      'code=1 msg=one of the urls is invalid',
    ]) {
      const stub = rejectedByConsole(new Error(msg));
      const result = await writeRedirectWhitelist(stub.postJson, 'cli_x', twoWanted);
      expect(result.status).toBe('updated_fallback');
      expect(stub.writes).toHaveLength(2);
    }
  });

  it.each([
    // 实测误触发场景：只有拒绝词「invalid」，说的根本不是 URL。
    ['400 invalid csrf token', new OpenPlatformApiError('invalid csrf token', { code: 1, msg: 'invalid csrf token' }, 400)],
    // ↓ 三条「词内片段」负例：英文关键词必须按独立单词匹配，裸 includes 全会误判成双命中。
    // security 里含主题词 uri + 拒绝词 invalid，说的却是令牌。
    ['security token invalid', new Error('code=1 msg=security token invalid')],
    // during 里含主题词 uri，说的是操作本身非法。
    ['invalid operation during request', new Error('code=1 msg=invalid operation during request')],
    // information 里含拒绝词 format；主题词 callback 虽真命中，但没有任何「被拒」的表述。
    ['callback information unavailable', new Error('code=1 msg=callback information unavailable')],
    // 主题词命中但属于限流：改小重发只会再吃一次限流。
    ['429 redirect rate limited', new OpenPlatformApiError('HTTP 429: redirect rate limited', { code: 1 }, 429)],
    // 限流 / 服务端故障优先于关键词：文案双命中也不能重写线上配置（否则限流时反而多打一次）。
    ['429 且文案双命中', new OpenPlatformApiError('HTTP 429: redirect url format invalid', { code: 1 }, 429)],
    ['503 且文案双命中', new OpenPlatformApiError('HTTP 503: redirect url format invalid', { code: 1 }, 503)],
    ['409 且文案双命中', new OpenPlatformApiError('HTTP 409: redirect url format invalid', { code: 1 }, 409)],
    // 只有拒绝词「not allowed」，与白名单写了什么无关。
    ['operation not allowed', new Error('code=1 msg=operation not allowed')],
  ])('不因 %s 触发二次写', async (_label, err) => {
    const stub = rejectedByConsole(err);
    await expect(writeRedirectWhitelist(stub.postJson, 'cli_x', twoWanted)).rejects.toBe(err);
    // 只发 1 次 update，也就不可能返回 updated_fallback（兜底那次才会产生它）。
    expect(stub.writes).toHaveLength(1);
  });

  it('collects every redirect base botmux knows about, loopback first', () => {
    const prevHome = process.env.HOME;
    const prevPublic = process.env.BOTMUX_PUBLIC_URL;
    // 两个不同的 HOME：readGlobalConfig 按路径缓存 2s，同一路径改文件读不到新值。
    const emptyHome = mkdtempSync(join(tmpdir(), 'botmux-redirect-home-a-'));
    const configuredHome = mkdtempSync(join(tmpdir(), 'botmux-redirect-home-b-'));
    mkdirSync(join(configuredHome, '.botmux'));
    writeFileSync(
      join(configuredHome, '.botmux', 'config.json'),
      JSON.stringify({ oauthRedirectBase: 'http://10.1.2.3:7891/' }),
    );
    try {
      // 空 HOME（没有 config.json / platform.json）+ 自建反代 → 只多出反代那条。
      process.env.HOME = emptyHome;
      process.env.BOTMUX_PUBLIC_URL = 'https://botmux.example.com/';
      expect(collectBotmuxRedirectUrls()).toEqual([
        BOTMUX_REDIRECT_URL,
        'https://botmux.example.com/oauth/callback',
      ]);

      // 手填的 oauthRedirectBase 也要进白名单（今天一条都没写进去，正是要手动粘贴的根因）。
      process.env.HOME = configuredHome;
      delete process.env.BOTMUX_PUBLIC_URL;
      expect(collectBotmuxRedirectUrls()).toEqual([
        BOTMUX_REDIRECT_URL,
        'http://10.1.2.3:7891/oauth/callback',
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevPublic === undefined) delete process.env.BOTMUX_PUBLIC_URL;
      else process.env.BOTMUX_PUBLIC_URL = prevPublic;
    }
  });
});

describe('prepareFeishuWebSession', () => {
  it('gets a new botmux session via built-in Feishu QR login and saves it privately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const qrPayloads: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        return Response.json(
          { code: 0, data: { step_info: { token: 'qr-token' } } },
          { headers: { 'x-flow-key': 'flow-key' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        return Response.json({
          code: 0,
          data: {
            next_step: 'enter_app',
            step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' },
          },
        });
      }
      if (href === 'https://accounts.feishu.cn/cross-login') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=secret-cookie-value; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: ({ qrPayload }) => qrPayloads.push(qrPayload),
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(qrPayloads).toEqual([JSON.stringify({ qrlogin: { token: 'qr-token' } })]);
    expect(readStoredCookiesFromSessionFile(sessionFile)?.map(c => c.name)).toContain('session');
    if (process.platform !== 'win32') {
      expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    }
  });

  it('emits a structured scan confirmation only after Feishu reports the exact QR as scanned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-scan-confirmation-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const confirmations: number[] = [];
    let pollingCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        return Response.json(
          { code: 0, data: { step_info: { token: 'qr-token' } } },
          { headers: { 'x-flow-key': 'flow-key' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        pollingCount += 1;
        if (pollingCount === 1) {
          return Response.json({
            code: 0,
            data: { next_step: null, step_info: { status: 2 } },
          });
        }
        return Response.json({
          code: 0,
          data: {
            next_step: 'enter_app',
            step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' },
          },
        });
      }
      if (href === 'https://accounts.feishu.cn/cross-login') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=secret-cookie-value; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      forceQrLogin: true,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: () => {},
      onQrScanConfirmed: ({ confirmedAt }) => confirmations.push(confirmedAt),
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(confirmations).toHaveLength(1);
    expect(Number.isInteger(confirmations[0])).toBe(true);
  });

  it('does not fabricate a scan confirmation when Feishu jumps directly to enter_app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-no-scan-confirmation-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const onQrScanConfirmed = vi.fn();
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        return Response.json(
          { code: 0, data: { step_info: { token: 'qr-token' } } },
          { headers: { 'x-flow-key': 'flow-key' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        return Response.json({
          code: 0,
          data: {
            next_step: 'enter_app',
            step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' },
          },
        });
      }
      if (href === 'https://accounts.feishu.cn/cross-login') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=secret-cookie-value; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      forceQrLogin: true,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: () => {},
      onQrScanConfirmed,
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(onQrScanConfirmed).not.toHaveBeenCalled();
  });

  it('forces a fresh QR login for onboarding even when a valid cache exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-force-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    let initCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        initCount++;
        return Response.json(
          { code: 0, data: { step_info: { token: 'fresh-token' } } },
          { headers: { 'x-flow-key': 'fresh-flow' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        return Response.json({
          code: 0,
          data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/fresh-cross' } },
        });
      }
      if (href === 'https://accounts.feishu.cn/fresh-cross') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=fresh-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      forceQrLogin: true,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: () => {},
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(initCount).toBe(1);
    expect(readStoredCookiesFromSessionFile(sessionFile)?.find(c => c.name === 'session')?.value).toBe('fresh-cookie');
  });

  it('can require cache-only reuse so follow-up setup never displays a second QR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-reuse-only-'));
    const onQrCode = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network must not be used without cached cookies');
    }) as unknown as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: join(dir, 'missing-session.json'),
      disableQrLogin: true,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode,
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onQrCode).not.toHaveBeenCalled();
  });

  it('uses old bytedcli session file only as fallback after built-in QR login fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const fallbackSessionFile = join(dir, 'bytedcli-feishu-session.json');
    writeFileSync(fallbackSessionFile, JSON.stringify({ cookies: [cookie()] }));
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) throw new Error('login down');
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      bytedcliFallbackSessionFilePath: fallbackSessionFile,
      fetchImpl,
      onQrCode: () => {},
    });

    expect(result.ok && result.source).toBe('bytedcli_fallback');
    expect(readStoredCookiesFromSessionFile(sessionFile)?.map(c => c.name)).toContain('session');
  });
});

describe('createFeishuOpenPlatformApp', () => {
  it('reuses one cached Web session to upload an icon, create/enable the bot, and read its secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-create-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: Array<{ path: string; body: unknown }> = [];
    let qrCount = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') {
        return new Response(openPlatformPage(), { status: 200 });
      }
      const path = new URL(href).pathname;
      calls.push({ path, body: init?.body });
      if (path === '/developers/v1/app/upload/image') {
        expect(init?.body).toBeInstanceOf(FormData);
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          appManifestTemplateID: 'developer_console',
          createAppUserCustomField: {
            i18n: { zh_cn: { name: 'botmux-4' } },
            avatar: 'https://cdn.example/botmux.png',
            primaryLang: 'zh_cn',
          },
        });
        expect(typeof body.cid).toBe('string');
        expect(body.cid.length).toBeGreaterThan(0);
        return Response.json({ code: 0, data: { clientID: 'cli_created' } });
      }
      if (path === '/developers/v1/app_version/create/cli_created') {
        return Response.json({ code: 0, data: { versionId: 'v-enable' } });
      }
      if (path === '/developers/v1/secret/cli_created') {
        return Response.json({ code: 0, data: { secret: 'created-secret' } });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-4',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode: () => { qrCount += 1; },
    });

    expect(result).toMatchObject({
      ok: true,
      appId: 'cli_created',
      appSecret: 'created-secret',
      sessionSource: 'botmux_cache',
      sessionIdentity: { userId: 'u_1', tenantId: 't_1' },
    });
    expect(qrCount).toBe(0);
    // 创建后立刻发布一个极简版本让应用上架启用(对齐 launcher),再读 secret
    expect(calls.map(call => call.path)).toEqual([
      '/developers/v1/app/upload/image',
      '/developers/v1/manifest/upsert_by_template',
      '/developers/v1/robot/switch/cli_created',
      '/developers/v1/event/switch/cli_created',
      // 模板建出来的应用数据范围默认是 mode:'all'(「全部」),必须在**这一版发布之前**
      // 收窄——这个 mock 的 privilege/all 返回空,所以只有读、没有 privilege/update。
      '/developers/v1/privilege/all/cli_created',
      '/developers/v1/app_version/create/cli_created',
      '/developers/v1/publish/commit/cli_created/v-enable',
      '/developers/v1/secret/cli_created',
    ]);
    // 版本可见成员含当前登录人(session identity userId),否则发布不自动上架
    const versionCall = calls.find(c => c.path === '/developers/v1/app_version/create/cli_created');
    expect(JSON.parse(String(versionCall?.body))).toMatchObject({ visibleSuggest: { members: ['u_1'] } });
  });

  it('falls back to plain app/create when the one-click template endpoint fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-fallback-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      const path = new URL(href).pathname;
      calls.push(path);
      if (path === '/developers/v1/app/upload/image') {
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
        return Response.json({ code: 1, msg: 'template not available for this tenant' });
      }
      if (path === '/developers/v1/app/create') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ name: 'botmux-5', appSceneType: 0 });
        return Response.json({ code: 0, data: { ClientID: 'cli_fallback' } });
      }
      if (path === '/developers/v1/app_version/create/cli_fallback') {
        return Response.json({ code: 0, data: { versionId: 'v-enable' } });
      }
      if (path === '/developers/v1/secret/cli_fallback') {
        return Response.json({ code: 0, data: { secret: 'fallback-secret' } });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-5',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, appId: 'cli_fallback', appSecret: 'fallback-secret' });
    expect(calls).toEqual([
      '/developers/v1/app/upload/image',
      '/developers/v1/manifest/upsert_by_template',
      '/developers/v1/app/create',
      '/developers/v1/robot/switch/cli_fallback',
      '/developers/v1/event/switch/cli_fallback',
      // 回退路径（裸自建应用）同样在发版前收窄数据范围。
      '/developers/v1/privilege/all/cli_fallback',
      '/developers/v1/app_version/create/cli_fallback',
      '/developers/v1/publish/commit/cli_fallback/v-enable',
      '/developers/v1/secret/cli_fallback',
    ]);
  });

  /**
   * 🔴 生产回归（live 建 bot 实测发现）：模板建出来的应用，数据范围出生就是
   * `mode:'all'`（「全部」），而**紧接着就发第一个版本**。只在
   * `automateOpenPlatformSetup` 里收窄救不回这一版（它发的是下一版），所以创建
   * 路径必须自己做一次。上面的顺序断言只证明「读了」，这里证明「**真写了**、且
   * 写在发版之前、内容是与应用的可用范围一致」。
   */
  it('模板默认的「全部」在第一个版本发布前就被收窄', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-narrow-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    let written: any;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      const path = new URL(href).pathname;
      calls.push(path);
      if (path === '/developers/v1/app/upload/image') {
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
        return Response.json({ code: 0, data: { clientID: 'cli_narrow' } });
      }
      if (path === '/developers/v1/privilege/all/cli_narrow') {
        // 线上模板建出来的真实形态：isRequired 且 mode:'all'。
        return Response.json({
          code: 0,
          data: {
            scopeBiz: [{ bizId: 'vc', bizName: '视频会议' }],
            privileges: [{
              bizId: 'vc', resource: 'meeting.meetingid', name: '会议号查询会议信息',
              isRequired: true, privilegeStatus: 2, schemaType: 1, organizationType: 1,
              content: '{"biz_id":"vc","resource":"meeting.meetingid","mode":"all","description":"视频会议 - 会议号查询会议信息\\n\\t全部\\n"}',
              schemaContent: {
                selectionExpressionSchemaContent: {
                  fields: [{ id: 'owner_scope', name: '会议的归属者', operators: ['in'], data_source: { type: 'select_staff', val: '' } }],
                  select_mode_options: ['all', 'part', 'null'],
                },
              },
            }],
          },
        });
      }
      if (path === '/developers/v1/privilege/update/cli_narrow') {
        written = JSON.parse(String(init?.body));
        return Response.json({ code: 0 });
      }
      if (path === '/developers/v1/app_version/create/cli_narrow') {
        return Response.json({ code: 0, data: { versionId: 'v-enable' } });
      }
      if (path === '/developers/v1/secret/cli_narrow') {
        return Response.json({ code: 0, data: { secret: 'narrow-secret' } });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-narrow', sessionFilePath: sessionFile, disableBytedcliFallback: true, fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, appId: 'cli_narrow' });

    // 真的发出了写请求，且内容是「按条件筛选 + 与应用的可用范围一致」
    expect(written?.clientId).toBe('cli_narrow');
    const content = JSON.parse(written.privileges[0].content);
    expect(content.mode).toBe('part');
    expect(JSON.parse(content.filters[0].value)[0].mode).toBe('availability_of_app');

    // 顺序：收窄必须在**这一版**发布之前，否则第一版仍带「全部」进审批。
    const narrowAt = calls.indexOf('/developers/v1/privilege/update/cli_narrow');
    const versionAt = calls.indexOf('/developers/v1/app_version/create/cli_narrow');
    expect(narrowAt).toBeGreaterThanOrEqual(0);
    expect(versionAt).toBeGreaterThan(narrowAt);
  });

  it('数据范围收窄失败不影响建 bot（非致命）', async () => {
    // 这里正处在「应用已建成、还没发版」的窗口：为一个只影响审批快慢的步骤把整条
    // 创建链路判死，会把用户丢进手动读 Secret 的恢复路径，代价明显更大。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-narrowfail-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      const path = new URL(href).pathname;
      if (path === '/developers/v1/app/upload/image') {
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
        return Response.json({ code: 0, data: { clientID: 'cli_nf' } });
      }
      if (path === '/developers/v1/privilege/all/cli_nf') {
        return Response.json({ code: 1, msg: 'privilege read denied' });
      }
      if (path === '/developers/v1/app_version/create/cli_nf') {
        return Response.json({ code: 0, data: { versionId: 'v-enable' } });
      }
      if (path === '/developers/v1/secret/cli_nf') {
        return Response.json({ code: 0, data: { secret: 'nf-secret' } });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;

    await expect(createFeishuOpenPlatformApp({
      name: 'botmux-nf', sessionFilePath: sessionFile, disableBytedcliFallback: true, fetchImpl,
    })).resolves.toMatchObject({ ok: true, appId: 'cli_nf', appSecret: 'nf-secret' });
  });

  function outcomeUnknownFetchImpl(calls: string[], templateResponse: () => Response | Promise<Response>) {
    return (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      const path = new URL(href).pathname;
      calls.push(path);
      if (path === '/developers/v1/app/upload/image') {
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
        return templateResponse();
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;
  }

  it('fails closed without cross-endpoint fallback when the template succeeds without a ClientID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-noid-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-6',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      // code=0 但响应缺 ClientID:应用可能已建成,禁止再走 app/create 重建
      fetchImpl: outcomeUnknownFetchImpl(calls, () => Response.json({ code: 0, data: {} })),
    });

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) expect(result.message).toContain('确认');
    expect(calls.filter(p => p === '/developers/v1/app/create')).toEqual([]);
  });

  it('fails closed without cross-endpoint fallback on ambiguous transport errors from the template endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-transport-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-7',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      // 传输错误(如 ECONNRESET):服务端可能已 commit,结果未知,不得重建
      fetchImpl: outcomeUnknownFetchImpl(calls, () => { throw new Error('socket hang up (ECONNRESET)'); }),
    });

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls.filter(p => p === '/developers/v1/app/create')).toEqual([]);
  });

  it('fails closed without cross-endpoint fallback on HTTP 5xx from the template endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-5xx-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-8',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      // 5xx:服务端内部错误,可能已部分落库,结果未知
      fetchImpl: outcomeUnknownFetchImpl(calls, () => new Response('oops', { status: 502 })),
    });

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls.filter(p => p === '/developers/v1/app/create')).toEqual([]);
  });

  it('stops before app/create when the account or tenant changed after the UI confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-identity-race-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const post = vi.fn();
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      post(href, init);
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await createFeishuOpenPlatformApp({
      name: 'must-not-exist',
      sessionFilePath: sessionFile,
      disableQrLogin: true,
      disableBytedcliFallback: true,
      expectedIdentity: { userId: 'u_1', tenantId: 'another_tenant' },
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: 'session_changed' });
    expect(post).not.toHaveBeenCalled();
  });

  // 应用已建成后,启用能力/发版/读 Secret 这几步撞宿主机↔飞书的瞬态网络抖动
  // (undici `fetch failed`),此前一次失败就把整条链路判死,用户被丢进「应用已创建
  // 但配置尚未完成」的手动恢复。幂等步骤(robot/switch、读 Secret)现在小步重试自愈,
  // 非幂等写(app_version/create、publish/commit)保持一次即抛,不重复提交。
  const transientCreateError = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });

  // 复用第一条 happy-path 的建应用流程,允许对指定 path 的前 N 次调用注入瞬态错误。
  function createAppFetchImpl(
    calls: string[],
    inject: (path: string, attempt: number) => void = () => {},
  ): typeof fetch {
    const attempts = new Map<string, number>();
    return (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      const path = new URL(href).pathname;
      calls.push(path);
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      inject(path, attempt); // 可 throw 瞬态错误
      if (path === '/developers/v1/app/upload/image') {
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
        return Response.json({ code: 0, data: { clientID: 'cli_created' } });
      }
      if (path === '/developers/v1/app_version/create/cli_created') {
        return Response.json({ code: 0, data: { versionId: 'v-enable' } });
      }
      if (path === '/developers/v1/secret/cli_created') {
        return Response.json({ code: 0, data: { secret: 'created-secret' } });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;
  }

  it('建成后读 Secret 撞一次瞬态网络错误能自愈,不再把用户丢进手动恢复', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-secret-retry-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = createAppFetchImpl(calls, (path, attempt) => {
      if (path === '/developers/v1/secret/cli_created' && attempt === 1) throw transientCreateError();
    });

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-secret-retry',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode: () => {},
    });

    expect(result).toMatchObject({ ok: true, appId: 'cli_created', appSecret: 'created-secret' });
    // secret 读取重试了一次(首次 + 重试);version/create 只发一次(未受影响)
    expect(calls.filter(p => p === '/developers/v1/secret/cli_created')).toHaveLength(2);
    expect(calls.filter(p => p === '/developers/v1/app_version/create/cli_created')).toHaveLength(1);
  });

  it('建成后启用机器人能力(robot/switch)撞一次瞬态网络错误能自愈', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-robot-retry-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = createAppFetchImpl(calls, (path, attempt) => {
      if (path === '/developers/v1/robot/switch/cli_created' && attempt === 1) throw transientCreateError();
    });

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-robot-retry',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode: () => {},
    });

    expect(result).toMatchObject({ ok: true, appId: 'cli_created', appSecret: 'created-secret' });
    expect(calls.filter(p => p === '/developers/v1/robot/switch/cli_created')).toHaveLength(2);
  });

  it('非幂等的上架发版(app_version/create)传输错误一次即抛,绝不重试重复建版', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-version-noretry-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = createAppFetchImpl(calls, (path) => {
      // 每次都抛:若被误当幂等重试,calls 里会出现多次
      if (path === '/developers/v1/app_version/create/cli_created') throw transientCreateError();
    });

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-version-noretry',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode: () => {},
    });

    // 应用已建成但发版失败:带 appId 供调用方兜底/提示(手动恢复路径)
    expect(result).toMatchObject({ ok: false, reason: 'api_error', appId: 'cli_created' });
    expect(calls.filter(p => p === '/developers/v1/app_version/create/cli_created')).toHaveLength(1);
  });
});

describe('probeVcMeetingEventSubscription — read-only VC event check', () => {
  // Serve the console page (CSRF) + the read-only event-state endpoint. The
  // probe must NEVER hit any /update or /create endpoint — it only reads.
  function makeFetch(subscribedEvents: string[], eventMode = 4): { fetchImpl: typeof fetch; mutatingCalls: string[] } {
    const mutatingCalls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      // Cached-session validation probe (prepareFeishuWebSession → validateFeishuWebSession):
      // non-login content marks the cookie jar valid so disableQrLogin reuses it.
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/app') || href.endsWith('/app/')) {
        return new Response('<script>window.csrfToken="csrf_probe"</script>', { status: 200 });
      }
      if (href.includes('/developers/v1/event/') && !href.includes('/update')) {
        return Response.json({ code: 0, data: { eventMode, appEvents: subscribedEvents, userEvents: subscribedEvents } });
      }
      // Anything that would mutate (event/update, app_version/create, publish/commit)
      if (href.includes('/update') || href.includes('/create') || href.includes('/publish')) {
        mutatingCalls.push(href);
        return Response.json({ code: 0, data: {} });
      }
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;
    return { fetchImpl, mutatingCalls };
  }

  it('reports zero missing when all VC events are subscribed and never mutates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-vc-probe-ok-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const all = ['vc.bot.meeting_invited_v1', 'vc.bot.meeting_activity_v1', 'vc.bot.meeting_ended_v1', 'vc.meeting.participant_meeting_joined_v1'];
    const { fetchImpl, mutatingCalls } = makeFetch(all);
    const result = await probeVcMeetingEventSubscription('cli_probe', { sessionFilePath: sessionFile, fetchImpl });
    expect(result).toMatchObject({ ok: true, missingVcEvents: [], eventModeReady: true });
    expect(mutatingCalls).toEqual([]); // read-only: proves no publish/subscribe side effects
  });

  it('lists the missing VC events when only some are subscribed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-vc-probe-missing-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const { fetchImpl } = makeFetch(['vc.bot.meeting_invited_v1']); // 3 of 4 missing
    const result = await probeVcMeetingEventSubscription('cli_probe', { sessionFilePath: sessionFile, fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.missingVcEvents).toEqual([
        'vc.bot.meeting_activity_v1', 'vc.bot.meeting_ended_v1', 'vc.meeting.participant_meeting_joined_v1',
      ]);
    }
  });

  it('flags eventModeReady=false when not on long-connection mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-vc-probe-mode-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const all = ['vc.bot.meeting_invited_v1', 'vc.bot.meeting_activity_v1', 'vc.bot.meeting_ended_v1', 'vc.meeting.participant_meeting_joined_v1'];
    const { fetchImpl } = makeFetch(all, /* eventMode */ 0);
    const result = await probeVcMeetingEventSubscription('cli_probe', { sessionFilePath: sessionFile, fetchImpl });
    expect(result).toMatchObject({ ok: true, missingVcEvents: [], eventModeReady: false });
  });

  it('fails cleanly (no QR, no throw) when there is no cached web session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-vc-probe-nosession-'));
    const sessionFile = join(dir, 'feishu-session.json'); // never written
    let qrShown = false;
    const fetchImpl = (async () => { qrShown = true; throw new Error('should not fetch without a session'); }) as typeof fetch;
    const result = await probeVcMeetingEventSubscription('cli_probe', { sessionFilePath: sessionFile, fetchImpl });
    expect(result.ok).toBe(false);
    expect(qrShown).toBe(false); // disableQrLogin: no network / no QR when the cache is gone
  });
});

describe('readDefaultScopeManifest', () => {
  it('loads the bundled manifest and returns an independent copy', () => {
    const first = readDefaultScopeManifest();
    const second = readDefaultScopeManifest();

    expect(first.scopes?.tenant?.length).toBeGreaterThan(0);
    expect(first.scopes?.user?.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
    expect(first.scopes?.tenant).not.toBe(second.scopes?.tenant);

    first.scopes?.tenant?.pop();
    expect(second.scopes?.tenant?.length).toBeGreaterThan(0);
  });
});

describe('automateOpenPlatformSetup', () => {
  it('forwards forceQrLogin so configure --switch-account ignores a valid cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-auto-force-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    let initCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        initCount++;
        return Response.json(
          { code: 0, data: { step_info: { token: 'fresh-token' } } },
          { headers: { 'x-flow-key': 'fresh-flow' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        return Response.json({
          code: 0,
          data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/fresh-cross' } },
        });
      }
      if (href === 'https://accounts.feishu.cn/fresh-cross') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=fresh-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/app/cli_x/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/cli_x')) return Response.json({ code: 1, msg: 'stop after login' });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      forceQrLogin: true,
      disableBytedcliFallback: true,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: () => {},
    });

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(initCount).toBe(1);
    expect(readStoredCookiesFromSessionFile(sessionFile)?.find(c => c.name === 'session')?.value).toBe('fresh-cookie');
  });

  it('classifies an exact app access denial as an owner-session mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-owner-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_owner"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 10003, msg: '无权限访问' }, { status: 403 });
      }
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_owner',
      sessionFilePath: sessionFile,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: 'owner_session_mismatch' });
  });

  it('does not classify a non-403 code 10003 response as an owner-session mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-owner-status-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_owner"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 10003, msg: 'other business error' });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_owner',
      sessionFilePath: sessionFile,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
  });

  it('returns login failure so setup can fall back to manual steps without aborting', async () => {
    const fetchImpl = (async () => {
      throw new Error('login down');
    }) as typeof fetch;
    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: join(tmpdir(), `botmux-missing-${Date.now()}.json`),
      disableBytedcliFallback: true,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      onQrCode: () => {},
      maxWaitMs: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'login_failed' });
  });

  it('uses botmux session cookies, page csrf, and calls the expected Open Platform endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) {
        return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({
          code: 0,
          data: {
            appScopeList: [{ id: 'tenant-1', name: 'im:message' }],
            userScopeList: [{ id: 'user-1', name: 'auth:user_access_token:read' }],
          },
        });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionSource).toBe('botmux_cache');
    // redirect 白名单紧跟 csrf 就位（/app/cli_x/auth 之后第一件事）：读一次现值再写，
    // 不再排在发版前——后面任何一步提前 return 都不该把白名单一起拖死。
    expect(calls.filter(call => new URL(call.url).host === 'open.feishu.cn').map(call => new URL(call.url).pathname)).toEqual([
      '/app/cli_x/auth',
      '/developers/v1/safe_setting/cli_x',
      '/developers/v1/safe_setting/update/cli_x',
      '/developers/v1/scope/all/cli_x',
      '/developers/v1/scope/update/cli_x',
      // 权限点进清单后紧接着读它带的「数据范围」条目（这个 mock 没有待配条目，
      // 所以只有读、没有 privilege/update）。
      '/developers/v1/privilege/all/cli_x',
      '/developers/v1/robot/switch/cli_x',
      '/developers/v1/event/switch/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/event/update/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/callback/switch/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/callback/update/cli_x',
      '/developers/v1/callback/cli_x',
      // app_version/list 提前到可见范围之前：它现在还兼任「有没有卡住的草稿」的判据，
      // 而那个判据要先于「无变更就跳过发版」的短路（否则草稿永远等不到被提交）。
      // 两者都是读操作，先后无副作用。
      '/developers/v1/app_version/list/cli_x',
      '/developers/v1/visible/online/cli_x',
      '/developers/v1/app_version/create/cli_x',
      // 提交前先查审批流程：秒过的一声不吭办完，要人审的如实说在等谁。
      // 顺序是硬要求——提交后再查等于没用上。
      '/developers/v1/approval_nodes/get/cli_x',
      '/developers/v1/publish/commit/cli_x/v1',
      // commit 后回读一次版本状态：`publish/commit` 回 code=0 不代表版本真的提交了
      // （线上实测过 code=0 却留在草稿态，日志因此谎报 published，而那个草稿会用
      // `code=10043 版本已创建` 永久卡死后续每一次自愈）。
      '/developers/v1/app_version/list/cli_x',
    ]);
    if (result.ok) expect(result.redirectConfigured).toBe(true);
    const updateCall = calls.find(call => call.url.includes('/scope/update/'));
    expect(new Headers(updateCall?.init.headers).get('x-csrf-token')).toBe('csrf_auto');
    expect(new Headers(updateCall?.init.headers).get('cookie')).toBe('session=secret-cookie-value');
    expect(JSON.parse(String(updateCall?.init.body))).toMatchObject({
      clientId: 'cli_x',
      appScopeIDs: ['tenant-1'],
      userScopeIDs: ['user-1'],
    });
  });

  it('uses the redirected Open Platform origin for API calls and referer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app/cli_x/auth') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://open.larkoffice.com/app/cli_x/auth' },
        });
      }
      if (href === 'https://open.larkoffice.com/app/cli_x/auth') {
        return new Response('<script>window.csrfToken="csrf_larkoffice"</script>', {
          status: 200,
          headers: {
            'set-cookie': 'lark_oapi_csrf_token=csrf_larkoffice_cookie; Domain=.larkoffice.com; Path=/; Secure',
          },
        });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({
          code: 0,
          data: {
            appScopeList: [{ id: 'tenant-1', name: 'im:message' }],
            userScopeList: [{ id: 'user-1', name: 'auth:user_access_token:read' }],
          },
        });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    expect(calls.filter(call => new URL(call.url).host === 'open.larkoffice.com').map(call => new URL(call.url).pathname)).toEqual([
      '/app/cli_x/auth',
      '/developers/v1/safe_setting/cli_x',
      '/developers/v1/safe_setting/update/cli_x',
      '/developers/v1/scope/all/cli_x',
      '/developers/v1/scope/update/cli_x',
      // 权限点进清单后紧接着读它带的「数据范围」条目（这个 mock 没有待配条目，
      // 所以只有读、没有 privilege/update）。
      '/developers/v1/privilege/all/cli_x',
      '/developers/v1/robot/switch/cli_x',
      '/developers/v1/event/switch/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/event/update/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/callback/switch/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/callback/update/cli_x',
      '/developers/v1/callback/cli_x',
      // app_version/list 提前到可见范围之前：它现在还兼任「有没有卡住的草稿」的判据，
      // 而那个判据要先于「无变更就跳过发版」的短路（否则草稿永远等不到被提交）。
      // 两者都是读操作，先后无副作用。
      '/developers/v1/app_version/list/cli_x',
      '/developers/v1/visible/online/cli_x',
      '/developers/v1/app_version/create/cli_x',
      // 提交前先查审批流程：秒过的一声不吭办完，要人审的如实说在等谁。
      // 顺序是硬要求——提交后再查等于没用上。
      '/developers/v1/approval_nodes/get/cli_x',
      '/developers/v1/publish/commit/cli_x/v1',
      // commit 后回读版本状态（见上一个用例的说明）。
      '/developers/v1/app_version/list/cli_x',
    ]);
    const updateCall = calls.find(call => call.url === 'https://open.larkoffice.com/developers/v1/scope/update/cli_x');
    const updateHeaders = new Headers(updateCall?.init.headers);
    expect(updateHeaders.get('origin')).toBe('https://open.larkoffice.com');
    expect(updateHeaders.get('referer')).toBe('https://open.larkoffice.com/app/cli_x');
    expect(updateHeaders.get('x-csrf-token')).toBe('csrf_larkoffice');
    expect(updateHeaders.get('cookie')).toContain('lark_oapi_csrf_token=csrf_larkoffice_cookie');
  });

  it('treats a rejected scope batch as success (partial-permission tenants) and still configures redirect + version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/scope/update/')) return Response.json({ code: 1, msg: 'scope not grantable for tenant' });
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCount).toBe(0);
      expect(result.scopeWarning).toBeTruthy();
      expect(result.versionId).toBe('v1');
    }
    // 权限被租户拒绝不阻塞后续：redirect / 版本 / 发布仍然走完。
    expect(calls.some(u => u.includes('/safe_setting/update/'))).toBe(true);
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
  });

  it('still writes the redirect whitelist when a later step aborts the whole run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/safe_setting/')) return Response.json({ code: 0, data: { redirectURL: [] } });
      // scope/all 失败会让整个流程提前 return——白名单必须在这之前就已经落地。
      if (href.includes('/scope/all/')) return new Response('forbidden', { status: 403 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({ appId: 'cli_x', sessionFilePath: sessionFile, fetchImpl });

    expect(result.ok).toBe(false);
    expect(calls.some(u => u.includes('/safe_setting/update/cli_x'))).toBe(true);
    if (!result.ok) expect(result.redirectConfigured).toBe(true);
  });

  it('keeps going and reports a warning when the redirect whitelist cannot be written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/safe_setting/update/')) return Response.json({ code: 1, msg: 'redirect rejected' });
      if (href.includes('/safe_setting/')) return Response.json({ code: 0, data: { redirectURL: [] } });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });

    // 白名单写不进去不该拖垮建 bot：事件/版本照常走完，只是显式带回「还差这一步」。
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.redirectConfigured).toBe(false);
      expect(result.redirectWarning).toContain('redirect');
      expect(result.versionId).toBe('v1');
    }
  });

  it('存量应用读不到白名单时零写入，只记 warning（绝不盲写覆盖用户条目）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x', { redirectUnreadable: true });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });

    expect(result.ok).toBe(true);
    // 读失败 → 一次 safe_setting/update 都没发；其余步骤照常走完。
    expect(calls.some(u => u.includes('/safe_setting/update/'))).toBe(false);
    if (result.ok) {
      expect(result.redirectConfigured).toBe(false);
      expect(result.redirectWarning).toContain('未写入');
      expect(result.versionId).toBe('v1');
    }
  });

  it('appJustCreated=true 时读不到白名单仍会覆盖写（新应用没有可被覆盖的用户条目）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x', { redirectUnreadable: true });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      appJustCreated: true,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });

    expect(result.ok).toBe(true);
    expect(calls.some(u => u.includes('/safe_setting/update/'))).toBe(true);
    if (result.ok) expect(result.redirectConfigured).toBe(true);
  });

  it('全集被拒退到最小集时不报「已配置」：redirectConfigured=false + warning 列出缺失地址 + ready_with_warnings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-fallback-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    // 空 HOME（无 config.json / platform.json）+ 反代基址 → wanted 恰好两条，
    // 其中反代那条正是最小集兜底会丢掉的。
    const emptyHome = mkdtempSync(join(tmpdir(), 'botmux-open-platform-fallback-home-'));
    const prevHome = process.env.HOME;
    const prevPublic = process.env.BOTMUX_PUBLIC_URL;
    process.env.HOME = emptyHome;
    process.env.BOTMUX_PUBLIC_URL = 'https://botmux.example.com/';
    const proxyRedirectUrl = 'https://botmux.example.com/oauth/callback';

    const sub = openPlatformSubscriptionMock('cli_x');
    const redirectWrites: string[][] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/safe_setting/update/')) {
        const body = JSON.parse(String(init?.body));
        redirectWrites.push(body.redirectURL);
        // 第一次（全集）被 console 判非法 → 触发最小集兜底；第二次放行。
        return redirectWrites.length === 1
          ? Response.json({ code: 1, msg: 'redirect url format invalid' })
          : Response.json({ code: 0 });
      }
      if (href.includes('/safe_setting/')) {
        return Response.json({ code: 0, data: { redirectURL: ['https://console.example.com/my-own-callback'] } });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    try {
      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl,
        scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      });

      // 兜底集 = 线上现值 ∪ 本机回调：反代那条被丢了，按定义就没写全。
      expect(redirectWrites).toHaveLength(2);
      expect(redirectWrites[0]).toContain(proxyRedirectUrl);
      expect(redirectWrites[1]).not.toContain(proxyRedirectUrl);
      // 白名单没写全不阻断建 bot：版本照常发；但绝不能报成「已配置 redirect URL」。
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.redirectConfigured).toBe(false);
        expect(result.redirectWarning).toContain(proxyRedirectUrl);
        expect(result.versionId).toBe('v1');
      }
      // CLI 打印 / scripted JSON / onboarding 都挂在这条 outcome 上。
      expect(classifySetupOpenPlatformOutcome(result).status).toBe('ready_with_warnings');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevPublic === undefined) delete process.env.BOTMUX_PUBLIC_URL;
      else process.env.BOTMUX_PUBLIC_URL = prevPublic;
    }
  });

  it('skips scope update when no manifest scope exists in this tenant catalog, still succeeding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message', 'contact:user.base:readonly'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCount).toBe(0);
      expect(result.skippedScopeCount).toBe(3);
    }
    expect(calls.some(u => u.includes('/scope/update/'))).toBe(false);
  });

  function subscriptionFetchImpl(
    sub: ReturnType<typeof openPlatformSubscriptionMock>,
    calls: string[],
    versionId: string | null = 'v1',
  ) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) {
        return Response.json({ code: 0, data: versionId ? { versionId } : {} });
      }
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;
  }

  async function runSetupWithMock(
    sessionDirPrefix: string,
    sub: ReturnType<typeof openPlatformSubscriptionMock>,
    calls: string[],
    options: { requireVerifiedEvents?: boolean; versionId?: string | null } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), sessionDirPrefix));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    return automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl: subscriptionFetchImpl(sub, calls, options.versionId === undefined ? 'v1' : options.versionId),
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      requireVerifiedEvents: options.requireVerifiedEvents,
    });
  }

  it('returns an exact event and version ack from the same managed session', async () => {
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-managed-', sub, calls, {
      requireVerifiedEvents: true,
    });

    expect(result).toMatchObject({
      ok: true,
      eventMode: 4,
      verifiedEventCount: BOT_BASELINE_APP_EVENTS.length + BOT_BASELINE_CALLBACKS.length,
      versionId: 'v1',
    });
  });

  it('fails managed activation when one baseline event is still missing after same-session readback', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', {
      rejectEventNames: ['im.chat.member.bot.added_v1'],
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-managed-missing-', sub, calls, {
      requireVerifiedEvents: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'event_verification_failed',
    });
  });

  it('fails managed activation when the published version cannot be proven', async () => {
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-managed-version-', sub, calls, {
      requireVerifiedEvents: true,
      versionId: null,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'version_verification_failed',
    });
  });

  it('subscribes baseline app events incrementally and the card callback via /callback endpoints', async () => {
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-', sub, calls);

    expect(result.ok).toBe(true);
    const eventUpdate = sub.updateBodies.find(body => Array.isArray(body.appEvents));
    expect(eventUpdate).toMatchObject({ clientId: 'cli_x', operation: 'add', eventMode: 4, events: [] });
    expect(eventUpdate?.appEvents).toContain('im.message.receive_v1');
    expect(eventUpdate?.appEvents).toContain('im.chat.member.bot.added_v1');
    expect(eventUpdate?.appEvents).toContain('vc.bot.meeting_invited_v1');
    expect(eventUpdate?.appEvents).not.toContain('card.action.trigger');
    expect(eventUpdate?.userEvents).toEqual(['vc.meeting.participant_meeting_joined_v1']);
    const callbackUpdate = sub.updateBodies.find(body => Array.isArray(body.callbacks));
    expect(callbackUpdate).toMatchObject({ clientId: 'cli_x', operation: 'add', callbacks: ['card.action.trigger'], callbackMode: 4 });
    // 回调接收方式初始是 webhook(1),必须先切长连接再订阅
    expect(sub.state.callbackMode).toBe(4);
    if (result.ok) {
      expect(result.subscribedEventCount).toBeGreaterThanOrEqual(8);
      expect(result.eventWarning).toBeUndefined();
    }
  });

  it('is idempotent: already-subscribed apps get no event/callback update calls', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', {
      initial: {
        appEvents: [
          'im.message.receive_v1',
          'im.chat.member.bot.added_v1',
          'im.chat.member.bot.deleted_v1',
          'drive.notice.comment_add_v1',
          'im.message.reaction.created_v1',
          'im.message.reaction.deleted_v1',
          'im.chat.member.user.added_v1',
          'im.chat.member.user.deleted_v1',
          'vc.bot.meeting_invited_v1',
          'vc.bot.meeting_activity_v1',
          'vc.bot.meeting_ended_v1',
        ],
        userEvents: ['vc.meeting.participant_meeting_joined_v1'],
        callbacks: ['card.action.trigger'],
        callbackMode: 4,
      },
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-idem-', sub, calls);

    expect(result.ok).toBe(true);
    expect(sub.updateBodies).toEqual([]);
    expect(calls.some(u => u.includes('/callback/switch/'))).toBe(false);
  });

  it('fails closed when im.message.receive_v1 cannot be subscribed', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', { failEventUpdate: true });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-fail-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) {
      expect(result.message).toContain('im.message.receive_v1');
      expect(result.eventWarning).toBeTruthy();
    }
    // 批量失败后逐个重试过:baseline 6 + 可选 user 事件 2 + VC app 3 + VC user 1 = 批量 1 次 + 单个 12 次
    expect(sub.updateBodies.filter(body => Array.isArray(body.appEvents)).length).toBe(13);
    // 核心事件缺失时不再继续发版,避免发布一个收不到消息的版本
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('fails closed when the card.action.trigger callback cannot be subscribed', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', { failCallbackUpdate: true });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-cbfail-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) expect(result.message).toContain('card.action.trigger');
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('fails closed when the callback long-connection switch fails even with the callback already subscribed', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', {
      failCallbackSwitch: true,
      initial: { callbacks: ['card.action.trigger'], callbackMode: 1 },
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-swfail-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) expect(result.message).toContain('回调接收模式');
    expect(sub.state.callbackMode).toBe(1);
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('fails closed when callback mode readback still shows webhook after a successful switch call', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', {
      callbackSwitchNoop: true,
      initial: { callbacks: ['card.action.trigger'], callbackMode: 1 },
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-swnoop-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) expect(result.message).toContain('回调接收模式');
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('keeps plain bot setup ok when only VC events fail, but reports missingVcEvents for the listener gate', async () => {
    const vcEvents = [
      'vc.bot.meeting_invited_v1',
      'vc.bot.meeting_activity_v1',
      'vc.bot.meeting_ended_v1',
      'vc.meeting.participant_meeting_joined_v1',
    ];
    const sub = openPlatformSubscriptionMock('cli_x', { rejectEventNames: vcEvents });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-vc-', sub, calls);

    // 普通建 bot:baseline+回调齐 → 不阻断,照常发版
    expect(result.ok).toBe(true);
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
    if (result.ok) {
      expect(result.missingVcEvents).toEqual(vcEvents);
      expect(result.subscribedEventCount).toBe(9); // 6 baseline 事件 + 2 可选 user 事件 + 1 回调
      expect(result.eventWarning).toContain('VC 会议事件未确认订阅');
      // VC listener 保存门必须拦下这种结果(dashboard 两条分支都走这个门)
      expect(vcListenerEventGateError(result)).toContain('vc.bot.meeting_invited_v1');
    }
  });

  it('fails closed and blocks the listener gate when event mode readback stays webhook despite full subscriptions', async () => {
    // event/switch 返回成功(mock 默认 code 0)但回读 eventMode 仍是 1:
    // 订阅名齐、count=11、missingVcEvents=[],唯一异常是接收方式。
    const sub = openPlatformSubscriptionMock('cli_x', {
      initial: {
        eventMode: 1,
        appEvents: [
          'im.message.receive_v1',
          'im.chat.member.bot.added_v1',
          'im.chat.member.bot.deleted_v1',
          'drive.notice.comment_add_v1',
          'im.message.reaction.created_v1',
          'im.message.reaction.deleted_v1',
          'vc.bot.meeting_invited_v1',
          'vc.bot.meeting_activity_v1',
          'vc.bot.meeting_ended_v1',
        ],
        userEvents: ['vc.meeting.participant_meeting_joined_v1'],
        callbacks: ['card.action.trigger'],
        callbackMode: 4,
      },
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-evmode-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) {
      expect(result.message).toContain('事件接收模式');
      expect(result.eventModeReady).toBe(false);
      expect(result.missingVcEvents).toEqual([]);
      // dashboard 非登录失败分支的 listener 门必须拦下(此前 count=11/missingVc=[] 会放行)
      expect(vcListenerEventGateError(result)).toContain('长连接');
    }
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('vcListenerEventGateError passes clean results and blocks zero-subscription, missing-VC or mode-not-ready results', () => {
    expect(vcListenerEventGateError({ subscribedEventCount: 12, missingVcEvents: [], eventModeReady: true })).toBeNull();
    expect(vcListenerEventGateError({ eventWarning: 'boom', subscribedEventCount: 0 })).toContain('事件订阅全部失败');
    expect(vcListenerEventGateError({ subscribedEventCount: 8, missingVcEvents: ['vc.bot.meeting_ended_v1'], eventModeReady: true }))
      .toContain('vc.bot.meeting_ended_v1');
    expect(vcListenerEventGateError({ subscribedEventCount: 12, missingVcEvents: [], eventModeReady: false }))
      .toContain('长连接');
    // 走不到订阅阶段的早期失败(missingVcEvents/eventModeReady 均 undefined)保持原 best-effort 语义
    expect(vcListenerEventGateError({})).toBeNull();
  });

  // 无变更短路：redirect / scope / 事件 / 回调 / 接收模式一路下来都没落地过写操作时，
  // 不应再 create+publish 一个新版本（存量 bot 每次重启命中自检都凭空多一版的根因）。
  describe('无变更时跳过发版', () => {
    // 「什么都不缺」的 mock：所有 botmux 需要的事件/回调/长连接模式都已就位，
    // redirect 白名单已含全部 wanted，scope 传空清单 → 全程零写请求。
    function noopMock(appId: string) {
      return openPlatformSubscriptionMock(appId, {
        initial: {
          appEvents: [...BOT_BASELINE_APP_EVENTS, ...BOT_OPTIONAL_APP_EVENTS, ...VC_MEETING_APP_EVENTS],
          userEvents: [...VC_MEETING_USER_EVENTS],
          eventMode: LONG_CONNECTION_EVENT_MODE,
          callbacks: [...BOT_BASELINE_CALLBACKS],
          callbackMode: LONG_CONNECTION_EVENT_MODE,
          redirectUrls: collectBotmuxRedirectUrls(),
        },
      });
    }

    function noopFetch(appId: string, sub: ReturnType<typeof openPlatformSubscriptionMock>, calls: string[]) {
      return (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
        if (href.includes(`/scope/all/${appId}`)) {
          return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
        }
        // 命中发版端点直接抛：无变更时它们绝不该被调用。
        if (href.includes('/app_version/create/') || href.includes('/publish/commit/')) {
          throw new Error(`must not publish on no-op: ${href}`);
        }
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;
    }

    it('权限/事件/回调全就位时不 create+publish，直接回成功且 versionId 为空', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-noop-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_x');
      const calls: string[] = [];

      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl: noopFetch('cli_x', sub, calls),
        // 空清单 → importedScopeCount=0 → 不发 scope/update
        scopeManifest: { scopes: { tenant: [], user: [] } },
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.versionId).toBeUndefined();
      // 一条发版请求都没有；也没有任何写请求（redirect/scope/event/callback update）。
      expect(calls.some(u => u.includes('/app_version/create/'))).toBe(false);
      expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
      expect(calls.some(u => u.includes('/scope/update/'))).toBe(false);
      expect(sub.updateBodies).toEqual([]);
      expect(sub.redirectWrites).toEqual([]);
    });

    /**
     * 🔴 无变更短路 × 卡死草稿的交互：两个特性各自都对，合在一起会互相抵消。
     *
     * 一个 scope 已齐、事件已订阅、数据范围已收窄的 bot，`mutated` 恒为 false ⟹ 命中
     * 无变更短路直接 return ⟹ 「提交草稿」的代码**永远到不了** ⟹ 草稿一直卡着，而
     * 卡着的草稿会让将来任何一次 `app_version/create` 撞 `code=10043`。
     *
     * 「有没有草稿」与「本轮有没有配置变更」是两件独立的事，所以草稿必须能独立地把
     * 短路顶开。（这个交互是 rebase 到 master 后发现的：两边都是新代码，文本无冲突。）
     */
    it('🔴 无变更但存在未提交草稿时，不许短路——必须把草稿提交掉', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-noop-draft-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_nd');
      const calls: string[] = [];
      let committed: string | undefined;
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="c"</script>', { status: 200 });
        if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
        // 建新版本仍然不该发生（草稿要复用，不是再建一个）
        if (href.includes('/app_version/create/')) throw new Error(`must not create a new version: ${href}`);
        if (href.includes('/publish/commit/')) { committed = href.split('/').pop(); return Response.json({ code: 0 }); }
        if (href.includes('/approval_nodes/get/')) {
          return Response.json({ code: 0, data: { applyInstanceInfo: { applyNodes: [
            { nodeName: '免审策略', nodeType: '自动通过', nodeUser: [] },
          ] } } });
        }
        if (href.includes('/app_version/list/')) {
          return Response.json({ code: 0, data: { versions: committed
            ? [{ appVersion: '1.0.1', versionId: 'stuck-draft', versionStatus: 2 }]
            : [{ appVersion: '1.0.1', versionId: 'stuck-draft', versionStatus: 0 },
               { appVersion: '1.0.0', versionId: 'live', versionStatus: 2 }] } });
        }
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;

      const result = await automateOpenPlatformSetup({
        appId: 'cli_nd',
        sessionFilePath: sessionFile,
        fetchImpl,
        scopeManifest: { scopes: { tenant: [], user: [] } },
      });

      expect(result.ok, `ok=false ${(result as any).message}`).toBe(true);
      // 草稿被提交了 —— 而不是被短路跳过
      expect(committed, '卡住的草稿必须被提交').toBe('stuck-draft');
      if (result.ok) {
        expect(result.versionReused).toBe(true);
        expect(result.versionId).toBe('stuck-draft');
        expect(result.publishSkipped, '有草稿要处理时不该报「跳过发版」').not.toBe(true);
      }
      // 仍然不许凭空建新版本
      expect(calls.some(u => u.includes('/app_version/create/'))).toBe(false);
    });

    it('appJustCreated=true 时即便无变更也照常发版（新应用要靠首发上架）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-noop-new-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_x');
      const calls: string[] = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
        if (href.includes('/scope/all/cli_x')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
        if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;

      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl,
        scopeManifest: { scopes: { tenant: [], user: [] } },
        appJustCreated: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.versionId).toBe('v1');
      expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
    });

    it('requireVerifiedEvents=true 时即便无变更也照常发版（受管激活靠精确 versionId ACK）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-noop-managed-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_x');
      const calls: string[] = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
        if (href.includes('/scope/all/cli_x')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
        if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;

      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl,
        scopeManifest: { scopes: { tenant: [], user: [] } },
        requireVerifiedEvents: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.versionId).toBe('v1');
      expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
    });

    // 锁生产链路：走**真实默认 manifest**（不注入 scopeManifest）+ 已授权集合。
    // 这是维护者复审揪出的空白——之前 3 例都注入空 manifest，恰好绕开了唯一有意义
    // 的那条路径（默认 171+130 项、importedScopeCount 恒 >0 → mutated 恒真 → 短路
    // 永不触发）。这里用「manifest 全部已授权」模拟「配置本就齐全」的重启自检。
    const defaultManifest = JSON.parse(
      readFileSync(join(fileURLToPath(new URL('../src/setup/lark-scopes.json', import.meta.url))), 'utf-8'),
    ) as { scopes: { tenant: string[]; user: string[] } };
    const allDefaultScopeNames = [...defaultManifest.scopes.tenant, ...defaultManifest.scopes.user];

    // 用默认 manifest 里的名字构造一份「租户目录」——scope/all 返回它，automation 据此
    // 把 name 映射成 ID。ID 只要唯一即可。
    function defaultCatalogFetch(
      appId: string,
      sub: ReturnType<typeof openPlatformSubscriptionMock>,
      calls: string[],
      captured: { scopeUpdateBodies: Array<Record<string, unknown>> },
    ) {
      const nameToId = new Map<string, string>();
      allDefaultScopeNames.forEach((name, i) => nameToId.set(name, `id_${i}`));
      return (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
        if (href.includes(`/scope/all/${appId}`)) {
          return Response.json({
            code: 0,
            data: {
              appScopeList: defaultManifest.scopes.tenant.map(name => ({ name, id: nameToId.get(name) })),
              userScopeList: defaultManifest.scopes.user.map(name => ({ name, id: nameToId.get(name) })),
            },
          });
        }
        if (href.includes(`/scope/update/${appId}`)) {
          captured.scopeUpdateBodies.push(JSON.parse(String(init?.body)));
          return Response.json({ code: 0 });
        }
        if (href.includes('/app_version/create/') || href.includes('/publish/commit/')) {
          throw new Error(`must not publish on no-op: ${href}`);
        }
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;
    }

    it('默认全量 manifest + grantedScopeNames 覆盖全部权限时，短路生效、零 scope/update、不发版', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-noop-default-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_x');
      const calls: string[] = [];
      const captured = { scopeUpdateBodies: [] as Array<Record<string, unknown>> };

      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl: defaultCatalogFetch('cli_x', sub, calls, captured),
        // 关键：不传 scopeManifest（走真实默认清单），但告知「全部已授权」——
        // 按桶传：tenant / user 两桶各自全授权。
        grantedScopeNames: {
          tenant: [...defaultManifest.scopes.tenant],
          user: [...defaultManifest.scopes.user],
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.versionId).toBeUndefined();
        expect(result.publishSkipped).toBe(true);
      }
      // 全部已授权 → 差集为空 → 一次 scope/update 都不发、也不发版。
      expect(captured.scopeUpdateBodies).toEqual([]);
      expect(calls.some(u => u.includes('/scope/update/'))).toBe(false);
      expect(calls.some(u => u.includes('/app_version/create/'))).toBe(false);
      expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
    });

    // #1042 × #1044 合并回归：`narrowRequiredPrivilegeRanges` 会真发 `privilege/update`
    // （返回值就是写进去的条目数）。它排在无变更短路之前，所以「scope/事件/回调全齐、
    // 只有权限数据范围被收敛」的那一轮**确实改了线上配置**，必须照常发版——否则改动
    // 留在草稿里不生效。反向变异（删掉 `privilegeRangeCount > 0` 那句置位）时本例转红。
    it('只有权限数据范围被收敛时仍算一次变更、照常发版（不被无变更短路吞掉）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-privilege-only-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_x');
      const calls: string[] = [];
      const nameToId = new Map<string, string>();
      allDefaultScopeNames.forEach((name, i) => nameToId.set(name, `id_${i}`));
      // 线上 `privilege/all` 的真实条目形态：isRequired + content 为空 + 单个选人字段
      // ⇒ 落进 selectPrivilegesNeedingAppAvailability，会触发一次 privilege/update。
      const vcPrivilege = {
        bizId: 'vc',
        resource: 'meeting.meetingid',
        name: '会议号查询会议信息',
        isRequired: true,
        content: '',
        privilegeStatus: 3,
        schemaType: 1,
        organizationType: 1,
        schemaContent: {
          selectionExpressionSchemaContent: {
            fields: [{
              id: 'owner_scope', name: '会议的归属者', type: 'object', multi: false,
              operators: ['in'], data_source: { type: 'select_staff', val: '' },
            }],
            select_mode_options: ['all', 'part', 'null'],
            fallback_value: { mode: 'all' },
          },
        },
      };
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
        if (href.includes('/scope/all/cli_x')) {
          return Response.json({
            code: 0,
            data: {
              appScopeList: defaultManifest.scopes.tenant.map(name => ({ name, id: nameToId.get(name) })),
              userScopeList: defaultManifest.scopes.user.map(name => ({ name, id: nameToId.get(name) })),
            },
          });
        }
        if (href.includes('/privilege/all/cli_x')) {
          return Response.json({ code: 0, data: { scopeBiz: [{ bizId: 'vc', bizName: '视频会议' }], privileges: [vcPrivilege] } });
        }
        if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v-priv' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;

      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl,
        // scope 两桶全授权 ⇒ 差集为空、零 scope/update；唯一的变更来自数据范围收敛。
        grantedScopeNames: {
          tenant: [...defaultManifest.scopes.tenant],
          user: [...defaultManifest.scopes.user],
        },
      });

      expect(result.ok).toBe(true);
      // 真发过一次 privilege/update，且没有任何 scope/update。
      expect(calls.some(u => u.includes('/privilege/update/'))).toBe(true);
      expect(calls.some(u => u.includes('/scope/update/'))).toBe(false);
      if (result.ok) {
        expect(result.privilegeRangeCount).toBe(1);
        // 关键断言：这一轮**不是**无变更，必须发版。
        expect(result.publishSkipped).toBeUndefined();
        expect(result.versionId).toBe('v-priv');
      }
      expect(calls.some(u => u.includes('/app_version/create/'))).toBe(true);
      expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
    });

    // PR #1044 R2 回归：dual-bucket 名字（tenant/user 两桶都有）的 user 侧独缺时，
    // 必须仍对 user 侧发 scope/update——不能因为 tenant 侧已授权就把它从 user 桶误删。
    // 用扁平集合做差会把这一项静默吞掉（0 次 scope/update + publishSkipped），本例锁死。
    it('dual-bucket 名字仅 user 侧缺失时，按桶做差仍申请其 user 授权、不误报无变更', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-dual-user-missing-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_x');
      const calls: string[] = [];
      const captured = { scopeUpdateBodies: [] as Array<Record<string, unknown>> };
      // 取一个同时出现在 tenant 与 user 两桶的名字。
      const tenantSet = new Set(defaultManifest.scopes.tenant);
      const dualName = defaultManifest.scopes.user.find(n => tenantSet.has(n))!;
      expect(dualName, 'expected a dual-bucket scope name in the default manifest').toBeTruthy();
      const nameToId = new Map<string, string>();
      allDefaultScopeNames.forEach((name, i) => nameToId.set(name, `id_${i}`));
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
        if (href.includes('/scope/all/cli_x')) {
          return Response.json({
            code: 0,
            data: {
              appScopeList: defaultManifest.scopes.tenant.map(name => ({ name, id: nameToId.get(name) })),
              userScopeList: defaultManifest.scopes.user.map(name => ({ name, id: nameToId.get(name) })),
            },
          });
        }
        if (href.includes('/scope/update/cli_x')) {
          captured.scopeUpdateBodies.push(JSON.parse(String(init?.body)));
          return Response.json({ code: 0 });
        }
        if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v-NEW' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;

      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl,
        // tenant 侧全授权；user 侧独缺 dualName。扁平集合会因 tenant 有 dualName 而误删 user 桶。
        grantedScopeNames: {
          tenant: [...defaultManifest.scopes.tenant],
          user: defaultManifest.scopes.user.filter(n => n !== dualName),
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // 确有新增（user 侧那一项）→ 必须发版、不是无变更。
        expect(result.publishSkipped).toBeUndefined();
      }
      // 恰好对「user 侧缺的那一项」发一次 scope/update：零 tenant id、一个 user id。
      expect(captured.scopeUpdateBodies).toHaveLength(1);
      expect(captured.scopeUpdateBodies[0].appScopeIDs).toEqual([]);
      expect(captured.scopeUpdateBodies[0].userScopeIDs).toEqual([nameToId.get(dualName)]);
      expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
    });

    it('默认全量 manifest + grantedScopeNames 缺一项时，只对缺的那项发 scope/update 并发版', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-default-onemissing-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_x');
      const calls: string[] = [];
      const captured = { scopeUpdateBodies: [] as Array<Record<string, unknown>> };
      // 缺一项**仅出现在 tenant 桶**的 scope（避免 dual 名字干扰，其余全部已授权）。
      const userSet = new Set(defaultManifest.scopes.user);
      const missingName = defaultManifest.scopes.tenant.find(n => !userSet.has(n))!;
      expect(missingName, 'expected a tenant-only scope name').toBeTruthy();
      const nameToId = new Map<string, string>();
      allDefaultScopeNames.forEach((name, i) => nameToId.set(name, `id_${i}`));
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
        if (href.includes('/scope/all/cli_x')) {
          return Response.json({
            code: 0,
            data: {
              appScopeList: defaultManifest.scopes.tenant.map(name => ({ name, id: nameToId.get(name) })),
              userScopeList: defaultManifest.scopes.user.map(name => ({ name, id: nameToId.get(name) })),
            },
          });
        }
        if (href.includes('/scope/update/cli_x')) {
          captured.scopeUpdateBodies.push(JSON.parse(String(init?.body)));
          return Response.json({ code: 0 });
        }
        if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v-NEW' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;

      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl,
        grantedScopeNames: {
          tenant: defaultManifest.scopes.tenant.filter(n => n !== missingName),
          user: [...defaultManifest.scopes.user],
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.versionId).toBe('v-NEW');
        expect(result.publishSkipped).toBeUndefined();
      }
      // 只对「真正还缺的那一项」发 scope/update：payload 里恰好一个 tenant scope id、零 user scope。
      expect(captured.scopeUpdateBodies).toHaveLength(1);
      expect(captured.scopeUpdateBodies[0].appScopeIDs).toEqual([nameToId.get(missingName)]);
      expect(captured.scopeUpdateBodies[0].userScopeIDs).toEqual([]);
      expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
    });

    it('不传 grantedScopeNames（默认全量 manifest）时保持原保守行为：发 scope/update 且发版', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-default-nogrant-'));
      const sessionFile = join(dir, 'feishu-session.json');
      writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
      const sub = noopMock('cli_x');
      const calls: string[] = [];
      const captured = { scopeUpdateBodies: [] as Array<Record<string, unknown>> };
      const nameToId = new Map<string, string>();
      allDefaultScopeNames.forEach((name, i) => nameToId.set(name, `id_${i}`));
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push(href);
        if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
        if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
        if (href.includes('/scope/all/cli_x')) {
          return Response.json({
            code: 0,
            data: {
              appScopeList: defaultManifest.scopes.tenant.map(name => ({ name, id: nameToId.get(name) })),
              userScopeList: defaultManifest.scopes.user.map(name => ({ name, id: nameToId.get(name) })),
            },
          });
        }
        if (href.includes('/scope/update/cli_x')) {
          captured.scopeUpdateBodies.push(JSON.parse(String(init?.body)));
          return Response.json({ code: 0 });
        }
        if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v-NEW' } });
        return sub.handle(href, init) ?? Response.json({ code: 0 });
      }) as typeof fetch;

      const result = await automateOpenPlatformSetup({
        appId: 'cli_x',
        sessionFilePath: sessionFile,
        fetchImpl,
        // 不传 grantedScopeNames：拿不到已授权信号 → 保守近似 → 照发不误。
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.versionId).toBe('v-NEW');
        expect(result.publishSkipped).toBeUndefined();
      }
      // 保守行为：整份 manifest 全量映射 → 发一次非空 scope/update → 发版。
      expect(captured.scopeUpdateBodies).toHaveLength(1);
      expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
    });
  });
});

/**
 * 回归：自动发版必须原样镜像线上可见范围。
 *
 * 历史 bug —— 这里读的是 `contact_range`（通讯录权限范围）且只取 members，
 * `departments` / `groups` / `isAll` 在版本 payload 里写死空值。由于
 * `app_version/create` 的 visibleSuggest 是**全量覆写**语义，每次权限自愈自动
 * 发版都把「全员可见 / 按部门授权 / 按用户组授权」静默清成「仅少数个人可见」，
 * 升级次日大量用户访问不了应用。
 */
describe('automateOpenPlatformSetup 版本可见范围', () => {
  const visibilityFetch = (appId: string, sub: ReturnType<typeof openPlatformSubscriptionMock>, calls: string[]) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === `https://open.feishu.cn/app/${appId}/auth`) {
        return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      }
      const path = new URL(href).pathname;
      calls.push(path);
      if (path.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 'tenant-1', name: 'im:message' }], userScopeList: [] } });
      }
      if (path.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

  const runWith = async (visibleOnline: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-visibility-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x', { visibleOnline });
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const inner = visibilityFetch('cli_x', sub, calls);
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/app_version/create/')) bodies.push(JSON.parse(String(init?.body)));
      return inner(url, init);
    }) as typeof fetch;
    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });
    return { result, calls, versionBody: bodies[0] };
  };

  it('把线上的全员可见 / 部门 / 用户组原样镜像进新版本，而不是清空', async () => {
    const { result, versionBody } = await runWith({
      code: 0,
      data: {
        whiteList: {
          departments: [{ id: 'od_sales' }, { id: 'od_eng' }],
          members: [{ id: 'ou_alice' }],
          groups: [{ id: 'g_oncall' }],
          isAll: 1,
        },
        blackList: { departments: [], members: [{ id: 'ou_banned' }], groups: [], isAll: 0 },
      },
    });

    expect(result.ok).toBe(true);
    // 四个集合一个都不能丢：isAll=1 掉成 0 就是「全员可见」被撤销，
    // departments/groups 清空就是按部门/用户组授权的人全部失去访问。
    expect(versionBody.visibleSuggest).toEqual({
      departments: ['od_sales', 'od_eng'],
      members: ['ou_alice'],
      groups: ['g_oncall'],
      isAll: 1,
    });
    // 黑名单同样要镜像：丢了就把被拉黑的人重新放进来。
    expect(versionBody.blackVisibleSuggest).toEqual({
      departments: [], members: ['ou_banned'], groups: [], isAll: 0,
    });
  });

  it('读的是 visible/online（应用可见范围），不再读 contact_range（通讯录权限范围）', async () => {
    const { calls } = await runWith(undefined);
    expect(calls).toContain('/developers/v1/visible/online/cli_x');
    expect(calls).not.toContain('/developers/v1/contact_range/cli_x');
  });

  it('可见范围响应形态不认识时 fail closed：不建版、不发布', async () => {
    // isAll 是字符串 '1' —— 猜错方向就会把全员可见发布成不可见，宁可不发版。
    const { result, calls } = await runWith({
      code: 0,
      data: {
        whiteList: { departments: [], members: [], groups: [], isAll: '1' },
        blackList: { departments: [], members: [], groups: [], isAll: 0 },
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'visibility_unreadable' });
    expect(calls.some(path => path.includes('/app_version/create/'))).toBe(false);
    expect(calls.some(path => path.includes('/publish/commit/'))).toBe(false);
  });

  it('可见范围块缺键时同样 fail closed（残缺响应不得当成空可见范围）', async () => {
    const { result, calls } = await runWith({ code: 0, data: { whiteList: {}, blackList: {} } });

    expect(result).toMatchObject({ ok: false, reason: 'visibility_unreadable' });
    expect(calls.some(path => path.includes('/app_version/create/'))).toBe(false);
  });
});

// 宿主机到飞书的偶发网络抖动会让 undici 抛 TypeError('fetch failed')，一次失败
// 就中断整条 console 链路（dashboard 改名/改头像实测偶发中招）。页面读取 GET
// 幂等可重试；console POST 写操作传输错误时结果未知，绝不能重试。
describe('console 页面读取的瞬态网络错误重试', () => {
  const transientFetchError = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });

  it('GET 页面读取遇瞬态网络错误自动重试，抖一次不再让整条链路失败', async () => {
    let pageAttempts = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://open.feishu.cn/app') {
        pageAttempts += 1;
        if (pageAttempts === 1) throw transientFetchError();
        return new Response(openPlatformPage(), { status: 200 });
      }
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(result.ok).toBe(true);
    expect(pageAttempts).toBe(2);
  });

  it('重试耗尽后返回 network 失败，message 带上 cause 里的真实网络错误', async () => {
    let pageAttempts = 0;
    const fetchImpl = (async () => {
      pageAttempts += 1;
      throw transientFetchError();
    }) as typeof fetch;

    const result = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'network' });
    if (!result.ok) {
      expect(result.message).toContain('fetch failed');
      expect(result.message).toContain('ECONNRESET');
    }
    expect(pageAttempts).toBe(3); // 首次 + 2 次重试
  });

  it('console POST 写操作不重试：传输错误立刻抛出，避免重复提交', async () => {
    let postAttempts = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        postAttempts += 1;
        throw transientFetchError();
      }
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const clientResult = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    await expect(clientResult.client.postJson('/developers/v1/app/cli_x', {})).rejects.toThrow('fetch failed');
    expect(postAttempts).toBe(1);
  });

  it('非网络错误不重试（mock/逻辑错误一次就失败，不白等退避）', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error('boom');
    }) as typeof fetch;

    const result = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'network' });
    expect(attempts).toBe(1);
  });
});

// 「TLS 握手完成之前就断连」是唯一可证明「请求一个字节都没发出去」的传输错误：
// Node 内置 `_tls_wrap.js` 的 `onConnectEnd` 在建 socket 时挂上、在
// `onConnectSecure` 里摘掉，所以它只会在握手完成前触发 ⟹ 没有加密通道 ⟹ 请求行/
// 头/body 都没送出。因此连非幂等的 console 写操作也能安全重放；不重放的代价是
// 用户的改名/改头像被一次网络毛刺整轮打挂（线上实测：改头像失败并把这句话原样
// 抛给用户）。以下用例守住「该重试的重试、不该重试的绝不重试」两侧。
describe('pre-TLS 断连：可证明未送达，写操作也重试', () => {
  /** 与线上实测逐字一致的错误形态（外层 undici 包装 + cause 带 code）。 */
  const preTlsDisconnect = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(
        new Error('Client network socket disconnected before secure TLS connection was established'),
        { code: 'ECONNRESET' },
      ),
    });
  /** 对照：握手已完成、请求已送达后才断 —— 服务端可能已处理，绝不能重放。 */
  const afterRequestSent = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });

  async function postWith(errFactory: () => Error, failTimes: number) {
    let postAttempts = 0;
    let failed = 0;
    const bodies: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        postAttempts += 1;
        bodies.push(String(init?.body ?? ''));
        if (failed < failTimes) { failed += 1; throw errFactory(); }
        return new Response(JSON.stringify({ code: 0, data: { ok: true } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const clientResult = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) throw new Error('client construction failed');
    return { client: clientResult.client, attempts: () => postAttempts, bodies };
  }

  it('POST 写操作遇 pre-TLS 断连会重试，并把 body 原样重发', async () => {
    const h = await postWith(preTlsDisconnect, 1);
    await expect(h.client.postJson('/developers/v1/base_info/cli_x', { clientId: 'cli_x', name: '小助手' }))
      .resolves.toMatchObject({ code: 0 });
    expect(h.attempts()).toBe(2);
    // 重发的必须是同一份 payload——否则会写出半截数据。
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[0]).toBe(h.bodies[1]);
    expect(h.bodies[0]).toContain('"name":"小助手"');
  });

  it('POST 的 multipart 上传（改头像图片）同样重试且 FormData 可原样重发', async () => {
    let postAttempts = 0;
    const sizes: Array<number | string> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        postAttempts += 1;
        const body = init?.body as FormData;
        sizes.push(body instanceof FormData ? ((body.get('file') as Blob | null)?.size ?? 'MISSING') : 'NOT_FORM');
        if (postAttempts === 1) throw preTlsDisconnect();
        return new Response(JSON.stringify({ code: 0, data: { url: 'https://cdn/a.png' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const clientResult = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(64).fill(7)], { type: 'image/png' }), 'avatar.png');
    await expect(clientResult.client.postForm('/developers/v1/app/upload/image', form))
      .resolves.toMatchObject({ code: 0 });
    expect(postAttempts).toBe(2);
    // 两次都带着完整的 64 字节图片——重发不能退化成空 body。
    expect(sizes).toEqual([64, 64]);
  });

  it('重试耗尽后仍失败，并把这句 pre-TLS 断连原样透出给用户', async () => {
    const h = await postWith(preTlsDisconnect, Number.POSITIVE_INFINITY);
    await expect(h.client.postJson('/developers/v1/base_info/cli_x', {}))
      .rejects.toThrow('fetch failed');
    expect(h.attempts()).toBe(3); // 首次 + 2 次退避重试
  });

  it('对照：握手后断连（UND_ERR_SOCKET）的写操作绝不重试——结果未知不可重放', async () => {
    const h = await postWith(afterRequestSent, 1);
    await expect(h.client.postJson('/developers/v1/app_version/create/cli_x', {}))
      .rejects.toThrow('fetch failed');
    expect(h.attempts()).toBe(1);
  });

  it('对照：普通 ECONNRESET（非 pre-TLS 文案）的写操作也不重试——仅靠 code 判定不安全', async () => {
    const genericReset = () => new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    const h = await postWith(genericReset, 1);
    await expect(h.client.postJson('/developers/v1/publish/commit/cli_x/v1', {}))
      .rejects.toThrow('fetch failed');
    expect(h.attempts()).toBe(1);
  });

  // 判据必须是**整句精确匹配**，不能放宽成关键词包含。Node 内置的
  // `ConnResetException` 有多条文案共用 code=ECONNRESET，其中 `socket hang up`
  // （`_http_client.js`）是在请求**已发出之后**才抛的 —— 一旦用
  // `includes('disconnected')` 之类的松匹配，或把别的 ConnResetException 文案
  // 也算进来，写操作就会在「服务端可能已处理」的情况下被重放。
  it.each([
    ['socket hang up', 'ECONNRESET'],                                   // 请求已送达后
    ['aborted', 'ECONNRESET'],                                          // 响应中途断
    ['Client network socket disconnected', 'ECONNRESET'],               // 截断的近似文案
    ['socket disconnected before secure TLS handshake', 'ECONNRESET'],  // 改写过的近似文案
  ])('对照：ConnResetException 的其它文案 %j 不得被当成可重放', async (message, code) => {
    const near = () => new TypeError('fetch failed', {
      cause: Object.assign(new Error(message), { code }),
    });
    const h = await postWith(near, 1);
    await expect(h.client.postJson('/developers/v1/app_version/create/cli_x', {}))
      .rejects.toThrow('fetch failed');
    expect(h.attempts()).toBe(1);
  });

  it('调用方主动 abort 即使裹在 pre-TLS 文案里也不重试（不违背调用方意图）', async () => {
    const aborted = () => {
      const e = new Error('Client network socket disconnected before secure TLS connection was established');
      e.name = 'AbortError';
      (e as any).code = 'ECONNRESET';
      return new TypeError('fetch failed', { cause: e });
    };
    const h = await postWith(aborted, 1);
    await expect(h.client.postJson('/developers/v1/base_info/cli_x', {})).rejects.toThrow('fetch failed');
    expect(h.attempts()).toBe(1);
  });

  // AggregateError 一律不支持（有意收窄）：真实 Node pre-TLS 断连不是聚合体
  // ——`net.internalConnectMultiple` 只在**所有** TCP connect 失败时构造
  // NodeAggregateError，而这句文案由 `_tls_wrap.onConnectEnd` 在某条腿 connect
  // **成功之后**才可能产出，两者互斥。支持聚合体就得对 `.errors` 与同样合法的
  // `.cause` 都做全称量词检查，任一遗漏即 fail-open，证明责任配不上收益。
  it.each([
    ['全部成员都是 pre-TLS 文案', () => new AggregateError([
      Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }),
    ], '')],
    ['混合成员（一条已送达）', () => new AggregateError([
      Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ], '')],
    ['成员安全但 aggregate 自带不安全 cause', () => new AggregateError([
      Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }),
    ], '', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })],
    ['空 errors', () => new AggregateError([], '')],
  ])('AggregateError（%s）的写操作一律不重试', async (_label, mk) => {
    const h = await postWith(() => new TypeError('fetch failed', { cause: mk() }), 1);
    await expect(h.client.postJson('/developers/v1/app_version/create/cli_x', {}))
      .rejects.toThrow('fetch failed');
    expect(h.attempts()).toBe(1);
  });

  it('精确文案节点自带 cause 时 fail-closed（Node 构造 ConnResetException 不挂 cause）', async () => {
    const tampered = () => {
      const leaf = Object.assign(
        new Error('Client network socket disconnected before secure TLS connection was established'),
        { code: 'ECONNRESET' },
      );
      (leaf as any).cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return new TypeError('fetch failed', { cause: leaf });
    };
    const h = await postWith(tampered, 1);
    await expect(h.client.postJson('/developers/v1/publish/commit/cli_x/v1', {}))
      .rejects.toThrow('fetch failed');
    expect(h.attempts()).toBe(1);
  });

  // 运行时边界：本特判绑定 Node/undici 的错误形态。Bun 原生 fetch 对同一真实
  // 故障（accept 后立即断）抛的是顶层 `TypeError`、message
  // `The socket connection was closed unexpectedly...`、code=ECONNRESET、**无
  // cause**，不满足精确文案 ⟹ 不会命中。这是**已知的跨运行时缺口**而非安全
  // 问题（不重试 = 保持旧行为）；要覆盖 Bun 必须先为它的文案建立同等级
  // 「只可能握手前」证明，不能只凭 code=ECONNRESET。本用例把该边界钉住，
  // 避免日后有人误以为 Bun 路径已被覆盖。
  it('Bun 原生 pre-TLS 错误形态（无 cause）不命中特判 —— 已知跨运行时缺口', async () => {
    const bunShaped = () => Object.assign(
      new TypeError('The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'),
      { code: 'ECONNRESET' },
    );
    const h = await postWith(bunShaped, 1);
    await expect(h.client.postJson('/developers/v1/base_info/cli_x', {}))
      .rejects.toThrow('socket connection was closed');
    expect(h.attempts()).toBe(1);
  });
});

// 语义幂等的 console POST（robot/event switch 设值、只读拉 Secret）与 GET/HEAD 同权
// 认全部瞬态错误，但**预算只在 fetchRaw 这一层**。历史上这三处在外层另包了一轮
// retry，与内层相乘成 3×3=9 次（实测 4.8s 退避）；更隐蔽的是**异构错误序列**——
// 内层先遇 2 次 pre-TLS、第 3 次是普通 reset 时，外层看到的是普通 reset 于是又跑
// 一轮，最坏仍能到 9。故断言各种序列下总尝试恒为 3。
describe('语义幂等 POST 的统一重试预算（防乘法重试回归）', () => {
  const PRE_TLS = 'Client network socket disconnected before secure TLS connection was established';
  const preTls = () => new TypeError('fetch failed', {
    cause: Object.assign(new Error(PRE_TLS), { code: 'ECONNRESET' }),
  });
  const genericReset = () => new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });

  /** 按序列逐次抛错（用尽后继续抛最后一个），返回真实发出的 POST 次数。 */
  async function attemptsFor(
    sequence: Array<() => Error>,
    call: (client: OpenPlatformApiClient) => Promise<unknown>,
  ): Promise<number> {
    let posts = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        const idx = posts;
        posts += 1;
        throw (sequence[idx] ?? sequence[sequence.length - 1])();
      }
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;
    const clientResult = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) throw new Error('client construction failed');
    await expect(call(clientResult.client)).rejects.toThrow();
    return posts;
  }

  it.each([
    ['全部 pre-TLS', [preTls]],
    ['全部普通 reset', [genericReset]],
    // 这一格是真实乘法 bug 的形态：外层只按「最终错误」短路时守不住 3。
    ['异构：pre-TLS, pre-TLS, 普通 reset…', [preTls, preTls, genericReset]],
    ['异构：普通 reset, pre-TLS…', [genericReset, preTls]],
  ])('postJsonIdempotent 在「%s」下总尝试恒为 3', async (_label, seq) => {
    const posts = await attemptsFor(
      seq,
      client => client.postJsonIdempotent('/developers/v1/robot/switch/cli_x', { clientId: 'cli_x', enable: true }),
    );
    expect(posts).toBe(3);
  });

  it('普通 postJson 不因此变宽：pre-TLS 仍 3 次，普通 reset 仍 1 次', async () => {
    expect(await attemptsFor([preTls], c => c.postJson('/developers/v1/app_version/create/cli_x', {}))).toBe(3);
    expect(await attemptsFor([genericReset], c => c.postJson('/developers/v1/app_version/create/cli_x', {}))).toBe(1);
  });
});

describe('safeErrorMessage', () => {
  it('展开 undici fetch failed 的 cause 链，露出真实网络错误', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
    });
    expect(safeErrorMessage(err)).toBe('fetch failed: connect ETIMEDOUT 1.2.3.4:443');
  });

  it('cause 是 happy-eyeballs 的 AggregateError 时取首个真实错误', () => {
    const err = new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }),
      ]),
    });
    expect(safeErrorMessage(err)).toBe('fetch failed: connect ECONNREFUSED 1.2.3.4:443');
  });

  it('message 里没有错误码时把 code 补进去', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo failure'), { code: 'EAI_AGAIN' }),
    });
    expect(safeErrorMessage(err)).toBe('fetch failed: getaddrinfo failure (EAI_AGAIN)');
  });

  it('仍然脱敏长 token', () => {
    const err = new Error(`bad token ${'a'.repeat(32)}`);
    expect(safeErrorMessage(err)).toBe('bad token ***');
  });
});
