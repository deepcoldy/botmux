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
  // 源码结构护栏(K3+K2)：spawn 前的读隔离闸门在 worker.ts 的 spawnCli 巨型闭包里，没有可单测的 seam；
  // 上面的纯函数用例删掉 worker 调用点照样全绿。守两件事：① 闸门吃的是经冷机判定升级后的 probe——
  // 2026-10-02 重启清空 /tmp 后所有读隔离 bot 一直起不来（11d09778c9）；② 这个「unknown→missing」
  // 的放宽只有这一个生产调用点，不能扩散到 post-kill 确认 / MCP 闸门等其它 fail-closed 判定。
  it('feeds only the read-isolation gate through the tmux cold-machine probe upgrade', () => {
    const src = stripComments(readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8'));
    const call = src.match(/(\w+) = resolveReadIsolationPaneProbe\([\s\S]{0,200}?serverAbsentOnColdMachine\(\)/);
    expect(call).not.toBeNull();
    expect(src.match(/resolveReadIsolationPaneProbe\(/g)).toHaveLength(1);
    expect(src.match(/serverAbsentOnColdMachine\(/g)).toHaveLength(1);
    // The gate's state machine consumes the resolved probe, never the raw one.
    const resolved = src.slice(call!.index!);
    const gateInput = resolved.slice(resolved.indexOf('evaluatePersistentPaneMigration({'));
    expect(resolved).toMatch(new RegExp(`paneProbe = ${call![1]}\\.probe\\b`));
    expect(gateInput.slice(0, gateInput.indexOf('})'))).toMatch(/\bpaneProbe\b/);
    expect(src).not.toMatch(/evaluatePersistentPaneMigration\(\{[^}]*rawPaneProbe/);
  });
});
