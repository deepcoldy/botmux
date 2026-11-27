// 部署里各平台机器人的数量（飞书 / 企业微信），决定导航、创建入口和企业微信相关请求要不要出现。
import { useSyncExternalStore } from 'react';
import { providerDescriptor } from './providers/registry.js';
import type { ProviderDeploymentCapabilities, ProviderId } from './providers/types.js';

export interface ProviderRosterSnapshot {
  /** 两个平台的数量都已知。 */
  loaded: boolean;
  /** 企业微信的数量已知（来自看板快照或企业微信名单）。 */
  wecomKnown: boolean;
  hasLarkBots: boolean;
  hasWecomBots: boolean;
  /** 已确认只有企业微信机器人：隐藏飞书专属的入口。 */
  onlyWecom: boolean;
}

const counts: Partial<Record<ProviderId, number>> = {};
let snapshot: ProviderRosterSnapshot = {
  loaded: false,
  wecomKnown: false,
  hasLarkBots: false,
  hasWecomBots: false,
  onlyWecom: false,
};
const listeners = new Set<() => void>();

/**
 * 发布某个平台的机器人数量。数量只来自完整的名册来源：飞书 `/api/bots` 与名称快照，
 * 企业微信名单与看板快照里的连接数；从会话行推不出来，也不该推。
 */
export function publishProviderRoster(provider: ProviderId, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) return;
  counts[provider] = count;
  const larkCount = counts.lark;
  const wecomCount = counts.wecom;
  const loaded = larkCount !== undefined && wecomCount !== undefined;
  const next: ProviderRosterSnapshot = {
    loaded,
    wecomKnown: wecomCount !== undefined,
    hasLarkBots: !!larkCount,
    hasWecomBots: !!wecomCount,
    onlyWecom: loaded && larkCount === 0 && !!wecomCount,
  };
  const unchanged = (Object.keys(next) as Array<keyof ProviderRosterSnapshot>)
    .every(key => next[key] === snapshot[key]);
  if (unchanged) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * 看板快照里的企业微信连接数。服务端只在本机管理身份、且确实有企业微信连接时才带
 * `wecomConnectionCount`；字段缺省就是 0（没有连接，或这个身份看不到企业微信）。
 */
export function wecomConnectionCountFromSnapshot(body: unknown): number {
  const value = (body as { wecomConnectionCount?: unknown } | null | undefined)?.wecomConnectionCount;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function providerRosterSnapshot(): ProviderRosterSnapshot {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useProviderRoster(): ProviderRosterSnapshot {
  return useSyncExternalStore(subscribe, providerRosterSnapshot, providerRosterSnapshot);
}

/**
 * 部署级入口按哪个平台的能力表走：已确认只有企业微信时按企业微信；没加载完、混合部署、
 * 纯飞书都按飞书（与企业微信接入前一致）。
 */
export function deploymentProvider(state = providerRosterSnapshot()): ProviderId {
  return state.onlyWecom ? 'wecom' : 'lark';
}

/**
 * 混合部署里，部署级入口所按的平台（见 deploymentProvider）之外、也有机器人的平台。两个平台的数量都
 * 知道了才算；⌘K 为它们另列平台自己的配置条目。
 */
export function deploymentAdditionalProviders(state = providerRosterSnapshot()): ProviderId[] {
  if (!state.loaded) return [];
  const primary = deploymentProvider(state);
  const present: ProviderId[] = [];
  if (state.hasLarkBots) present.push('lark');
  if (state.hasWecomBots) present.push('wecom');
  return present.filter(provider => provider !== primary);
}

/** 名册已经确认部署里没有这个平台的机器人（数量已知且为 0）；还不知道时为 false。 */
export function deploymentLacksProvider(provider: ProviderId): boolean {
  return counts[provider] === 0;
}

export function deploymentSupports(
  feature: keyof ProviderDeploymentCapabilities,
  state = providerRosterSnapshot(),
): boolean {
  return providerDescriptor(deploymentProvider(state)).deployment[feature];
}

/** 部署不支持「群组」页（已确认只有企业微信）时，导航里不放它。 */
export function providerNavigationItems<T extends { id: string }>(
  items: readonly T[],
  state = providerRosterSnapshot(),
): T[] {
  return deploymentSupports('groupsNavigation', state) ? [...items] : items.filter(item => item.id !== 'groups');
}
