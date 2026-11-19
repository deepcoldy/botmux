import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startBotViaSupervisor, stopBotViaSupervisor, fleetStatePath, fleetCommandPath, resolveFleetMembers, waitFleetOnline } from '../src/core/fleet-runtime.js';
import { readFleetCommands } from '../src/core/fleet-command-queue.js';
import { writeFleetState } from '../src/core/fleet-state-store.js';
import { freshProc, type FleetState } from '../src/core/fleet-supervisor-policy.js';
import { signalAttestedFleetProcess } from '../src/core/fleet-process-identity.js';

// No real supervisor is signalled. State files live inside the test HOME fence.
vi.mock('../src/core/fleet-process-identity.js', () => ({
  fleetProcessIdentityRuntime: {},
  inspectFleetProcess: vi.fn(),
  builtinFleetEntryMatches: vi.fn(),
  inspectSupervisorState: () => ({ status: 'exact', attestation: { pid: 123 } }),
  signalAttestedFleetProcess: vi.fn(),
}));
let state: FleetState;
beforeEach(() => {
  mkdirSync(join(homedir(), '.botmux'), { recursive: true });
  writeFileSync(join(homedir(), '.botmux', 'bots.json'), JSON.stringify([{ name: 'renamed', larkAppId: 'cli_a', cliId: 'minimax' }]));
  writeFileSync(fleetCommandPath(), JSON.stringify({ commands: [] }));
  state = { supervisorPid: 123, supervisorStartedAt: 'T', procs: [freshProc('botmux-0', 'cli_a', process.pid, 'T')] };
  writeFleetState(fleetStatePath(), state);
  vi.mocked(signalAttestedFleetProcess).mockReset();
});

describe('single-bot control follows App ID across names', () => {
  it('accepts renamed fleet members but still requires the dashboard', () => {
    expect(waitFleetOnline(resolveFleetMembers(), 0)).toMatchObject({ healthy: false, online: 1, pending: ['botmux-dashboard'] });
    state.procs.push(freshProc('botmux-dashboard', '', process.ppid, 'T'));
    writeFleetState(fleetStatePath(), state);
    expect(waitFleetOnline(resolveFleetMembers(), 0)).toEqual({ healthy: true, online: 2, expected: 2, pending: [] });
  });

  it('does not mistake a reused name for the configured App ID', () => {
    state.procs[0] = freshProc('botmux-renamed', 'cli_peer', process.pid, 'T');
    state.procs.push(freshProc('botmux-dashboard', '', process.ppid, 'T'));
    writeFleetState(fleetStatePath(), state);
    expect(waitFleetOnline(resolveFleetMembers(), 0)).toMatchObject({ healthy: false, online: 1, pending: ['botmux-renamed'] });
  });

  it('waits for the supervisor to finish retiring a still-live orphan', () => {
    state.procs[0].status = 'launching';
    state.procs.push(freshProc('botmux-dashboard', '', process.ppid, 'T'));
    writeFleetState(fleetStatePath(), state);
    expect(waitFleetOnline(resolveFleetMembers(), 0)).toMatchObject({ healthy: false, online: 1, pending: ['botmux-renamed'] });
    state.procs[0].status = 'online';
    writeFleetState(fleetStatePath(), state);
    expect(waitFleetOnline(resolveFleetMembers(), 0).healthy).toBe(true);
  });

  it('does not match a bot with an empty App ID to the dashboard', () => {
    writeFileSync(join(homedir(), '.botmux', 'bots.json'), JSON.stringify([{ name: 'renamed', larkAppId: '', cliId: 'minimax' }]));
    state.procs = [freshProc('botmux-dashboard', '', process.ppid, 'T')];
    writeFleetState(fleetStatePath(), state);
    vi.mocked(signalAttestedFleetProcess).mockImplementation(() => {
      state.procs.push(freshProc('botmux-renamed', '', process.pid, 'T'));
      writeFleetState(fleetStatePath(), state); return true;
    });
    expect(startBotViaSupervisor('', () => 'start', () => 'T', 0)).toMatchObject({ ok: true, state: 'started', name: 'botmux-renamed' });
    vi.mocked(signalAttestedFleetProcess).mockImplementation(() => {
      state.procs[1].status = 'stopped'; state.procs[1].pid = 0;
      writeFleetState(fleetStatePath(), state); return true;
    });
    expect(stopBotViaSupervisor('', () => 'stop', () => 'T', 0)).toMatchObject({ ok: true, state: 'stopped' });
    expect(state.procs[0].status).toBe('online');
  });

  it('recognizes an already-online daemon under the previous name', () => {
    expect(startBotViaSupervisor('cli_a', () => 'start', () => 'T', 0)).toMatchObject({ ok: true, state: 'already-online', name: 'botmux-0' });
    expect(signalAttestedFleetProcess).not.toHaveBeenCalled();
  });
  it('accepts a deduplicated start that retains the original name after backoff', () => {
    state.procs[0].status = 'launching'; state.procs[0].pid = 0;
    writeFleetState(fleetStatePath(), state);
    vi.mocked(signalAttestedFleetProcess).mockImplementation(() => {
      state.procs[0].status = 'online'; state.procs[0].pid = process.pid;
      writeFleetState(fleetStatePath(), state); return true;
    });
    expect(startBotViaSupervisor('cli_a', () => 'start', () => 'T', 0)).toMatchObject({ ok: true, state: 'started', name: 'botmux-0' });
  });
  it('requests stop for a renamed daemon and waits for every old alias', () => {
    state.procs.push(freshProc('botmux-renamed', 'cli_a', process.ppid, 'T'));
    writeFleetState(fleetStatePath(), state);
    vi.mocked(signalAttestedFleetProcess).mockImplementation(() => {
      state.procs[1].status = 'stopped'; state.procs[1].pid = 0;
      writeFleetState(fleetStatePath(), state); return true;
    });
    expect(stopBotViaSupervisor('cli_a', () => 'stop', () => 'T', 0)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(readFleetCommands(fleetCommandPath())).toMatchObject([{ op: 'stop-bot', appId: 'cli_a' }]);
    vi.mocked(signalAttestedFleetProcess).mockImplementation(() => {
      state.procs[0].status = 'stopped'; state.procs[0].pid = 0;
      writeFleetState(fleetStatePath(), state); return true;
    });
    expect(stopBotViaSupervisor('cli_a', () => 'stop2', () => 'T', 0)).toMatchObject({ ok: true, state: 'stopped' });
  });
});
