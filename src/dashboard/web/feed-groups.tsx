import type React from 'react';
import { useEffect, useState } from 'react';

/**
 * 飞书标签（feed group）的读取 + 用户授权状态机，供「新建群聊」（groups 页）与
 * 「新建会话」（sessions 页）两个对话框共用：
 *
 *   GET  /api/feed-groups               → 标签列表 + 当前使用的 larkAppId
 *   GET  /api/feed-groups/auth-url      → 发起用户授权，拿到飞书授权链接
 *   POST /api/feed-groups/oauth-callback → 远程部署时手动粘贴回调地址完成授权
 *
 * 授权链接出现后每秒轮询一次 /api/feed-groups：本机部署时飞书回调由 daemon 自动
 * 接住，轮询一成功就关掉授权弹层；远程部署则保留弹层，让用户粘贴回调地址。
 */

export type FeedGroupOption = { groupId: string; name: string; type?: string };

async function fetchFeedGroups(): Promise<{ groups: FeedGroupOption[]; appId: string }> {
  const response = await fetch('/api/feed-groups');
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  return {
    groups: Array.isArray(body.groups) ? body.groups : [],
    appId: typeof body.larkAppId === 'string' ? body.larkAppId : '',
  };
}

export interface UseFeedGroupsOptions {
  /** 为 false 时不读取标签列表（对话框未打开 / 已出结果）。默认 true。 */
  enabled?: boolean;
  /** 变化时重新读取（对话框每次重新打开）。不传则只在挂载时读一次。 */
  reloadKey?: unknown;
  /** 授权发起 / 完成失败时回调；各页自己决定用 toast 还是对话框内错误行展示。 */
  onAuthError(kind: 'open' | 'complete', reason: string): void;
}

export function useFeedGroups(options: UseFeedGroupsOptions) {
  const enabled = options.enabled ?? true;
  const [groups, setGroups] = useState<FeedGroupOption[]>([]);
  const [appId, setAppId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authUrl, setAuthUrl] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');

  const applyLoaded = (loaded: { groups: FeedGroupOption[]; appId: string }) => {
    setGroups(loaded.groups);
    setAppId(loaded.appId);
    setError('');
  };
  const closeAuth = () => {
    setAuthUrl('');
    setCallbackUrl('');
  };

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    setLoading(true);
    void fetchFeedGroups()
      .then(loaded => { if (alive) applyLoaded(loaded); })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [enabled, options.reloadKey]);

  useEffect(() => {
    if (!authUrl) return undefined;
    let alive = true;
    const timer = window.setInterval(() => {
      void fetchFeedGroups()
        .then(loaded => {
          if (!alive) return;
          applyLoaded(loaded);
          closeAuth();
        })
        .catch(() => { /* remote/manual fallback remains visible */ });
    }, 1_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [authUrl]);

  async function openLogin(): Promise<void> {
    const query = appId ? `?larkAppId=${encodeURIComponent(appId)}` : '';
    const response = await fetch(`/api/feed-groups/auth-url${query}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.authUrl) {
      options.onAuthError('open', body.error ?? `HTTP ${response.status}`);
      return;
    }
    setAuthUrl(String(body.authUrl));
    setCallbackUrl('');
  }

  async function completeLogin(pastedUrl: string): Promise<void> {
    setAuthSubmitting(true);
    try {
      const response = await fetch('/api/feed-groups/oauth-callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callbackUrl: pastedUrl.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
      applyLoaded(await fetchFeedGroups());
      closeAuth();
    } catch (err) {
      options.onAuthError('complete', err instanceof Error ? err.message : String(err));
    } finally {
      setAuthSubmitting(false);
    }
  }

  return {
    groups,
    /** 当前读取标签所用的 larkAppId；创建请求里的 feedGroupAppId 取它。 */
    appId,
    loading,
    error,
    selectedId,
    newName,
    select(nextId: string, nextNewName: string) {
      setSelectedId(nextId);
      setNewName(nextNewName);
    },
    authUrl,
    callbackUrl,
    authSubmitting,
    setCallbackUrl,
    cancelAuth: closeAuth,
    openLogin,
    completeLogin,
    /** 对话框重新打开时清掉选择 / 错误 / 授权弹层（不动已读到的标签列表）。 */
    reset() {
      setSelectedId('');
      setNewName('');
      setError('');
      closeAuth();
    },
  };
}

export type FeedGroupsState = ReturnType<typeof useFeedGroups>;

/** 读取失败（多半是尚未授权）时的提示行 + 「立即授权」按钮。`className` 是各页自己的样式钩子。 */
export function FeedGroupAuthPrompt(props: { feed: FeedGroupsState; className: string }): React.JSX.Element | null {
  const { feed } = props;
  if (!feed.error) return null;
  return (
    <div className={props.className}>
      <small>{feed.error}</small>{' '}
      <button type="button" disabled={feed.authSubmitting} onClick={() => void feed.openLogin()}>
        {feed.authSubmitting ? '正在完成授权…' : '立即授权'}
      </button>
      <small> 授权后会弹窗提示你粘贴回调地址。</small>
    </div>
  );
}

/** 授权弹层：跳转飞书授权 + 远程部署时粘贴回调地址。`titleId` 供 aria-labelledby，两个对话框各用各的避免 id 冲突。 */
export function FeedGroupAuthOverlay(props: { feed: FeedGroupsState; titleId: string }): React.JSX.Element | null {
  const { feed, titleId } = props;
  if (!feed.authUrl) return null;
  return (
    <div className="feed-group-auth-overlay">
      <section className="feed-group-auth-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId}>授权飞书标签</h3>
        <p>点击下面的按钮，在飞书页面确认授权。如果 BotMux 与浏览器在同一台电脑，确认后会自动完成授权。如果 BotMux 运行在远程虚拟机上，浏览器会因无法访问本机地址 <code>127.0.0.1:9768</code> 而显示“无法访问”；此时请复制地址栏中的完整链接并粘贴到下方。</p>
        <button type="button" className="primary feed-group-auth-open" onClick={() => window.open(feed.authUrl, '_blank', 'noopener')}>跳转飞书授权</button>
        <label>
          <span>请把点击授权后的完整链接粘贴在这里</span>
          <input type="url" value={feed.callbackUrl} placeholder="http://127.0.0.1:9768/callback?code=…&state=…" onChange={event => feed.setCallbackUrl(event.currentTarget.value)} />
        </label>
        <div className="actions">
          <button type="button" onClick={feed.cancelAuth}>取消</button>
          <button type="button" className="primary" disabled={!feed.callbackUrl.trim() || feed.authSubmitting} onClick={() => void feed.completeLogin(feed.callbackUrl)}>
            {feed.authSubmitting ? '正在完成授权…' : '完成授权'}
          </button>
        </div>
      </section>
    </div>
  );
}
