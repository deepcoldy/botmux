/**
 * Open a Botmux session as a real Desktop terminal tab (Botmux xterm + PTY)
 * that runs the WS relay against the worker write-link.
 */
import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import type { Tab, TuiAgent } from '../../../shared/types'

export type NativeTerminalSpec = {
  command: string
  args: string[]
  title: string
  /** When true (default for Electron binary), prefix ELECTRON_RUN_AS_NODE=1 */
  electronRunAsNode?: boolean
}

function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * True when `command` is likely the Electron helper binary (needs RUN_AS_NODE).
 */
export function looksLikeElectronBinary(command: string): boolean {
  const base = command.split(/[/\\]/).pop() ?? command
  return /^(Electron|electron|botmux-desktop|Botmux)(\.exe)?$/i.test(base)
}

/**
 * Build a one-shot shell line that replaces the shell with the relay process.
 * Uses the Electron/Node binary that shipped the relay (spec.command).
 */
export function buildNativeRelayShellCommand(spec: NativeTerminalSpec): string {
  const parts = [spec.command, ...spec.args].map(shellQuote)
  const runAsNode =
    spec.electronRunAsNode === true ||
    (spec.electronRunAsNode !== false && looksLikeElectronBinary(spec.command))
  const body = `exec ${parts.join(' ')}`
  // Why: process.execPath inside Electron is the GUI binary; without this flag
  // the .mjs relay is treated as an app entry and never runs as Node.
  if (runAsNode) {
    return `ELECTRON_RUN_AS_NODE=1 ${body}`
  }
  return body
}

function finishBotmuxTerminalTab(args: {
  worktreeId: string
  title: string
  shellLine: string
  groupId?: string | null
  /** Stamp on TerminalTab for same-session re-open (store-side bind). */
  botmuxSessionId?: string | null
  /**
   * Why: Orca agent worktrees stamp launch identity so native chat can resolve
   * the transcript layout before hooks report. Botmux attach tabs need the same.
   */
  launchAgent?: TuiAgent | null
  /** Initial pane mode when native chat is preferred for this agent. */
  viewMode?: Tab['viewMode']
}): { tabId: string } {
  const store = useAppStore.getState()
  console.info('[botmux-open]', 'tab:createTab', {
    worktreeId: args.worktreeId,
    title: args.title,
    groupId: args.groupId ?? null,
    shellPreview: args.shellLine.slice(0, 200),
    botmuxSessionId: args.botmuxSessionId ?? null,
    launchAgent: args.launchAgent ?? null,
    viewMode: args.viewMode ?? null,
    existingTabs: (store.tabsByWorktree[args.worktreeId] ?? []).length
  })

  // Why: do NOT append `\n` here. Shell-ready / sendInput already submit with
  // exactly one CR/LF. A trailing `\n` plus delivery `\r` becomes double Enter —
  // after `tmux attach` that lands in the agent input as blank lines.
  const line = args.shellLine.replace(/[\r\n]+$/g, '')

  // Why: pre-mint the tab id and queue startup BEFORE createTab. When the
  // botmux host is already active, createTab notifies subscribers and can
  // mount TerminalPane in the same turn — useState snapshots
  // pendingStartupByTabId before a post-create queue runs (ptyId stays null).
  const tabId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `botmux-tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
  store.queueTabStartupCommand(tabId, {
    command: line
  })
  console.info('[botmux-open]', 'tab:queued-startup', {
    tabId,
    worktreeId: args.worktreeId,
    commandLen: line.length,
    command: line
  })

  // Why: activate:true so the new tab becomes the focused surface immediately.
  // Startup was already queued under tabId so the first TerminalPane mount
  // still sees pendingStartupByTabId (unlike queue-after-create).
  const tab = store.createTab(args.worktreeId, args.groupId ?? undefined, undefined, {
    id: tabId,
    quickCommandLabel: args.title,
    activate: true,
    ...(args.botmuxSessionId
      ? { botmuxSessionId: args.botmuxSessionId }
      : {}),
    ...(args.launchAgent ? { launchAgent: args.launchAgent } : {}),
    ...(args.viewMode ? { viewMode: args.viewMode } : {})
  })

  store.setActiveTabType('terminal')

  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[args.worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles
    .filter((f) => f.worktreeId === args.worktreeId)
    .map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[args.worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[args.worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(args.worktreeId, order)

  fresh.updateTabTitle(tab.id, args.title)

  console.info('[botmux-open]', 'tab:created', {
    tabId: tab.id,
    worktreeId: args.worktreeId,
    title: args.title,
    ptyId: tab.ptyId,
    activeTabId: fresh.activeTabId,
    tabOrderTail: order.slice(-3)
  })

  return { tabId: tab.id }
}

/** WS relay path (write-link protocol) — legacy / fallback. */
export function openBotmuxNativeTerminalTab(args: {
  worktreeId: string
  spec: NativeTerminalSpec
  groupId?: string | null
  botmuxSessionId?: string | null
  launchAgent?: TuiAgent | null
  viewMode?: Tab['viewMode']
}): { tabId: string } {
  return finishBotmuxTerminalTab({
    worktreeId: args.worktreeId,
    title: args.spec.title,
    shellLine: buildNativeRelayShellCommand(args.spec),
    groupId: args.groupId,
    botmuxSessionId: args.botmuxSessionId,
    launchAgent: args.launchAgent,
    viewMode: args.viewMode
  })
}

/**
 * Preferred path: shell line that runs `tmux attach` (or `ssh -tt … tmux attach`).
 * Matches Botmux remote terminal: real PTY, not webview.
 *
 * Do **not** wrap with `exec` here. Attach builders intentionally leave the
 * shell alive on failure so SSH/tmux errors stay visible instead of a flash
 * close or dead black pane (exec replaces the shell → PTY exit).
 */
export function openBotmuxTmuxAttachTab(args: {
  worktreeId: string
  shellCommand: string
  title: string
  groupId?: string | null
  botmuxSessionId?: string | null
  launchAgent?: TuiAgent | null
  viewMode?: Tab['viewMode']
}): { tabId: string } {
  return finishBotmuxTerminalTab({
    worktreeId: args.worktreeId,
    title: args.title,
    shellLine: args.shellCommand,
    groupId: args.groupId,
    botmuxSessionId: args.botmuxSessionId,
    launchAgent: args.launchAgent,
    viewMode: args.viewMode
  })
}
