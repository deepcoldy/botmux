/**
 * Zellij session discovery for /adopt — find CLIs already running inside a
 * user's zellij sessions and the pane needed to drive them.
 *
 * Why this exists (and why it's not just `list-panes`): zellij's
 * `list-panes --json` exposes pane ids + geometry but NOT the running command,
 * cwd, or pid, and its `terminal_command` is null for anything the user started
 * interactively (typed `claude` into a shell — the common case). The data we
 * need is instead surfaced by zellij's **session-resurrection** machinery: to be
 * able to restore a session after a reboot, zellij continuously introspects each
 * pane's *foreground process command + cwd* and exposes it via
 * `zellij action dump-layout`. That's where we read "what CLI is in this pane".
 *
 * Discovery pipeline:
 *   1. dump-layout  → per-pane { command, args, cwd }   (detection)
 *   2. list-panes --json → per-pane { id: terminal_<n> } (drive target)
 *   3. order/geometry join → bind command ↔ pane id
 *   4. (caller) /proc descent under the pane shell → pid → ~/.claude/sessions/<pid>.json
 *
 * Parsers here are pure (string in, struct out) so they unit-test without a
 * live zellij. The order-join (step 3) is robust for normal single/few-pane
 * layouts; exotic multi-tab/floating arrangements may need the geometry/proc
 * cross-check the caller layers on top.
 */
import { execFileSync } from 'node:child_process';
import { isAbsolute, join as pathJoin } from 'node:path';
import { zellijEnv } from '../setup/ensure-zellij.js';

export interface LayoutPane {
  /** Foreground command (argv0) zellij introspected for this pane, e.g. "claude". */
  command: string;
  /** Explicit pane name if set (zellij `name=`), else undefined. */
  name?: string;
  /** Absolute cwd of the pane (layout base cwd joined with the pane's relative cwd). */
  cwd?: string;
  /** Command args, when present in the dump. */
  args: string[];
}

export interface ListedPane {
  /** "terminal_<n>" — the id used to target zellij `action` commands. */
  paneId: string;
  isPlugin: boolean;
  title?: string;
  terminalCommand?: string | null;
}

export interface DiscoveredCli {
  session: string;
  paneId: string;
  command: string;
  cwd?: string;
  args: string[];
  title?: string;
}

const TEMPLATE_MARKERS = /\b(new_tab_template|swap_tiled_layout|swap_floating_layout)\b/;

/**
 * Parse `zellij action dump-layout` output, returning only the panes that have
 * a foreground `command=` (i.e. real terminal panes running something) in
 * document order. Template sections (new_tab_template / swap_*_layout) are cut
 * off first — their bare `pane` nodes have no command and would otherwise add
 * noise. Plugin panes (tab-bar / status-bar / about) have no command= and are
 * naturally excluded.
 */
export function parseDumpLayoutPanes(kdl: string): LayoutPane[] {
  // Drop the template tail so we only see live tab content.
  const tmplIdx = kdl.search(TEMPLATE_MARKERS);
  const body = tmplIdx >= 0 ? kdl.slice(0, tmplIdx) : kdl;

  const lines = body.split('\n');
  const panes: LayoutPane[] = [];

  // Layout base cwd is a NODE: `cwd "..."` (space). Pane cwd is an ATTRIBUTE:
  // `cwd="..."` (equals). The first node-form cwd is the layout base.
  let layoutCwd: string | undefined;
  const baseCwdMatch = body.match(/^\s*cwd\s+"([^"]*)"/m);
  if (baseCwdMatch) layoutCwd = baseCwdMatch[1];

  let pending: LayoutPane | null = null;
  const flush = () => { if (pending) { panes.push(pending); pending = null; } };

  for (const line of lines) {
    const trimmed = line.trim();
    // A pane that runs a command (attributes can appear in any order).
    if (/^pane\b/.test(trimmed) && /\bcommand=/.test(trimmed)) {
      flush();
      const command = attr(trimmed, 'command');
      const name = attr(trimmed, 'name');
      const cwdAttr = attr(trimmed, 'cwd');
      pending = {
        command: command ?? '',
        name: name ?? undefined,
        cwd: resolveCwd(layoutCwd, cwdAttr),
        args: [],
      };
      // Single-line pane (closed on same line, no block) — flush immediately.
      if (trimmed.includes('}') && !trimmed.endsWith('{')) flush();
      continue;
    }
    // args node inside the current pane block: `args "a" "b" …`
    if (pending && /^args\b/.test(trimmed)) {
      pending.args = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => unescapeKdl(m[1]!));
      continue;
    }
    // Next pane / tab / closing — a new `pane` (without command) ends the block.
    if (pending && /^pane\b/.test(trimmed)) flush();
  }
  flush();
  return panes;
}

/** Parse `zellij action list-panes --json` into a flat list (document order). */
export function parseListPanesJson(json: string): ListedPane[] {
  let arr: any;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((p: any) => ({
    paneId: `terminal_${p.id}`,
    isPlugin: !!p.is_plugin,
    title: typeof p.title === 'string' ? p.title : undefined,
    terminalCommand: p.terminal_command ?? null,
  }));
}

/**
 * Join dump-layout command panes with list-panes terminal panes by document
 * order: the i-th command pane ↔ the i-th non-plugin terminal pane (sorted by
 * id). zellij assigns pane ids in creation order and walks the tree in a stable
 * order, so this aligns for normal layouts. Returns one DiscoveredCli per
 * command pane that could be bound to an id.
 */
export function joinPanes(session: string, layoutPanes: LayoutPane[], listed: ListedPane[]): DiscoveredCli[] {
  const terminals = listed
    .filter(p => !p.isPlugin)
    .sort((a, b) => paneNum(a.paneId) - paneNum(b.paneId));
  const out: DiscoveredCli[] = [];
  for (let i = 0; i < layoutPanes.length; i++) {
    const lp = layoutPanes[i]!;
    const tp = terminals[i];
    if (!tp) break;
    out.push({
      session,
      paneId: tp.paneId,
      command: lp.command,
      cwd: lp.cwd,
      args: lp.args,
      title: tp.title,
    });
  }
  return out;
}

// ─── Runtime (shells out to zellij) ─────────────────────────────────────────

/** Names of live (non-exited) zellij sessions. */
export function listLiveSessions(): string[] {
  try {
    const out = execFileSync('zellij', ['list-sessions', '--no-formatting'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env: zellijEnv(),
    });
    return out.split('\n').map(l => l.trim())
      .filter(l => l.length > 0 && !/EXITED/i.test(l))
      .map(l => l.split(/\s+/)[0]!).filter(Boolean);
  } catch { return []; }
}

function zellijAction(session: string, args: string[]): string | null {
  try {
    return execFileSync('zellij', ['--session', session, 'action', ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, env: zellijEnv(),
    });
  } catch { return null; }
}

/** Discover CLIs running in one session. */
export function discoverSessionClis(session: string): DiscoveredCli[] {
  const layout = zellijAction(session, ['dump-layout']);
  const panesJson = zellijAction(session, ['list-panes', '--json']);
  if (!layout || !panesJson) return [];
  return joinPanes(session, parseDumpLayoutPanes(layout), parseListPanesJson(panesJson));
}

/** Discover CLIs across every live zellij session. */
export function discoverAllClis(): DiscoveredCli[] {
  return listLiveSessions().flatMap(discoverSessionClis);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function attr(line: string, key: string): string | undefined {
  const m = line.match(new RegExp(`\\b${key}="((?:[^"\\\\]|\\\\.)*)"`));
  return m ? unescapeKdl(m[1]!) : undefined;
}

function resolveCwd(base: string | undefined, paneCwd: string | undefined): string | undefined {
  if (!paneCwd) return base;
  if (isAbsolute(paneCwd)) return paneCwd;
  return base ? pathJoin(base, paneCwd) : paneCwd;
}

function paneNum(paneId: string): number {
  const m = paneId.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function unescapeKdl(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}
