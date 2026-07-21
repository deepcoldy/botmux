/**
 * Synthetic main-area hosts for OrcaBotmux control-plane sessions.
 *
 * OrcaBotmux terminals require a worktreeId (`tabsByWorktree[id]`). We fabricate a
 * stable Worktree shell from session metadata — never a Projects card, never
 * the floating panel.
 *
 * **Identity stability:** `getKnownWorktreeById` / `useActiveWorktree` must
 * return the **same object reference** for a given id. Returning a fresh
 * object every call makes Zustand think the store changed → maximum update
 * depth (see FileExplorer / right-sidebar crash).
 *
 * **Host model (agent-scoped):**
 *  - Preferred: `orca_botmux:agent:<host>::<agentKey>` — one worktree per
 *    host×agent so multiple sessions share the terminal tab strip.
 *  - Legacy: `orca_botmux:session:<sessionId>` still recognized for hydration.
 *
 * **PTY vs filesystem split:**
 *  - Terminal spawn always uses a **local** PTY + `ssh -tt … tmux attach`.
 *  - Worktree.path holds the session **cwd** for FileExplorer; filesystem
 *    APIs use `filesystemConnectionId` (SSH target), not remote PTY.
 */
import {
  ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
  FLOATING_TERMINAL_WORKTREE_ID
} from './constants'
import type { Worktree } from './types'

export const ORCA_BOTMUX_SESSION_WORKTREE_PREFIX = 'orca_botmux:session:'
export const ORCA_BOTMUX_AGENT_WORKTREE_PREFIX = 'orca_botmux:agent:'

export type OrcaBotmuxSessionHostSpec = {
  sessionId: string
  hostId: string
  hostLabel?: string
  title?: string
  cwd?: string | null
  /**
   * Agent grouping key/label (from orca_botmux session tree). When set, opens
   * land on an agent-scoped host so sibling sessions share tabs.
   */
  agentKey?: string
  agentLabel?: string
  /**
   * OrcaBotmux SSH target id (no `ssh:` prefix) for **filesystem** routing only.
   * Terminal spawn stays local regardless of this value.
   */
  sshTargetId?: string | null
}

export type OrcaBotmuxSessionHostMeta = {
  /** Most recently activated session on this host. */
  sessionId: string
  hostId: string
  agentKey?: string
  agentLabel?: string
  /**
   * SSH target for FileExplorer / git over SSH.
   * Must NOT be used for pty:spawn (always local for control-plane).
   */
  filesystemConnectionId: string | null
  /** @deprecated use filesystemConnectionId; kept for older call sites */
  sshTargetId: string | null
  /** tabId → sessionId so multi-session agent hosts can reuse/focus tabs */
  sessionIdsByTabId: Record<string, string>
  /** sessionId → cwd for panel path when switching tabs */
  cwdBySessionId: Record<string, string>
}

// Why: Vite can load this module twice (shared vs renderer graph). Module-local
// Maps then desync bind vs find and same-session re-open always creates. Park
// both maps on globalThis so every instance shares one live registry in-session.
type OrcaBotmuxHostRegistry = {
  worktrees: Map<string, Worktree>
  meta: Map<string, OrcaBotmuxSessionHostMeta>
}
const ORCA_BOTMUX_HOST_REGISTRY_KEY = '__botmuxControlPlaneHostRegistry_v1'
function getOrcaBotmuxHostRegistry(): OrcaBotmuxHostRegistry {
  const g = globalThis as typeof globalThis & {
    [ORCA_BOTMUX_HOST_REGISTRY_KEY]?: OrcaBotmuxHostRegistry
  }
  if (!g[ORCA_BOTMUX_HOST_REGISTRY_KEY]) {
    g[ORCA_BOTMUX_HOST_REGISTRY_KEY] = {
      worktrees: new Map(),
      meta: new Map()
    }
  }
  return g[ORCA_BOTMUX_HOST_REGISTRY_KEY]
}
const sessionWorktreeCache = getOrcaBotmuxHostRegistry().worktrees
const sessionHostMeta = getOrcaBotmuxHostRegistry().meta

/** Singleton — never allocate a new main host object per lookup. */
const MAIN_HOST_WORKTREE: Worktree = {
  id: ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
  repoId: 'orca_botmux:main-terminal',
  displayName: 'orca_botmux',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  linkedBitbucketPR: null,
  linkedAzureDevOpsPR: null,
  linkedGiteaPR: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  path: '',
  head: '',
  branch: '',
  isBare: false,
  isSparse: false,
  isMainWorktree: false
}

export function isOrcaBotmuxMainTerminalHostId(worktreeId: string | null | undefined): boolean {
  return worktreeId === ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID
}

export function isOrcaBotmuxSessionHostId(worktreeId: string | null | undefined): boolean {
  return typeof worktreeId === 'string' && worktreeId.startsWith(ORCA_BOTMUX_SESSION_WORKTREE_PREFIX)
}

export function isOrcaBotmuxAgentHostId(worktreeId: string | null | undefined): boolean {
  return typeof worktreeId === 'string' && worktreeId.startsWith(ORCA_BOTMUX_AGENT_WORKTREE_PREFIX)
}

/** Main host, per-session, or per-agent synthetic host (control plane, not Projects). */
export function isOrcaBotmuxControlPlaneHostId(worktreeId: string | null | undefined): boolean {
  return (
    isOrcaBotmuxMainTerminalHostId(worktreeId) ||
    isOrcaBotmuxSessionHostId(worktreeId) ||
    isOrcaBotmuxAgentHostId(worktreeId)
  )
}

/** True for synthetic terminal hosts that are not real git/folder projects. */
export function isSyntheticTerminalHostId(worktreeId: string | null | undefined): boolean {
  return isOrcaBotmuxControlPlaneHostId(worktreeId) || worktreeId === FLOATING_TERMINAL_WORKTREE_ID
}

export function worktreeIdForOrcaBotmuxSession(sessionId: string): string {
  const id = String(sessionId ?? '').trim()
  if (!id) return ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID
  return `${ORCA_BOTMUX_SESSION_WORKTREE_PREFIX}${id}`
}

/**
 * Separator between host and agent segments. Must NOT be `::` — that is the
 * OrcaBotmux worktree id separator (`repoId::path`). Using `::` made
 * splitWorktreeId treat the agent key as a filesystem path and PTY spawn
 * failed with DaemonProtocolError on `claude-code%3A%3A…`.
 */
export const ORCA_BOTMUX_AGENT_ID_SEPARATOR = '~~'

/**
 * Stable agent-scoped host id. agentKey may contain `::` — encode both parts
 * and join with {@link ORCA_BOTMUX_AGENT_ID_SEPARATOR} (never `::`).
 */
export function worktreeIdForOrcaBotmuxAgent(hostId: string, agentKey: string): string {
  const h = encodeURIComponent(String(hostId ?? '').trim() || 'unknown')
  const a = encodeURIComponent(String(agentKey ?? '').trim() || 'unknown')
  return `${ORCA_BOTMUX_AGENT_WORKTREE_PREFIX}${h}${ORCA_BOTMUX_AGENT_ID_SEPARATOR}${a}`
}

export function sessionIdFromBotmuxWorktreeId(worktreeId: string): string | null {
  if (!isOrcaBotmuxSessionHostId(worktreeId)) return null
  const id = worktreeId.slice(ORCA_BOTMUX_SESSION_WORKTREE_PREFIX.length).trim()
  return id || null
}

/**
 * Map bridge hostId (`local` | `ssh:<targetId>` | …) to OrcaBotmux SSH target id.
 */
export function sshTargetIdFromOrcaBotmuxHostId(hostId: string | null | undefined): string | null {
  const h = String(hostId ?? '').trim()
  if (!h || h === 'local' || h.startsWith('platform:')) return null
  if (h.startsWith('ssh:manual:')) return null
  if (h.startsWith('ssh:')) {
    const rest = h.slice(4).trim()
    return rest || null
  }
  return null
}

export function orcaBotmuxMainTerminalWorktree(): Worktree {
  return MAIN_HOST_WORKTREE
}

function buildSessionDisplayName(spec: OrcaBotmuxSessionHostSpec): string {
  const host = spec.hostLabel?.trim() || 'orca_botmux'
  const title = spec.title?.trim() || spec.sessionId.slice(0, 8)
  return `${host} · ${title}`
}

function buildAgentDisplayName(spec: OrcaBotmuxSessionHostSpec): string {
  const host = spec.hostLabel?.trim() || 'orca_botmux'
  const agent = spec.agentLabel?.trim() || spec.agentKey?.trim() || 'Agent'
  return `${host} · ${agent}`
}

function emptyMeta(
  sessionId: string,
  hostId: string,
  filesystemConnectionId: string | null,
  agentKey?: string,
  agentLabel?: string
): OrcaBotmuxSessionHostMeta {
  return {
    sessionId,
    hostId,
    agentKey,
    agentLabel,
    filesystemConnectionId,
    sshTargetId: filesystemConnectionId,
    sessionIdsByTabId: {},
    cwdBySessionId: {}
  }
}

/**
 * Ensure a stable synthetic Worktree for this session exists and is up to date.
 * Prefer {@link ensureOrcaBotmuxAgentWorktree} for multi-session agent hosts.
 */
export function ensureOrcaBotmuxSessionWorktree(spec: OrcaBotmuxSessionHostSpec): Worktree {
  const worktreeId = worktreeIdForOrcaBotmuxSession(spec.sessionId)
  const filesystemConnectionId =
    spec.sshTargetId !== undefined
      ? spec.sshTargetId?.trim() || null
      : sshTargetIdFromOrcaBotmuxHostId(spec.hostId)
  // Plant session cwd so FileExplorer can list; PTY spawn still uses '.'.
  const path = (spec.cwd ?? '').trim()
  const displayName = buildSessionDisplayName(spec)

  let wt = sessionWorktreeCache.get(worktreeId)
  if (!wt) {
    wt = {
      id: worktreeId,
      repoId: `orca_botmux:session-repo:${spec.sessionId}`,
      displayName,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
      path,
      head: '',
      branch: '',
      isBare: false,
      isSparse: false,
      isMainWorktree: false
    }
    sessionWorktreeCache.set(worktreeId, wt)
  } else {
    wt.displayName = displayName
    if (path) wt.path = path
    wt.lastActivityAt = Date.now()
  }

  const prev = sessionHostMeta.get(worktreeId)
  const meta = emptyMeta(
    spec.sessionId,
    spec.hostId,
    filesystemConnectionId,
    spec.agentKey,
    spec.agentLabel
  )
  if (prev) {
    meta.sessionIdsByTabId = { ...prev.sessionIdsByTabId }
    meta.cwdBySessionId = { ...prev.cwdBySessionId }
  }
  if (path) meta.cwdBySessionId[spec.sessionId] = path
  sessionHostMeta.set(worktreeId, meta)
  return wt
}

/**
 * Agent-scoped host: many sessions share one worktreeId / terminal tab strip.
 * Path follows the **active** session cwd for the right panel.
 */
export function ensureOrcaBotmuxAgentWorktree(spec: OrcaBotmuxSessionHostSpec): Worktree {
  const agentKey = String(spec.agentKey ?? '').trim() || 'unknown'
  const worktreeId = worktreeIdForOrcaBotmuxAgent(spec.hostId, agentKey)
  const filesystemConnectionId =
    spec.sshTargetId !== undefined
      ? spec.sshTargetId?.trim() || null
      : sshTargetIdFromOrcaBotmuxHostId(spec.hostId)
  const path = (spec.cwd ?? '').trim()
  const displayName = buildAgentDisplayName(spec)
  const sessionId = String(spec.sessionId ?? '').trim()

  let wt = sessionWorktreeCache.get(worktreeId)
  if (!wt) {
    wt = {
      id: worktreeId,
      repoId: `orca_botmux:agent-repo:${encodeURIComponent(spec.hostId)}:${encodeURIComponent(agentKey)}`,
      displayName,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
      path,
      head: '',
      branch: '',
      isBare: false,
      isSparse: false,
      isMainWorktree: false
    }
    sessionWorktreeCache.set(worktreeId, wt)
  } else {
    wt.displayName = displayName
    if (path) wt.path = path
    wt.lastActivityAt = Date.now()
  }

  const prev = sessionHostMeta.get(worktreeId)
  const meta = emptyMeta(
    sessionId || prev?.sessionId || '',
    spec.hostId,
    filesystemConnectionId,
    agentKey,
    spec.agentLabel?.trim() || agentKey
  )
  if (prev) {
    meta.sessionIdsByTabId = { ...prev.sessionIdsByTabId }
    meta.cwdBySessionId = { ...prev.cwdBySessionId }
  }
  if (sessionId && path) meta.cwdBySessionId[sessionId] = path
  if (sessionId) meta.sessionId = sessionId
  sessionHostMeta.set(worktreeId, meta)
  return wt
}

/**
 * Point the agent host's FileExplorer path at a session's cwd (tab switch).
 * Mutates the cached worktree in place for reference stability.
 */
export function setOrcaBotmuxHostActiveSession(
  worktreeId: string,
  args: { sessionId: string; cwd?: string | null; title?: string }
): void {
  if (!isOrcaBotmuxControlPlaneHostId(worktreeId) || isOrcaBotmuxMainTerminalHostId(worktreeId)) {
    return
  }
  const wt = sessionWorktreeCache.get(worktreeId)
  const meta = sessionHostMeta.get(worktreeId)
  if (!wt || !meta) return
  const sessionId = String(args.sessionId ?? '').trim()
  if (!sessionId) return
  const cwd = (args.cwd ?? meta.cwdBySessionId[sessionId] ?? '').trim()
  meta.sessionId = sessionId
  if (cwd) {
    meta.cwdBySessionId[sessionId] = cwd
    wt.path = cwd
  }
  wt.lastActivityAt = Date.now()
}

export function bindOrcaBotmuxHostTabSession(
  worktreeId: string,
  tabId: string,
  sessionId: string,
  cwd?: string | null
): void {
  const meta = sessionHostMeta.get(worktreeId)
  if (!meta) return
  const sid = String(sessionId ?? '').trim()
  const tid = String(tabId ?? '').trim()
  if (!sid || !tid) return
  meta.sessionIdsByTabId[tid] = sid
  meta.sessionId = sid
  const path = (cwd ?? '').trim()
  if (path) meta.cwdBySessionId[sid] = path
  const wt = sessionWorktreeCache.get(worktreeId)
  if (wt && path) wt.path = path
}

export function findOrcaBotmuxHostTabForSession(
  worktreeId: string,
  sessionId: string
): string | null {
  const meta = sessionHostMeta.get(worktreeId)
  if (!meta) return null
  const sid = String(sessionId ?? '').trim()
  for (const [tabId, mapped] of Object.entries(meta.sessionIdsByTabId)) {
    if (mapped === sid) return tabId
  }
  return null
}

/**
 * Resolve the tab for a session using meta map and/or tab.orcaBotmuxSessionId stamps
 * on the host's live tabs (store co-location survives dual-module map issues).
 */
export function resolveOrcaBotmuxBoundTabIdForSession(args: {
  worktreeId: string
  sessionId: string
  hostTabs: ReadonlyArray<{ id: string; orcaBotmuxSessionId?: string | null }>
}): string | null {
  const sid = String(args.sessionId ?? '').trim()
  if (!sid) return null
  const fromMeta = findOrcaBotmuxHostTabForSession(args.worktreeId, sid)
  if (fromMeta && args.hostTabs.some((t) => t.id === fromMeta)) {
    return fromMeta
  }
  for (const t of args.hostTabs) {
    if (String(t.orcaBotmuxSessionId ?? '').trim() === sid) {
      return t.id
    }
  }
  // Meta may still point at a closed tab; only return if still present.
  return fromMeta && args.hostTabs.some((t) => t.id === fromMeta) ? fromMeta : null
}

/** Reverse of {@link findOrcaBotmuxHostTabForSession}: which session owns this tab. */
export function findOrcaBotmuxSessionIdForTab(
  worktreeId: string,
  tabId: string
): string | null {
  const meta = sessionHostMeta.get(worktreeId)
  const tid = String(tabId ?? '').trim()
  if (!tid) return null
  const fromMeta = meta?.sessionIdsByTabId[tid]
  if (fromMeta) return String(fromMeta)
  return null
}

export function getCachedOrcaBotmuxControlPlaneWorktree(
  worktreeId: string
): Worktree | undefined {
  if (isOrcaBotmuxMainTerminalHostId(worktreeId)) return MAIN_HOST_WORKTREE
  if (isOrcaBotmuxSessionHostId(worktreeId) || isOrcaBotmuxAgentHostId(worktreeId)) {
    return sessionWorktreeCache.get(worktreeId)
  }
  return undefined
}

export function getOrcaBotmuxSessionHostMeta(
  worktreeId: string
): OrcaBotmuxSessionHostMeta | undefined {
  return sessionHostMeta.get(worktreeId)
}

/**
 * SSH connection for **filesystem** (FileExplorer). Not for PTY spawn.
 */
export function getOrcaBotmuxFilesystemConnectionId(
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId || isOrcaBotmuxMainTerminalHostId(worktreeId)) return null
  const meta = sessionHostMeta.get(worktreeId)
  return meta?.filesystemConnectionId ?? meta?.sshTargetId ?? null
}

/**
 * Always null for control-plane hosts — terminal must use local PTY + ssh -tt.
 * @deprecated Prefer local PTY always; kept so createTab remote routing stays off.
 */
export function getOrcaBotmuxHostSshTargetId(worktreeId: string): string | null {
  // Intentionally never return filesystem connection for PTY routing.
  void worktreeId
  return null
}

/**
 * Path handed to TerminalPane for local node-pty spawn cwd.
 *
 * Control-plane Worktree.path may hold a **remote** session cwd for
 * FileExplorer. Spawn must never use that as a local process cwd.
 *
 * Why prefix string checks: Vite can temporarily load two copies of this
 * module (dynamic import vs app graph). The helper must still treat
 * `orca_botmux:agent:*` / `orca_botmux:session:*` as control-plane even when the
 * dual instance's `isOrcaBotmuxControlPlaneHostId` is stale — otherwise
 * OverlayLayer gets `null` and never mounts TerminalPane (pty.spawn never
 * called; CDP repro 2026-07).
 */
export function resolveOrcaBotmuxTerminalSpawnPath(
  worktreeId: string,
  worktreePath: string | null | undefined
): string | null {
  const id = String(worktreeId ?? '')
  if (
    isOrcaBotmuxControlPlaneHostId(id) ||
    id.startsWith(ORCA_BOTMUX_AGENT_WORKTREE_PREFIX) ||
    id.startsWith(ORCA_BOTMUX_SESSION_WORKTREE_PREFIX) ||
    id === ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID
  ) {
    return '.'
  }
  const trimmed = String(worktreePath ?? '').trim()
  if (trimmed) return trimmed
  return null
}

/**
 * Host ids that Terminal.tsx must include in workspaceSurfaces so panes mount.
 * Synthetic orca_botmux hosts live outside worktreesByRepo.
 */
export function collectOrcaBotmuxWorkspaceSurfaceIds(
  tabHostIds: Iterable<string>,
  activeWorktreeId: string | null | undefined
): string[] {
  const ids = new Set<string>()
  for (const worktreeId of tabHostIds) {
    if (isOrcaBotmuxControlPlaneHostId(worktreeId)) {
      ids.add(worktreeId)
    }
  }
  if (activeWorktreeId && isOrcaBotmuxControlPlaneHostId(activeWorktreeId)) {
    ids.add(activeWorktreeId)
  }
  return Array.from(ids)
}
