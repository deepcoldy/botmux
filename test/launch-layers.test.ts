import { describe, expect, it } from 'vitest';
import { unwrapBotmuxLaunchLayers } from '../src/core/launch-layers.js';
import { sessionScopePayloadPid, wrapCommandInSessionScope } from '../src/core/session-scope.js';

// A synthetic /proc. The argv come from the real wrappers, so a change to the
// scope supervisor's or the relay's command line shape shows up here.
const RELAY_ARGV = ['/usr/bin/node', '/opt/botmux/dist/program-status-relay.js', 'a'.repeat(64), '/tmp/botmux-psr-x/plan.json'];
const SCOPE_ARGV = wrapCommandInSessionScope('6b50f4a4-3392-43df-837b-02261f498b43', '/root/.local/bin/claude', ['--resume', 'x'],
  undefined, { cleanupSupported: true, memoryControllerSupported: false }, {}).args;
const CLAUDE_ARGV = ['/root/.local/bin/claude', '--resume', 'x'];

interface Proc { argv: string[]; children?: number[]; comm?: string }

function walk(table: Record<number, Proc>, pane: number, relay = true) {
  const proc = (pid: number): Proc | undefined => table[pid];
  return unwrapBotmuxLaunchLayers(pane, {
    relay,
    probes: {
      readCmdline: pid => proc(pid)?.argv ?? [],
      childrenOf: pid => proc(pid)?.children ?? [],
      commOf: pid => proc(pid)?.comm,
      scopePayloadOf: pid => sessionScopePayloadPid(pid, {
        platform: 'linux',
        readFile: path => {
          const p = proc(Number(path.split('/')[2]));
          if (!p) throw new Error('process gone');
          return path.endsWith('/cmdline') ? `${p.argv.join('\0')}\0` : `${(p.children ?? []).join(' ')} `;
        },
      }),
    },
  });
}

describe('unwrapBotmuxLaunchLayers', () => {
  it('unwraps relay → scope supervisor → Claude, outermost first', () => {
    expect(walk({
      100: { argv: RELAY_ARGV, children: [150] },
      150: { argv: SCOPE_ARGV, children: [175], comm: 'sh' },
      175: { argv: CLAUDE_ARGV, comm: 'claude' },
    }, 100)).toEqual({ pid: 175, layers: ['program-status-relay', 'session-scope'], chain: [100, 150, 175] });
  });

  it('unwraps a scope supervisor that is the pane itself (no relay)', () => {
    expect(walk({
      100: { argv: SCOPE_ARGV, children: [175], comm: 'sh' },
      175: { argv: CLAUDE_ARGV, comm: 'claude' },
    }, 100)).toEqual({ pid: 175, layers: ['session-scope'], chain: [100, 175] });
  });

  it('never treats the pane as a relay where none can run', () => {
    expect(walk({
      100: { argv: RELAY_ARGV, children: [150] },
      150: { argv: SCOPE_ARGV, children: [175], comm: 'sh' },
    }, 100, false).layers).toEqual([]);
  });

  it('stops at the deepest layer that is already observable', () => {
    // Relay has not forked the CLI's PTY child yet (only its stty helper).
    expect(walk({ 100: { argv: RELAY_ARGV, children: [140] }, 140: { argv: ['stty'], comm: 'stty' } }, 100))
      .toEqual({ pid: 100, layers: [], chain: [100] });
    // The relay's child is still `/usr/bin/env`, not yet exec'd into the supervisor.
    expect(walk({
      100: { argv: RELAY_ARGV, children: [150] },
      150: { argv: ['/usr/bin/env', ...SCOPE_ARGV], children: [] },
    }, 100)).toEqual({ pid: 150, layers: ['program-status-relay'], chain: [100, 150] });
    // The supervisor has not forked systemd-run yet.
    expect(walk({
      100: { argv: RELAY_ARGV, children: [150] },
      150: { argv: SCOPE_ARGV, children: [], comm: 'sh' },
    }, 100)).toEqual({ pid: 150, layers: ['program-status-relay'], chain: [100, 150] });
  });

  it('leaves an unrecognised pane or an ambiguous child set alone', () => {
    expect(walk({ 100: { argv: CLAUDE_ARGV, comm: 'claude' } }, 100)).toEqual({ pid: 100, layers: [], chain: [100] });
    expect(walk({ 100: { argv: RELAY_ARGV, children: [150, 151] } }, 100).pid).toBe(100);
  });
});
