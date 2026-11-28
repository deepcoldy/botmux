import { useCallback, useEffect, useRef, useState } from 'react';
import type { WecomConnectionAction, WecomConnectionDto } from '../../im/wecom/contract/dashboard-dto.js';
import { BOT_ONBOARDING_COMPLETED_EVENT } from './bot-onboarding-events.js';
import { controlCsrfHeaders } from './control-csrf.js';
import { jget, sendJson } from './dashboard-api.js';
import { publishProviderRoster, useProviderRoster } from './provider-roster.js';
import { t } from './ui.js';

interface Snapshot {
  connections: WecomConnectionDto[];
}

interface Api {
  list(): Promise<{ status: number; body: Snapshot }>;
  action(id: string, action: WecomConnectionAction): Promise<{ ok: boolean; status: number }>;
}

const api: Api = {
  list: () => jget<Snapshot>('/api/wecom/connections'),
  action: (id, action) => sendJson('POST', `/api/wecom/connections/${encodeURIComponent(id)}/${action}`, undefined, controlCsrfHeaders()),
};

const ACTION_FAILED_KEYS: Record<WecomConnectionAction, string> = {
  start: 'wecom.connections.startFailed',
  stop: 'wecom.connections.stopFailed',
  restart: 'wecom.connections.restartFailed',
};

/** 有企业微信连接时刷新它们运行状态的间隔。 */
const WECOM_CONNECTIONS_POLL_MS = 5_000;

/** 两份连接名单逐条逐字段相同（DTO 是纯 JSON）。 */
function sameConnections(a: readonly WecomConnectionDto[], b: readonly WecomConnectionDto[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

export function useWecomConnections({ client = api }: { client?: Api } = {}) {
  // 名册（看板快照里的企业微信连接数）说没有企业微信时，这里一条 /api/wecom/* 请求都不发。
  const { hasWecomBots, wecomKnown } = useProviderRoster();
  const [items, setItems] = useState<WecomConnectionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [restricted, setRestricted] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const active = useRef(true);
  const sequence = useRef(0);
  const pendingRef = useRef(new Set<string>());
  const hasConnectionsRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    const seq = ++sequence.current;
    if (!silent) setRefreshing(true);
    try {
      const response = await client.list();
      if (!active.current || sequence.current !== seq) return;
      if (response.status === 401 || response.status === 403) {
        hasConnectionsRef.current = false;
        setRestricted(true);
        setItems([]);
        setError(undefined);
        return;
      }
      if (response.status !== 200 || !Array.isArray(response.body?.connections)) throw new Error('load');
      const connections = response.body.connections;
      publishProviderRoster('wecom', connections.length);
      hasConnectionsRef.current = connections.length > 0;
      // 内容没变就留着原数组：轮询每 5 秒拿到一份新数组，换掉它会让整个 Bot 配置页重渲染一遍。
      setItems(current => (sameConnections(current, connections) ? current : connections));
      setRestricted(false);
      setError(undefined);
    } catch {
      if (active.current && sequence.current === seq) setError(t('wecom.connections.refreshFailed'));
    } finally {
      if (active.current && sequence.current === seq) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [client]);

  useEffect(() => {
    if (!hasWecomBots) return;
    active.current = true;
    void refresh();
    const completed = () => void refresh(true);
    if (typeof window !== 'undefined') window.addEventListener?.(BOT_ONBOARDING_COMPLETED_EVENT, completed);
    // 新建的连接经创建向导完成事件进来（第一个连接由名册同步负责，名册一变这里就会重跑）。
    // 后台标签页不轮询（与总览同口径）；回到前台后下一拍照常刷新。
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (hasConnectionsRef.current && !pendingRef.current.size) void refresh(true);
    }, WECOM_CONNECTIONS_POLL_MS);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener?.(BOT_ONBOARDING_COMPLETED_EVENT, completed);
      active.current = false;
      sequence.current++;
      clearInterval(timer);
    };
  }, [refresh, hasWecomBots]);

  // The server answers once the action has begun; the connection then shows it in
  // progress, and the polling below picks up how it ended.
  const action = async (id: string, kind: WecomConnectionAction) => {
    if (pendingRef.current.has(id) || restricted || error) return;
    const item = items.find(value => value.id === id);
    const allowed = kind === 'start' ? item?.canStart : kind === 'stop' ? item?.canStop : item?.canRestart;
    if (!item || !allowed) return;
    pendingRef.current.add(id);
    setPending(new Set(pendingRef.current));
    try {
      const response = await client.action(id, kind);
      if (!active.current) return;
      if (!response.ok) throw new Error('action');
      await refresh(true);
    } catch {
      if (active.current) setError(t(ACTION_FAILED_KEYS[kind]));
    } finally {
      pendingRef.current.delete(id);
      if (active.current) setPending(new Set(pendingRef.current));
    }
  };

  return {
    connections: hasWecomBots ? items : [],
    // 还不知道有没有企业微信时算加载中，免得只有企业微信机器人的部署先闪一下空状态。
    loading: hasWecomBots ? loading : !wecomKnown,
    refreshing,
    restricted,
    error,
    pending,
    onRefresh: () => { if (hasWecomBots) void refresh(); },
    onAction: (id: string, kind: WecomConnectionAction) => void action(id, kind),
  };
}
