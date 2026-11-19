import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { matchesOrcaTerminalIdentity, type OrcaCallResult, type OrcaExpectedTerminalIdentity } from './orca-cli.js';
import { TerminalRenderer } from '../utils/terminal-renderer.js';
import { detectCodexComposerState } from './codex-composer-state.js';
import { OrcaRelayClient, type OrcaRelayEndpoint } from './orca-relay.js';
import { scanLocalOrcaCliPids } from './orca-processes.js';

interface RelayPty {
  id: string;
  incarnationId?: string;
  terminalHandle: string;
  title?: string;
}
interface Terminal {
  handle: string;
  ptyId: string;
  incarnationId?: string;
  executionHostId: string;
  worktreeId: string;
  worktreePath: string;
  agentIdentity?: string;
  connected: true;
  writable: true;
  pid: number;
  cols: number;
  rows: number;
}

function endpoints(): OrcaRelayEndpoint[] {
  const root = process.env.ORCA_REMOTE_DIR || join(homedir(), '.orca-remote');
  const found: OrcaRelayEndpoint[] = [];
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return found; }
  for (const name of dirs.filter(name => name.startsWith('relay-'))) {
    const dir = join(root, name);
    try {
      const version = readFileSync(join(dir, '.version'), 'utf-8').trim();
      for (const socket of readdirSync(dir).filter(name => name.endsWith('.sock'))) {
        const socketPath = join(dir, socket);
        try {
          const credential = readFileSync(`${socketPath}.credential`, 'utf-8').trim();
          if (version && credential) found.push({ socketPath, version, credential });
        } catch { /* not a live authenticated endpoint */ }
      }
    } catch { /* obsolete relay installation */ }
  }
  return found;
}

async function inventory(client: OrcaRelayClient, endpoint: OrcaRelayEndpoint, handle?: string): Promise<Terminal[]> {
  const list = await client.request('pty.listProcesses');
  if (!Array.isArray(list)) throw new Error('Invalid Orca relay PTY list');
  // Older relays without incarnation metadata cannot prove a recreated PTY's identity.
  const rows = list.filter((row): row is RelayPty => typeof row?.id === 'string' && typeof row.terminalHandle === 'string'
    && (!handle || row.terminalHandle === handle)
    && typeof row.incarnationId === 'string' && row.incarnationId.length > 0);
  if (rows.length === 0) return [];
  const serialized = await client.request('pty.serialize', { ids: rows.map(row => row.id) });
  if (typeof serialized !== 'string') throw new Error('Invalid Orca relay PTY metadata');
  const metadata: unknown = JSON.parse(serialized);
  if (!Array.isArray(metadata)) throw new Error('Invalid Orca relay PTY metadata');
  const terminals = rows.flatMap(row => {
    const info = metadata.find(info => info?.id === row.id && info.terminalHandle === row.terminalHandle);
    if (!info || !Number.isInteger(info.pid) || info.pid <= 0 || typeof info.worktreeId !== 'string' || !info.worktreeId || typeof info.cwd !== 'string' || !info.cwd) return [];
    try {
      const env = readFileSync(`/proc/${info.pid}/environ`, 'utf-8').split('\0');
      if (!env.includes(`ORCA_TERMINAL_HANDLE=${row.terminalHandle}`) || !env.includes(`ORCA_WORKTREE_ID=${info.worktreeId}`)) return [];
    } catch {
      if (handle) throw new Error('Orca relay process ownership could not be verified');
      return [];
    }
    if (!Number.isInteger(info.cols) || info.cols <= 0 || info.cols > 500 || !Number.isInteger(info.rows) || info.rows <= 0 || info.rows > 500) return [];
    return [{
      handle: row.terminalHandle!, ptyId: `${endpoint.socketPath}@@${row.id}`, incarnationId: row.incarnationId,
      executionHostId: 'local', worktreeId: info.worktreeId, worktreePath: info.cwd,
      agentIdentity: row.title === 'traecli' ? 'trae' : row.title,
      connected: true as const, writable: true as const, pid: info.pid, cols: info.cols, rows: info.rows,
    }];
  });
  // A tool subprocess can own the foreground while the original CLI is still running.
  const clis = scanLocalOrcaCliPids(new Map(terminals.map(terminal => [terminal.handle, terminal.pid])));
  return terminals.map(terminal => {
    const cli = clis.get(terminal.handle);
    return cli ? { ...terminal, agentIdentity: cli.cliId === 'traex' ? 'trae' : cli.cliId } : terminal;
  });
}

async function withClient<T>(endpoint: OrcaRelayEndpoint, timeoutMs: number, run: (client: OrcaRelayClient) => Promise<T>): Promise<T> {
  const client = await OrcaRelayClient.open(endpoint, timeoutMs);
  try {
    // A subscriber never displaces the desktop's terminal owner or its output delivery.
    try { await client.request('pty.openClient', { protocolVersion: 1, clientInstanceId: `botmux-${randomUUID()}`, requestedRole: 'subscriber' }); }
    catch (error) { if (!(error instanceof Error) || !/method not found|unknown method/i.test(error.message)) throw error; }
    return await run(client);
  } finally { client.close(); }
}

function sameTerminal(a: Terminal, b: Terminal): boolean {
  return a.handle === b.handle && a.ptyId === b.ptyId && a.incarnationId === b.incarnationId
    && a.pid === b.pid && a.worktreeId === b.worktreeId && a.agentIdentity === b.agentIdentity;
}

async function readScreen(client: OrcaRelayClient, terminal: Terminal): Promise<unknown> {
  try {
    const response = await client.request('orca.cli', {
      argv: ['terminal', 'read', '--terminal', terminal.handle, '--screen', '--limit', '1000', '--json'],
      cwd: terminal.worktreePath, env: {},
    });
    if (!response || typeof response !== 'object' || !('stdout' in response) || typeof response.stdout !== 'string') throw new Error('Invalid Orca screen response');
    const envelope = JSON.parse(response.stdout);
    if (envelope?.ok !== true || !envelope.result?.terminal) throw new Error('Orca screen read was not confirmed');
    return envelope.result.terminal;
  } catch (error) {
    // Replaying while a desktop owns the relay can drop its pending output; use it only after the owner disconnects.
    if (!(error instanceof Error) || !/No owning Orca client is connected to the relay/.test(error.message)) throw error;
  }
  const id = terminal.ptyId.slice(terminal.ptyId.lastIndexOf('@@') + 2);
  const result = await client.request('pty.attach', { id, suppressReplayNotification: true, requireReplay: true });
  if (!result || typeof result !== 'object' || !('replay' in result) || typeof result.replay !== 'string') throw new Error('Orca relay screen unavailable');
  if ('incarnationId' in result && result.incarnationId !== terminal.incarnationId) throw new Error('terminal_handle_stale');
  const renderer = new TerminalRenderer(terminal.cols, terminal.rows);
  try {
    // shortcut: relay replay can start mid-redraw; use a snapshot RPC when the relay exposes one.
    await renderer.writeAndFlush(result.replay);
    const viewport = renderer.rawSnapshot({ preserveFormatting: true });
    const buffer = renderer.xterm.buffer.active;
    const state = detectCodexComposerState({ viewport: viewport.replace(/^(\s*)❯/gm, '$1›'), cursor: { x: buffer.cursorX, y: buffer.cursorY } });
    return { status: 'running', source: 'screen', tail: viewport.split('\n'), ...(state === 'draft' ? { draft: 'Unsubmitted terminal input' } : {}), draftVisible: true };
  } finally { renderer.dispose(); }
}

/** Operates on PTYs held by local SSH relays, without forwarding through the Mac. */
export async function callLocalOrcaRelay(args: readonly string[], timeoutMs = 8_000, expected?: OrcaExpectedTerminalIdentity): Promise<OrcaCallResult<unknown>> {
  const action = args[1];
  if (args[0] !== 'terminal' || !['list', 'show', 'read', 'send'].includes(action ?? '')) return { ok: false, kind: 'error', message: 'Unsupported local Orca relay command' };
  const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const handle = flag('--terminal');
  try {
    if (action === 'list') {
      const lists = await Promise.all(endpoints().map(endpoint => withClient(endpoint, timeoutMs, async client => {
        const terminals = await inventory(client, endpoint);
        return terminals.map(terminal => ({ terminal, endpoint }));
      }).catch(() => [])));
      const terminals = lists.flat();
      const counts = new Map<string, number>();
      for (const { terminal } of terminals) counts.set(terminal.handle, (counts.get(terminal.handle) ?? 0) + 1);
      return { ok: true, value: { terminals: terminals.filter(({ terminal }) => counts.get(terminal.handle) === 1).map(({ terminal }) => terminal) } };
    }
    if (!handle) return { ok: false, kind: 'error', message: 'Missing Orca terminal handle' };
    let endpoint = expected?.ptyId
      ? endpoints().find(endpoint => expected.ptyId!.startsWith(`${endpoint.socketPath}@@`))
      : undefined;
    if (expected?.ptyId && !endpoint) return { ok: false, kind: 'unavailable', message: 'Orca relay socket unavailable' };
    if (!endpoint) {
      const routes = await Promise.allSettled(endpoints().map(endpoint => withClient(endpoint, timeoutMs, async client => {
        const terminal = (await inventory(client, endpoint, handle)).find(row => row.handle === handle);
        return terminal ? endpoint : undefined;
      })));
      const matches = routes.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
      if (matches.length > 1) return { ok: false, kind: 'unavailable', message: 'Orca relay terminal identity is ambiguous' };
      if (matches.length === 0 && routes.some(result => result.status === 'rejected')) return { ok: false, kind: 'unavailable', message: 'Orca relay socket unavailable' };
      endpoint = matches[0];
    }
    if (!endpoint) return { ok: false, kind: 'missing', message: 'terminal_handle_stale' };
    const route = endpoint;
    const value = await withClient(route, timeoutMs, async client => {
      const terminal = (await inventory(client, route, handle)).find(row => row.handle === handle);
      if (!terminal) return undefined;
      if (expected && !matchesOrcaTerminalIdentity(terminal, expected)) throw new Error('terminal_handle_stale');
      if (action === 'show') return { terminal };
      if (action === 'read') return { terminal: await readScreen(client, terminal) };
      const id = terminal.ptyId.slice(terminal.ptyId.lastIndexOf('@@') + 2);
      const text = flag('--text') ?? '';
      const data = args.includes('--interrupt') ? '\x03' : text + (args.includes('--enter') ? '\r' : '');
      if (!data) throw new Error('Empty Orca relay input');
      client.notify('pty.data', { id, data });
      // The reply follows the write on this relay connection; never retry an uncertain input.
      const after = (await inventory(client, route, handle)).find(row => row.handle === handle);
      if (!after || !sameTerminal(terminal, after)) throw new Error('Orca relay input was not confirmed');
      return { send: { accepted: true } };
    });
    if (value !== undefined) return { ok: true, value };
    return { ok: false, kind: 'missing', message: 'terminal_handle_stale' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: /terminal_handle_stale/.test(message) ? 'missing' : 'unavailable', message };
  }
}
