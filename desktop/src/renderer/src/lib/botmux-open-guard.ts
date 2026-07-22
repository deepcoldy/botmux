/**
 * Pure helpers for single-open attach: in-flight dedupe and existing-tab reuse.
 * Kept free of Electron/Zustand so unit tests can drive the real decision path.
 */

export function botmuxOpenGuardKey(sessionId: string, mode: string): string {
  return `${String(mode).trim()}:${String(sessionId ?? '').trim()}`
}

export type BotmuxAttachTabAction =
  | { kind: 'create' }
  | { kind: 'reuse'; tabId: string }
  | { kind: 'skip-inflight' }

/**
 * Titles left on the tab after local PTY spawn when ssh/tmux attach never stuck
 * (or fell through the `|| printf` path back to a local shell). Reusing these
 * as "live attach" leaves the user on a bare `~` prompt forever.
 *
 * Also matches post-restart reattach leftovers whose OSC cwd became the
 * desktop userData folder (e.g. `..ebug-userdata` / `.cdp-debug-userdata`).
 */
export function isBareLocalShellTabTitle(title: string | null | undefined): boolean {
  const t = String(title ?? '').trim()
  if (!t) return true
  if (t === '~' || t === '$' || t === '#' || t === '%' || t === '-' || t === '.') return true
  // Home-only / tilde path titles from OSC cwd updates after failed attach.
  if (/^~[/\\]?$/.test(t)) return true
  // Daemon reattach without re-running ssh/tmux: shell title or local userData.
  if (/^shell$/i.test(t)) return true
  if (/cdp-debug-userdata|botmux-desktop-dev|Application Support/i.test(t)) return true
  if (/\.\.ebug-userdata/i.test(t)) return true
  return false
}

/**
 * Whether a control-plane tab with a live ptyId is safe to reuse on attach open.
 *
 * CDP repro: tab had ptyId + title "~" after a failed/never-run ssh attach;
 * reuse skipped re-queueing `ssh -tt … tmux attach` and stuck on local shell.
 *
 * Require either positive attach evidence (tmux session name / user@host) or a
 * non-bare title for local-only attach. Bare local titles always force create.
 */
export function isReusableBotmuxAttachTab(args: {
  ptyId?: string | null
  title?: string | null
  /** e.g. bmx-e2e9b0d1 — when set, prefer titles that still name this session */
  tmuxSessionName?: string | null
}): boolean {
  if (!args.ptyId) return false
  if (isBareLocalShellTabTitle(args.title)) return false

  const title = String(args.title ?? '').trim()
  const tmux = String(args.tmuxSessionName ?? '').trim()
  if (tmux && title.includes(tmux)) return true
  // OpenSSH / remote shell often set the tab to user@host after a real attach.
  if (/^[^@\s/]+@[^@\s]+/.test(title)) return true
  // Any other non-bare title (agent name, cwd path, product title without
  // tilde-only) is treated as still useful — avoids killing a live agent on
  // re-click when OSC renames away from bmx-*.
  return true
}

/**
 * Decide whether attach open should create a tab, reuse an existing one on the
 * session host, or wait on an in-flight open for the same session+mode.
 *
 * Callers must pass only **reusable** live tab ids (see
 * `isReusableBotmuxAttachTab`). Bare local shells with a ptyId must not appear
 * here.
 */
export function decideBotmuxAttachTabAction(args: {
  openKey: string
  inFlightKeys: ReadonlySet<string>
  /** Terminal tab ids already on the resolved session host (e.g. botmux:session:*) */
  existingTabIds: readonly string[]
}): BotmuxAttachTabAction {
  if (args.inFlightKeys.has(args.openKey)) {
    return { kind: 'skip-inflight' }
  }
  const first = args.existingTabIds.find((id) => id.trim().length > 0)
  if (first) {
    return { kind: 'reuse', tabId: first }
  }
  return { kind: 'create' }
}

export type BotmuxSessionOpenDecision =
  | { kind: 'reuse'; tabId: string; reason: 'bound-live' | 'legacy-single' }
  | { kind: 'close-stale-then-create'; tabId: string; reason: 'bound-dead' }
  | { kind: 'create'; reason: 'no-binding' }

export type BotmuxSessionOpenTabSnapshot = {
  id: string
  ptyId?: string | null
  title?: string | null
  quickCommandLabel?: string | null
  botmuxSessionId?: string | null
}

/**
 * Pure open decision for attach click:
 * - same sessionId with a still-present bound tab + healthy attach → focus
 * - bound tab with bare local shell (failed/missing attach) → close then create
 * - bound tab present but no ptyId → close then create
 * - no binding: optional legacy single unbound healthy tab → reuse+bind
 * - else create
 */
export function decideBotmuxSessionOpenAction(args: {
  sessionId: string
  /** Pre-resolved bound tab id (meta and/or tab stamps); null if unknown */
  boundTabId: string | null
  hostTabs: readonly BotmuxSessionOpenTabSnapshot[]
  tmuxSessionName?: string | null
}): BotmuxSessionOpenDecision {
  const sid = String(args.sessionId ?? '').trim()
  const hostTabs = args.hostTabs
  let boundTabId = args.boundTabId
  if (!boundTabId && sid) {
    const stamped = hostTabs.find((t) => String(t.botmuxSessionId ?? '').trim() === sid)
    if (stamped) boundTabId = stamped.id
  }
  if (boundTabId) {
    const boundTab = hostTabs.find((t) => t.id === boundTabId)
    if (boundTab) {
      if (
        boundTab.ptyId &&
        isReusableBotmuxAttachTab({
          ptyId: boundTab.ptyId,
          // Prefer live OSC title; fall back to product label (d2 · bmx-*).
          title: boundTab.title ?? boundTab.quickCommandLabel,
          tmuxSessionName: args.tmuxSessionName
        })
      ) {
        return { kind: 'reuse', tabId: boundTab.id, reason: 'bound-live' }
      }
      // Bare local shell after restart / failed attach — force re-attach.
      return { kind: 'close-stale-then-create', tabId: boundTab.id, reason: 'bound-dead' }
    }
  }

  // Legacy: one unbound healthy tab on a cold host — claim it for this session.
  const unboundReusable = hostTabs.filter((t) => {
    const owner = String(t.botmuxSessionId ?? '').trim()
    if (owner && owner !== sid) return false
    return isReusableBotmuxAttachTab({
      ptyId: t.ptyId,
      title: t.title ?? t.quickCommandLabel,
      tmuxSessionName: args.tmuxSessionName
    })
  })
  if (unboundReusable.length === 1 && hostTabs.length === 1) {
    return { kind: 'reuse', tabId: unboundReusable[0].id, reason: 'legacy-single' }
  }
  return { kind: 'create', reason: 'no-binding' }
}

/** Module-level in-flight registry for attach opens (sessionId+mode). */
const inflightAttachOpens = new Map<string, Promise<unknown>>()

export function getBotmuxAttachInFlightKeysForTest(): ReadonlySet<string> {
  return new Set(inflightAttachOpens.keys())
}

export function clearBotmuxAttachInFlightForTest(): void {
  inflightAttachOpens.clear()
}

/**
 * Run `fn` once per openKey; concurrent callers await the same promise so
 * double-click / double-fire cannot create two attach tabs.
 */
export async function runBotmuxAttachOpenExclusive<T>(
  openKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const existing = inflightAttachOpens.get(openKey)
  if (existing) {
    return existing as Promise<T>
  }
  const run = (async () => {
    try {
      return await fn()
    } finally {
      inflightAttachOpens.delete(openKey)
    }
  })()
  inflightAttachOpens.set(openKey, run)
  return run
}
