// 企业微信名册的来源：看板快照决定「有没有企业微信」，只有有的时候才去拉企业微信名单。
import { BOT_ONBOARDING_COMPLETED_EVENT } from './bot-onboarding-events.js';
import { loadWecomConnectionsSnapshot } from './overview.js';
import { providerRosterSnapshot, publishProviderRoster, wecomConnectionCountFromSnapshot } from './provider-roster.js';
import { store } from './store.js';

export interface WecomRosterSync {
  /** 每份看板快照（启动、对齐）和每次企业微信会话读取都交给它。 */
  onSessionSnapshot(body: unknown): void;
  /**
   * 每次探明登录态之后调用。身份降级到读不到企业微信时，清掉上一身份留下的企业微信行：
   * 降级后的对齐快照不带 `wecomSessionIds`，清不掉已关闭的企业微信行，只能在这里清。
   */
  onAuthStateLoaded(): void;
  dispose(): void;
}

/**
 * 页面启动本来就会拉 `/api/sessions?view=board`；服务端在有企业微信连接时往里带
 * `wecomConnectionCount`。这里据此发布企业微信名册，只在连接数变成非零（或变化）时拉一次
 * `/api/wecom/connections` 名单。没有企业微信连接的部署从头到尾不发任何 `/api/wecom/*` 请求。
 *
 * 另外两个入口：
 * - `bots.changed`：只有已知有企业微信时才顺带刷新名单；
 * - 创建向导完成（{@link BOT_ONBOARDING_COMPLETED_EVENT}，企业微信任务完成时由向导派发）：
 *   刚建出第一个企业微信机器人时看板快照还没刷新，靠这条通知立即拉名单，名册随之变为有企业微信。
 */
export function startWecomRosterSync(options: { canRead(): boolean; onUpdate(): void }): WecomRosterSync {
  let lastCount: number | undefined;
  const refresh = (): void => {
    if (!options.canRead()) return;
    void loadWecomConnectionsSnapshot().then(() => options.onUpdate());
  };

  const onSessionSnapshot = (body: unknown): void => {
    const count = wecomConnectionCountFromSnapshot(body);
    publishProviderRoster('wecom', count);
    // 连接都没了，缓存里残留的企业微信会话也不该再显示。
    if (count === 0 && options.canRead() && store.hasProviderSessions()) store.replaceProviderRows([], []);
    if (count > 0 && count !== lastCount) refresh();
    lastCount = count;
  };

  const offBots = store.onBotsChanged(() => {
    if (providerRosterSnapshot().hasWecomBots) refresh();
  });
  const onOnboardingCompleted = (event: Event): void => {
    if ((event as CustomEvent<{ platform?: string }>).detail?.platform === 'wecom') refresh();
  };
  if (typeof window !== 'undefined') window.addEventListener?.(BOT_ONBOARDING_COMPLETED_EVENT, onOnboardingCompleted);

  return {
    onSessionSnapshot,
    onAuthStateLoaded: () => {
      if (!options.canRead() && store.hasProviderSessions()) store.replaceProviderRows([], []);
    },
    dispose: () => {
      offBots();
      if (typeof window !== 'undefined') window.removeEventListener?.(BOT_ONBOARDING_COMPLETED_EVENT, onOnboardingCompleted);
    },
  };
}
