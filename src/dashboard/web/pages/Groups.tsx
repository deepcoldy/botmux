import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ChatRow, type GroupsPayload, type BotInfo, type MemberBot } from '../api.js';
import { allExpectedInChat } from '../groups-helpers.js';
import { useT } from '../i18n.js';
import { Card } from '../components/ui/Card.js';
import { Input, Checkbox } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { Table, Thead, Tbody, Tr, Th, Td } from '../components/ui/Table.js';
import { Dialog, DialogHeader, DialogBody, DialogFooter } from '../components/ui/Dialog.js';
import { CheckboxPicker } from '../components/ui/CheckboxPicker.js';
import { StatusText, type Status } from '../components/ui/StatusText.js';
import { KvLine } from '../components/ui/KvLine.js';
import { Spinner } from '../components/ui/Spinner.js';
import { RefreshButton } from '../components/ui/RefreshButton.js';
import { cn } from '../lib/utils.js';

const EMPTY: GroupsPayload = { chats: [], bots: [] };

export function GroupsPage() {
  const t = useT();
  const [data, setData] = useState<GroupsPayload>(EMPTY);
  const [q, setQ] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [successResp, setSuccessResp] = useState<any>(null);
  const [addBotsChat, setAddBotsChat] = useState<ChatRow | null>(null);
  const [manageChat, setManageChat] = useState<ChatRow | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const body = await api.groups();
      setData(body);
    } catch {
      /* tolerate */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return data.chats
      .filter(
        (c) =>
          !ql ||
          (c.name ?? '').toLowerCase().includes(ql) ||
          c.chatId.toLowerCase().includes(ql) ||
          (c.ownerId ?? '').toLowerCase().includes(ql),
      )
      .filter((c) => !missingOnly || c.memberBots.some((m) => !m.inChat));
  }, [data.chats, q, missingOnly]);

  function patchChat(chatId: string, next: ChatRow) {
    setData((prev) => ({ ...prev, chats: prev.chats.map((c) => (c.chatId === chatId ? next : c)) }));
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            placeholder={t.groups.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-72 flex-1"
          />
          <label className="flex items-center gap-1.5 text-sm text-slate-700 select-none cursor-pointer">
            <Checkbox checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
            {t.groups.missingBotOnly}
          </label>
          <RefreshButton onClick={reload} loading={loading} title={t.common.refresh} />
          <Button variant="primary" onClick={() => setCreateOpen(true)}>{t.groups.createGroup}</Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <Thead>
            <Tr className="hover:bg-transparent">
              <Th>{t.groups.chat}</Th>
              {data.bots.map((b) => (
                <Th key={b.larkAppId} className="text-center">{b.botName ?? b.larkAppId}</Th>
              ))}
              <Th>{t.groups.actions}</Th>
            </Tr>
          </Thead>
          <Tbody>
            {loading && data.chats.length === 0 && (
              <Tr className="hover:bg-transparent">
                <Td colSpan={Math.max(2, data.bots.length + 2)} className="text-center py-12">
                  <Spinner label={t.common.loading} />
                </Td>
              </Tr>
            )}
            {!loading && filtered.length === 0 && (
              <Tr className="hover:bg-transparent">
                <Td colSpan={data.bots.length + 2} className="text-center py-10 text-slate-400">
                  {t.groups.empty}
                </Td>
              </Tr>
            )}
            {filtered.map((c) => (
              <Tr key={c.chatId}>
                <Td>
                  <div className="font-medium text-slate-900">{c.name ?? c.chatId}</div>
                  <div className="text-[11px] text-slate-400 font-mono">{c.chatId}</div>
                </Td>
                {data.bots.map((b) => {
                  const m = c.memberBots.find((m) => m.larkAppId === b.larkAppId);
                  const cell = !m ? '?' : m.error ? '!' : m.inChat ? '✓' : '✗';
                  const cls = !m
                    ? 'text-amber-500'
                    : m.error ? 'text-red-500'
                    : m.inChat ? 'text-emerald-600'
                    : 'text-slate-300';
                  return (
                    <Td key={b.larkAppId} className={cn('text-center text-lg font-semibold', cls)} title={m?.error ?? ''}>
                      {cell}
                    </Td>
                  );
                })}
                <Td>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => setAddBotsChat(c)}>{t.groups.addBots}</Button>
                    <Button size="sm" variant="outline" onClick={() => setManageChat(c)}>{t.groups.manage}</Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>

      <CreateGroupModal
        open={createOpen}
        bots={data.bots}
        onClose={() => setCreateOpen(false)}
        onCreated={(resp, optimisticChat) => {
          setCreateOpen(false);
          setSuccessResp(resp);
          if (optimisticChat) {
            setData((prev) => ({
              ...prev,
              chats: [optimisticChat, ...prev.chats.filter((c) => c.chatId !== optimisticChat.chatId)],
            }));
          }
        }}
        onReconcile={reload}
      />

      <CreateSuccessDialog resp={successResp} onClose={() => setSuccessResp(null)} />

      <AddBotsModal
        chat={addBotsChat}
        allBots={data.bots}
        onClose={() => setAddBotsChat(null)}
        onDone={reload}
      />

      <ManageChatModal
        chat={manageChat}
        onClose={() => setManageChat(null)}
        onReload={reload}
        onPatch={patchChat}
      />
    </div>
  );
}

function CreateGroupModal({
  open, bots, onClose, onCreated, onReconcile,
}: {
  open: boolean;
  bots: BotInfo[];
  onClose: () => void;
  onCreated: (resp: any, optimisticChat: ChatRow | null) => void;
  onReconcile: () => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [bindWorkingDir, setBindWorkingDir] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setName(''); setBindWorkingDir(''); setPicked(new Set()); }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (picked.size === 0) { alert(t.groups.create.pickOne); return; }
    setBusy(true);
    const ids = [...picked];
    try {
      const resp = await api.createGroup({
        name: name.trim() || undefined,
        larkAppIds: ids,
        bindWorkingDir: bindWorkingDir.trim() || undefined,
      });
      if (resp.ok && resp.chatId) {
        const invalidBotIds: string[] = Array.isArray(resp.invalidBotIds) ? resp.invalidBotIds : [];
        const validIds = ids.filter((id) => !invalidBotIds.includes(id));
        const expected = new Set<string>(validIds);
        if (typeof resp.creator === 'string' && resp.creator) expected.add(resp.creator);
        const inChatSet = new Set(validIds);
        if (resp.creator) inChatSet.add(resp.creator);
        const optimistic: ChatRow = {
          chatId: resp.chatId,
          name: name.trim() || resp.chatId,
          ownerId: resp.creator ?? null,
          memberBots: bots.map((b) => ({
            larkAppId: b.larkAppId,
            botName: b.botName,
            inChat: inChatSet.has(b.larkAppId),
            oncallChat: null,
          })),
        };
        onCreated(resp, optimistic);
        void (async () => {
          const delays = [600, 1200, 1200, 1200, 1200, 1200];
          for (const d of delays) {
            await new Promise((r) => setTimeout(r, d));
            try {
              const next = await api.groups();
              const row = next.chats.find((c) => c.chatId === resp.chatId);
              if (row && allExpectedInChat(row, expected)) { await onReconcile(); return; }
            } catch { continue; }
          }
        })();
      } else {
        alert(t.schedules.failed(resp.error ?? 'unknown'));
        onClose();
      }
    } catch (e: any) {
      alert(t.schedules.networkError(e?.message ?? String(e)));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="max-w-xl">
      <DialogHeader>{t.groups.create.title}</DialogHeader>
      <form onSubmit={submit}>
        <DialogBody>
          <p className="text-xs text-slate-500">{t.groups.create.desc}</p>
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">
              {t.groups.create.name} <small>{t.groups.create.nameHint}</small>
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. AI ChangeLog"
              maxLength={60}
              className="w-full"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">
              {t.groups.create.bindDir} <small>{t.groups.create.nameHint}</small>
            </span>
            <Input
              value={bindWorkingDir}
              onChange={(e) => setBindWorkingDir(e.target.value)}
              placeholder="e.g. ~/projects/botmux"
              className="w-full font-mono text-xs"
            />
            <small className="text-[11px] text-slate-400 block">{t.groups.create.bindDirDesc}</small>
          </label>
          <fieldset className="border border-slate-200 rounded-lg p-3">
            <legend className="text-xs text-slate-500 px-2">{t.groups.create.bots}</legend>
            <CheckboxPicker
              items={bots.map((b) => ({
                id: b.larkAppId,
                label: b.botName ?? b.larkAppId,
                hint: <small className="text-slate-400 font-mono text-[10px]">({b.larkAppId})</small>,
              }))}
              selected={picked}
              onToggle={(id, on) => {
                const next = new Set(picked);
                if (on) next.add(id); else next.delete(id);
                setPicked(next);
              }}
              empty={<p className="text-sm text-slate-400 text-center py-4">{t.groups.create.noBots}</p>}
            />
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button variant="primary" type="submit" disabled={busy || picked.size === 0}>
            {busy ? t.groups.create.submitting : t.groups.create.submit}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function CreateSuccessDialog({ resp, onClose }: { resp: any | null; onClose: () => void }) {
  const t = useT();
  if (!resp) return null;
  const chatId = String(resp.chatId);
  const appLink = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
  const invalidBots: string[] = resp.invalidBotIds ?? [];
  const invalidUsers: string[] = resp.invalidUserIds ?? [];
  const auto = resp.autoInvitedOpenId as string | null | undefined;
  const rejected = !!resp.autoInviteRejected;
  const ownerTo = resp.ownerTransferredTo as string | null | undefined;
  const transferErr = resp.transferError as string | null | undefined;
  const notifyMsgId = resp.notifyMessageId as string | null | undefined;
  const notifyErr = resp.notifyError as string | null | undefined;
  const binds = Array.isArray(resp.oncallBindings) ? (resp.oncallBindings as any[]) : [];
  const bindOk = binds.filter((b) => b?.ok).length;
  const bindFailed = binds.filter((b) => !b?.ok);

  return (
    <Dialog open={!!resp} onClose={onClose} maxWidth="max-w-xl">
      <DialogHeader>{t.groups.success.title}</DialogHeader>
      <DialogBody>
        <KvLine label={t.groups.success.chatIdLabel} copy={chatId}><code className="text-xs">{chatId}</code></KvLine>
        <KvLine label={t.groups.success.creatorLabel}><code className="text-xs">{resp.creator ?? '?'}</code></KvLine>

        {auto ? (
          <Hint kind="ok">
            {t.groups.success.invitedOk(auto)}
            {ownerTo && <><br /><small>{t.groups.success.ownerTransferred}</small></>}
            {!ownerTo && transferErr && (
              <><br /><small className="text-amber-800">{t.groups.success.transferFailed(transferErr)}</small></>
            )}
            {notifyMsgId && <><br /><small>{t.groups.success.notified(notifyMsgId)}</small></>}
            {!notifyMsgId && notifyErr && (
              <><br /><small className="text-amber-800">{t.groups.success.notifyFailed(notifyErr)}</small></>
            )}
          </Hint>
        ) : rejected ? (
          <Hint kind="warn">{t.groups.success.inviteRejected}</Hint>
        ) : (
          <Hint kind="warn">{t.groups.success.noOwnerOpenId}</Hint>
        )}

        {binds.length > 0 && (
          bindFailed.length === 0 ? (
            <Hint kind="ok">{t.groups.success.bindOk(resp.bindResolvedPath ?? '', bindOk, binds.length)}</Hint>
          ) : (
            <Hint kind="warn">
              {t.groups.success.bindFailed(bindOk, binds.length)}
              {bindFailed.map((b, i) => (
                <div key={i} className="text-xs">
                  <code>{b.larkAppId ?? '?'}</code>: {b.error ?? 'unknown'}
                </div>
              ))}
            </Hint>
          )
        )}

        {(invalidBots.length > 0 || invalidUsers.length > 0) && (
          <ul className="text-xs list-disc list-inside text-slate-600 space-y-0.5">
            {invalidBots.length > 0 && <li>{t.groups.success.invalidBots} <code>{invalidBots.join(', ')}</code></li>}
            {invalidUsers.length > 0 && <li>{t.groups.success.invalidUsers} <code>{invalidUsers.join(', ')}</code></li>}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        <a
          className="inline-flex items-center h-9 px-3.5 text-sm rounded-md bg-blue-600 text-white border border-blue-600 hover:bg-blue-700 font-medium"
          href={appLink} target="_blank" rel="noopener"
        >
          {t.groups.success.open}
        </a>
        <Button variant="ghost" onClick={onClose}>{t.common.close}</Button>
      </DialogFooter>
    </Dialog>
  );
}

function Hint({ kind, children }: { kind: 'ok' | 'warn'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-md border-l-4 px-3 py-2 text-sm',
        kind === 'ok'
          ? 'bg-emerald-50 border-emerald-500 text-emerald-900'
          : 'bg-amber-50 border-amber-500 text-amber-900',
      )}
    >
      {children}
    </div>
  );
}

function AddBotsModal({
  chat, allBots, onClose, onDone,
}: {
  chat: ChatRow | null;
  allBots: BotInfo[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (chat) setPicked(new Set()); }, [chat]);

  if (!chat) return null;

  const inChatSet = new Set<string>(chat.memberBots.filter((m) => m.inChat).map((m) => m.larkAppId));
  const candidates = allBots.filter((b) => !inChatSet.has(b.larkAppId));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chat) return;
    if (picked.size === 0) { alert(t.groups.create.pickOne); return; }
    setBusy(true);
    try {
      const r = await api.addBots(chat.chatId, [...picked]);
      if (r.error === 'no_proxy_bot') {
        alert(t.groups.addBotsModal.noProxy);
      } else if (r.result) {
        const lines = (r.result as any[])
          .map((x) => `${x.id}: ${x.ok ? 'OK' : `failed (${x.error ?? 'unknown'})`}`)
          .join('\n');
        alert(lines);
        await onDone();
      } else {
        alert(`Unexpected response: ${JSON.stringify(r)}`);
      }
    } catch (e: any) {
      alert(t.schedules.networkError(e?.message ?? String(e)));
    } finally {
      setBusy(false);
      onClose();
    }
  }

  return (
    <Dialog open={!!chat} onClose={onClose} maxWidth="max-w-lg">
      <DialogHeader>{t.groups.addBotsModal.title(chat.name ?? chat.chatId)}</DialogHeader>
      <form onSubmit={submit}>
        <DialogBody>
          <p className="text-xs text-slate-500">{t.groups.addBotsModal.desc}</p>
          <CheckboxPicker
            items={candidates.map((b) => ({
              id: b.larkAppId,
              label: b.botName ?? b.larkAppId,
              hint: <small className="text-slate-400 font-mono text-[10px]">({b.larkAppId})</small>,
            }))}
            selected={picked}
            onToggle={(id, on) => {
              const next = new Set(picked);
              if (on) next.add(id); else next.delete(id);
              setPicked(next);
            }}
            empty={<p className="text-sm text-slate-400 py-3 text-center">{t.groups.addBotsModal.allInChat}</p>}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button variant="primary" type="submit" disabled={busy || picked.size === 0 || candidates.length === 0}>
            {busy ? t.groups.addBotsModal.submitting : t.groups.addBotsModal.submit}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function ManageChatModal({
  chat, onClose, onReload, onPatch,
}: {
  chat: ChatRow | null;
  onClose: () => void;
  onReload: () => Promise<void>;
  onPatch: (chatId: string, next: ChatRow) => void;
}) {
  const t = useT();
  const [leaveSet, setLeaveSet] = useState<Set<string>>(() => new Set());

  useEffect(() => { if (chat) setLeaveSet(new Set()); }, [chat]);

  if (!chat) return null;
  const c: ChatRow = chat;
  const inChat = c.memberBots.filter((m) => m.inChat);
  const ownerAppId = typeof c.ownerId === 'string' ? c.ownerId : '';

  async function leaveBots() {
    const ids = [...leaveSet];
    if (ids.length === 0) { alert(t.groups.manageModal.pickAtLeastOne); return; }
    if (!confirm(t.groups.manageModal.confirmLeave(ids.length))) return;
    try {
      const r = await api.leaveGroup(c.chatId, ids);
      const lines = (r.result ?? []).map((x: any) => {
        if (!x.ok) return `${x.larkAppId}: failed (${x.error ?? 'unknown'})`;
        const closed = (x.closedSessions ?? []) as any[];
        const failed = closed.filter((cs) => !cs.ok).length;
        const ok = closed.length - failed;
        const note = closed.length === 0
          ? ''
          : failed === 0
            ? t.groups.manageModal.closedNoteOk(ok)
            : t.groups.manageModal.closedNoteMixed(ok, failed);
        return `${x.larkAppId}: OK${note}`;
      }).join('\n');
      alert(lines || `Unexpected: ${JSON.stringify(r)}`);
      await onReload();
    } catch (e: any) {
      alert(t.schedules.networkError(e?.message ?? String(e)));
    } finally {
      onClose();
    }
  }

  async function disband() {
    if (inChat.length === 0) return;
    if (!confirm(t.groups.manageModal.confirmDisband(c.name ?? c.chatId))) return;
    const ordered = [...inChat].sort(
      (a, b) => (b.larkAppId === ownerAppId ? 1 : 0) - (a.larkAppId === ownerAppId ? 1 : 0),
    );
    const errs: string[] = [];
    for (const m of ordered) {
      try {
        const r = await api.disbandGroup(c.chatId, m.larkAppId);
        if (r.ok) {
          const closed = (r.closedSessions ?? []) as any[];
          const failed = closed.filter((cs) => !cs.ok).length;
          const ok = closed.length - failed;
          const closedNote = closed.length === 0
            ? ''
            : failed === 0
              ? t.groups.manageModal.closedNoteOk(ok)
              : t.groups.manageModal.closedNoteMixed(ok, failed);
          alert(t.groups.manageModal.disbandedBy(m.botName ?? m.larkAppId, closedNote));
          await onReload();
          onClose();
          return;
        }
        errs.push(`${m.botName ?? m.larkAppId}: ${r.error ?? 'failed'}`);
      } catch (e: any) {
        errs.push(`${m.botName ?? m.larkAppId}: ${e?.message ?? e}`);
      }
    }
    alert(t.groups.manageModal.disbandAllFailed(errs.join('\n')));
  }

  return (
    <Dialog open={!!c} onClose={onClose} maxWidth="max-w-2xl">
      <DialogHeader>{t.groups.manageModal.title(c.name ?? c.chatId)}</DialogHeader>
      <DialogBody>
        <KvLine label={t.groups.manageModal.chatId}><code className="text-xs">{c.chatId}</code></KvLine>
        <KvLine label={t.groups.manageModal.owner}>
          <code className="text-xs">{c.ownerId ?? t.groups.manageModal.ownerUnknown}</code>
        </KvLine>

        <fieldset className="border border-slate-200 rounded-lg p-3 space-y-2">
          <legend className="text-xs text-slate-500 px-2">{t.groups.manageModal.oncallTitle}</legend>
          <p className="text-xs text-slate-500">{t.groups.manageModal.oncallDesc}</p>
          {inChat.length === 0 ? (
            <p className="text-sm text-slate-400 py-2 text-center">{t.groups.manageModal.oncallNoBots}</p>
          ) : (
            inChat.map((m) => (
              <OncallRow
                key={m.larkAppId}
                chatId={c.chatId}
                member={m}
                onSaved={(patch) => {
                  const nextMembers = c.memberBots.map((x) =>
                    x.larkAppId === m.larkAppId ? { ...x, ...patch } : x,
                  );
                  onPatch(c.chatId, { ...c, memberBots: nextMembers });
                }}
              />
            ))
          )}
        </fieldset>

        <fieldset className="border border-slate-200 rounded-lg p-3 space-y-1">
          <legend className="text-xs text-slate-500 px-2">{t.groups.manageModal.leaveTitle}</legend>
          <CheckboxPicker
            items={inChat.map((m) => ({
              id: m.larkAppId,
              label: m.botName ?? m.larkAppId,
              hint:
                m.larkAppId === ownerAppId ? (
                  <small className="text-amber-700">{t.groups.manageModal.ownerTag}</small>
                ) : undefined,
            }))}
            selected={leaveSet}
            onToggle={(id, on) => {
              const next = new Set(leaveSet);
              if (on) next.add(id); else next.delete(id);
              setLeaveSet(next);
            }}
            empty={<p className="text-sm text-slate-400 py-2 text-center">{t.groups.manageModal.oncallNoBots}</p>}
          />
        </fieldset>

        <Hint kind="warn">{t.groups.manageModal.disbandHint}</Hint>
      </DialogBody>
      <DialogFooter>
        <Button onClick={leaveBots} disabled={inChat.length === 0}>{t.groups.manageModal.leaveButton}</Button>
        <Button variant="destructive" onClick={disband} disabled={inChat.length === 0}>
          {t.groups.manageModal.disbandButton}
        </Button>
        <Button variant="ghost" onClick={onClose}>{t.common.close}</Button>
      </DialogFooter>
    </Dialog>
  );
}

function OncallRow({
  chatId, member, onSaved,
}: {
  chatId: string; member: MemberBot;
  onSaved: (patch: Partial<MemberBot>) => void;
}) {
  const t = useT();
  const [enabled, setEnabled] = useState(!!member.oncallChat);
  const [wd, setWd] = useState(member.oncallChat?.workingDir ?? '');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setStatus(null);
    if (enabled && !wd.trim()) { setStatus({ kind: 'err', text: t.groups.manageModal.wdRequired }); return; }
    setBusy(true);
    try {
      const r = enabled
        ? await api.setOncall(chatId, member.larkAppId, wd.trim())
        : await api.clearOncall(chatId, member.larkAppId);
      if (r.ok) {
        setStatus({
          kind: 'ok',
          text: enabled ? t.groups.manageModal.bindOk(r.resolvedPath ?? wd) : t.groups.manageModal.unbound,
        });
        onSaved({ oncallChat: enabled ? { workingDir: r.resolvedPath ?? wd.trim() } : null });
      } else {
        setStatus({ kind: 'err', text: t.groups.manageModal.saveFailed(r.error ?? 'failed') });
      }
    } catch (e: any) {
      setStatus({ kind: 'err', text: t.groups.manageModal.saveFailed(e?.message ?? String(e)) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-dashed border-slate-200 first:border-t-0 pt-2 first:pt-0 space-y-1.5">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Checkbox checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setStatus(null); }} />
        <span className="text-sm">
          <strong>{member.botName ?? member.larkAppId}</strong>{' '}
          <small className="text-slate-400 font-mono text-[10px]">({member.larkAppId})</small>
        </span>
      </label>
      <div className="flex items-center gap-2 pl-6 flex-wrap">
        <Input
          value={wd}
          onChange={(e) => { setWd(e.target.value); setStatus(null); }}
          disabled={!enabled}
          placeholder="e.g. /root/iserver/botmux"
          className="flex-1 min-w-56 font-mono text-xs"
        />
        <Button size="sm" onClick={save} disabled={busy}>
          {busy ? '…' : t.common.save}
        </Button>
        <StatusText status={status} />
      </div>
    </div>
  );
}
