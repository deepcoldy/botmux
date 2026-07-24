import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
const claudeAdapterSource = readFileSync(
  join(process.cwd(), 'src/adapters/cli/claude-code.ts'),
  'utf8',
);
const adapterTypesSource = readFileSync(
  join(process.cwd(), 'src/adapters/cli/types.ts'),
  'utf8',
);

function scriptBlock(startMarker: string): string {
  const start = workerSource.indexOf(startMarker);
  const end = workerSource.indexOf('</script>', start);
  expect(start).toBeGreaterThan(-1);
  return workerSource.slice(start, end);
}

describe('read-only web terminal wheel scrolling', () => {
  it('exposes readonlyWheelScroll as an opt-in adapter capability, on for Claude only', () => {
    expect(adapterTypesSource).toContain('readonly readonlyWheelScroll?: boolean;');
    // Claude family (claude-code + seed share this adapter) opts in.
    expect(claudeAdapterSource).toContain('readonlyWheelScroll: true,');
    // No OTHER shipped adapter turns it on.
    const others = [
      'codex', 'gemini', 'opencode', 'cursor', 'grok', 'pi', 'copilot',
      'kimi', 'aiden', 'coco', 'hermes', 'mira', 'mir', 'traex', 'riff',
      'genius', 'mtr', 'antigravity', 'kiro-cli', 'oh-my-pi', 'codex-app',
    ];
    for (const name of others) {
      const src = readFileSync(join(process.cwd(), `src/adapters/cli/${name}.ts`), 'utf8');
      expect(src, `${name} must not enable readonlyWheelScroll`).not.toContain('readonlyWheelScroll');
    }
  });

  it('only enables the capability on the shared relay path (not tmux/zellij attach)', () => {
    expect(workerSource).toContain(
      'const readonlyWheelScroll = cliAdapter?.readonlyWheelScroll === true\n'
      + '        && !(isTmuxMode && !isPipeMode);',
    );
    expect(workerSource).toContain(
      'getTerminalHtml(hasWrite, platformReadonly, loginUrl, forceRemoteScroll, localTerminalBackend, readonlyWheelScroll)',
    );
    expect(workerSource).toContain('var readonlyWheelScroll=${readonlyWheelScroll};');
  });

  it('read-only client sends a RESTRICTED scroll intent, never raw mouse bytes', () => {
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');
    // Under !hasToken + alt-screen + capability, the client emits {type:'scroll'}
    // carrying only a direction and a bounded line count — NOT an SGR byte string.
    expect(wheelBlock).toContain('if(readonlyWheelScroll&&ws_&&ws_.readyState===1&&px){');
    expect(wheelBlock).toContain("type:'scroll',dir:px<0?'up':'down',lines:_lines");
    expect(wheelBlock).toContain('var _lines=Math.max(1,Math.min(6,Math.round(Math.abs(px)/33)));');
    // The read-only branch must NOT reach _fwdScroll (which forwards raw SGR bytes).
    const roBranch = wheelBlock.slice(
      wheelBlock.indexOf('if(!hasToken){', wheelBlock.indexOf('_canScrollLocal(px)')),
    );
    const roOnly = roBranch.slice(0, roBranch.indexOf('_fwdScroll(px,_cellAt'));
    expect(roOnly).not.toContain('_fwdScroll');
  });

  it('server ignores scroll intent unless the adapter opted in', () => {
    // The 'scroll' handler is gated on the adapter capability and is NOT behind
    // authedClients (that is the whole point — read-only is allowed here), but a
    // non-opted-in CLI drops it entirely.
    expect(workerSource).toContain("} else if (msg.type === 'scroll') {");
    expect(workerSource).toContain('if (cliAdapter?.readonlyWheelScroll !== true) return;');
    expect(workerSource).toContain('buildReadonlyWheelSequence(msg.dir, msg.lines, grantedTicks)');
    expect(workerSource).toContain('if (!seq) return;');
  });

  it('server synthesizes the wheel bytes — client cannot supply button/coord/keys', () => {
    // buildReadonlyWheelSequence hard-codes the button and a server-owned centre
    // coordinate, and clamps the line count. The client's message never reaches
    // backend.write() as raw bytes.
    const fn = workerSource.slice(
      workerSource.indexOf('function buildReadonlyWheelSequence'),
      workerSource.indexOf('function handleTermAction'),
    );
    expect(fn).toContain("if (dir !== 'up' && dir !== 'down') return '';");
    expect(fn).toContain('Math.max(1, Math.min(READONLY_SCROLL_MAX_TICKS, Math.floor(lines)))');
    expect(fn).toContain('const n = Math.min(requested, Math.floor(maxTicks));');
    expect(fn).toContain("const button = dir === 'up' ? 64 : 65;");
    expect(fn).toContain('const col = (cols >> 1) + 1;');
    expect(fn).toContain('const row = (rows >> 1) + 1;');
    // No client-provided coordinate or button is ever interpolated.
    expect(fn).not.toContain('msg.');
  });

  it('buildReadonlyWheelSequence behaves: clamps, fixes button, rejects garbage', () => {
    // Port the pure function and verify its guarantees directly.
    function build(dir: unknown, lines: unknown, maxTicks = 6, cols = 80, rows = 24): string {
      if (dir !== 'up' && dir !== 'down') return '';
      if (maxTicks <= 0) return '';
      const requested = typeof lines === 'number' && Number.isFinite(lines)
        ? Math.max(1, Math.min(6, Math.floor(lines)))
        : 1;
      const n = Math.min(requested, Math.floor(maxTicks));
      if (n <= 0) return '';
      const col = (cols >> 1) + 1;
      const row = (rows >> 1) + 1;
      const button = dir === 'up' ? 64 : 65;
      const coord = `${col};${row}`;
      let seq = '';
      for (let i = 0; i < n; i++) seq += `\x1b[<${button};${coord}M`;
      return seq;
    }

    // Direction → fixed wheel button, server-centre coordinate (41;13 for 80x24).
    expect(build('up', 1)).toBe('\x1b[<64;41;13M');
    expect(build('down', 1)).toBe('\x1b[<65;41;13M');
    // Line count clamped to [1,6]; three ticks up.
    expect(build('up', 3)).toBe('\x1b[<64;41;13M'.repeat(3));
    expect(build('up', 999)).toBe('\x1b[<64;41;13M'.repeat(6)); // capped
    expect(build('up', 0)).toBe('\x1b[<64;41;13M'); // floored to 1
    // maxTicks (rate-limiter grant) shrinks further and can zero it out entirely.
    expect(build('up', 6, 2)).toBe('\x1b[<64;41;13M'.repeat(2));
    expect(build('up', 6, 0)).toBe(''); // no tokens granted → nothing forwarded
    // Garbage direction / non-numeric lines → nothing / safe fallback.
    expect(build('left', 3)).toBe('');
    expect(build('click', 3)).toBe('');
    expect(build('up', 'evil')).toBe('\x1b[<64;41;13M'); // non-number → 1 tick, still pure wheel
    // Never contains a mouse-press (button 0) or release ('m') sequence.
    for (const dir of ['up', 'down'] as const) {
      const s = build(dir, 6);
      expect(s).not.toContain('\x1b[<0;'); // no left-click press
      expect(s).not.toContain('m'); // no SGR release
      expect(s.endsWith('M') || s === '').toBe(true);
    }
  });

  it('shared idle-reset burst: multi-WS cannot stack, sustained flood stays ≤6, reconnect never refreshes', () => {
    const MAX = 6;
    const WINDOW = 250;
    // Faithful port of admitReadonlyScrollTicks — a SINGLE shared burst counter,
    // NOT per-connection. Resets only after a full idle window or a direction
    // reversal, mirroring #577's client _fwdScroll gesture cap.
    const burst = { ticks: 0, dir: 0, last: -Infinity };
    function admit(dir: 'up' | 'down', wantTicks: number, now: number): number {
      if (wantTicks <= 0) return 0;
      const dirSign = dir === 'up' ? -1 : 1;
      const idle = now - burst.last >= WINDOW;
      const reversed = burst.dir !== 0 && dirSign !== burst.dir;
      if (idle || reversed) burst.ticks = 0;
      burst.dir = dirSign;
      burst.last = now;
      const remaining = MAX - burst.ticks;
      if (remaining <= 0) return 0;
      const granted = Math.min(wantTicks, remaining);
      burst.ticks += granted;
      return granted;
    }

    // (1) Multi-connection at the SAME instant cannot stack past 6. Simulate N=10
    //     sockets each looping {lines:6}; the shared burst caps the total at 6.
    let totalAtT0 = 0;
    for (let socket = 0; socket < 10; socket++) {
      for (let i = 0; i < 100; i++) totalAtT0 += admit('up', 6, 0);
    }
    expect(totalAtT0).toBe(6); // NOT 6·N — one shared ceiling

    // (2) Sustained flood over 1s from many interleaved sockets. The burst only
    //     resets on a FULL idle window; continuous traffic never idles, so after
    //     the first 6 nothing more is admitted for the whole second.
    const burst2 = { ticks: 0, dir: 0, last: -Infinity };
    function admit2(dir: 'up' | 'down', want: number, now: number): number {
      if (want <= 0) return 0;
      const dirSign = dir === 'up' ? -1 : 1;
      const idle = now - burst2.last >= WINDOW;
      const reversed = burst2.dir !== 0 && dirSign !== burst2.dir;
      if (idle || reversed) burst2.ticks = 0;
      burst2.dir = dirSign; burst2.last = now;
      const remaining = MAX - burst2.ticks;
      if (remaining <= 0) return 0;
      const g = Math.min(want, remaining); burst2.ticks += g; return g;
    }
    let sustained = 0;
    for (let t = 0; t <= 1000; t += 10) { // flood every 10ms — never idle for 250ms
      for (let socket = 0; socket < 3; socket++) sustained += admit2('up', 6, t);
    }
    expect(sustained).toBe(6); // continuous traffic never resets → still just 6

    // (3) A full idle window (everyone quiet ≥250ms) is required to reopen.
    const burst3 = { ticks: 0, dir: 0, last: -Infinity };
    function admit3(dir: 'up' | 'down', want: number, now: number): number {
      if (want <= 0) return 0;
      const dirSign = dir === 'up' ? -1 : 1;
      const idle = now - burst3.last >= WINDOW;
      const reversed = burst3.dir !== 0 && dirSign !== burst3.dir;
      if (idle || reversed) burst3.ticks = 0;
      burst3.dir = dirSign; burst3.last = now;
      const remaining = MAX - burst3.ticks;
      if (remaining <= 0) return 0;
      const g = Math.min(want, remaining); burst3.ticks += g; return g;
    }
    expect(admit3('up', 6, 0)).toBe(6);        // first gesture
    expect(admit3('up', 6, 100)).toBe(0);      // 100ms later — still same burst
    expect(admit3('up', 6, 200)).toBe(0);      // 200ms — still not idle enough
    expect(admit3('up', 6, 450)).toBe(6);      // 250ms after last (200) → reset, reopens

    // (4) Reconnect does NOT refresh the budget — the burst is shared/global, not
    //     tied to a socket. A "new connection" that keeps flooding within the
    //     window sees the burst already spent.
    const burst4 = { ticks: 0, dir: 0, last: -Infinity };
    function admit4(dir: 'up' | 'down', want: number, now: number): number {
      if (want <= 0) return 0;
      const dirSign = dir === 'up' ? -1 : 1;
      const idle = now - burst4.last >= WINDOW;
      const reversed = burst4.dir !== 0 && dirSign !== burst4.dir;
      if (idle || reversed) burst4.ticks = 0;
      burst4.dir = dirSign; burst4.last = now;
      const remaining = MAX - burst4.ticks;
      if (remaining <= 0) return 0;
      const g = Math.min(want, remaining); burst4.ticks += g; return g;
    }
    expect(admit4('up', 6, 0)).toBe(6);   // socket #1 spends the burst
    // socket #1 "closes", socket #2 "opens" and floods 50ms later — no fresh 6.
    expect(admit4('up', 6, 50)).toBe(0);
    expect(admit4('up', 6, 100)).toBe(0);

    // (5) Direction reversal starts a new gesture (matches #577 client behaviour).
    const burst5 = { ticks: 0, dir: 0, last: -Infinity };
    function admit5(dir: 'up' | 'down', want: number, now: number): number {
      if (want <= 0) return 0;
      const dirSign = dir === 'up' ? -1 : 1;
      const idle = now - burst5.last >= WINDOW;
      const reversed = burst5.dir !== 0 && dirSign !== burst5.dir;
      if (idle || reversed) burst5.ticks = 0;
      burst5.dir = dirSign; burst5.last = now;
      const remaining = MAX - burst5.ticks;
      if (remaining <= 0) return 0;
      const g = Math.min(want, remaining); burst5.ticks += g; return g;
    }
    expect(admit5('up', 6, 0)).toBe(6);   // up burst exhausted
    expect(admit5('up', 6, 10)).toBe(0);  // still up, still spent
    expect(admit5('down', 6, 20)).toBe(6); // reversed → new gesture reopens
  });

  it('the scroll handler admits ticks BEFORE writing, and drops on exhausted burst', () => {
    // Ordering matters: rate-limit gate must run before backend.write.
    const handler = workerSource.slice(
      workerSource.indexOf("} else if (msg.type === 'scroll') {"),
      workerSource.indexOf('backend?.write(seq);') + 'backend?.write(seq);'.length,
    );
    expect(handler).toContain('const grantedTicks = admitReadonlyScrollTicks(msg.dir, wantTicks, Date.now());');
    expect(handler).toContain('if (grantedTicks <= 0) return;');
    expect(handler).toContain('buildReadonlyWheelSequence(msg.dir, msg.lines, grantedTicks)');
    // admit must appear before the write.
    expect(handler.indexOf('admitReadonlyScrollTicks'))
      .toBeLessThan(handler.indexOf('backend?.write(seq)'));
    // The burst is a SINGLE shared counter (not per-connection), so multiple
    // viewers/connections cannot stack past the cap.
    expect(workerSource).toContain('const readonlyScrollBurst = { ticks: 0, dir: 0, last: -Infinity };');
    expect(workerSource).not.toContain('new WeakMap<WebSocket, { tokens');
    expect(workerSource).toContain('const READONLY_SCROLL_MAX_TICKS = 6;');
    expect(workerSource).toContain('const READONLY_SCROLL_WINDOW_MS = 250;');
  });
});
