/**
 * Open a OrcaBotmux session in the **main** Terminal workbench.
 *
 * SSH attach policy (avoids black/flash):
 *  - Prefer **local PTY** + `ssh -tt … tmux attach` (cliShellCommand).
 *  - Only use remote OrcaBotmux SSH PTY when a real worktree match is live and the
 *    SSH provider is connected — otherwise `pty:spawn` throws
 *    "No PTY provider for connection …" and the tab dies.
 *
 * Never opens the floating terminal panel.
 *
 * Debug: filter DevTools / main console with `[orca-botmux-open]`.
 */
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  bindOrcaBotmuxHostTabSession,
  findOrcaBotmuxSessionIdForTab,
  isOrcaBotmuxControlPlaneHostId,
  resolveOrcaBotmuxBoundTabIdForSession
} from '../../../shared/orca-botmux-main-terminal-host'
import {
  activateOrcaBotmuxTabHost,
  ensureOrcaBotmuxWorkspaceHost,
  resolveOrcaBotmuxSessionTabHost
} from '@/lib/ensure-orca-botmux-workspace-host'
import {
  orcaBotmuxOpenGuardKey,
  decideOrcaBotmuxSessionOpenAction,
  runOrcaBotmuxAttachOpenExclusive
} from '@/lib/orca-botmux-open-guard'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  openOrcaBotmuxNativeTerminalTab,
  openOrcaBotmuxTmuxAttachTab,
  type NativeTerminalSpec
} from '@/lib/open-orca-botmux-native-terminal-tab'

const LOG = '[orca-botmux-open]'

type OrcaBotmuxOpenLogEntry = {
  t: number
  level: 'info' | 'warn' | 'error'
  step: string
  detail?: Record<string, unknown>
}

declare global {
  interface Window {
    /** Ring buffer for CDP / MCP dump: window.__orcaBotmuxOpenLogs */
    __orcaBotmuxOpenLogs?: OrcaBotmuxOpenLogEntry[]
    /** Convenience: copy JSON of last N orca-botmux-open logs */
    __dumpOrcaBotmuxOpenLogs?: (n?: number) => string
  }
}

function pushOpenLog(
  level: OrcaBotmuxOpenLogEntry['level'],
  step: string,
  detail?: Record<string, unknown>
): void {
  try {
    if (typeof window === 'undefined') return
    if (!window.__orcaBotmuxOpenLogs) {
      window.__orcaBotmuxOpenLogs = []
      window.__dumpOrcaBotmuxOpenLogs = (n = 80) => {
        const buf = window.__orcaBotmuxOpenLogs ?? []
        return JSON.stringify(buf.slice(-n), null, 2)
      }
    }
    window.__orcaBotmuxOpenLogs.push({ t: Date.now(), level, step, detail })
    // Cap memory (~200 events)
    if (window.__orcaBotmuxOpenLogs.length > 200) {
      window.__orcaBotmuxOpenLogs.splice(0, window.__orcaBotmuxOpenLogs.length - 200)
    }
  } catch {
    /* ignore */
  }
}

function log(step: string, detail?: Record<string, unknown>): void {
  pushOpenLog('info', step, detail)
  if (detail) {
    console.info(LOG, step, detail)
  } else {
    console.info(LOG, step)
  }
}

function logWarn(step: string, detail?: Record<string, unknown>): void {
  pushOpenLog('warn', step, detail)
  if (detail) {
    console.warn(LOG, step, detail)
  } else {
    console.warn(LOG, step)
  }
}

/** Co-locate session bind on the tab object (survives dual-module meta maps). */
function stampOrcaBotmuxSessionIdOnTab(tabId: string, sessionId: string): void {
  const sid = String(sessionId ?? '').trim()
  const tid = String(tabId ?? '').trim()
  if (!sid || !tid) return
  useAppStore.setState((s) => {
    let changed = false
    const next: typeof s.tabsByWorktree = { ...s.tabsByWorktree }
    for (const [wtId, tabs] of Object.entries(s.tabsByWorktree)) {
      const idx = tabs.findIndex((t) => t.id === tid)
      if (idx < 0) continue
      if (tabs[idx].orcaBotmuxSessionId === sid) return {}
      const copy = tabs.slice()
      copy[idx] = { ...copy[idx], orcaBotmuxSessionId: sid }
      next[wtId] = copy
      changed = true
      break
    }
    return changed ? { tabsByWorktree: next } : {}
  })
}

function logError(step: string, err: unknown, detail?: Record<string, unknown>): void {
  const payload = {
    ...detail,
    error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
  }
  pushOpenLog('error', step, payload)
  console.error(LOG, step, payload)
}

export type OrcaBotmuxSessionOpenTarget = {
  sessionId: string
  hostId: string
  hostLabel: string
  title?: string
  cwd?: string
  botName?: string
  cliType?: string
}

export type OrcaBotmuxSessionOpenMode = 'attach' | 'web' | 'relay' | 'external'

type TmuxAttachSpecOk = {
  ok: true
  attachKind: 'local' | 'ssh'
  tmuxSessionName: string
  shellCommand: string
  remoteShellCommand?: string
  cliShellCommand?: string
  title: string
  sshTargetId?: string
  destination?: string
}

type BridgeApi = {
  getWriteLink: (args: {
    sessionId: string
    hostId?: string
  }) => Promise<{ ok: boolean; url?: string; message?: string }>
  tmuxAttachSpec?: (args: {
    sessionId: string
    hostId?: string
  }) => Promise<TmuxAttachSpecOk | { ok: false; reason?: string; message?: string }>
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
  openTerminal: (args: {
    sessionId: string
    hostId?: string
    external?: boolean
    title?: string
  }) => Promise<{ ok: boolean; message?: string }>
}

function bridgeApi(): BridgeApi | undefined {
  return (window as unknown as { api?: { orcaBotmuxBridge?: BridgeApi } }).api?.orcaBotmuxBridge
}

function sessionTitle(session: OrcaBotmuxSessionOpenTarget): string {
  return `${session.hostLabel} · ${session.title || session.sessionId}`
}

/**
 * Resolve the preload UI focus entry (window.api.ui.focus → window:focus IPC).
 * Pure so tests assert the real call path without a full Electron open.
 */
export function resolveOrcaBotmuxDesktopFocusCall(
  api: { ui?: { focus?: () => void }; focus?: () => void } | null | undefined
): (() => void) | null {
  // Why: focus lives on api.ui next to minimize/maximize (not top-level api.focus).
  const uiFocus = api?.ui?.focus
  if (typeof uiFocus === 'function') {
    return () => uiFocus()
  }
  return null
}

/** Raise the desktop window so attach output is not stuck under hidden-delivery. */
export function requestOrcaBotmuxDesktopWindowFocus(): void {
  try {
    const api = (window as unknown as { api?: { ui?: { focus?: () => void } } }).api
    resolveOrcaBotmuxDesktopFocusCall(api)?.()
  } catch {
    /* best-effort */
  }
  try {
    window.focus()
  } catch {
    /* best-effort */
  }
}

function focusMainTerminalTab(worktreeId: string, tab: 'terminal' | 'browser', tabId?: string): void {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    throw new Error('OrcaBotmux session open refused floating terminal host')
  }
  const before = useAppStore.getState()
  log('focus:before', {
    worktreeId,
    tab,
    tabId: tabId ?? null,
    activeWorktreeId: before.activeWorktreeId,
    activeView: before.activeView,
    activeTabId: before.activeTabId,
    tabsOnHost: (before.tabsByWorktree[worktreeId] ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      ptyId: t.ptyId
    }))
  })
  activateOrcaBotmuxTabHost(worktreeId)
  const store = useAppStore.getState()
  store.setActiveTabType(tab)
  if (tabId && tab === 'terminal') {
    store.setActiveTab(tabId)
    focusTerminalTabSurface(tabId)
  }
  const after = useAppStore.getState()
  log('focus:after', {
    worktreeId,
    tabId: tabId ?? null,
    activeWorktreeId: after.activeWorktreeId,
    activeView: after.activeView,
    activeTabType: after.activeTabType,
    activeTabId: after.activeTabId
  })
}

/**
 * Prefer cli ssh attach for SSH sessions unless the host explicitly has a live
 * remote PTY (matched OrcaBotmux SSH worktree + connected provider).
 */
function resolveAttachShellCommand(
  attach: TmuxAttachSpecOk,
  host: { remotePty: boolean }
): string {
  if (attach.attachKind === 'ssh' && host.remotePty) {
    return (
      attach.remoteShellCommand ||
      `tmux attach-session -t ${attach.tmuxSessionName} || printf '%s\\n' 'OrcaBotmux: attach failed'`
    )
  }
  if (attach.attachKind === 'ssh') {
    // Local PTY + system OpenSSH (IdentityFile from Settings → SSH).
    return attach.cliShellCommand ?? attach.shellCommand
  }
  return attach.shellCommand
}

async function openWebOnHost(
  api: BridgeApi,
  session: OrcaBotmuxSessionOpenTarget,
  worktreeId: string,
  title: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const link = await api.getWriteLink({
    sessionId: session.sessionId,
    hostId: session.hostId
  })
  if (!link.ok || !link.url) {
    return { ok: false, message: link.message ?? 'write-link unavailable' }
  }
  activateOrcaBotmuxTabHost(worktreeId)
  useAppStore.getState().createBrowserTab(worktreeId, link.url, { title, activate: true })
  focusMainTerminalTab(worktreeId, 'browser')
  return { ok: true }
}

export async function openOrcaBotmuxSessionInMainWorkspace(
  session: OrcaBotmuxSessionOpenTarget,
  mode: OrcaBotmuxSessionOpenMode = 'attach'
): Promise<
  { ok: true; used?: 'attach' | 'web' | 'relay' | 'external' } | { ok: false; message: string }
> {
  // Why: intentional open must raise the app so PTY bytes are not dropped by
  // the hidden-delivery gate while the window is backgrounded.
  requestOrcaBotmuxDesktopWindowFocus()

  const openKey = orcaBotmuxOpenGuardKey(session.sessionId, mode)
  if (mode === 'attach') {
    return runOrcaBotmuxAttachOpenExclusive(openKey, () =>
      openOrcaBotmuxSessionInMainWorkspaceBody(session, mode, openKey)
    )
  }
  return openOrcaBotmuxSessionInMainWorkspaceBody(session, mode, openKey)
}

async function openOrcaBotmuxSessionInMainWorkspaceBody(
  session: OrcaBotmuxSessionOpenTarget,
  mode: OrcaBotmuxSessionOpenMode,
  openKey: string
): Promise<
  { ok: true; used?: 'attach' | 'web' | 'relay' | 'external' } | { ok: false; message: string }
> {
  const t0 = performance.now()
  log('start', {
    mode,
    sessionId: session.sessionId,
    hostId: session.hostId,
    hostLabel: session.hostLabel,
    title: session.title ?? null,
    cwd: session.cwd ?? null,
    openKey
  })

  try {
    const api = bridgeApi()
    if (!api) {
      logWarn('fail:no-bridge-api')
      return { ok: false, message: 'orcaBotmuxBridge unavailable — rebuild desktop.' }
    }

    const title = sessionTitle(session)
    log('api', {
      hasTmuxAttachSpec: typeof api.tmuxAttachSpec === 'function',
      hasNativeTerminalSpec: typeof api.nativeTerminalSpec === 'function',
      hasGetWriteLink: typeof api.getWriteLink === 'function'
    })

    if (mode === 'external') {
      log('path:external')
      const r = await api.openTerminal({
        sessionId: session.sessionId,
        hostId: session.hostId,
        external: true,
        title
      })
      log(r.ok ? 'done:external' : 'fail:external', {
        ms: Math.round(performance.now() - t0),
        message: r.message ?? null
      })
      return r.ok
        ? { ok: true, used: 'external' }
        : { ok: false, message: r.message ?? 'Open failed' }
    }

    if (mode === 'attach' && api.tmuxAttachSpec) {
      log('path:attach → tmuxAttachSpec')
      const attach = await api.tmuxAttachSpec({
        sessionId: session.sessionId,
        hostId: session.hostId
      })
      if (attach.ok) {
        log('tmuxAttachSpec:result', {
          ok: true,
          attachKind: attach.attachKind,
          tmuxSessionName: attach.tmuxSessionName,
          sshTargetId: attach.sshTargetId ?? null,
          destination: attach.destination ?? null,
          shellCommand: attach.shellCommand,
          cliShellCommand: attach.cliShellCommand ?? null,
          remoteShellCommand: attach.remoteShellCommand ?? null
        })
      } else {
        log('tmuxAttachSpec:result', {
          ok: false,
          reason: 'reason' in attach ? String(attach.reason ?? '') : null,
          message: 'message' in attach ? String(attach.message ?? '') : null
        })
      }

      if (attach.ok) {
        const hostHint = {
          sessionId: session.sessionId,
          hostId: session.hostId,
          hostLabel: session.hostLabel,
          title: session.title,
          cwd: session.cwd,
          botName: session.botName,
          cliType: session.cliType
        }
        let host = resolveOrcaBotmuxSessionTabHost(hostHint)
        log('host:resolved', host.ok ? { ...host } : { ok: false, message: host.message })
        if (!host.ok) {
          logWarn('fail:host', { message: host.message, ms: Math.round(performance.now() - t0) })
          return host
        }

        // Only wait on SSH connect when we will use remote PTY.
        if (host.remotePty && attach.sshTargetId) {
          log('ssh:connect:start', { targetId: attach.sshTargetId })
          const sshApi = (
            window as unknown as {
              api?: { ssh?: { connect?: (args: { targetId: string }) => Promise<unknown> } }
            }
          ).api?.ssh
          try {
            await sshApi?.connect?.({ targetId: attach.sshTargetId })
            const st = useAppStore.getState().sshConnectionStates.get(attach.sshTargetId)
            log('ssh:connect:done', {
              targetId: attach.sshTargetId,
              status: st?.status ?? null
            })
          } catch (err) {
            logWarn('ssh:connect:error', {
              targetId: attach.sshTargetId,
              error: err instanceof Error ? err.message : String(err)
            })
          }
          const again = resolveOrcaBotmuxSessionTabHost(hostHint)
          if (again.ok) {
            log('host:re-resolved-after-ssh', { ...again })
            host = again
          }
        }

        if (!host.ok) {
          return host
        }

        const shellCommand = resolveAttachShellCommand(attach, host)
        const hostWorktreeId = host.worktreeId
        const tmuxSessionName = attach.tmuxSessionName

        // Why: agent-scoped hosts hold many sessions as tabs. Same sessionId
        // re-open focuses the bound tab (reuse). Different session → create.
        // Binding lives on meta (globalThis registry) + tab.orcaBotmuxSessionId.
        if (isOrcaBotmuxControlPlaneHostId(hostWorktreeId)) {
          const hostTabs = useAppStore.getState().tabsByWorktree[hostWorktreeId] ?? []
          const boundTabId = resolveOrcaBotmuxBoundTabIdForSession({
            worktreeId: hostWorktreeId,
            sessionId: session.sessionId,
            hostTabs
          })
          const decision = decideOrcaBotmuxSessionOpenAction({
            sessionId: session.sessionId,
            boundTabId,
            hostTabs: hostTabs.map((t) => ({
              id: t.id,
              ptyId: t.ptyId,
              title: t.title ?? t.quickCommandLabel,
              quickCommandLabel: t.quickCommandLabel,
              orcaBotmuxSessionId:
                t.orcaBotmuxSessionId ?? findOrcaBotmuxSessionIdForTab(hostWorktreeId, t.id)
            })),
            tmuxSessionName
          })

          if (decision.kind === 'reuse') {
            bindOrcaBotmuxHostTabSession(
              hostWorktreeId,
              decision.tabId,
              session.sessionId,
              session.cwd
            )
            stampOrcaBotmuxSessionIdOnTab(decision.tabId, session.sessionId)
            useAppStore.getState().setOrcaBotmuxHostSurface(hostWorktreeId, {
              sessionId: session.sessionId,
              cwd: session.cwd
            })
            log('tab:reuse-existing', {
              worktreeId: hostWorktreeId,
              tabId: decision.tabId,
              sessionId: session.sessionId,
              reason: decision.reason,
              reusedTitle:
                hostTabs.find((t) => t.id === decision.tabId)?.title ?? null
            })
            focusMainTerminalTab(hostWorktreeId, 'terminal', decision.tabId)
            log('done:attach', {
              tabId: decision.tabId,
              worktreeId: hostWorktreeId,
              reused: true,
              reason: decision.reason,
              ms: Math.round(performance.now() - t0)
            })
            return { ok: true, used: 'attach' }
          }

          if (decision.kind === 'close-stale-then-create') {
            log('tab:close-stale-before-create', {
              worktreeId: hostWorktreeId,
              closeIds: [decision.tabId],
              sessionId: session.sessionId,
              reason: decision.reason
            })
            try {
              useAppStore.getState().closeTab(decision.tabId, { reason: 'cleanup' })
            } catch (err) {
              logWarn('tab:close-stale-failed', {
                tabId: decision.tabId,
                error: err instanceof Error ? err.message : String(err)
              })
            }
          }
        }

        log('tab:create', {
          worktreeId: hostWorktreeId,
          remotePty: host.remotePty,
          reason: host.reason,
          shellCommand,
          shellLen: shellCommand.length,
          sessionId: session.sessionId
        })

        const { tabId } = openOrcaBotmuxTmuxAttachTab({
          worktreeId: hostWorktreeId,
          shellCommand,
          title: attach.title || title,
          orcaBotmuxSessionId: session.sessionId
        })
        if (isOrcaBotmuxControlPlaneHostId(hostWorktreeId)) {
          bindOrcaBotmuxHostTabSession(hostWorktreeId, tabId, session.sessionId, session.cwd)
          stampOrcaBotmuxSessionIdOnTab(tabId, session.sessionId)
          useAppStore.getState().setOrcaBotmuxHostSurface(hostWorktreeId, {
            sessionId: session.sessionId,
            cwd: session.cwd
          })
        }
        focusMainTerminalTab(hostWorktreeId, 'terminal', tabId)

        // Snapshot shortly after open — flash/close often clears tab here.
        window.setTimeout(() => {
          const s = useAppStore.getState()
          const still = (s.tabsByWorktree[hostWorktreeId] ?? []).find((t) => t.id === tabId)
          log('tab:post-100ms', {
            tabId,
            worktreeId: hostWorktreeId,
            stillExists: Boolean(still),
            ptyId: still?.ptyId ?? null,
            activeWorktreeId: s.activeWorktreeId,
            activeTabId: s.activeTabId,
            tabCountOnHost: (s.tabsByWorktree[hostWorktreeId] ?? []).length
          })
        }, 100)
        window.setTimeout(() => {
          const s = useAppStore.getState()
          const still = (s.tabsByWorktree[hostWorktreeId] ?? []).find((t) => t.id === tabId)
          log('tab:post-500ms', {
            tabId,
            worktreeId: hostWorktreeId,
            stillExists: Boolean(still),
            ptyId: still?.ptyId ?? null,
            activeWorktreeId: s.activeWorktreeId,
            activeTabId: s.activeTabId
          })
        }, 500)

        log('done:attach', {
          tabId,
          worktreeId: hostWorktreeId,
          ms: Math.round(performance.now() - t0)
        })
        return { ok: true, used: 'attach' }
      }

      logWarn('attach-spec-failed → web-fallback', {
        message: 'message' in attach ? attach.message : null
      })
      const host = resolveOrcaBotmuxSessionTabHost({
        sessionId: session.sessionId,
        hostId: session.hostId,
        hostLabel: session.hostLabel,
        title: session.title,
        cwd: session.cwd
      })
      if (!host.ok) {
        logWarn('fail:host-web-fallback', { message: host.message })
        return host
      }
      const web = await openWebOnHost(api, session, host.worktreeId, title)
      log(web.ok ? 'done:web-fallback' : 'fail:web-fallback', {
        ms: Math.round(performance.now() - t0),
        worktreeId: host.worktreeId
      })
      if (web.ok) return { ok: true, used: 'web' }
      return { ok: false, message: attach.message ?? 'tmux attach unavailable' }
    }

    const host = await ensureOrcaBotmuxWorkspaceHost()
    if (!host.ok) {
      logWarn('fail:ensure-host', { message: host.message })
      return host
    }
    const { worktreeId } = host
    log('host:ensure', { ...host })

    if (mode === 'relay') {
      if (!api.nativeTerminalSpec) {
        logWarn('fail:no-nativeTerminalSpec')
        return { ok: false, message: 'nativeTerminalSpec unavailable — rebuild desktop.' }
      }
      activateOrcaBotmuxTabHost(worktreeId)
      const spec = await api.nativeTerminalSpec({
        sessionId: session.sessionId,
        hostId: session.hostId
      })
      log('nativeTerminalSpec:result', { ok: spec.ok, ...(spec.ok ? { title: spec.title } : {}) })
      if (!spec.ok) {
        return { ok: false, message: spec.message ?? 'Could not build PTY relay' }
      }
      const terminalSpec: NativeTerminalSpec = {
        command: spec.command,
        args: spec.args,
        title: spec.title || title,
        electronRunAsNode: spec.electronRunAsNode !== false
      }
      const { tabId } = openOrcaBotmuxNativeTerminalTab({ worktreeId, spec: terminalSpec })
      focusMainTerminalTab(worktreeId, 'terminal', tabId)
      log('done:relay', { tabId, ms: Math.round(performance.now() - t0) })
      return { ok: true, used: 'relay' }
    }

    log('path:web')
    const web = await openWebOnHost(api, session, worktreeId, title)
    log(web.ok ? 'done:web' : 'fail:web', { ms: Math.round(performance.now() - t0) })
    return web.ok ? { ok: true, used: 'web' } : web
  } catch (err) {
    logError('throw', err, {
      mode,
      sessionId: session.sessionId,
      ms: Math.round(performance.now() - t0)
    })
    throw err
  }
}
