/**
 * Display names for the /adopt picker's live herdr entries: workspace name, tab
 * name (and whether herdr auto-named it), plus a Claude session's first real
 * prompt for when nothing better names it.
 *
 * Runs only on the picker's render path (collectAdoptCandidates), never inside
 * discovery: the confirm path re-discovers up to four times within Lark's 3 s
 * callback budget and has no use for names. Best-effort and time-boxed — a slow,
 * old or failing herdr, or an unreadable transcript, leaves an entry exactly as
 * discovery produced it, and the card then renders it exactly as before.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AdoptableSession } from '../core/session-discovery.js';
import type { ZellijAdoptableSession } from '../core/zellij-adopt-discovery.js';
import type { OrcaAdoptableSession } from '../core/orca-adopt-discovery.js';
import { claudeFirstUserTurn } from './resumable-session-discovery.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { herdrExecutable } from '../utils/herdr-executable.js';
import { cleanLiveAdoptTitle, countHerdrTabGroups, herdrTabGroupKey } from '../utils/live-title.js';

/** Same union as adopt-picker's LiveAdoptableSession, kept local because
 *  adopt-picker imports this module. Only herdr entries are ever changed. */
type LiveSession = AdoptableSession | ZellijAdoptableSession | OrcaAdoptableSession;
type HerdrSession = AdoptableSession & { herdrSessionName: string };

/** Longest the picker waits for names, whatever the caller's deadline. */
export const ADOPT_LIVE_ENRICH_BUDGET_MS = 800;
/** With less time than this left before the deadline, skip enrichment. */
const ADOPT_LIVE_ENRICH_MIN_MS = 100;
/** Head read limits for the first prompt; a prompt past them counts as none. */
const FIRST_PROMPT_MAX_BYTES = 1024 * 1024;
const FIRST_PROMPT_MAX_LINES = 5_000;
const FIRST_PROMPT_CHUNK_BYTES = 64 * 1024;
const FIRST_PROMPT_CONCURRENCY = 4;
/** Parallel `stat`s when scanning `projects/*` for a transcript. */
const TRANSCRIPT_SCAN_CONCURRENCY = 8;
/** Claude session ids are UUIDs; anything else is never turned into a path. */
const CLAUDE_SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]*$/;

export type HerdrRunner = (args: string[], opts: { signal: AbortSignal; timeoutMs: number }) => Promise<string | undefined>;

export interface AdoptLiveEnrichOptions {
  /** Absolute epoch-ms deadline of the caller. Budget = min(800 ms, deadline - now). */
  deadlineMs?: number;
  /** Runs `herdr <args>` and resolves its stdout (undefined on failure). It must
   *  end the child process once `signal` aborts. Default: runHerdrCli. */
  runHerdr?: HerdrRunner;
  /** First real user prompt of a Claude session, or undefined. Default:
   *  readClaudeFirstPrompt under `claudeDataDir`. */
  readFirstPrompt?: (sessionId: string, cwd: string, signal: AbortSignal) => Promise<string | undefined>;
  /** Claude data root holding `projects/` (default `~/.claude`). */
  claudeDataDir?: string;
}

interface FoundNames {
  workspaces: Map<string, string>;
  tabs: Map<string, { label: string; autoNamed: boolean }>;
  prompts: Map<HerdrSession, string>;
}

/**
 * Return `sessions` with names added to their live herdr entries (new objects;
 * the input is never mutated). One `workspace list` and one `tab list` per
 * herdr session, all started at once; first prompts are read afterwards, at most
 * four at a time, only where one could become the title. At the budget's end
 * every unfinished herdr child is killed and file reads stop; whatever arrived
 * by then is used and the rest is left out. Never rejects.
 */
export async function enrichAdoptLiveSessions(
  sessions: LiveSession[],
  opts: AdoptLiveEnrichOptions = {},
): Promise<LiveSession[]> {
  // One absolute deadline, fixed at entry: every later wait, child timeout and
  // launch decision is measured against it, so time spent starting children
  // comes out of the budget instead of extending it.
  const start = Date.now();
  const deadline = Math.min(opts.deadlineMs ?? Infinity, start + ADOPT_LIVE_ENRICH_BUDGET_MS);
  if (!(deadline - start >= ADOPT_LIVE_ENRICH_MIN_MS)) return sessions;
  const herdr = sessions.filter(isHerdrSession);
  // Only query what an entry can use: older herdr reports no workspace / tab ids.
  const workspaceQueries = new Set(herdr.filter(s => s.herdrWorkspaceId).map(s => s.herdrSessionName));
  const tabQueries = new Set(herdr.filter(s => s.herdrTabId).map(s => s.herdrSessionName));
  if (workspaceQueries.size === 0 && tabQueries.size === 0) return sessions;

  const controller = new AbortController();
  const { signal } = controller;
  const remainingMs = () => (signal.aborted ? 0 : Math.max(0, deadline - Date.now()));
  const runHerdr = opts.runHerdr ?? runHerdrCli;
  const readFirstPrompt = opts.readFirstPrompt
    ?? ((sessionId: string, cwd: string, s: AbortSignal) => readClaudeFirstPrompt(sessionId, cwd, s, opts.claudeDataDir));
  const groups = countHerdrTabGroups(sessions);
  const slot = concurrencyLimit(FIRST_PROMPT_CONCURRENCY);
  const found: FoundNames = { workspaces: new Map(), tabs: new Map(), prompts: new Map() };

  const list = async (sessionName: string, kind: 'workspace' | 'tab'): Promise<any[] | undefined> => {
    // Nothing new starts once the deadline has passed.
    const timeoutMs = remainingMs();
    if (timeoutMs <= 0) return undefined;
    try {
      const stdout = await runHerdr(['--session', sessionName, kind, 'list'], { signal, timeoutMs });
      return herdrListItems(stdout, kind === 'workspace' ? 'workspaces' : 'tabs');
    } catch {
      return undefined;
    }
  };

  const work = Promise.all([...new Set([...workspaceQueries, ...tabQueries])].map(async (sessionName) => {
    const workspaces = workspaceQueries.has(sessionName)
      ? list(sessionName, 'workspace').then(items => recordWorkspaces(found, sessionName, items))
      : undefined;
    if (tabQueries.has(sessionName)) {
      recordTabs(found, sessionName, await list(sessionName, 'tab'));
      const wanted = herdr.filter(s => s.herdrSessionName === sessionName && wantsFirstPrompt(s, found, groups));
      await Promise.all(wanted.map(s => slot(async () => {
        if (remainingMs() <= 0) return;
        const prompt = cleanLiveAdoptTitle(await readFirstPrompt(s.sessionId!, s.cwd, signal).catch(() => undefined));
        if (prompt) found.prompts.set(s, prompt);
      })));
    }
    await workspaces;
  })).catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, remainingMs()); })]);
  clearTimeout(timer);
  controller.abort();
  return sessions.map(s => (isHerdrSession(s) ? withNames(s, found) : s));
}

/** Default HerdrRunner: `herdr <args>` through execFile. Both the timeout and an
 *  aborted signal SIGKILL the child, so a hung herdr never outlives the budget.
 *  The signal is not handed to execFile: Node answers an abort there with
 *  SIGTERM, which a child can ignore, and drops the timeout along with it. */
export function runHerdrCli(
  args: string[],
  opts: { signal: AbortSignal; timeoutMs: number },
  executable: string = herdrExecutable(),
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (opts.signal.aborted) return resolve(undefined);
    try {
      const child = execFile(executable, args, {
        encoding: 'utf-8',
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout) => resolve(err ? undefined : stdout));
      const kill = () => { child.kill('SIGKILL'); };
      opts.signal.addEventListener('abort', kill, { once: true });
      child.once('close', () => opts.signal.removeEventListener('abort', kill));
      child.stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
}

/** First prompts found so far, by transcript path. A transcript only grows at
 *  the end, so a found first prompt never changes; misses are not cached. */
const firstPromptCache = new BoundedMap<string, string>(256);

/**
 * The first real user prompt of a Claude session (same rule as history titles,
 * see claudeFirstUserTurn), or undefined: no transcript yet (a session that has
 * not been prompted), a botmux envelope first, or nothing within the first
 * 1 MiB / 5000 lines. Reads only the head of the transcript and stops as soon
 * as the prompt is found or `signal` aborts; the file is always closed.
 */
export async function readClaudeFirstPrompt(
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
  dataDir: string = join(homedir(), '.claude'),
): Promise<string | undefined> {
  if (!CLAUDE_SESSION_ID_RE.test(sessionId)) return undefined;
  const path = await locateClaudeTranscript(join(dataDir, 'projects'), sessionId, cwd, signal);
  if (!path || signal.aborted) return undefined;
  const cached = firstPromptCache.get(path);
  if (cached !== undefined) return cached;
  const prompt = await readFirstPromptHead(path, signal);
  if (prompt) firstPromptCache.set(path, prompt);
  return prompt;
}

function isHerdrSession(s: LiveSession): s is HerdrSession {
  return !('zellijPaneId' in s) && s.source === 'herdr' && !!s.herdrSessionName;
}

function herdrListItems(stdout: string | undefined, key: 'workspaces' | 'tabs'): any[] | undefined {
  const text = stdout?.trim();
  if (!text) return undefined;
  try {
    const items = JSON.parse(text)?.result?.[key];
    return Array.isArray(items) ? items : undefined;
  } catch {
    return undefined;
  }
}

function recordWorkspaces(found: FoundNames, sessionName: string, items: any[] | undefined): void {
  for (const ws of items ?? []) {
    const label = cleanLiveAdoptTitle(ws?.label);
    if (typeof ws?.workspace_id === 'string' && label) {
      found.workspaces.set(`${sessionName}\0${ws.workspace_id}`, label);
    }
  }
}

/** Herdr names a tab without a custom name by its 1-based position in its
 *  workspace (`tab list` order), renumbering when tabs close or move; `number`
 *  is a stable creation counter and says nothing about the name. */
function recordTabs(found: FoundNames, sessionName: string, items: any[] | undefined): void {
  const positions = new Map<string, number>();
  for (const tab of items ?? []) {
    if (typeof tab?.workspace_id !== 'string') continue;
    const position = (positions.get(tab.workspace_id) ?? 0) + 1;
    positions.set(tab.workspace_id, position);
    const label = cleanLiveAdoptTitle(tab.label);
    if (typeof tab.tab_id !== 'string' || !label) continue;
    found.tabs.set(`${sessionName}\0${tab.tab_id}`, { label, autoNamed: tab.label === String(position) });
  }
}

/** A first prompt can only become the title of a Claude entry with no pane
 *  label and no native title, in a found tab — and when the entry is alone in
 *  that tab, only if the tab name is herdr's default (a given name wins first). */
function wantsFirstPrompt(s: HerdrSession, found: FoundNames, groups: Map<string, number>): boolean {
  if (s.cliId !== 'claude-code' || !s.sessionId || s.herdrPaneLabel || s.herdrNativeTitle) return false;
  const tab = s.herdrTabId ? found.tabs.get(`${s.herdrSessionName}\0${s.herdrTabId}`) : undefined;
  if (!tab) return false;
  const groupKey = herdrTabGroupKey(s);
  return (groupKey ? groups.get(groupKey) ?? 1 : 1) > 1 || tab.autoNamed;
}

function withNames(s: HerdrSession, found: FoundNames): LiveSession {
  const workspace = s.herdrWorkspaceId ? found.workspaces.get(`${s.herdrSessionName}\0${s.herdrWorkspaceId}`) : undefined;
  const tab = s.herdrTabId ? found.tabs.get(`${s.herdrSessionName}\0${s.herdrTabId}`) : undefined;
  if (!workspace && !tab) return s;
  const prompt = tab ? found.prompts.get(s) : undefined;
  return {
    ...s,
    ...(workspace ? { herdrWorkspaceLabel: workspace } : {}),
    ...(tab ? { herdrTabLabel: tab.label, herdrTabAutoNamed: tab.autoNamed } : {}),
    ...(prompt ? { herdrFirstPrompt: prompt } : {}),
  };
}

/** Run at most `max` tasks at a time; a finishing task hands its slot straight
 *  to the next waiter so a late caller can never push the count past `max`. */
function concurrencyLimit(max: number): <R>(task: () => Promise<R>) => Promise<R> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fsp.stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Claude keeps a session at `projects/<realpath(cwd) with every
 *  non-[A-Za-z0-9-] char as '-'>/<id>.jsonl`. A long cwd gets a cut + hashed
 *  directory name instead (`<first 200 chars>-<hash>`, probed first), so fall
 *  back to any `projects/<dir>/<id>.jsonl` — the id is a UUID, a hit cannot
 *  belong to another session. Checks `signal` around every filesystem call and
 *  probes the fallback at most 8 directories at a time, each at most once, so
 *  once aborted no new call is issued (one already in flight is left to
 *  finish). */
async function locateClaudeTranscript(
  projectsDir: string,
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  const file = `${sessionId}.jsonl`;
  const realCwd = await fsp.realpath(cwd).catch(() => cwd);
  if (signal.aborted) return undefined;
  const slug = realCwd.replace(/[^A-Za-z0-9-]/g, '-');
  const exact = join(projectsDir, slug, file);
  if (await isFile(exact)) return exact;
  if (signal.aborted) return undefined;
  let dirs: string[];
  try {
    dirs = await fsp.readdir(projectsDir);
  } catch {
    return undefined;
  }
  let hit: string | undefined;
  const scan = async (names: string[]): Promise<void> => {
    let next = 0;
    const probe = async (): Promise<void> => {
      while (!hit && !signal.aborted && next < names.length) {
        const path = join(projectsDir, names[next++]!, file);
        if (path !== exact && await isFile(path)) hit ??= path;
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRANSCRIPT_SCAN_CONCURRENCY, names.length) }, probe));
  };
  if (slug.length > 200) {
    // Same rule as resolveClaudeJsonlPath: try the cut directories first.
    const cut = `${slug.slice(0, 200)}-`;
    const likely = (dir: string) => dir === slug || dir.startsWith(cut);
    await scan(dirs.filter(likely));
    dirs = dirs.filter(dir => !likely(dir));
  }
  await scan(dirs);
  return signal.aborted ? undefined : hit;
}

function firstUserTurnOfLine(line: string): ReturnType<typeof claudeFirstUserTurn> {
  const text = line.trim();
  if (!text) return undefined;
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    return undefined;
  }
  return rec && typeof rec === 'object' && !Array.isArray(rec)
    ? claudeFirstUserTurn(rec as Record<string, unknown>)
    : undefined;
}

/** Scan complete lines from the start of the file, at most 1 MiB / 5000 lines.
 *  A line cut by the byte cap is never parsed. */
async function readFirstPromptHead(path: string, signal: AbortSignal): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(path, 'r');
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(FIRST_PROMPT_CHUNK_BYTES);
    let text = '';
    let offset = 0;
    let lines = 0;
    for (;;) {
      if (signal.aborted) return undefined;
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, FIRST_PROMPT_MAX_BYTES - offset), offset);
      offset += bytesRead;
      const atEnd = bytesRead === 0;
      text += atEnd ? decoder.end() : decoder.write(chunk.subarray(0, bytesRead));
      let start = 0;
      for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
        const turn = firstUserTurnOfLine(text.slice(start, nl));
        start = nl + 1;
        if (turn) return turn.botmux ? undefined : turn.prompt;
        if (++lines >= FIRST_PROMPT_MAX_LINES) return undefined;
      }
      text = text.slice(start);
      if (atEnd) {
        // The last line of a file need not end with a newline.
        const turn = firstUserTurnOfLine(text);
        return turn && !turn.botmux ? turn.prompt : undefined;
      }
      if (offset >= FIRST_PROMPT_MAX_BYTES) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
