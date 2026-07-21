/**
 * Right-sidebar surface for multi-endpoint OrcaBotmux sessions
 * (local + multiple SSH remotes concurrently).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ExternalLink,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  X
} from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { OrcaBotmuxAskCard } from '@/components/orca-botmux/OrcaBotmuxAskCard'
import {
  loadOrcaBotmuxSshTargets,
  type OrcaBotmuxSshTargetRow
} from '@/lib/load-orca-botmux-ssh-targets'
import { openOrcaBotmuxSessionInMainWorkspace } from '@/lib/open-orca-botmux-session-in-workspace'
import { isOrcaBotmuxSessionClosed } from '@/components/sidebar/OrcaBotmuxSessionStatusDot'
import {
  filterSessionsForWorktree,
  orcaBotmuxHostIdForRepoConnection,
  type WorktreeMatchTarget
} from '@/lib/match-orca-botmux-sessions-to-worktree'
import { isOrcaBotmuxControlPlaneHostId } from '../../../../shared/orca-botmux-main-terminal-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { isOrcaBotmuxTabHostPath } from '@/lib/orca-botmux-session-tree'
import { translate } from '@/i18n/i18n'

type SessionRow = {
  sessionId: string
  hostId: string
  hostLabel: string
  botId?: string
  botName?: string
  title?: string
  status?: string
  cwd?: string
  cliType?: string
}

type EndpointRow = {
  id: string
  ok: boolean
  message?: string
  sessionCount?: number
  transport: {
    kind: 'local' | 'ssh' | 'platform'
    sshTargetId?: string
    label?: string
    target?: string
  }
}

type PendingAsk = {
  askId: string
  sessionId: string
  hostId: string
  hostLabel: string
  botName?: string
  larkAppId?: string
  questions: Array<{
    prompt: string
    multiSelect: boolean
    options: Array<{ key: string; label: string }>
  }>
  deadlineAt: number
}

type OrcaBotmuxBridgeApi = {
  listEndpoints: () => Promise<EndpointRow[]>
  connectEndpoint: (t: {
    kind: 'local' | 'ssh' | 'platform'
    sshTargetId?: string
    target?: string
  }) => Promise<EndpointRow>
  disconnectEndpoint: (id: string) => Promise<{ ok: boolean; message?: string }>
  reconnectPersisted?: () => Promise<{
    attempted: number
    connected: number
    failures?: Array<{ id: string; message: string }>
  }>
  getStatus: () => Promise<{
    ok: boolean
    message?: string
    totalSessions?: number
    sessionCount?: number
    endpoints: EndpointRow[]
  }>
  listSessions: () => Promise<
    { ok: true; sessions: SessionRow[] } | { ok: false; message: string; sessions?: SessionRow[] }
  >
  getWriteLink: (
    args: string | { sessionId: string; hostId?: string }
  ) => Promise<{ ok: boolean; url?: string; message?: string }>
  openTerminal: (args: {
    sessionId: string
    hostId?: string
    external?: boolean
    title?: string
  }) => Promise<{ ok: boolean; message?: string }>
  sendMessage: (args: {
    sessionId: string
    botId?: string
    text: string
    hostId?: string
  }) => Promise<{ ok: boolean; message?: string }>
  listPendingAsks: () => Promise<{ ok: boolean; asks: PendingAsk[]; message?: string }>
  answerAsk: (args: {
    askId: string
    selections: string[][]
    hostId?: string
    larkAppId?: string
  }) => Promise<{ ok: boolean; message?: string }>
  nativeTerminalSpec: (args: {
    sessionId: string
    hostId?: string
  }) => Promise<
    | {
        ok: true
        command: string
        args: string[]
        title: string
        electronRunAsNode?: boolean
      }
    | { ok: false; message?: string }
  >
  localReadiness: () => Promise<{
    ready: boolean
    port: number | null
    hasToken: boolean
    message: string
  }>
}

function bridgeApi(): OrcaBotmuxBridgeApi | undefined {
  return (window as unknown as { api?: { orcaBotmuxBridge?: OrcaBotmuxBridgeApi } }).api?.orcaBotmuxBridge
}

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.orcaBotmuxBridge.${key}`, fallback, options)


export default function OrcaBotmuxSessionsPanel(): React.JSX.Element {
  const api = bridgeApi()

  const [endpoints, setEndpoints] = useState<EndpointRow[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [asks, setAsks] = useState<PendingAsk[]>([])
  const [sshTargets, setSshTargets] = useState<OrcaBotmuxSshTargetRow[]>([])
  const [localConnected, setLocalConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [composeKey, setComposeKey] = useState<string | null>(null)
  const [composeText, setComposeText] = useState('')
  const [filterHostId, setFilterHostId] = useState<string | 'all'>('all')
  const [showClosed, setShowClosed] = useState(false)
  /** When a normal worktree is active, default to only sessions under that cwd. */
  const [scopeToActiveWorktree, setScopeToActiveWorktree] = useState(true)
  const [localHint, setLocalHint] = useState<string | null>(null)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repos = useAppStore((s) => s.repos)
  const getKnownWorktreeById = useAppStore((s) => s.getKnownWorktreeById)
  const ensureHostForWorktreeRef = useRef<string | null>(null)

  /** Project worktree under the cursor — used to scan matching botmux sessions. */
  const activeWorktreeTarget: WorktreeMatchTarget | null = useMemo(() => {
    if (!activeWorktreeId || activeWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) return null
    if (isOrcaBotmuxControlPlaneHostId(activeWorktreeId)) return null
    const wt = getKnownWorktreeById(activeWorktreeId)
    if (!wt?.path || isOrcaBotmuxTabHostPath(wt.path)) return null
    const repo = repos.find((r) => r.id === wt.repoId)
    return {
      worktreeId: wt.id,
      path: wt.path,
      orcaBotmuxHostId: orcaBotmuxHostIdForRepoConnection(repo?.connectionId)
    }
  }, [activeWorktreeId, getKnownWorktreeById, repos])

  const worktreeScoped = Boolean(activeWorktreeTarget) && scopeToActiveWorktree

  const refresh = useCallback(
    async (opts?: { importConfig?: boolean; reconnect?: boolean }) => {
      if (!api) {
        setError(t('ipcMissingShort', 'orcaBotmuxBridge unavailable — rebuild desktop.'))
        return
      }
      setBusy(true)
      setError(null)
      try {
        if (opts?.reconnect && typeof api.reconnectPersisted === 'function') {
          try {
            await api.reconnectPersisted()
          } catch {
            /* best-effort */
          }
        }
        // Same catalog as Settings → SSH (importConfig on first open).
        const ssh = await loadOrcaBotmuxSshTargets({ importConfig: opts?.importConfig === true })
        setSshTargets(ssh.targets)
        setLocalConnected(ssh.localConnected)

        const st = await api.getStatus()
        setEndpoints(st.endpoints ?? [])
        const list = await api.listSessions()
        if (!list.ok) {
          setSessions(list.sessions ?? [])
          if ((st.endpoints?.length ?? 0) === 0) {
            setError(list.message)
          }
        } else {
          setSessions(list.sessions)
        }
        if (api.listPendingAsks) {
          const pending = await api.listPendingAsks()
          setAsks(pending.asks ?? [])
        }
        if (api.localReadiness) {
          const readiness = await api.localReadiness()
          setLocalHint(readiness.ready ? null : readiness.message)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [api]
  )

  useEffect(() => {
    // First mount: sync ~/.ssh/config like Settings → SSH, then poll.
    void refresh({ importConfig: true, reconnect: true })
    const timer = window.setInterval(() => {
      void refresh({ importConfig: false, reconnect: false })
    }, 12_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // Why: selecting a normal worktree should ensure its Botmux host is connected
  // so listSessions can discover cwd-matched sessions for the right panel.
  useEffect(() => {
    if (!api || !activeWorktreeTarget) return
    const hostId = activeWorktreeTarget.orcaBotmuxHostId
    const already = endpoints.some((e) => e.id === hostId && e.ok)
    if (already) {
      ensureHostForWorktreeRef.current = hostId
      return
    }
    // Debounce: one connect attempt per host until success or worktree change.
    if (ensureHostForWorktreeRef.current === hostId) return
    ensureHostForWorktreeRef.current = hostId
    void (async () => {
      try {
        if (hostId === 'local') {
          await api.connectEndpoint({ kind: 'local' })
        } else if (hostId.startsWith('ssh:')) {
          const sshTargetId = hostId.slice(4)
          if (sshTargetId) {
            await api.connectEndpoint({ kind: 'ssh', sshTargetId })
          }
        }
        await refresh({ importConfig: false })
      } catch {
        // best-effort; panel still lists whatever is already connected
      }
    })()
  }, [activeWorktreeTarget, api, endpoints, refresh])

  // Reset "scope to worktree" when the user switches to a different project.
  useEffect(() => {
    setScopeToActiveWorktree(true)
  }, [activeWorktreeTarget?.worktreeId])

  const connectLocal = async () => {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.connectEndpoint({ kind: 'local' })
      if (!r.ok) setError(r.message ?? t('localConnectFailed', 'Local connect failed'))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const connectPlatform = async () => {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.connectEndpoint({ kind: 'platform' })
      if (!r.ok) setError(r.message ?? t('platformConnectFailed', 'Platform connect failed'))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const connectSsh = async (sshTargetId: string) => {
    if (!api || !sshTargetId) return
    setBusy(true)
    setError(null)
    try {
      // Reuses Settings → SSH target id: tunnel via OrcaBotmux port-forward when
      // already connected, else auto-connect that host, else system ssh -L.
      const r = await api.connectEndpoint({ kind: 'ssh', sshTargetId })
      if (!r.ok) setError(r.message ?? t('sshConnectFailed', 'SSH connect failed'))
      await refresh({ importConfig: false })
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (id: string) => {
    if (!api) return
    setBusy(true)
    try {
      await api.disconnectEndpoint(id)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const worktreeMatchedSessions = useMemo(() => {
    if (!activeWorktreeTarget) return [] as SessionRow[]
    return filterSessionsForWorktree(sessions, activeWorktreeTarget)
  }, [activeWorktreeTarget, sessions])

  const scopedBaseSessions = useMemo(() => {
    if (worktreeScoped) return worktreeMatchedSessions
    return sessions
  }, [sessions, worktreeMatchedSessions, worktreeScoped])

  const closedCount = useMemo(
    () => scopedBaseSessions.filter((s) => isOrcaBotmuxSessionClosed(s.status)).length,
    [scopedBaseSessions]
  )
  const visibleSessions = useMemo(() => {
    let list = scopedBaseSessions
    if (!showClosed) {
      list = list.filter((s) => !isOrcaBotmuxSessionClosed(s.status))
    }
    if (filterHostId !== 'all') {
      list = list.filter((s) => s.hostId === filterHostId)
    }
    return list
  }, [scopedBaseSessions, filterHostId, showClosed])

  /** Open session into the main workspace (auto-creates OrcaBotmux Sessions host if needed). */
  const openTerminal = async (
    session: SessionRow,
    mode: 'attach' | 'web' | 'relay' | 'external' = 'attach'
  ) => {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      const r = await openOrcaBotmuxSessionInMainWorkspace(
        {
          sessionId: session.sessionId,
          hostId: session.hostId,
          hostLabel: session.hostLabel,
          title: session.title,
          cwd: session.cwd
        },
        mode
      )
      if (!r.ok) setError(r.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('openFailed', 'Open failed'))
    } finally {
      setBusy(false)
    }
  }

  const answerAsk = async (ask: PendingAsk, selections: string[][]) => {
    if (!api?.answerAsk) return
    setBusy(true)
    try {
      const r = await api.answerAsk({
        askId: ask.askId,
        selections,
        hostId: ask.hostId,
        larkAppId: ask.larkAppId
      })
      if (!r.ok) setError(r.message ?? t('answerFailed', 'Answer failed'))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const send = async (session: SessionRow) => {
    if (!api) return
    const text = composeText.trim()
    if (!text) return
    setBusy(true)
    try {
      const r = await api.sendMessage({
        sessionId: session.sessionId,
        botId: session.botId,
        text,
        hostId: session.hostId
      })
      if (!r.ok) {
        setError(r.message ?? t('sendFailed', 'Send failed'))
        return
      }
      setComposeKey(null)
      setComposeText('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const linkedSshIds = useMemo(
    () => new Set(sshTargets.filter((t) => t.botmuxConnected).map((t) => t.id)),
    [sshTargets]
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-1 border-b border-border/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Server size={12} />
            {t('sidebarTitle', 'Botmux 连接')}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={busy}
            onClick={() => void refresh()}
            title={t('refreshTitle', 'Refresh all hosts')}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t(
            'sidebarHint',
            '连接本机/SSH 上的 Botmux。选中普通 worktree 时，这里会扫描并只显示该目录下的会话。'
          )}
        </p>
      </div>

      {/* Connected endpoints */}
      <div className="flex flex-col gap-1.5 border-b border-border/60 px-3 py-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('connectedHosts', 'Connected hosts')}
        </div>
        {localHint && endpoints.length === 0 ? (
          <p className="rounded border border-border/50 bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
            {localHint}
          </p>
        ) : null}
        {endpoints.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t('noneConnect', 'None — connect local and/or SSH.')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {endpoints.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-1 rounded border border-border/40 px-1.5 py-1"
              >
                <button
                  type="button"
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-[11px]',
                    filterHostId === e.id && 'font-semibold text-foreground',
                    !e.ok && 'text-destructive'
                  )}
                  onClick={() => setFilterHostId((id) => (id === e.id ? 'all' : e.id))}
                  title={e.message}
                >
                  {e.transport.kind === 'local'
                    ? t('local', 'Local')
                    : e.transport.label || e.transport.target || e.id}{' '}
                  <span className="text-muted-foreground">
                    ({e.sessionCount ?? '—'})
                  </span>
                </button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  title={t('disconnect', 'Disconnect')}
                  onClick={() => void disconnect(e.id)}
                >
                  <X className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-1 flex flex-wrap gap-1">
          {!localConnected ? (
            <Button
              type="button"
              size="sm"
              className="h-6 text-[11px]"
              variant="outline"
              disabled={busy}
              onClick={() => void connectLocal()}
            >
              <Plus className="size-3" />
              {t('local', 'Local')}
            </Button>
          ) : null}
          {!endpoints.some((e) => e.id.startsWith('platform:')) ? (
            <Button
              type="button"
              size="sm"
              className="h-6 text-[11px]"
              variant="outline"
              disabled={busy}
              onClick={() => void connectPlatform()}
              title={t('platformTitle', 'Use ~/.orca_botmux/platform.json machine URL')}
            >
              <Plus className="size-3" />
              {t('platform', 'Platform')}
            </Button>
          ) : null}
        </div>

        {/* Known SSH hosts — same catalog as Settings → SSH */}
        <div className="mt-2 flex flex-col gap-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('knownSshHosts', 'Known SSH hosts')}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {t(
              'knownSshHint',
              'Same hosts as Settings → SSH (including ~/.ssh/config). Click Connect to attach orca_botmux over that host.'
            )}
          </p>
          {sshTargets.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t(
                'noKnownSsh',
                'No SSH hosts yet. Add them in Settings → SSH or import ~/.ssh/config.'
              )}
            </p>
          ) : (
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {sshTargets.map((host) => {
                const orcaStatus =
                  host.orcaSshStatus ?? sshConnectionStates.get(host.id)?.status ?? null
                const linked = host.botmuxConnected || linkedSshIds.has(host.id)
                return (
                  <li
                    key={host.id}
                    className="flex items-center justify-between gap-1 rounded border border-border/40 px-1.5 py-1"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-medium">{host.label}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {host.destination}
                        {orcaStatus === 'connected'
                          ? ` · ${t('orcaSshConnected', 'SSH connected')}`
                          : orcaStatus
                            ? ` · ${t('orcaSshIdle', 'SSH idle')}`
                            : ''}
                        {host.source === 'ssh-config'
                          ? ` · ${t('sourceConfig', 'from ~/.ssh/config')}`
                          : ''}
                      </div>
                    </div>
                    {linked ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {t('botmuxLinked', 'OrcaBotmux linked')}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        className="h-6 shrink-0 text-[10px]"
                        disabled={busy}
                        onClick={() => void connectSsh(host.id)}
                      >
                        {t('connectBotmux', 'Connect')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {filterHostId !== 'all' ? (
          <button
            type="button"
            className="text-left text-[10px] text-muted-foreground underline"
            onClick={() => setFilterHostId('all')}
          >
            {t('showAllHosts', 'Show all hosts')}
          </button>
        ) : null}
        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      </div>

      {/* Pending ask-hooks (multi-question / multi-select) */}
      {asks.length > 0 ? (
        <div className="border-b border-border/60 px-2 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-amber-600">
            {t('needsAnswer', 'Needs answer ({{count}})', { count: asks.length })}
          </div>
          <ul className="flex flex-col gap-2">
            {asks.map((ask) => (
              <li key={ask.askId}>
                <OrcaBotmuxAskCard
                  askId={ask.askId}
                  hostLabel={ask.hostLabel}
                  botName={ask.botName}
                  questions={ask.questions}
                  deadlineAt={ask.deadlineAt}
                  busy={busy}
                  onSubmit={(selections) => void answerAsk(ask, selections)}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Sessions (merged, tagged by host) — scoped to active worktree when set */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {activeWorktreeTarget ? (
          <div className="mb-2 flex items-center justify-between gap-1 px-1">
            <div className="min-w-0">
              <div className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {worktreeScoped
                  ? t('worktreeSessionsTitle', 'This worktree')
                  : t('allSessionsTitle', 'All sessions')}
              </div>
              <div className="truncate text-[10px] text-muted-foreground" title={activeWorktreeTarget.path}>
                {worktreeScoped
                  ? t('worktreeSessionsHint', '{{count}} under this path', {
                      count: worktreeMatchedSessions.length
                    })
                  : t('worktreeSessionsAllHint', 'Showing every connected host')}
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 shrink-0 px-1.5 text-[10px]"
              onClick={() => setScopeToActiveWorktree((v) => !v)}
            >
              {worktreeScoped
                ? t('showAllSessions', 'Show all')
                : t('showWorktreeOnly', 'This worktree only')}
            </Button>
          </div>
        ) : null}
        {closedCount > 0 ? (
          <div className="mb-1.5 flex items-center justify-between gap-1 px-1">
            <span className="text-[10px] text-muted-foreground">
              {showClosed
                ? t('showingClosed', 'Showing closed ({{count}})', { count: closedCount })
                : t('closedHidden', '{{count}} closed hidden', { count: closedCount })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed
                ? t('hideClosed', 'Hide closed')
                : t('showClosed', 'Show closed ({{count}})', { count: closedCount })}
            </Button>
          </div>
        ) : null}
        {visibleSessions.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {worktreeScoped
              ? t(
                  'noWorktreeSessions',
                  'No Botmux sessions under this worktree. Connect the host above if needed, or run agents whose cwd is inside this path.'
                )
              : t('noSessionsConnect', 'No sessions. Connect one or more hosts above.')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {visibleSessions.map((s) => {
              const key = `${s.hostId}::${s.sessionId}`
              return (
                <li
                  key={key}
                  className={cn(
                    'rounded-md border border-border/50 px-2 py-1.5',
                    'hover:bg-accent/40'
                  )}
                >
                  <div className="flex items-start justify-between gap-1">
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded text-left hover:bg-accent/30"
                      title={t(
                        'openInWorkspace',
                        'Open native terminal (tmux attach). Shift+click for Web.'
                      )}
                      onClick={(e) =>
                        void openTerminal(s, e.shiftKey ? 'web' : 'attach')
                      }
                    >
                      <div className="truncate text-[10px] font-medium text-muted-foreground">
                        {s.hostLabel}
                      </div>
                      <div className="truncate text-xs font-medium">
                        {s.title || s.sessionId}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {[s.botName, s.status, s.cliType].filter(Boolean).join(' · ')}
                      </div>
                    </button>
                    <div className="flex shrink-0 gap-0.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        title={t('attachTitle', 'Native terminal (tmux attach)')}
                        onClick={() => void openTerminal(s, 'attach')}
                      >
                        <Terminal className="size-3" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1 text-[9px]"
                        title={t('webTerminalTitle', 'Web terminal (browser tab)')}
                        onClick={() => void openTerminal(s, 'web')}
                      >
                        {t('web', 'Web')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        title={t('externalTitle', 'System browser')}
                        onClick={() => void openTerminal(s, 'external')}
                      >
                        <ExternalLink className="size-3" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        title={t('sendTitle', 'Send message')}
                        onClick={() => setComposeKey((k) => (k === key ? null : key))}
                      >
                        <MessageSquare className="size-3" />
                      </Button>
                    </div>
                  </div>
                  {composeKey === key ? (
                    <div className="mt-1.5 flex flex-col gap-1 border-t border-border/40 pt-1.5">
                      <Input
                        className="h-7 text-xs"
                        placeholder={t('messagePlaceholder', 'Message…')}
                        value={composeText}
                        onChange={(e) => setComposeText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void send(s)
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={busy}
                        onClick={() => void send(s)}
                      >
                        {t('send', 'Send')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
