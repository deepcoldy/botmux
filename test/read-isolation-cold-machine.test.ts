/**
 * Cold-machine tie-break for the read-isolation pre-spawn gate.
 *
 * 2026-10-02: after a reboot wiped /tmp, the tmux socket file was gone, every
 * read-isolated session's liveness probe read 'unknown', the gate refused
 * (refuse-inconclusive-probe) and — since a refused session never starts a tmux
 * server — every isolated bot on the machine stayed down until an unsandboxed
 * bot happened to spawn first.
 *
 * resolveReadIsolationPaneProbe upgrades ONLY an 'unknown' tmux probe, and
 * ONLY when the cold-machine check confirms it; the general probe is untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from './helpers/bun-leg-selectors.js';
import {
  evaluatePersistentPaneMigration,
  resolveReadIsolationPaneProbe,
  type PersistentPaneMigrationInput,
} from '../src/adapters/cli/read-isolation.js';

const never = () => { throw new Error('cold-machine check must not run'); };

describe('resolveReadIsolationPaneProbe', () => {
  it('upgrades an unknown tmux probe to missing when the server is absent on a cold machine', () => {
    expect(resolveReadIsolationPaneProbe('unknown', 'tmux', () => true))
      .toEqual({ probe: 'missing', coldServerAbsent: true });
  });

  it('keeps unknown when the server is not absent on a cold machine, or the check throws / returns non-true', () => {
    expect(resolveReadIsolationPaneProbe('unknown', 'tmux', () => false).probe).toBe('unknown');
    expect(resolveReadIsolationPaneProbe('unknown', 'tmux', never).probe).toBe('unknown');
    expect(resolveReadIsolationPaneProbe('unknown', 'tmux', (() => 'yes') as any).probe).toBe('unknown');
  });

  it('passes exists / missing through without running the check', () => {
    let ran = 0;
    const absent = () => { ran++; return true; };
    expect(resolveReadIsolationPaneProbe('exists', 'tmux', absent).probe).toBe('exists');
    expect(resolveReadIsolationPaneProbe('missing', 'tmux', absent)).toEqual({ probe: 'missing', coldServerAbsent: false });
    expect(ran).toBe(0);
  });

  it('never touches non-tmux backends', () => {
    // The check says "absent" — a non-tmux backend must still not be upgraded,
    // and the check must not even run (a throwing stub would be swallowed).
    let ran = 0;
    const absent = () => { ran++; return true; };
    for (const backend of ['zellij', 'zmx', 'herdr', 'pty']) {
      expect(resolveReadIsolationPaneProbe('unknown', backend, absent).probe).toBe('unknown');
    }
    expect(ran).toBe(0);
  });

  it('turns the post-reboot refusal into a cold spawn (policy ON, stale provenance on disk)', () => {
    const base: PersistentPaneMigrationInput = {
      appliedIsolationCapabilities: ['credential', 'read', 'write'],
      isolationCapableBackend: true,
      noTransport: false,
      isolationMarkerPresent: true,
      policyOffTombstonePresent: false,
      policyOffTombstoneValid: false,
      paneProbe: 'unknown',
      pendingProvenancePresent: false,
      isolationMarkerReattachSafe: false,
    };
    expect(evaluatePersistentPaneMigration(base)).toEqual({ action: 'refuse-inconclusive-probe' });
    const { probe } = resolveReadIsolationPaneProbe('unknown', 'tmux', () => true);
    expect(evaluatePersistentPaneMigration({ ...base, paneProbe: probe }))
      .toEqual({ action: 'clear-stale-then-cold-spawn' });
  });
});

describe('worker wiring', () => {
  it('feeds the read-isolation gate through resolveReadIsolationPaneProbe with the tmux cold-machine check', () => {
    const src = stripComments(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8'));
    expect(src).toMatch(/const paneProbe = resolvedPaneProbe\.probe;/);
    expect(src).toMatch(/resolveReadIsolationPaneProbe\(\s*rawPaneProbe,\s*effectiveBackendType,\s*\(\) => TmuxBackend\.serverAbsentOnColdMachine\(\),\s*\)/);
    // The gate's state machine consumes the resolved probe, not the raw one.
    const gate = src.slice(src.indexOf('const paneProbe = resolvedPaneProbe.probe;'));
    expect(gate.slice(0, gate.indexOf('evaluatePersistentPaneMigration(') + 2000)).toMatch(/paneProbe,/);
    expect(src).not.toMatch(/evaluatePersistentPaneMigration\(\{[^}]*rawPaneProbe/);
  });

  it('keeps the upgrade out of every other consumer (post-kill confirm and the MCP gate probe afresh)', () => {
    const src = stripComments(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8'));
    // Exactly one production call site.
    expect(src.match(/resolveReadIsolationPaneProbe\(/g)).toHaveLength(1);
    expect(src.match(/serverAbsentOnColdMachine\(/g)).toHaveLength(1);
    // Post-kill confirmation re-probes the backend; it never reads paneProbe.
    const confirm = src.slice(src.indexOf('confirmPaneGone: () => {'));
    const confirmBody = confirm.slice(0, confirm.indexOf('},'));
    expect(confirmBody).toMatch(/const postKillProbe = [\s\S]*probePersistentBackendTarget\(stalePersistentTarget\)[\s\S]*probePersistentSession\(/);
    expect(confirmBody).not.toMatch(/\bpaneProbe\b/);
    // The MCP-gateway gate declares and computes its own probe.
    const mcp = src.slice(src.indexOf('if (cliAdapter.mcpGateway && mcpRuntimeManifest?.entries.length'));
    expect(mcp.slice(0, 600)).toMatch(/const paneProbe = effectiveBackendType === 'zmx'[\s\S]*probePersistentBackendTarget\(persistentTarget\)/);
  });
});
