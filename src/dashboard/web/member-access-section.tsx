import { useEffect, useMemo, useRef, useState } from 'react';
import { GRANT_DURATION_OPTIONS } from '../../services/grant-policy.js';
import type { GroupChat, GroupMemberBot } from './groups-api.js';
import { loadGroupMemberDisplays, type GroupMemberDisplay } from './roles.js';
import { toast } from './toast.js';

type Tr = (key: string, values?: Record<string, string | number>) => string;

const MAX_SUBJECTS = 50;
const READBACK_BATCH = 50;

const QUOTA_OPTIONS = ['1', '3', '5', '10', '20', '50', '100', '1000', 'unlimited'] as const;

type BlockedState = { raw: string[]; resolved: string[] };

/**
 * 群成员精确授权 / 整群授权 / 黑名单的 per-bot 管理面。
 *
 * open_id 是 app-scoped：成员列表（members-display）、精确授权、黑名单全部以
 * 当前选中的在群 bot 为视角，切 bot 必须整体重取，禁止跨 bot 复用 ou_。
 */
export function MemberAccessSection(props: {
  chat: GroupChat;
  members: GroupMemberBot[];
  disabled?: boolean;
  tr: Tr;
}) {
  const { chat, members, tr } = props;
  const disabled = props.disabled === true || members.length === 0;
  const [appId, setAppId] = useState(members[0]?.larkAppId ?? '');
  const [displays, setDisplays] = useState<GroupMemberDisplay[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [granted, setGranted] = useState<Set<string>>(() => new Set());
  const [blocked, setBlocked] = useState<BlockedState>({ raw: [], resolved: [] });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [quotaOption, setQuotaOption] = useState<string>('3');
  const [durationOption, setDurationOption] = useState<string>(String(GRANT_DURATION_OPTIONS[0]));
  const [busy, setBusy] = useState(false);
  // 懒加载：ManageDialog 一打开就为每个在群 bot 打 members-display / 黑名单 /
  // readback 三个请求太吵；折叠区首次展开才加载。
  const [active, setActive] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!members.some(member => member.larkAppId === appId)) {
      setAppId(members[0]?.larkAppId ?? '');
    }
  }, [members, appId]);

  useEffect(() => {
    if (!active) return;
    if (!appId) {
      setDisplays(null);
      setGranted(new Set());
      setBlocked({ raw: [], resolved: [] });
      setSelected(new Set());
      return;
    }
    const seq = ++seqRef.current;
    setDisplays(null);
    setLoadError(false);
    setGranted(new Set());
    setBlocked({ raw: [], resolved: [] });
    setSelected(new Set());
    setSearch('');
    void loadAll(seq, appId);

    async function loadAll(seq: number, currentAppId: string): Promise<void> {
      try {
        const [memberList, blockedState] = await Promise.all([
          loadGroupMemberDisplays(currentAppId, chat.chatId),
          loadBlocked(currentAppId),
        ]);
        if (seq !== seqRef.current) return;
        setDisplays(memberList);
        setBlocked(blockedState);
        const active = await readbackGranted(currentAppId, chat.chatId, memberList);
        if (seq !== seqRef.current) return;
        setGranted(active);
      } catch {
        if (seq !== seqRef.current) return;
        setLoadError(true);
      }
    }
  }, [active, appId, chat.chatId]);

  const blockedSet = useMemo(() => new Set(blocked.resolved), [blocked]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const list = displays ?? [];
    const matched = keyword
      ? list.filter(member => member.name.toLowerCase().includes(keyword) || member.openId.toLowerCase().includes(keyword))
      : list;
    return {
      users: matched.filter(member => member.memberType !== 'bot'),
      bots: matched.filter(member => member.memberType === 'bot'),
    };
  }, [displays, search]);

  function toggleMember(openId: string, checked: boolean): void {
    if (disabled || busy) return;
    setSelected(cur => {
      const next = new Set(cur);
      if (checked) next.add(openId);
      else next.delete(openId);
      return next;
    });
  }

  async function grantSelected(): Promise<void> {
    if (disabled || busy) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    if (ids.length > MAX_SUBJECTS) {
      toast(tr('grantAdmin.tooMany'), { kind: 'warning' });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/grants/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'grant',
          receiverLarkAppId: appId,
          chatId: chat.chatId,
          subjectOpenIds: ids,
          quota: quotaOption,
          durationMs: durationOption,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.ok) {
        const subjectIds = (body.subjects ?? []).map((s: any) => String(s.subjectOpenId));
        setGranted(cur => new Set([...cur, ...subjectIds]));
        setSelected(new Set());
        toast(tr('grantAdmin.grantOk', { count: subjectIds.length || ids.length }), { kind: 'success' });
        return;
      }
      // 成员已离群（receiver 视角 live membership 不含）：明确语义提示，
      // 不是网络错误。
      if (r.status === 409 && body.error === 'subject_not_current_chat_bot') {
        const count = Array.isArray(body.invalidSubjectOpenIds) ? body.invalidSubjectOpenIds.length : ids.length;
        toast(tr('grantAdmin.notInChat', { count }), { kind: 'warning' });
        return;
      }
      toast(`${tr('grantAdmin.grantFailed')}: ${body.error ?? r.status}`, { kind: 'error' });
    } catch (err) {
      toast(`Network error: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function setWholeGroup(grant: boolean): Promise<void> {
    if (disabled || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/chat-group-grant`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: chat.chatId, granted: grant }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.ok) {
        toast(grant ? tr('grantAdmin.wholeGrantOk') : tr('grantAdmin.wholeRevokeOk'), { kind: 'success' });
      } else {
        toast(`${tr('grantAdmin.wholeFailed')}: ${body.error ?? r.status}`, { kind: 'error' });
      }
    } catch (err) {
      toast(`Network error: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function setRowBlocked(openId: string, block: boolean): Promise<void> {
    if (disabled || busy) return;
    setBusy(true);
    try {
      if (block) {
        // 封禁仍走「GET 现有原始条目再全量 PUT」，避免并发编辑互相覆盖。
        const current = await loadBlocked(appId);
        const entries = current.raw.includes(openId) ? current.raw : [...current.raw, openId];
        const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/blocked-users`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entries }),
        });
        await handleBlockedWrite(r, block);
        return;
      }
      // 解除按 open_id 定向：后端会把邮箱 / on_ / 手机形态的别名条目一并
      // 反查剔除，前端不再依赖 raw 里恰好存在 ou_ 直值。
      const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/blocked-users`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ removeOpenIds: [openId] }),
      });
      await handleBlockedWrite(r, block);
    } catch (err) {
      toast(`Network error: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function handleBlockedWrite(r: Response, block: boolean): Promise<void> {
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.ok) {
      setBlocked({ raw: body.raw ?? [], resolved: body.resolved ?? [] });
      toast(block ? tr('blocked.rowBlockOk') : tr('blocked.rowUnblockOk'), { kind: 'success' });
    } else if (r.status === 409 || body.error === 'cannot_block_admin') {
      toast(tr('blocked.conflict'), { kind: 'warning' });
    } else if (r.status === 422 || body.error === 'empty_resolved') {
      toast(tr('blocked.emptyResolved'), { kind: 'warning' });
    } else {
      toast(`${tr('blocked.saveFailed')}: ${body.error ?? r.status}`, { kind: 'error' });
    }
  }

  if (members.length === 0) {
    return (
      <section className="g-member-access" data-member-access>
        <h4>{tr('grantAdmin.sectionTitle')}</h4>
        <p className="empty">{tr('grantAdmin.noBot')}</p>
      </section>
    );
  }

  return (
    <section className="g-member-access" data-member-access>
      <details
        data-member-access-toggle
        onToggle={ev => setActive(ev.currentTarget.open)}
      >
        <summary><h4>{tr('grantAdmin.sectionTitle')}</h4></summary>
        <p><small>{tr('grantAdmin.sectionHelp')}</small></p>
        <label className="checkbox-row">
          <strong>{tr('grantAdmin.botSwitcher')}</strong>
          <select
            data-action="bot-switch"
            value={appId}
            disabled={props.disabled === true || busy}
            onChange={ev => setAppId(ev.currentTarget.value)}
          >
            {members.map(member => (
              <option key={member.larkAppId} value={member.larkAppId}>
                {`${member.botName ?? member.larkAppId} (${member.larkAppId})`}
              </option>
            ))}
          </select>
        </label>

        {loadError ? <p className="hint-warn-inline">{tr('grantAdmin.loadFailed')}</p> : null}
        {active && displays === null && !loadError ? <p className="empty">{tr('grantAdmin.loading')}</p> : null}

        {displays !== null ? (
        <>
          <input
            type="search"
            data-action="member-search"
            placeholder={tr('grantAdmin.search')}
            value={search}
            disabled={disabled || busy}
            onChange={ev => setSearch(ev.currentTarget.value)}
          />
          <p><small>{tr('grantAdmin.selected', { count: selected.size })}</small></p>

          {(['users', 'bots'] as const).map(group => {
            const rows = filtered[group];
            return (
              <div className="g-member-access-group" key={group} data-member-group={group}>
                <strong>{tr(group === 'users' ? 'grantAdmin.groupUsers' : 'grantAdmin.groupBots')} ({rows.length})</strong>
                {rows.length === 0 ? <p className="empty">—</p> : rows.map(member => (
                  <MemberRow
                    key={member.openId}
                    member={member}
                    checked={selected.has(member.openId)}
                    granted={granted.has(member.openId)}
                    blocked={blockedSet.has(member.openId)}
                    disabled={disabled || busy}
                    tr={tr}
                    onToggle={toggleMember}
                    onSetBlocked={setRowBlocked}
                  />
                ))}
              </div>
            );
          })}

          <div className="g-member-access-controls">
            <label>
              {tr('grantAdmin.quota')}{' '}
              <select
                data-action="quota-select"
                value={quotaOption}
                disabled={disabled || busy}
                onChange={ev => setQuotaOption(ev.currentTarget.value)}
              >
                {QUOTA_OPTIONS.map(value => (
                  <option key={value} value={value}>
                    {value === 'unlimited' ? tr('grantAdmin.unlimited') : value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr('grantAdmin.duration')}{' '}
              <select
                data-action="duration-select"
                value={durationOption}
                disabled={disabled || busy}
                onChange={ev => setDurationOption(ev.currentTarget.value)}
              >
                {GRANT_DURATION_OPTIONS.map((ms, index) => (
                  <option key={ms} value={String(ms)}>{tr(DURATION_LABEL_KEYS[index] ?? 'grantAdmin.duration1h')}</option>
                ))}
                <option value="permanent">{tr('grantAdmin.permanent')}</option>
              </select>
            </label>
            <button
              type="button"
              className="primary"
              data-action="grant-selected"
              disabled={disabled || busy || selected.size === 0}
              onClick={() => void grantSelected()}
            >{tr('grantAdmin.grantSelected')}</button>
          </div>

          <div className="g-member-access-whole">
            <p><small>{tr('grantAdmin.wholeHelp')}</small></p>
            <button
              type="button"
              data-action="whole-grant"
              disabled={disabled || busy}
              onClick={() => void setWholeGroup(true)}
            >{tr('grantAdmin.wholeGrant')}</button>
            <button
              type="button"
              data-action="whole-revoke"
              disabled={disabled || busy}
              onClick={() => void setWholeGroup(false)}
            >{tr('grantAdmin.wholeRevoke')}</button>
          </div>
        </>
      ) : null}
      </details>
    </section>
  );
}

const DURATION_LABEL_KEYS = [
  'grantAdmin.duration1h',
  'grantAdmin.duration8h',
  'grantAdmin.duration24h',
  'grantAdmin.duration7d',
] as const;

function MemberRow(props: {
  member: GroupMemberDisplay;
  checked: boolean;
  granted: boolean;
  blocked: boolean;
  disabled: boolean;
  tr: Tr;
  onToggle(openId: string, checked: boolean): void;
  onSetBlocked(openId: string, block: boolean): void;
}) {
  const { member, tr } = props;
  return (
    <div className="checkbox-row" data-member-row={member.openId}>
      <input
        type="checkbox"
        data-action="member-select"
        value={member.openId}
        checked={props.checked}
        disabled={props.disabled}
        onChange={ev => props.onToggle(member.openId, ev.currentTarget.checked)}
      />
      <span className="checkbox-row-main">
        <strong>{member.name || member.openId}</strong>
        {member.name ? <small>({member.openId})</small> : null}
        {props.granted ? <small className="hint-ok"> · {tr('grantAdmin.grantedTag')}</small> : null}
        {props.blocked ? <small className="hint-warn-inline"> · {tr('blocked.rowBlockedTag')}</small> : null}
      </span>
      {props.blocked ? (
        <button
          type="button"
          data-action="row-unblock"
          disabled={props.disabled}
          onClick={() => void props.onSetBlocked(member.openId, false)}
        >{tr('blocked.rowUnblock')}</button>
      ) : (
        <button
          type="button"
          data-action="row-block"
          disabled={props.disabled}
          onClick={() => void props.onSetBlocked(member.openId, true)}
        >{tr('blocked.rowBlock')}</button>
      )}
    </div>
  );
}

async function loadBlocked(appId: string): Promise<BlockedState> {
  const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/blocked-users`, { method: 'GET' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) throw new Error(body.error ?? `blocked_users_${r.status}`);
  return {
    raw: Array.isArray(body.raw) ? body.raw.filter((x: unknown) => typeof x === 'string') : [],
    resolved: Array.isArray(body.resolved) ? body.resolved.filter((x: unknown) => typeof x === 'string') : [],
  };
}

// Readback is explicitly bounded by the service (MAX 50 subjects/request);
// batch accordingly and merge the active ids.
async function readbackGranted(
  appId: string,
  chatId: string,
  members: GroupMemberDisplay[],
): Promise<Set<string>> {
  const ids = members.map(member => member.openId);
  const active = new Set<string>();
  for (let start = 0; start < ids.length; start += READBACK_BATCH) {
    const batch = ids.slice(start, start + READBACK_BATCH);
    const r = await fetch(`/api/bots/${encodeURIComponent(appId)}/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'readback',
        receiverLarkAppId: appId,
        chatId,
        subjectOpenIds: batch,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok || !Array.isArray(body.subjects)) continue;
    for (const subject of body.subjects) {
      if (subject?.chatGrantActive === true) active.add(String(subject.subjectOpenId));
    }
  }
  return active;
}
