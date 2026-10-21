import type { CliId } from '../adapters/cli/types.js';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';

export function scanLocalOrcaCliPids(
  rootPidByHandle: ReadonlyMap<string, number>,
  expectedCliByHandle: ReadonlyMap<string, CliId> = new Map(),
): Map<string, { pid: number; cliId: CliId }> {
  const byHandle = new Map<string, { pid: number; cliId: CliId }>();
  const candidates = new Map<string, Array<{ pid: number; cliId: CliId; depth: number }>>();
  let pids: number[];
  try {
    pids = readdirSync('/proc')
      .filter(name => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return byHandle;
  }
  const parentByPid = new Map<number, number>();
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const match = status.match(/^PPid:\s+(\d+)/m);
      if (match) parentByPid.set(pid, Number(match[1]));
    } catch { /* exited */ }
  }
  const depthFrom = (pid: number, rootPid: number): number | undefined => {
    const seen = new Set<number>();
    let current: number | undefined = pid;
    let depth = 0;
    while (current && !seen.has(current)) {
      if (current === rootPid) return depth;
      seen.add(current);
      current = parentByPid.get(current);
      depth += 1;
    }
    return undefined;
  };
  const processCliIds: Readonly<Record<string, CliId>> = {
    claude: 'claude-code',
    codex: 'codex',
    coco: 'coco',
    traex: 'traex',
    traecli: 'traex',
    'cursor-agent': 'cursor',
    gemini: 'gemini',
    opencode: 'opencode',
    opencode2: 'opencode2',
    mtr: 'mtr',
    hermes: 'hermes',
    pi: 'pi',
    omp: 'oh-my-pi',
    grok: 'grok',
    'kiro-cli': 'kiro-cli',
  };
  for (const pid of pids) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`);
      const handleMatch = env.toString('utf-8').match(/(?:^|\0)ORCA_TERMINAL_HANDLE=([^\0]+)/);
      if (!handleMatch) continue;
      const rootPid = rootPidByHandle.get(handleMatch[1]!);
      if (!rootPid) continue;
      const expectedCliId = expectedCliByHandle.get(handleMatch[1]!);
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
      let executable = '';
      try { executable = basename(readlinkSync(`/proc/${pid}/exe`)); } catch { /* unreadable */ }
      const processName = processCliIds[comm] ?? processCliIds[executable];
      const cliId = (comm === 'traecli' || executable === 'traecli')
        && (expectedCliId === 'traex' || expectedCliId === 'coco')
        ? expectedCliId
        : processName;
      const depth = depthFrom(pid, rootPid);
      if (!cliId || (expectedCliId && cliId !== expectedCliId) || depth === undefined) continue;
      const list = candidates.get(handleMatch[1]!) ?? [];
      list.push({ pid, cliId, depth });
      candidates.set(handleMatch[1]!, list);
    } catch { /* another user's or exited process */ }
  }
  for (const [handle, list] of candidates) {
    list.sort((a, b) => b.depth - a.depth);
    if (list.length > 1 && list[0]!.depth === list[1]!.depth) continue;
    const selected = list[0];
    if (selected) byHandle.set(handle, { pid: selected.pid, cliId: selected.cliId });
  }
  return byHandle;
}
