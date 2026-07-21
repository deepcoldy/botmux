import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, RefreshCw, Server, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { OrcaBotmuxAskCard } from '@/components/orca-botmux/OrcaBotmuxAskCard'
import {
  loadOrcaBotmuxSshTargets,
  type OrcaBotmuxSshTargetRow
} from '@/lib/load-orca-botmux-ssh-targets'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

type EndpointRow = {
  id: string
  ok: boolean
  message?: string
  baseUrl?: string
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
  connectEndpoint: (t: {
    kind: 'local' | 'ssh' | 'platform'
    sshTargetId?: string
    target?: string
  }) => Promise<EndpointRow>
  disconnectEndpoint: (id: string) => Promise<{ ok: boolean; message?: string }>
  disconnectAll: () => Promise<{ ok: boolean }>
  getStatus: () => Promise<{
    ok: boolean
    message?: string
    totalSessions?: number
    sessionCount?: number
    endpoints: EndpointRow[]
  }>
  listPendingAsks: () => Promise<{ ok: boolean; asks: PendingAsk[] }>
  answerAsk: (args: {
    askId: string
    selections: string[][]
    hostId?: string
    larkAppId?: string
  }) => Promise<{ ok: boolean; message?: string }>
  localReadiness: () => Promise<{ ready: boolean; message: string }>
}

function bridgeApi(): OrcaBotmuxBridgeApi | undefined {
  return (window as unknown as { api?: { orcaBotmuxBridge?: OrcaBotmuxBridgeApi } }).api
    ?.orcaBotmuxBridge
}

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.orcaBotmuxBridge.${key}`, fallback, options)

export function getOrcaBotmuxBridgeSettingsPaneSearchEntries(): Array<{
  id: string
  label: string
  keywords?: string[]
}> {
  return [
    {
      id: 'orca-botmux-bridge-multi',
      label: t('searchMulti', 'Multi-host orca_botmux'),
      keywords: ['feishu', 'ssh', 'remote', 'botmux']
    },
    {
      id: 'orca-botmux-bridge-sessions',
      label: t('searchSessions', 'Botmux sessions'),
      keywords: ['session', 'terminal', 'botmux']
    }
  ]
}

export function OrcaBotmuxBridgeSettingsPane(): React.JSX.Element {
  const api = bridgeApi()
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([])
  const [asks, setAsks] = useState<PendingAsk[]>([])
  const [sshTargets, setSshTargets] = useState<OrcaBotmuxSshTargetRow[]>([])
  const [localConnected, setLocalConnected] = useState(false)
  const [localHint, setLocalHint] = useState<string | null>(null)
  const [sshManual, setSshManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)

  const refresh = useCallback(
    async (opts?: { importConfig?: boolean }) => {
      if (!api) {
        setError(t('ipcMissing', 'orcaBotmuxBridge IPC not available — rebuild desktop preload.'))
        return
      }
      setBusy(true)
      setError(null)
      try {
        const ssh = await loadOrcaBotmuxSshTargets({ importConfig: opts?.importConfig === true })
        setSshTargets(ssh.targets)
        setLocalConnected(ssh.localConnected)

        const st = await api.getStatus()
        setEndpoints(st.endpoints ?? [])
        setHint(
          st.ok
            ? t('hostsSessions', '{{hosts}} host(s) · {{sessions}} session(s)', {
                hosts: st.endpoints?.length ?? 0,
                sessions: st.totalSessions ?? st.sessionCount ?? 0
              })
            : (st.message ?? null)
        )
        if (!st.ok && (st.endpoints?.length ?? 0) === 0) setError(st.message ?? null)
        if (api.listPendingAsks) {
          const pending = await api.listPendingAsks()
          setAsks(pending.asks ?? [])
        }
        if (api.localReadiness) {
          const r = await api.localReadiness()
          setLocalHint(r.ready ? null : r.message)
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
    void refresh({ importConfig: true })
    const timer = window.setInterval(() => {
      void refresh({ importConfig: false })
    }, 12_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const connectLocal = async () => {
    if (!api) return
    setBusy(true)
    try {
      const r = await api.connectEndpoint({ kind: 'local' })
      if (!r.ok) setError(r.message ?? t('localConnectFailed', 'Local connect failed'))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const connectSshTarget = async (sshTargetId: string) => {
    if (!api || !sshTargetId) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.connectEndpoint({ kind: 'ssh', sshTargetId })
      if (!r.ok) setError(r.message ?? t('sshConnectFailed', 'SSH connect failed'))
      await refresh({ importConfig: false })
    } finally {
      setBusy(false)
    }
  }

  const connectSshManual = async () => {
    if (!api) return
    const target = sshManual.trim()
    if (!target) {
      setError(t('selectSshOrManual', 'Select an SSH host or enter a manual destination.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.connectEndpoint({ kind: 'ssh', target })
      if (!r.ok) setError(r.message ?? t('sshConnectFailed', 'SSH connect failed'))
      setSshManual('')
      await refresh({ importConfig: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Server className="size-4" />
          {t('controlPlaneTitle', 'Multi-host Botmux control plane')}
        </div>
        <p className="text-sm text-muted-foreground">
          {t(
            'controlPlaneBody',
            'Connect local, platform tunnel, and multiple SSH remotes at once. Pending ask-hooks appear below when agents need an answer (multi-question supported).'
          )}
        </p>
        {localHint ? (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {localHint}
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t('connected', 'Connected')}
          </div>
          {endpoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noEndpoints', 'No endpoints yet.')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {endpoints.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium">
                      {e.transport.kind === 'local'
                        ? t('local', 'Local')
                        : e.transport.label || e.transport.target || e.id}
                      {!e.ok ? (
                        <span className="ml-2 text-xs text-destructive">
                          {t('errorLabel', 'error')}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {e.message || e.baseUrl} · {e.sessionCount ?? 0}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void api?.disconnectEndpoint(e.id).then(() => refresh({ importConfig: false }))
                    }
                  >
                    <X className="size-4" />
                    {t('disconnect', 'Disconnect')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border/50 pt-3">
          {!localConnected ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => void connectLocal()}>
              <Plus className="size-4" />
              {t('connectLocal', 'Connect local')}
            </Button>
          ) : null}
          {!endpoints.some((e) => e.id.startsWith('platform:')) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              title={t('platformTitle', 'Use ~/.orca_botmux/platform.json machine URL')}
              onClick={() =>
                void (async () => {
                  if (!api) return
                  setBusy(true)
                  try {
                    const r = await api.connectEndpoint({ kind: 'platform' })
                    if (!r.ok)
                      setError(r.message ?? t('platformConnectFailed', 'Platform connect failed'))
                    await refresh({ importConfig: false })
                  } finally {
                    setBusy(false)
                  }
                })()
              }
            >
              <Plus className="size-4" />
              {t('platform', 'Platform')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void refresh({ importConfig: true })}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t('refreshAll', 'Refresh all')}
          </Button>
          {endpoints.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void api?.disconnectAll().then(() => refresh({ importConfig: false }))}
            >
              {t('disconnectAll', 'Disconnect all')}
            </Button>
          ) : null}
        </div>

        {/* Known SSH — same catalog as Settings → SSH */}
        <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
          <div className="text-xs font-medium text-muted-foreground">
            {t('knownSshHosts', 'Known SSH hosts')}
          </div>
          <p className="text-sm text-muted-foreground">
            {t(
              'knownSshHint',
              'Same hosts as Settings → SSH (including ~/.ssh/config). Click Connect to attach orca_botmux over that host.'
            )}
          </p>
          {sshTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(
                'noKnownSsh',
                'No SSH hosts yet. Add them in Settings → SSH or import ~/.ssh/config.'
              )}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sshTargets.map((host) => {
                const orcaStatus =
                  host.orcaSshStatus ?? sshConnectionStates.get(host.id)?.status ?? null
                return (
                  <li
                    key={host.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{host.label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {host.destination}
                        {orcaStatus === 'connected'
                          ? ` · ${t('orcaSshConnected', 'SSH connected')}`
                          : orcaStatus
                            ? ` · ${t('orcaSshIdle', 'SSH idle')}`
                            : ''}
                        {host.source === 'ssh-config'
                          ? ` · ${t('sourceConfig', 'from ~/.ssh/config')}`
                          : host.source === 'manual'
                            ? ` · ${t('sourceManual', 'manual')}`
                            : ''}
                      </div>
                    </div>
                    {host.botmuxConnected ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('botmuxLinked', 'Botmux linked')}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => void connectSshTarget(host.id)}
                      >
                        <Plus className="size-4" />
                        {t('connect', 'Connect')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
          <Label htmlFor="orca-botmux-ssh-manual">{t('manualTarget', 'Manual target (optional)')}</Label>
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                id="orca-botmux-ssh-manual"
                value={sshManual}
                onChange={(e) => setSshManual(e.target.value)}
                placeholder={t('manualPlaceholder', 'user@host')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void connectSshManual()
                  }
                }}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !sshManual.trim()}
              onClick={() => void connectSshManual()}
            >
              <Plus className="size-4" />
              {t('addSsh', 'Add SSH')}
            </Button>
          </div>
        </div>

        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>

      {asks.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-card p-4 flex flex-col gap-3">
          <div className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t('needsAnswer', 'Needs answer ({{count}})', { count: asks.length })}
          </div>
          {asks.map((ask) => (
            <OrcaBotmuxAskCard
              key={ask.askId}
              askId={ask.askId}
              hostLabel={ask.hostLabel}
              botName={ask.botName}
              questions={ask.questions}
              deadlineAt={ask.deadlineAt}
              busy={busy}
              onSubmit={(selections) =>
                void (async () => {
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
                })()
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
