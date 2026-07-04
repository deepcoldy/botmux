import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every `zellij` invocation the observe backend makes. dump-screen
// returns bare-`\n` content (as real zellij does) so we can assert normalisation.
// `listPanesResult` is mutable so the liveness tests can simulate a pane that
// transiently disappears and comes back.
const calls: string[][] = [];
let listPanesResult: () => string = () => JSON.stringify([{ id: 2, is_plugin: false }]);
vi.mock('node:child_process', () => ({
  execFileSync: (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    if (args.includes('dump-screen')) return 'line one\nline two\nline three\n';
    if (args.includes('list-panes')) return listPanesResult();
    return '';
  },
}));

import { ZellijObserveBackend } from '../src/adapters/backend/zellij-observe-backend.js';

const S = 'usersess';
const P = 'terminal_2';
const actionArgs = (cmd: string) =>
  calls.find(c => c[3] === 'action' && c[4] === cmd)?.slice(4);

describe('ZellijObserveBackend input encoding', () => {
  let be: ZellijObserveBackend;
  beforeEach(() => {
    calls.length = 0;
    be = new ZellijObserveBackend(S, P, { cliPid: 999 });
  });

  it('sendText → targeted write-chars on the pane', () => {
    be.sendText('hello');
    expect(actionArgs('write-chars')).toEqual(['write-chars', '--pane-id', P, '--', 'hello']);
  });

  it('sendSpecialKeys(Enter) → action write with the CR byte (13)', () => {
    be.sendSpecialKeys('Enter');
    expect(actionArgs('write')).toEqual(['write', '--pane-id', P, '13']);
  });

  it('sendSpecialKeys(C-c) → action write with ETX byte (3)', () => {
    be.sendSpecialKeys('C-c');
    expect(actionArgs('write')).toEqual(['write', '--pane-id', P, '3']);
  });

  it('pasteText wraps text in bracketed-paste markers', () => {
    be.pasteText('x');
    // captured call = ['zellij','--session',S,'action','write','--pane-id',P,...bytes]
    // \e[200~  = 27 91 50 48 48 126 ; \e[201~ = 27 91 50 48 49 126
    const writes = calls.filter(c => c[4] === 'write').map(c => c.slice(7));
    const chars = calls.filter(c => c[4] === 'write-chars').map(c => c.slice(7));
    expect(writes[0]).toEqual(['27', '91', '50', '48', '48', '126']); // open bracket
    expect(chars[0]).toEqual(['--', 'x']);
    expect(writes[1]).toEqual(['27', '91', '50', '48', '49', '126']); // close bracket
  });

  it('getChildPid returns the adopted cli pid', () => {
    expect(be.getChildPid()).toBe(999);
  });

  it('resize is a no-op (never issues a zellij command — non-invasive)', () => {
    be.resize(200, 50);
    expect(calls).toHaveLength(0);
  });

  it('normalises dump-screen bare \\n to \\r\\n (else xterm staircases lines)', () => {
    // zellij emits "line one\nline two\n…"; the xterm needs \r\n or each line
    // continues from the previous end column (the misalignment 申晗 hit).
    expect(be.captureViewport()).toBe('line one\r\nline two\r\nline three\r\n');
    expect(be.captureCurrentScreen()).toBe('line one\r\nline two\r\nline three\r\n');
  });
});

describe('ZellijObserveBackend liveness debounce', () => {
  const ALIVE = () => JSON.stringify([{ id: 2, is_plugin: false }]);
  const GONE = () => '[]';
  const opts = () => ({ cwd: '/tmp', cols: 80, rows: 24, env: process.env as Record<string, string> });

  beforeEach(() => {
    calls.length = 0;
    listPanesResult = ALIVE;
  });

  it('does NOT detach on a single transient list-panes failure that recovers', () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    try {
      const be = new ZellijObserveBackend(S, P, { cliPid: 999 });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((c, s) => exits.push([c, s]));
      be.spawn('', [], opts());

      listPanesResult = GONE;
      vi.advanceTimersByTime(1_000);   // 1 failed liveness probe
      listPanesResult = ALIVE;
      vi.advanceTimersByTime(8_000);   // sustained recovery
      expect(exits).toEqual([]);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('detaches only after 3 consecutive pane-gone probes + a failed confirm', () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    try {
      const be = new ZellijObserveBackend(S, P, { cliPid: 999 });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((c, s) => exits.push([c, s]));
      be.spawn('', [], opts());

      listPanesResult = GONE;
      vi.advanceTimersByTime(2_000);   // 2 failures — debounced
      expect(exits).toEqual([]);
      vi.advanceTimersByTime(1_000);   // 3rd + failed confirm ⇒ detach
      expect(exits).toEqual([[0, null]]);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('detaches IMMEDIATELY when the pid is gone (pid is decisive, not debounced)', () => {
    // process.kill(pid,0) can only report ESRCH/EPERM — never a transient
    // failure — so a dead pid tears down on the first tick to keep the user's
    // Lark input out of the shell the pane drops back to.
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: NodeJS.Signals | 0) => {
      if (pid === 999 && sig === 0) {
        const e: NodeJS.ErrnoException = new Error('gone');
        e.code = 'ESRCH';
        throw e;
      }
      return true;
    }) as typeof process.kill);
    try {
      listPanesResult = ALIVE;          // pane never disappears — only the pid is gone
      const be = new ZellijObserveBackend(S, P, { cliPid: 999 });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((c, s) => exits.push([c, s]));
      be.spawn('', [], opts());

      vi.advanceTimersByTime(1_000);    // first liveness tick ⇒ detach now
      expect(exits).toEqual([[0, null]]);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stays attached when the pane reappears on the final confirm (overload, not death)', () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    try {
      let listCalls = 0;
      listPanesResult = () => {
        listCalls += 1;
        // 3 polled probes miss the pane (busy server) …
        if (listCalls <= 3) return '[]';
        // … but the final confirm re-probe finds it ⇒ still alive.
        return JSON.stringify([{ id: 2, is_plugin: false }]);
      };
      const be = new ZellijObserveBackend(S, P, { cliPid: 999 });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((c, s) => exits.push([c, s]));
      be.spawn('', [], opts());

      vi.advanceTimersByTime(3_000);   // 3 failed polls + 1 successful confirm
      expect(exits).toEqual([]);       // recovered on the confirm — no detach
      expect(listCalls).toBe(4);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('setLiveAttach(true) resets a partial pane-failure streak at the attach transition', () => {
    // 2 failures, then a brief attach+detach that crosses NO liveness tick. If
    // setLiveAttach reset the streak, a single post-detach failure leaves the
    // gate at 1 (no detach). If it did NOT reset (e.g. relying only on the
    // per-tick reset), the gate would still be 2 and this one failure would hit
    // the threshold → detach. So this pins the reset to setLiveAttach itself —
    // it would go red if that reset were removed.
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    try {
      const be = new ZellijObserveBackend(S, P, { cliPid: 999 });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((c, s) => exits.push([c, s]));
      be.spawn('', [], opts());

      listPanesResult = GONE;
      vi.advanceTimersByTime(2_000);   // 2 pane failures (gate at 2, no detach)
      expect(exits).toEqual([]);

      be.setLiveAttach(true);          // attach resets the streak immediately…
      be.setLiveAttach(false);         // …and detaches before any liveness tick

      vi.advanceTimersByTime(1_000);   // ONE more failure → gate is 1, not 3
      expect(exits).toEqual([]);

      // And the gate genuinely counts from 1: two further failures DO trip it.
      vi.advanceTimersByTime(2_000);
      expect(exits).toEqual([[0, null]]);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
