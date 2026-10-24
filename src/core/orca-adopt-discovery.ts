import type { CliId } from '../adapters/cli/types.js';
import {
  callOrca,
  callOrcaSync,
  hasStableOrcaTerminalIdentity,
  matchesOrcaTerminalIdentity,
  type OrcaInstance,
  type OrcaTerminalIdentity,
} from '../services/orca-cli.js';
import { scanLocalOrcaCliPids } from '../services/orca-processes.js';
import { findCodexRolloutByPid } from '../services/codex-transcript.js';
import { findCocoSessionByPid } from '../services/coco-transcript.js';
import { findTraexRolloutByPid, findTraexThreadByPid } from '../services/traex-transcript.js';
import { readClaudeSessionMeta } from '../services/claude-transcript.js';
import { queryOrcaRelayPtyMetadata } from '../services/orca-relay.js';
import { queryOrcaDaemonSessions, type OrcaDaemonSessionMetadata } from '../services/orca-daemon.js';

export interface OrcaTerminalSummary extends OrcaTerminalIdentity {
  worktreePath: string;
  branch?: string;
  title?: string | null;
  lastOutputAt?: number | null;
  pid?: number;
  cols?: number;
  rows?: number;
}
export interface OrcaAdoptableSession {
  source: 'orca';
  orcaInstance: OrcaInstance;
  orcaTerminalHandle: string;
  orcaPtyId?: string;
  orcaIncarnationId?: string;
  orcaExecutionHostId?: string;
  orcaWorktreeId: string;
  orcaAgentIdentity: string;
  orcaTerminalTitle?: string;
  cliPid?: number;
  sessionId?: string;
  cliId: CliId;
  cwd: string;
  startedAt?: number;
  paneCols: number;
  paneRows: number;
  paneSizeVerified: boolean;
}


function sessionMetaForCliPid(
  cliId: CliId,
  pid: number | undefined,
): { sessionId?: string; title?: string } {
  if (!pid) return {};
  if (cliId === 'claude-code') return { sessionId: readClaudeSessionMeta(pid)?.sessionId };
  if (cliId === 'traex') {
    const rollout = findTraexRolloutByPid(pid);
    const thread = findTraexThreadByPid(pid);
    return { sessionId: rollout?.cliSessionId ?? thread?.cliSessionId, title: thread?.title };
  }
  if (cliId === 'codex') return { sessionId: findCodexRolloutByPid(pid)?.cliSessionId };
  if (cliId === 'coco') return { sessionId: findCocoSessionByPid(pid)?.sessionId };
  return {};
}

interface TerminalListResult {
  terminals?: OrcaTerminalSummary[];
}

interface TerminalShowResult {
  terminal?: OrcaTerminalSummary;
}

// MTR/Hermes remain discoverable for terminal I/O, but their external transcript
// ownership is not reliable enough to construct reply history (see adopt docs).
const ORCA_AGENT_CLI_IDS: Readonly<Record<string, CliId>> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  coco: 'coco',
  trae: 'traex',
  'trae-cli': 'traex',
  traex: 'traex',
  cursor: 'cursor',
  gemini: 'gemini',
  opencode: 'opencode',
  opencode2: 'opencode2',
  mtr: 'mtr',
  hermes: 'hermes',
  pi: 'pi',
  omp: 'oh-my-pi',
  'oh-my-pi': 'oh-my-pi',
  grok: 'grok',
  'kiro-cli': 'kiro-cli',
};

export function cliIdFromOrcaAgentIdentity(identity: string | undefined): CliId | undefined {
  return identity ? ORCA_AGENT_CLI_IDS[identity.trim().toLowerCase()] : undefined;
}

function toCandidate(
  terminal: OrcaTerminalSummary,
  filterCliId: CliId | undefined,
  instance: OrcaInstance,
  localPids: ReadonlyMap<string, { pid: number; cliId: CliId }> = new Map(),
  sizes: ReadonlyMap<string, { cols: number; rows: number }> = new Map(),
): OrcaAdoptableSession | undefined {
  const cliId = cliIdFromOrcaAgentIdentity(terminal.agentIdentity);
  if (!cliId || (filterCliId && cliId !== filterCliId)) return undefined;
  if (!terminal.handle || !terminal.worktreeId || !terminal.worktreePath) return undefined;
  if (terminal.connected !== true || terminal.writable !== true) return undefined;
  if (!hasStableOrcaTerminalIdentity(terminal)) return undefined;
  const local = localPids.get(terminal.handle);
  const cliPid = local?.cliId === cliId ? local.pid : undefined;
  const session = sessionMetaForCliPid(cliId, cliPid);
  const size = sizes.get(terminal.handle);
  return {
    source: 'orca',
    orcaInstance: instance,
    orcaTerminalHandle: terminal.handle,
    orcaPtyId: terminal.ptyId ?? undefined,
    orcaIncarnationId: terminal.incarnationId ?? undefined,
    orcaExecutionHostId: terminal.executionHostId,
    orcaWorktreeId: terminal.worktreeId,
    orcaAgentIdentity: terminal.agentIdentity!,
    orcaTerminalTitle: session.title || terminal.title?.trim() || undefined,
    cliId,
    cliPid,
    sessionId: session.sessionId,
    cwd: terminal.worktreePath,
    startedAt: undefined,
    // Without an attested geometry (relay socket or terminal daemon) the
    // public CLI offers none; keep conservative render defaults.
    paneCols: size?.cols ?? 120,
    paneRows: size?.rows ?? 50,
    paneSizeVerified: size !== undefined,
  };
}

function relayPtyId(terminal: OrcaTerminalSummary): string | undefined {
  const ptyId = terminal.ptyId ?? '';
  const separator = ptyId.indexOf('@@');
  return separator >= 0 ? ptyId.slice(separator + 2) || undefined : undefined;
}

async function localPidsForTerminals(
  instances: ReadonlyArray<{ instance: OrcaInstance; terminals: readonly OrcaTerminalSummary[] }>,
  daemonSessions: ReadonlyMap<string, OrcaDaemonSessionMetadata>,
): Promise<{
  localPids: Map<string, { pid: number; cliId: CliId }>;
  sizes: Map<string, { cols: number; rows: number }>;
}> {
  const relayIds = instances.flatMap(({ instance, terminals }) => (
    instance === 'relay'
      ? terminals.flatMap(terminal => {
        const id = relayPtyId(terminal);
        return id ? [id] : [];
      })
      : []
  ));
  const relayMetadata = relayIds.length > 0 ? await queryOrcaRelayPtyMetadata(relayIds) : new Map<string, never>();
  const rootsByHandle = new Map<string, number>();
  const expectedCliByHandle = new Map<string, CliId>();
  const sizes = new Map<string, { cols: number; rows: number }>();
  for (const { instance, terminals } of instances) {
    for (const terminal of terminals) {
      // Same-host root pids and geometry: relay terminals via the SSH relay
      // socket, server terminals via the terminal daemon, both keyed by handle.
      const relayId = instance === 'relay' ? relayPtyId(terminal) : undefined;
      const entry = instance === 'server'
        ? daemonSessions.get(terminal.handle)
        : instance === 'relay-local' ? terminal
        : relayId ? relayMetadata.get(relayId) : undefined;
      if (entry?.pid) rootsByHandle.set(terminal.handle, entry.pid);
      if (entry?.cols && entry.rows) sizes.set(terminal.handle, { cols: entry.cols, rows: entry.rows });
      const expectedCliId = cliIdFromOrcaAgentIdentity(terminal.agentIdentity);
      if (expectedCliId) expectedCliByHandle.set(terminal.handle, expectedCliId);
    }
  }
  return { localPids: scanLocalOrcaCliPids(rootsByHandle, expectedCliByHandle), sizes };
}

export async function discoverAdoptableOrcaSessions(
  filterCliId?: CliId,
  filterExecutable?: string,
): Promise<OrcaAdoptableSession[]> {
  // Orca exposes an agent kind, not the exact executable. A configured custom
  // runtime therefore cannot be proven to be the bot's selected distribution.
  if (filterExecutable) return [];
  const [relayList, localRelayList, serverList, daemonSessions] = await Promise.all([
    callOrca<TerminalListResult>(['terminal', 'list', '--limit', '1000']),
    callOrca<TerminalListResult>(['terminal', 'list', '--limit', '1000'], 'relay-local'),
    callOrca<TerminalListResult>(['terminal', 'list', '--limit', '1000'], 'server'),
    queryOrcaDaemonSessions(),
  ]);
  const instances = [
    ...(relayList.ok ? [{ instance: 'relay' as const, terminals: relayList.value.terminals ?? [] }] : []),
    ...(localRelayList.ok ? [{ instance: 'relay-local' as const, terminals: localRelayList.value.terminals ?? [] }] : []),
    ...(serverList.ok ? [{ instance: 'server' as const, terminals: serverList.value.terminals ?? [] }] : []),
  ];
  const { localPids, sizes } = await localPidsForTerminals(instances, daemonSessions);
  const byHandle = new Map<string, OrcaAdoptableSession>();
  for (const { instance, terminals } of instances) {
    for (const terminal of terminals) {
      const candidate = toCandidate(terminal, filterCliId, instance, localPids, sizes);
      if (!candidate) continue;
      // Prefer routes that keep working after the desktop disconnects.
      const existing = byHandle.get(candidate.orcaTerminalHandle);
      if (!existing || instance === 'server' || (instance === 'relay-local' && existing.orcaInstance === 'relay')) {
        byHandle.set(candidate.orcaTerminalHandle, candidate);
      }
    }
  }
  return [...byHandle.values()];
}

export async function discoverAdoptableOrcaSessionByHandle(
  handle: string,
  filterCliId?: CliId,
  filterExecutable?: string,
): Promise<OrcaAdoptableSession | undefined> {
  if (!handle || filterExecutable) return undefined;
  const [relayResult, localRelayResult, serverResult, daemonSessions] = await Promise.all([
    callOrca<TerminalShowResult>(['terminal', 'show', '--terminal', handle]),
    callOrca<TerminalShowResult>(['terminal', 'show', '--terminal', handle], 'relay-local'),
    callOrca<TerminalShowResult>(['terminal', 'show', '--terminal', handle], 'server'),
    queryOrcaDaemonSessions(),
  ]);
  // Prefer the server instance on dual hits (same rationale as list dedup).
  const serverTerminal = serverResult.ok ? serverResult.value.terminal : undefined;
  const localRelayTerminal = localRelayResult.ok ? localRelayResult.value.terminal : undefined;
  const relayTerminal = relayResult.ok ? relayResult.value.terminal : undefined;
  const instance: OrcaInstance | undefined = serverTerminal ? 'server' : localRelayTerminal ? 'relay-local' : relayTerminal ? 'relay' : undefined;
  const terminal = serverTerminal ?? localRelayTerminal ?? relayTerminal;
  if (!instance || !terminal) return undefined;
  const { localPids, sizes } = await localPidsForTerminals([{ instance, terminals: [terminal] }], daemonSessions);
  return toCandidate(terminal, filterCliId, instance, localPids, sizes);
}

export type OrcaAdoptValidationResult = 'alive' | 'missing' | 'unknown';

export function validateOrcaAdoptTarget(
  target: Pick<OrcaAdoptableSession, 'orcaTerminalHandle' | 'orcaPtyId' | 'orcaIncarnationId' | 'orcaExecutionHostId' | 'orcaWorktreeId' | 'orcaAgentIdentity'> & { orcaInstance?: OrcaInstance },
): OrcaAdoptValidationResult {
  const identity = {
    terminalHandle: target.orcaTerminalHandle,
    ptyId: target.orcaPtyId,
    incarnationId: target.orcaIncarnationId,
    executionHostId: target.orcaExecutionHostId,
    worktreeId: target.orcaWorktreeId,
    agentIdentity: target.orcaAgentIdentity,
  };
  // Absent instance = rows persisted before server support; they are relay terminals.
  const args = ['terminal', 'show', '--terminal', target.orcaTerminalHandle];
  const result = target.orcaInstance === 'relay-local'
    ? callOrcaSync<TerminalShowResult>(args, 'relay-local', 8_000, identity)
    : callOrcaSync<TerminalShowResult>(args, target.orcaInstance ?? 'relay');
  if (!result.ok) return result.kind === 'missing' ? 'missing' : 'unknown';
  const terminal = result.value.terminal;
  if (!terminal) return 'missing';
  const identityMatches = matchesOrcaTerminalIdentity(terminal, identity);
  return identityMatches ? 'alive' : 'missing';
}
