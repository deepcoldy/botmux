import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveVcMeetingConsumerProfiles } from '../src/bot-registry.js';

vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class FakeClient {} }));

/**
 * 每个用例都从干净模块图起：全局配置有读缓存，而共享目录的读路径三态判定
 * （uninitialized / explicit_empty / profiles）正是靠原始 JSON 区分的。
 */
async function freshModules() {
  vi.resetModules();
  return {
    globalConfig: await import('../src/global-config.js'),
    store: await import('../src/services/vc-meeting-shared-consumer-catalog-store.js'),
    bind: await import('../src/services/vc-meeting-shared-consumer-catalog.js'),
  };
}

type Raw = Record<string, unknown>;

describe('vc meeting shared consumer catalog store', () => {
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-vc-shared-catalog-'));
    vi.stubEnv('HOME', home);
    const { globalConfig } = await freshModules();
    mkdirSync(dirname(globalConfig.globalConfigPath()), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  async function writeGlobal(vcMeetingAgent: Raw): Promise<void> {
    const { globalConfig } = await freshModules();
    writeFileSync(globalConfig.globalConfigPath(), JSON.stringify({ vcMeetingAgent }, null, 2), 'utf8');
  }

  async function readGlobalRaw(): Promise<Raw> {
    const { globalConfig } = await freshModules();
    return JSON.parse(readFileSync(globalConfig.globalConfigPath(), 'utf8')) as Raw;
  }

  function sharedProfile(over: Raw = {}): Raw {
    return {
      id: 'minutes',
      label: '会议纪要',
      role: 'minutes',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ...over,
    };
  }

  it('falls back to the built-in default when the catalog was never configured', async () => {
    const { store } = await freshModules();
    const snap = store.readVcMeetingSharedConsumerCatalogSnapshot();

    // 「装好就能用」：43/47 个 bot 从来没有 vcMeetingAgent 配置，读路径内置默认
    // 才能让它们被拉进会时就有角色可跑，且不需要 daemon 启动时抢着写配置。
    expect(snap.catalogState).toBe('uninitialized');
    expect(snap.profiles.map(profile => profile.id)).toEqual(['minutes']);
    expect(snap.defaultMode).toBe('agents');
    expect(snap.defaultConsumerIds).toEqual(['minutes']);
    // 目录条目**没有**执行方字段：执行方是被拉进会的那个 bot 自己。
    expect(Object.keys(snap.profiles[0])).not.toContain('agentAppId');
    // 读一次不产生任何写盘。
    expect(() => readFileSync(store.vcMeetingSharedConsumerCatalogConfigPath(), 'utf8')).toThrow();
  });

  it('keeps an explicitly emptied catalog empty instead of resurrecting the built-in default', async () => {
    await writeGlobal({ consumerCatalog: { profiles: [], defaultMode: 'listenOnly', defaultConsumerIds: [] } });
    const { store } = await freshModules();
    const snap = store.readVcMeetingSharedConsumerCatalogSnapshot();

    expect(snap.catalogState).toBe('explicit_empty');
    expect(snap.profiles).toEqual([]);
    expect(snap.defaultMode).toBe('listenOnly');
  });

  it('hashes the raw catalog so a hand edit that normalization drops still bumps the revision', async () => {
    await writeGlobal({ consumerCatalog: { profiles: [sharedProfile()], defaultMode: 'listenOnly', defaultConsumerIds: [] } });
    const before = (await freshModules()).store.readVcMeetingSharedConsumerCatalogSnapshot();

    // defaultConsumerIds 指向不存在的预设：读路径会把它过滤掉，归一化结果与上面
    // 完全相同——若 revision 哈希的是归一化结果，这次手改就会悄悄绕过乐观并发。
    await writeGlobal({
      consumerCatalog: { profiles: [sharedProfile()], defaultMode: 'listenOnly', defaultConsumerIds: ['ghost'] },
    });
    const after = (await freshModules()).store.readVcMeetingSharedConsumerCatalogSnapshot();

    expect(after.defaultConsumerIds).toEqual([]);
    expect(after.profiles).toEqual(before.profiles);
    expect(after.revision).not.toBe(before.revision);
  });

  it('drops only the unparsable entry on read, keeping the rest of the catalog alive', async () => {
    await writeGlobal({
      consumerCatalog: {
        profiles: [sharedProfile(), { id: 'broken', role: 'x', responseMode: 'nonsense', capabilities: [] }],
        defaultMode: 'agents',
        defaultConsumerIds: ['minutes'],
      },
    });
    const { store } = await freshModules();
    const snap = store.readVcMeetingSharedConsumerCatalogSnapshot();

    // 目录是**全局**的：手改配置写坏一条，不能让全 fleet 的 bot 一起变成干听。
    // 读路径逐条 forgiving（坏条目消失），保存路径才是权威校验。
    expect(snap.profiles.map(profile => profile.id)).toEqual(['minutes']);
    expect(snap.defaultConsumerIds).toEqual(['minutes']);
  });

  it('rejects a stale expectedRevision without writing', async () => {
    await writeGlobal({ consumerCatalog: { profiles: [sharedProfile()], defaultMode: 'listenOnly', defaultConsumerIds: [] } });
    const { store } = await freshModules();
    const result = store.updateVcMeetingSharedConsumerCatalog({
      expectedRevision: 'sha256:stale',
      defaultMode: 'listenOnly',
      defaultConsumerIds: [],
      profiles: [],
    });

    expect(result).toEqual({ ok: false, reason: 'config_conflict' });
    expect(((await readGlobalRaw()).vcMeetingAgent as Raw).consumerCatalog).toMatchObject({
      profiles: [expect.objectContaining({ id: 'minutes' })],
    });
  });

  it('refuses two default roles in plain language (one bot runs one role)', async () => {
    const { store } = await freshModules();
    const current = store.readVcMeetingSharedConsumerCatalogSnapshot();
    const result = store.updateVcMeetingSharedConsumerCatalog({
      expectedRevision: current.revision,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes', 'facilitator'],
      profiles: [sharedProfile(), sharedProfile({ id: 'facilitator', role: 'facilitator', label: '主持' })] as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_failed');
    expect(result.fieldErrors?.[0].path).toBe('defaultConsumerIds');
    expect(result.fieldErrors?.[0].message).toContain('只能有一个默认角色');
  });

  it('reports a DTO-shaped field path for a malformed profile without writing', async () => {
    const { store } = await freshModules();
    const current = store.readVcMeetingSharedConsumerCatalogSnapshot();
    const result = store.updateVcMeetingSharedConsumerCatalog({
      expectedRevision: current.revision,
      defaultMode: 'listenOnly',
      defaultConsumerIds: [],
      profiles: [sharedProfile({ responseMode: 'nonsense' })] as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_failed');
    expect(result.fieldErrors?.[0].path).toMatch(/^profiles/u);
  });

  it('rejects "agents" with nothing selected instead of silently downgrading it', async () => {
    const { store } = await freshModules();
    const current = store.readVcMeetingSharedConsumerCatalogSnapshot();
    const result = store.updateVcMeetingSharedConsumerCatalog({
      expectedRevision: current.revision,
      defaultMode: 'agents',
      defaultConsumerIds: [],
      profiles: [sharedProfile()] as never,
    });

    // UI 侧删预设/清空 id 时会同步把 defaultMode 降回 listenOnly，所以这个组合
    // 只会来自直接打 API；宁可 422 也不猜操作者想要哪个角色。
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_failed');
    // 错误必须落在 UI 真的会渲染的锚点上（这两个锚点在默认角色区相邻渲染），
    // 否则用户只看到「保存失败」却找不到哪一项有问题。
    expect(['defaultMode', 'defaultConsumerIds']).toContain(result.fieldErrors?.[0].path);
  });

  it('never persists an executor field, even if the client injects one', async () => {
    const { store } = await freshModules();
    const current = store.readVcMeetingSharedConsumerCatalogSnapshot();
    const result = store.updateVcMeetingSharedConsumerCatalog({
      expectedRevision: current.revision,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      profiles: [sharedProfile({ agentAppId: 'cli_someone_else' })] as never,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.revision).not.toBe(current.revision);
    expect(Object.keys(result.snapshot.profiles[0])).not.toContain('agentAppId');

    const persisted = ((await readGlobalRaw()).vcMeetingAgent as Raw).consumerCatalog as Raw;
    // 回归：注入的 agentAppId 绝不能落盘——它正是「拉 A 进会却把 B 拉进群」的载体。
    expect(JSON.stringify(persisted)).not.toContain('agentAppId');
    expect(JSON.stringify(persisted)).not.toContain('cli_someone_else');
  });

  it('preserves unrelated global settings across a catalog write', async () => {
    await writeGlobal({ enabled: true, listenerBotAppId: 'cli_legacy_pin' });
    const { globalConfig } = await freshModules();
    globalConfig.mergeGlobalConfig({ lang: 'en' });

    const { store } = await freshModules();
    const current = store.readVcMeetingSharedConsumerCatalogSnapshot();
    const result = store.updateVcMeetingSharedConsumerCatalog({
      expectedRevision: current.revision,
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      profiles: [sharedProfile()] as never,
    });

    expect(result.ok).toBe(true);
    const raw = await readGlobalRaw();
    expect(raw.lang).toBe('en');
    expect((raw.vcMeetingAgent as Raw).enabled).toBe(true);
    expect((raw.vcMeetingAgent as Raw).listenerBotAppId).toBe('cli_legacy_pin');
  });
});

describe('bindVcMeetingConsumerCatalogToBot', () => {
  const SELF = 'cli_self';
  const OTHER = 'cli_other';

  function catalog(over: Record<string, unknown> = {}) {
    return {
      profiles: [{
        id: 'minutes',
        label: '会议纪要',
        role: 'minutes',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
      }],
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      ...over,
    } as never;
  }

  function seededProfile(agentAppId: string) {
    return {
      id: 'minutes',
      agentAppId,
      label: '会议纪要',
      role: 'minutes',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      instructions: '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。',
    };
  }

  async function bindModule() {
    const { bind } = await freshModules();
    bind.__resetSharedConsumerCatalogWarnState();
    return bind;
  }

  it('gives a bot with no VC consumer config the shared catalog, bound to itself', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, { enabled: true } as never, {
      readCatalog: () => catalog(),
    });

    expect(out.meetingConsumer?.enabled).toBe(true);
    expect(out.meetingConsumer?.consumerProfiles?.map(profile => profile.agentAppId)).toEqual([SELF]);
    expect(out.meetingConsumer?.defaultMode).toBe('agents');
    expect(out.meetingConsumer?.defaultConsumerIds).toEqual(['minutes']);
  });

  it('uses the built-in catalog when nothing is configured globally either', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, { enabled: true } as never, {
      readCatalog: () => undefined,
    });

    // 「没配过」和「显式清空」是两回事：前者落内置默认，后者是持久的「都不要」。
    expect(out.meetingConsumer?.consumerProfiles?.map(profile => profile.id)).toEqual(['minutes']);
    expect(out.meetingConsumer?.consumerProfiles?.[0].agentAppId).toBe(SELF);
  });

  it('honours an explicitly emptied shared catalog', async () => {
    const bind = await bindModule();
    const cfg = { enabled: true } as never;
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, cfg, {
      readCatalog: () => catalog({ profiles: [], defaultMode: 'listenOnly', defaultConsumerIds: [] }),
    });

    expect(out).toBe(cfg);
  });

  it('never rewrites operator-written per-bot profiles, including a deliberate cross-bot executor', async () => {
    const bind = await bindModule();
    // 多 agent 分工是真实用法：操作者可以有意把某个角色指给另一个 bot 跑。
    const cfg = {
      enabled: true,
      meetingConsumer: {
        enabled: true,
        consumerProfiles: [{
          id: 'review', agentAppId: OTHER, role: 'review',
          responseMode: 'silent', capabilities: ['meeting.read'],
        }],
        defaultMode: 'agents',
        defaultConsumerIds: ['review'],
      },
    } as never;
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, cfg, { readCatalog: () => catalog() });

    expect(out).toBe(cfg);
    expect(out.meetingConsumer?.consumerProfiles?.[0].agentAppId).toBe(OTHER);
  });

  it('treats an explicit empty per-bot list as "this bot takes no role"', async () => {
    const bind = await bindModule();
    const cfg = { enabled: true, meetingConsumer: { enabled: true, consumerProfiles: [] } } as never;

    expect(bind.bindVcMeetingConsumerCatalogToBot(SELF, cfg, { readCatalog: () => catalog() })).toBe(cfg);
  });

  it('leaves legacy executor policy (agentCandidates / defaultAgentAppId) alone', async () => {
    const bind = await bindModule();
    for (const legacy of [
      { agentCandidates: [OTHER] },
      { defaultAgentAppId: OTHER },
      { defaultAgent: OTHER },
      { agents: [OTHER] },
    ]) {
      const cfg = { enabled: true, meetingConsumer: { enabled: true, ...legacy } } as never;
      expect(bind.bindVcMeetingConsumerCatalogToBot(SELF, cfg, { readCatalog: () => catalog() })).toBe(cfg);
    }
  });

  it('lets a v2 seeded block fall back to the shared catalog and re-binds the executor to self', async () => {
    // 这就是用户看到的「拉 A 进会，却把 B 拉进监听群」：播种把另一个 bot 的 appId
    // 焊进了预设。读路径忽略播种残留即修好，磁盘残留原样留着（零迁移写盘）。
    const bind = await bindModule();
    const cfg = {
      enabled: true,
      meetingConsumer: {
        enabled: true,
        consumerProfiles: [seededProfile(OTHER)],
        defaultMode: 'agents',
        defaultConsumerIds: ['minutes'],
        defaultProfileBootstrap: { generatorVersion: 2, profileId: 'minutes', configHash: 'sha256:whatever' },
      },
    } as never;
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, cfg, {
      readCatalog: () => catalog({
        profiles: [{
          id: 'minutes', label: '共享纪要', role: 'minutes',
          responseMode: 'listener_thread', capabilities: ['meeting.read', 'listener.output.request'],
        }],
      }),
    });

    expect(out.meetingConsumer?.consumerProfiles?.map(profile => profile.agentAppId)).toEqual([SELF]);
    expect(out.meetingConsumer?.consumerProfiles?.[0].label).toBe('共享纪要');
    expect(cfg.meetingConsumer.consumerProfiles[0].agentAppId).toBe(OTHER); // 入参不被改
  });

  // 回归(PR#916 codex阻断②):seeded 块被判要忽略后,若共享目录不可用而 fallback
  // 原样 `return cfg`,焊死的 foreign appId 会从 fallback 复活——正是 PR 要消灭的
  // 「拉 A 拉 B」。fallback 对 seeded 必须剥成仅监听。
  const seededV2Cfg = () => ({
    enabled: true,
    meetingConsumer: {
      enabled: true,
      consumerProfiles: [seededProfile(OTHER)],
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      defaultProfileBootstrap: { generatorVersion: 2, profileId: 'minutes', configHash: 'sha256:whatever' },
    },
  }) as never;

  it('strips a seeded block (not resurrect foreign appId) when the catalog is explicitly emptied', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, seededV2Cfg(), {
      readCatalog: () => catalog({ profiles: [], defaultMode: 'listenOnly', defaultConsumerIds: [] }),
    });
    // 目录显式清空 → 该 bot 不跑角色;但绝不能把 OTHER 的预设留在配置里。
    expect(out.meetingConsumer?.consumerProfiles).toEqual([]);
    expect(out.meetingConsumer?.defaultMode).toBe('listenOnly');
  });

  it('strips a seeded block when every catalog entry is invalid (foreign appId never survives fallback)', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, seededV2Cfg(), {
      // 整份目录都是坏条目 → bound.length===0 fallback;seeded 仍须剥离。
      readCatalog: () => catalog({ profiles: [{ id: 'bad', role: 'minutes', responseMode: 'nope' }] }),
    });
    expect(out.meetingConsumer?.consumerProfiles).toEqual([]);
    expect(out.meetingConsumer?.defaultMode).toBe('listenOnly');
    const appIds = (out.meetingConsumer?.consumerProfiles ?? []).map(p => p.agentAppId);
    expect(appIds).not.toContain(OTHER);
  });

  it('clears a v2 seeded defaultConsumerIds on the listenOnly main path (no auto-activate)', async () => {
    // pi 复审阻断(同类第三处):v2 播种块自带 defaultConsumerIds:['minutes'],共享目录
    // 配成 listenOnly(保留 minutes 供会中切换)时,它会经 spread 存活,初始默认选择
    // resolveVcMeetingConsumerProfiles(cfg, undefined) 把 minutes 选成默认→被播种过的
    // bot 无视操作者 listenOnly 自动激活。修:listenOnly 分支显式 defaultConsumerIds:[]。
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, seededV2Cfg(), {
      // 目录保留 minutes 角色但全局默认 listenOnly(纪要角色仍可会中手动切)。
      readCatalog: () => catalog({ defaultMode: 'listenOnly', defaultConsumerIds: [] }),
    });
    expect(out.meetingConsumer?.defaultMode).toBe('listenOnly');
    // 关键:残留的 ['minutes'] 必须被清空,否则 resolver 会拿它当默认选中。
    expect(out.meetingConsumer?.defaultConsumerIds).toEqual([]);
    const resolution = resolveVcMeetingConsumerProfiles(out.meetingConsumer!, undefined);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.selectedProfiles).toEqual([]);
  });

  it('lets a pre-provenance (v1) seeded block fall back too, but keeps a near miss', async () => {
    const bind = await bindModule();
    const v1 = (profile: Record<string, unknown>) => ({
      enabled: true,
      meetingConsumer: { enabled: true, defaultMode: 'listenOnly', consumerProfiles: [profile] },
    }) as never;

    const seeded = bind.bindVcMeetingConsumerCatalogToBot(SELF, v1(seededProfile(OTHER)), {
      readCatalog: () => catalog(),
    });
    expect(seeded.meetingConsumer?.consumerProfiles?.map(profile => profile.agentAppId)).toEqual([SELF]);

    // 差一个字段就当操作者内容：v1 只能按形状识别，宁可保守。
    const nearMiss = v1({ ...seededProfile(OTHER), instructions: '我自己改过的指令' });
    expect(bind.bindVcMeetingConsumerCatalogToBot(SELF, nearMiss, { readCatalog: () => catalog() }))
      .toBe(nearMiss);
  });

  it('selects at most one default role even if the catalog lists several', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, { enabled: true } as never, {
      readCatalog: () => catalog({
        profiles: [
          { id: 'minutes', role: 'minutes', responseMode: 'silent', capabilities: ['meeting.read'] },
          { id: 'facilitator', role: 'facilitator', responseMode: 'silent', capabilities: ['meeting.read'] },
        ],
        defaultConsumerIds: ['minutes', 'facilitator'],
      }),
    });

    // 绑定后两条预设的 agentAppId 都是这个 bot，resolver 会拒绝同时选中两条。
    expect(out.meetingConsumer?.consumerProfiles).toHaveLength(2);
    expect(out.meetingConsumer?.defaultConsumerIds).toEqual(['minutes']);
  });

  it('honors a per-bot catalogDefaultConsumerId over the catalog global default', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(
      SELF,
      { enabled: true, meetingConsumer: { catalogDefaultConsumerId: 'facilitator' } } as never,
      {
        readCatalog: () => catalog({
          profiles: [
            { id: 'minutes', role: 'minutes', responseMode: 'silent', capabilities: ['meeting.read'] },
            { id: 'facilitator', role: 'facilitator', responseMode: 'silent', capabilities: ['meeting.read'] },
          ],
          defaultConsumerIds: ['minutes'],
        }),
      },
    );
    // per-bot 挑了 facilitator，覆盖全局默认 minutes。
    expect(out.meetingConsumer?.defaultMode).toBe('agents');
    expect(out.meetingConsumer?.defaultConsumerIds).toEqual(['facilitator']);
  });

  it('per-bot default forces agents mode even when the catalog global is listen-only', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(
      SELF,
      { enabled: true, meetingConsumer: { catalogDefaultConsumerId: 'minutes' } } as never,
      { readCatalog: () => catalog({ defaultMode: 'listenOnly', defaultConsumerIds: [] }) },
    );
    expect(out.meetingConsumer?.defaultMode).toBe('agents');
    expect(out.meetingConsumer?.defaultConsumerIds).toEqual(['minutes']);
  });

  it('ignores a per-bot default that is not in the catalog, falling back to the global default', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(
      SELF,
      { enabled: true, meetingConsumer: { catalogDefaultConsumerId: 'ghost' } } as never,
      { readCatalog: () => catalog() },
    );
    // 'ghost' 不在目录里 → 当没配、回落全局默认 minutes。
    expect(out.meetingConsumer?.defaultConsumerIds).toEqual(['minutes']);
  });

  it('drops default ids that no longer exist, falling back to listen-only', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, { enabled: true } as never, {
      readCatalog: () => catalog({ defaultConsumerIds: ['ghost'] }),
    });

    expect(out.meetingConsumer?.consumerProfiles).toHaveLength(1);
    expect(out.meetingConsumer?.defaultMode).toBe('listenOnly');
  });

  it('keeps listen-only catalogs listen-only (roles are still switchable in-meeting)', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, { enabled: true } as never, {
      readCatalog: () => catalog({ defaultMode: 'listenOnly', defaultConsumerIds: [] }),
    });

    expect(out.meetingConsumer?.defaultMode).toBe('listenOnly');
    expect(out.meetingConsumer?.consumerProfiles).toHaveLength(1);
  });

  it('drops only the broken catalog entry, still binding the good ones', async () => {
    const bind = await bindModule();
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, { enabled: true } as never, {
      readCatalog: () => catalog({
        profiles: [
          { id: 'bad', role: 'bad', responseMode: 'nonsense', capabilities: [] },
          { id: 'minutes', role: 'minutes', responseMode: 'silent', capabilities: ['meeting.read'] },
        ],
      }),
    });

    // daemon 侧丢弃的条目必须与 Dashboard 读到的一致，否则页面上列着的角色
    // 一个都跑不起来。
    expect(out.meetingConsumer?.consumerProfiles?.map(profile => profile.id)).toEqual(['minutes']);
    expect(out.meetingConsumer?.defaultConsumerIds).toEqual(['minutes']);
  });

  it('ignores a fully broken shared catalog instead of taking the whole fleet down', async () => {
    const bind = await bindModule();
    const cfg = { enabled: true } as never;
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, cfg, {
      readCatalog: () => catalog({
        profiles: [{ id: 'bad', role: 'bad', responseMode: 'nonsense', capabilities: [] }],
      }),
    });

    // 一份坏的全局目录只丢弃自己，不能让每个 bot 的会议能力一起挂。
    expect(out).toBe(cfg);
  });

  it('returns the config untouched for a bot with no appId', async () => {
    const bind = await bindModule();
    const cfg = { enabled: true } as never;

    expect(bind.bindVcMeetingConsumerCatalogToBot('', cfg, { readCatalog: () => catalog() })).toBe(cfg);
  });

  it('preserves unrelated meetingConsumer fields while binding', async () => {
    const bind = await bindModule();
    const cfg = {
      enabled: true,
      meetingConsumer: { enabled: false, injectIntervalMs: 30_000 },
    } as never;
    const out = bind.bindVcMeetingConsumerCatalogToBot(SELF, cfg, { readCatalog: () => catalog() });

    expect(out.meetingConsumer?.injectIntervalMs).toBe(30_000);
    // 显式关掉会议消费的 bot 不会被共享目录偷偷打开。
    expect(out.meetingConsumer?.enabled).toBe(false);
    expect(out.meetingConsumer?.consumerProfiles?.[0].agentAppId).toBe(SELF);
  });
});
