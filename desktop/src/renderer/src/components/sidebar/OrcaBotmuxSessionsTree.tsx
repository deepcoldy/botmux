/**
 * Left-sidebar OrcaBotmux section: connected hosts (machines) → flat session rows.
 *
 * Design (2026-07 rework):
 *  - Machine add lives in ONE "+" menu (Local / Platform / known SSH hosts /
 *    New SSH host… / Manage machines…) — no always-visible quick-connect chips.
 *  - Filtering lives in ONE ListFilter menu (text query + show-closed toggle)
 *    with an active-count badge — no chip rows.
 *  - Worktree matching auto-pins matched sessions to a "This worktree" group
 *    on top (move semantics; searching disables pinning) — no scope chips,
 *    no "Other sessions" duplicate tree, never an empty-by-default view.
 *  - Trees default to flat host → sessions, activity-sorted (working first),
 *    capped per host behind a "N more" row; an optional group-by-agent view
 *    re-inserts the agent level (same agentKey identity as the agent-scoped
 *    worktrees sessions open into).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Radio, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import {
  ORCA_BOTMUX_HOST_SESSION_ROW_CAP,
  orcaBotmuxSessionAgentKey,
  orcaBotmuxSessionMatchesQuery,
  buildOrcaBotmuxAgentOptions,
  buildOrcaBotmuxHostSections,
  isOrcaBotmuxTabHostPath,
  sortOrcaBotmuxSessionsByActivity,
  type OrcaBotmuxSessionLeaf
} from '@/lib/orca-botmux-session-tree'
import { isOrcaBotmuxSessionClosed } from '@/lib/orca-botmux-session-status'
import { openOrcaBotmuxSessionInMainWorkspace } from '@/lib/open-orca-botmux-session-in-workspace'
import { loadOrcaBotmuxSshTargets, type OrcaBotmuxSshTargetRow } from '@/lib/load-orca-botmux-ssh-targets'
import {
  orcaBotmuxHostIdForRepoConnection,
  partitionSessionsByWorktree,
  type WorktreeMatchTarget
} from '@/lib/match-orca-botmux-sessions-to-worktree'
import { publishOrcaBotmuxSessionsFeed } from '@/lib/orca-botmux-sessions-feed'
import {
  loadOrcaBotmuxSidebarViewState,
  saveOrcaBotmuxSidebarViewState
} from '@/lib/orca-botmux-sidebar-view-state'
import { translate } from '@/i18n/i18n'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import { OrcaBotmuxSessionRow } from './OrcaBotmuxSessionRow'
import { OrcaBotmuxHostSection } from './OrcaBotmuxHostSection'
import { BotmuxAddHostMenu } from './OrcaBotmuxAddHostMenu'
import { BotmuxFilterMenu } from './OrcaBotmuxFilterMenu'
import { AddRemoteHostDialog, type AddRemoteHostMode } from './AddRemoteHostDialog'

type BridgeTransport = {
  kind: 'local' | 'ssh' | 'platform'
  target?: string
  sshTargetId?: string
  label?: string
  baseUrl?: string
  token?: string
}

type EndpointRow = {
  id: string
  ok: boolean
  message?: string
  sessionCount?: number
  transport: BridgeTransport
}

type BridgeApi = {
  connectEndpoint: (t: BridgeTransport) => Promise<EndpointRow>
  disconnectEndpoint: (id: string) => Promise<{ ok: boolean }>
  reconnectPersisted?: () => Promise<{
    attempted: number
    connected: number
    failures?: Array<{ id: string; message: string }>
  }>
  getStatus: () => Promise<{
    ok: boolean
    endpoints: EndpointRow[]
    totalSessions?: number
  }>
  listSessions: () => Promise<
    | { ok: true; sessions: OrcaBotmuxSessionLeaf[] }
    | { ok: false; message: string; sessions?: OrcaBotmuxSessionLeaf[] }
  >
}

function bridgeApi(): BridgeApi | undefined {
  return (window as unknown as { api?: { orcaBotmuxBridge?: BridgeApi } }).api?.orcaBotmuxBridge
}

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.orcaBotmuxBridge.${key}`, fallback, options)

/** SectionMetricsBadge pill (WorktreeList) — the one rounded-full badge in the sidebar. */
const COUNT_PILL_CLASS =
  'inline-flex h-4 shrink-0 items-center rounded-full border border-worktree-sidebar-border bg-worktree-sidebar-accent text-[9px] font-medium leading-none text-muted-foreground/90'
const COUNT_PILL_INNER_CLASS = 'min-w-4 px-1.5 text-center'

export default function OrcaBotmuxSessionsTree(): React.JSX.Element {
  const api = bridgeApi()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const getKnownWorktreeById = useAppStore((s) => s.getKnownWorktreeById)
  const repos = useAppStore((s) => s.repos)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  // Why: terminal tab switch updates orcaBotmuxSurfaceByHostId; highlight that
  // session even when the user did not re-click the tree row.
  const surfaceActiveKey = useAppStore((s) => {
    const wt = s.activeWorktreeId
    if (!wt) return null
    const surface = s.orcaBotmuxSurfaceByHostId[wt]
    if (!surface?.sessionId || !surface.hostId) return null
    return `${surface.hostId}::${surface.sessionId}`
  })

  const [endpoints, setEndpoints] = useState<EndpointRow[]>([])
  const [sessions, setSessions] = useState<OrcaBotmuxSessionLeaf[]>([])
  const [sshTargets, setSshTargets] = useState<OrcaBotmuxSshTargetRow[]>([])
  const [localConnected, setLocalConnected] = useState(false)
  const [platformConnected, setPlatformConnected] = useState(false)
  /** User-initiated action in flight (connect/disconnect/open) — gates buttons. */
  const [busy, setBusy] = useState(false)
  /** Any refresh in flight (incl. 12s background polls) — drives only the refresh icon. */
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const highlightKey = surfaceActiveKey ?? activeKey
  const [query, setQuery] = useState('')
  /** Agent multi-select (orcaBotmuxAgentLabel keys); empty = all agents. Session-only. */
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  /** Row-cap expansions are session-only; collapse prefs below persist. */
  const [expandedHosts, setExpandedHosts] = useState<Record<string, boolean>>({})
  /** Agent sub-group collapse (group-by-agent view); session-only. */
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, boolean>>({})
  const [addHostMode, setAddHostMode] = useState<AddRemoteHostMode | null>(null)

  const [viewState, setViewState] = useState(loadOrcaBotmuxSidebarViewState)
  useEffect(() => {
    saveOrcaBotmuxSidebarViewState(viewState)
  }, [viewState])
  const { collapsedHosts, showClosed, sectionOpen, groupBy } = viewState

  const refresh = useCallback(
    async (opts?: { importConfig?: boolean; reconnect?: boolean }) => {
      if (!api) return
      // Why: refreshing is NOT busy — background polls must never gate buttons
      // (a slow SSH round would otherwise disable the add menu every 12s).
      setRefreshing(true)
      try {
        // Why: main auto-reconnect can race SSH readiness. On first open / explicit
        // refresh, retry persisted hosts so users don't have to re-add them.
        if (opts?.reconnect !== false && typeof api.reconnectPersisted === 'function') {
          try {
            await api.reconnectPersisted()
          } catch {
            // Best-effort — status refresh still surfaces offline hosts.
          }
        }

        const ssh = await loadOrcaBotmuxSshTargets({
          importConfig: opts?.importConfig === true
        })
        setSshTargets(ssh.targets)
        setLocalConnected(ssh.localConnected)
        setPlatformConnected(ssh.platformConnected)

        const st = await api.getStatus()
        setEndpoints(st.endpoints ?? [])
        const list = await api.listSessions()
        const nextSessions = list.ok ? list.sessions : (list.sessions ?? [])
        setSessions(nextSessions)
        publishOrcaBotmuxSessionsFeed(nextSessions, st.endpoints ?? [])
        // Why: zero endpoints is the designed empty state, not an error —
        // main returns ok:false 'No orca_botmux endpoints connected' for it.
        if (!list.ok && (st.endpoints?.length ?? 0) > 0) {
          setError(list.message)
        } else {
          setError(null)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setRefreshing(false)
      }
    },
    [api]
  )

  useEffect(() => {
    void refresh({ importConfig: true, reconnect: true })
    // Poll sessions; only re-run full reconnect on the slower cadence so we
    // heal offline hosts without thrashing tunnels every 12s.
    const pollTimer = window.setInterval(
      () => void refresh({ importConfig: false, reconnect: false }),
      12_000
    )
    const reconnectTimer = window.setInterval(
      () => void refresh({ importConfig: false, reconnect: true }),
      60_000
    )
    return () => {
      window.clearInterval(pollTimer)
      window.clearInterval(reconnectTimer)
    }
  }, [refresh])

  const runConnect = useCallback(
    async (transport: BridgeTransport, failureMessage: string) => {
      if (!api) return
      setBusy(true)
      try {
        const r = await api.connectEndpoint(transport)
        if (!r.ok) setError(r.message ?? failureMessage)
        // Why: reconnect:false — connecting ONE host must not re-attempt every
        // persisted host (serial tunnel rebuilds, seconds per offline host).
        await refresh({ importConfig: false, reconnect: false })
      } catch (e) {
        setError(e instanceof Error ? e.message : failureMessage)
      } finally {
        setBusy(false)
      }
    },
    [api, refresh]
  )

  const connectLocal = () =>
    void runConnect({ kind: 'local' }, t('localConnectFailed', 'Local connect failed'))
  const connectPlatform = () =>
    void runConnect({ kind: 'platform' }, t('platformConnectFailed', 'Platform connect failed'))
  const connectSsh = (sshTargetId: string) =>
    void runConnect({ kind: 'ssh', sshTargetId }, t('sshConnectFailed', 'SSH connect failed'))

  const reconnectHost = (hostId: string) => {
    const ep = endpoints.find((e) => e.id === hostId)
    if (!ep) return
    void runConnect(ep.transport, t('sshConnectFailed', 'SSH connect failed'))
  }

  const disconnectHost = async (hostId: string) => {
    if (!api) return
    setBusy(true)
    try {
      await api.disconnectEndpoint(hostId)
      await refresh({ importConfig: false, reconnect: false })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('disconnectFailed', 'Disconnect failed'))
    } finally {
      setBusy(false)
    }
  }

  const openManage = useCallback(() => {
    openSettingsPage()
    // Why: SettingsNavTarget union predates metadata-driven sections ('mobile'
    // is missing too); the section id IS the runtime pane id.
    openSettingsTarget({
      pane: 'orca-botmux-bridge' as SettingsNavTarget,
      repoId: null,
      sectionId: 'orca-botmux-bridge'
    })
  }, [openSettingsPage, openSettingsTarget])

  const onAddHostDialogChange = (mode: AddRemoteHostMode | null) => {
    setAddHostMode(mode)
    if (mode === null) {
      // Pick up the freshly saved SSH target in the add menu's host list.
      void refresh({ importConfig: false, reconnect: false })
    }
  }

  const openSession = async (s: OrcaBotmuxSessionLeaf, mode: 'attach' | 'web' = 'attach') => {
    console.info('[orca-botmux-open]', 'ui:click', {
      mode,
      sessionId: s.sessionId,
      hostId: s.hostId,
      hostLabel: s.hostLabel,
      title: s.title ?? null,
      cwd: s.cwd ?? null,
      status: s.status ?? null,
      busy
    })
    setBusy(true)
    setError(null)
    setActiveKey(`${s.hostId}::${s.sessionId}`)
    try {
      const r = await openOrcaBotmuxSessionInMainWorkspace(
        {
          sessionId: s.sessionId,
          hostId: s.hostId,
          hostLabel: s.hostLabel,
          title: s.title,
          cwd: s.cwd,
          botName: s.botName,
          cliType: s.cliType
        },
        mode
      )
      console.info('[orca-botmux-open]', 'ui:result', r)
      if (!r.ok) {
        setError(r.message)
        setActiveKey(null)
      }
    } catch (e) {
      console.error('[orca-botmux-open]', 'ui:throw', e)
      setError(e instanceof Error ? e.message : t('openFailed', 'Open failed'))
      setActiveKey(null)
    } finally {
      setBusy(false)
    }
  }

  const activeWorktreeTarget: WorktreeMatchTarget | null = useMemo(() => {
    if (!activeWorktreeId || activeWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) return null
    const wt = getKnownWorktreeById(activeWorktreeId)
    if (!wt?.path || isOrcaBotmuxTabHostPath(wt.path)) return null
    const repo = repos.find((r) => r.id === wt.repoId)
    return {
      worktreeId: wt.id,
      path: wt.path,
      orcaBotmuxHostId: orcaBotmuxHostIdForRepoConnection(repo?.connectionId)
    }
  }, [activeWorktreeId, getKnownWorktreeById, repos])

  const closedCount = useMemo(
    () => sessions.filter((s) => isOrcaBotmuxSessionClosed(s.status)).length,
    [sessions]
  )
  const openSessions = useMemo(
    () => (showClosed ? sessions : sessions.filter((s) => !isOrcaBotmuxSessionClosed(s.status))),
    [sessions, showClosed]
  )
  const agentOptions = useMemo(() => buildOrcaBotmuxAgentOptions(openSessions), [openSessions])
  const searching = query.trim().length > 0
  const agentFiltering = selectedAgents.length > 0
  const filtering = searching || agentFiltering
  const filteredSessions = useMemo(() => {
    let result = openSessions
    if (agentFiltering) {
      const wanted = new Set(selectedAgents)
      result = result.filter((s) => wanted.has(orcaBotmuxSessionAgentKey(s)))
    }
    if (searching) {
      result = result.filter((s) => orcaBotmuxSessionMatchesQuery(s, query))
    }
    return result
  }, [openSessions, agentFiltering, selectedAgents, searching, query])

  const resetFilters = useCallback(() => {
    setQuery('')
    setSelectedAgents([])
    setViewState((s) => ({ ...s, showClosed: false }))
  }, [])

  const toggleAgent = useCallback((agentKey: string) => {
    setSelectedAgents((list) =>
      list.includes(agentKey) ? list.filter((k) => k !== agentKey) : [...list, agentKey]
    )
  }, [])

  // Pin group is suppressed while searching: a query is an explicit global
  // scope, and moving rows out of hosts mid-type would feel unstable.
  const { matched, other } = useMemo(
    () => partitionSessionsByWorktree(filteredSessions, searching ? null : activeWorktreeTarget),
    [filteredSessions, searching, activeWorktreeTarget]
  )
  const pinnedSessions = useMemo(() => sortOrcaBotmuxSessionsByActivity(matched), [matched])
  const sections = useMemo(() => buildOrcaBotmuxHostSections(endpoints, other), [endpoints, other])
  // Why: while filtering, hosts with zero matches just render "No sessions"
  // noise — hide them. Connected-but-idle hosts still show when not filtering.
  const visibleSections = useMemo(
    () => (filtering ? sections.filter((s) => s.sessions.length > 0) : sections),
    [filtering, sections]
  )

  const hasHosts = endpoints.length > 0 || sessions.length > 0
  const availableSsh = sshTargets.filter((h) => !h.botmuxConnected)
  const visibleSessionCount = openSessions.length
  const worktreeLabel = activeWorktreeTarget
    ? activeWorktreeTarget.path.split('/').filter(Boolean).slice(-2).join('/')
    : null
  const nothingMatches = filtering && filteredSessions.length === 0

  return (
    <div className="flex flex-col border-b border-worktree-sidebar-border/60">
      <div className="mt-2 flex h-8 w-full items-center justify-between gap-2 px-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-left"
          onClick={() => setViewState((s) => ({ ...s, sectionOpen: !s.sectionOpen }))}
        >
          {sectionOpen ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <Radio className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-semibold text-muted-foreground/80 select-none">
            {t('sidebarTitle', 'orca_botmux')}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={COUNT_PILL_CLASS}
            title={
              closedCount > 0 && !showClosed
                ? t(
                    'hostsSessionsHiddenClosed',
                    '{{visible}} open · {{closed}} closed hidden',
                    { visible: visibleSessionCount, closed: closedCount }
                  )
                : t('hostsSessions', '{{hosts}} hosts · {{sessions}} sessions', {
                    hosts: endpoints.length,
                    sessions: visibleSessionCount
                  })
            }
          >
            <span className={COUNT_PILL_INNER_CLASS}>{visibleSessionCount}</span>
          </span>
          <BotmuxFilterMenu
            query={query}
            onQueryChange={setQuery}
            showClosed={showClosed}
            onShowClosedChange={(v) => setViewState((s) => ({ ...s, showClosed: v }))}
            closedCount={closedCount}
            agents={agentOptions}
            selectedAgentKeys={selectedAgents}
            onToggleAgent={toggleAgent}
            onResetFilters={resetFilters}
            groupBy={groupBy}
            onGroupByChange={(v) => setViewState((s) => ({ ...s, groupBy: v }))}
          />
          <BotmuxAddHostMenu
            localConnected={localConnected}
            platformConnected={platformConnected}
            sshTargets={availableSsh}
            busy={busy}
            onConnectLocal={connectLocal}
            onConnectPlatform={connectPlatform}
            onConnectSsh={connectSsh}
            onNewSshHost={() => setAddHostMode('ssh')}
            onManage={openManage}
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={refreshing || busy}
            aria-label={t('refreshTitle', 'Refresh all hosts')}
            title={t('refreshTitle', 'Refresh all hosts')}
            onClick={() => void refresh({ importConfig: true })}
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </span>
      </div>

      {sectionOpen ? (
        <div className="flex flex-col gap-1 px-2 pb-2 pt-1">
          {error ? (
            <p className="flex items-start gap-1 px-1 text-[10px] text-destructive">
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                className="shrink-0 rounded text-destructive/70 hover:text-destructive"
                aria-label={t('dismissError', 'Dismiss')}
                onClick={() => setError(null)}
              >
                <X className="size-3" />
              </button>
            </p>
          ) : null}

          {!hasHosts ? (
            <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
              <Radio className="size-5 text-muted-foreground/60" />
              <p className="text-[11px] font-medium text-foreground/80">
                {t('emptyMachinesTitle', 'No machines connected')}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t(
                  'emptyMachinesHint',
                  'Connect this machine or an SSH host to see orca_botmux sessions here.'
                )}
              </p>
              <div className="mt-1 flex items-center gap-2">
                {!localConnected ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    disabled={busy}
                    onClick={connectLocal}
                  >
                    {t('connectLocal', 'Connect local')}
                  </Button>
                ) : null}
                <BotmuxAddHostMenu
                  labeled
                  localConnected={localConnected}
                  platformConnected={platformConnected}
                  sshTargets={availableSsh}
                  busy={busy}
                  onConnectLocal={connectLocal}
                  onConnectPlatform={connectPlatform}
                  onConnectSsh={connectSsh}
                  onNewSshHost={() => setAddHostMode('ssh')}
                  onManage={openManage}
                />
              </div>
            </div>
          ) : (
            <div className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
              {pinnedSessions.length > 0 ? (
                <div className="flex flex-col">
                  <div
                    className="flex h-7 items-center gap-1.5 px-2"
                    title={activeWorktreeTarget?.path}
                  >
                    <Radio className="size-3 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 text-[11px] font-semibold text-foreground/80">
                      {t('filterWorktree', 'This worktree')}
                    </span>
                    {worktreeLabel ? (
                      <span className="min-w-0 truncate text-[10px] text-muted-foreground/70">
                        {worktreeLabel}
                      </span>
                    ) : null}
                    <span
                      className={COUNT_PILL_CLASS}
                      title={t('sessionCountTitle', '{{count}} sessions', {
                        count: pinnedSessions.length
                      })}
                    >
                      <span className={COUNT_PILL_INNER_CLASS}>{pinnedSessions.length}</span>
                    </span>
                  </div>
                  <div className="ml-2 flex flex-col gap-0.5">
                    {pinnedSessions.map((s) => {
                      const key = `${s.hostId}::${s.sessionId}`
                      return (
                        <OrcaBotmuxSessionRow
                          key={key}
                          session={s}
                          active={highlightKey === key}
                          busy={busy}
                          onOpen={(sess, mode) => void openSession(sess, mode)}
                        />
                      )
                    })}
                  </div>
                </div>
              ) : null}

              <ul className="flex flex-col gap-1">
                {visibleSections.map((section) => (
                  <OrcaBotmuxHostSection
                    key={section.hostId}
                    section={section}
                    collapsed={collapsedHosts[section.hostId] === true}
                    onToggleCollapsed={() =>
                      setViewState((s) => ({
                        ...s,
                        collapsedHosts: {
                          ...s.collapsedHosts,
                          [section.hostId]: !(s.collapsedHosts[section.hostId] === true)
                        }
                      }))
                    }
                    rowCap={filtering ? Number.POSITIVE_INFINITY : ORCA_BOTMUX_HOST_SESSION_ROW_CAP}
                    expanded={expandedHosts[section.hostId] === true}
                    onToggleExpanded={() =>
                      setExpandedHosts((e) => ({
                        ...e,
                        [section.hostId]: !(e[section.hostId] === true)
                      }))
                    }
                    groupByAgent={groupBy === 'agent'}
                    collapsedAgents={collapsedAgents}
                    onToggleAgentCollapsed={(agentId) =>
                      setCollapsedAgents((c) => ({ ...c, [agentId]: !(c[agentId] === true) }))
                    }
                    activeKey={highlightKey}
                    busy={busy}
                    onOpenSession={(sess, mode) => void openSession(sess, mode)}
                    onReconnect={reconnectHost}
                    onDisconnect={(hostId) => void disconnectHost(hostId)}
                    onManage={openManage}
                  />
                ))}
              </ul>

              {nothingMatches ? (
                <div className="flex flex-col items-center gap-2 px-4 py-4 text-center">
                  <p className="text-[11px] text-muted-foreground">
                    {searching
                      ? t('noFilterMatch', 'No sessions match "{{query}}"', {
                          query: query.trim()
                        })
                      : t('noFilteredSessions', 'No sessions match the current filters')}
                  </p>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-secondary/70 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent"
                    onClick={resetFilters}
                  >
                    <X className="size-3.5" />
                    {t('resetFilters', 'Reset filters')}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <AddRemoteHostDialog mode={addHostMode} onOpenChange={onAddHostDialogChange} />
    </div>
  )
}
