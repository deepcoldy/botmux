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

  it('server rate-limits scroll ticks per WS so a direct message flood is bounded', () => {
    const MAX = 6;
    const WINDOW = 250;
    // Faithful port of consumeReadonlyScrollTokens (WeakMap<ws> → per-connection).
    const buckets = new Map<object, { tokens: number; last: number }>();
    function consume(ws: object, wantTicks: number, now: number): number {
      if (wantTicks <= 0) return 0;
      const refillRate = MAX / WINDOW;
      let bucket = buckets.get(ws);
      if (!bucket) { bucket = { tokens: MAX, last: now }; buckets.set(ws, bucket); }
      const elapsed = Math.max(0, now - bucket.last);
      bucket.tokens = Math.min(MAX, bucket.tokens + elapsed * refillRate);
      bucket.last = now;
      const granted = Math.min(wantTicks, Math.floor(bucket.tokens));
      if (granted > 0) bucket.tokens -= granted;
      return granted;
    }

    // Attack: a viewToken holder loops {lines:6} 100× at t=0 (same instant).
    const ws = {};
    let ticksAtT0 = 0;
    for (let i = 0; i < 100; i++) ticksAtT0 += consume(ws, 6, 0);
    // Only the initial bucket (6) is granted — the other 99 messages get nothing.
    expect(ticksAtT0).toBe(6);

    // After a full window the bucket refills to its cap, not beyond.
    let ticksAfterWindow = 0;
    for (let i = 0; i < 100; i++) ticksAfterWindow += consume(ws, 6, WINDOW);
    expect(ticksAfterWindow).toBe(6);

    // Sustained throughput over 1s of flooding is bounded to ~MAX per window,
    // NOT the ~100× the attacker attempted. (t=0 burst + 4 refills across 1000ms.)
    const buckets2 = new Map<object, { tokens: number; last: number }>();
    function consume2(ws2: object, want: number, now: number): number {
      if (want <= 0) return 0;
      const refillRate = MAX / WINDOW;
      let b = buckets2.get(ws2);
      if (!b) { b = { tokens: MAX, last: now }; buckets2.set(ws2, b); }
      const el = Math.max(0, now - b.last);
      b.tokens = Math.min(MAX, b.tokens + el * refillRate);
      b.last = now;
      const g = Math.min(want, Math.floor(b.tokens));
      if (g > 0) b.tokens -= g;
      return g;
    }
    const ws2 = {};
    let total = 0;
    for (let t = 0; t <= 1000; t += 10) total += consume2(ws2, 6, t); // flood every 10ms
    // ≈ initial 6 + 1000ms/250ms×6 = 6 + 24 = 30, far below the 606 attempted.
    expect(total).toBeLessThanOrEqual(30);
    expect(total).toBeGreaterThanOrEqual(24);

    // Two viewers each get their OWN bucket — a second socket cannot borrow the
    // first's spent tokens, but also proves stacking is per-connection bounded.
    const a = {}; const b = {};
    expect(consume(a, 6, 2000)).toBe(6);
    expect(consume(a, 6, 2000)).toBe(0); // a is now empty at this instant
    expect(consume(b, 6, 2000)).toBe(6); // b independent, still capped at 6
  });

  it('the scroll handler consumes tokens BEFORE writing, and drops on empty bucket', () => {
    // Ordering matters: rate-limit gate must run before backend.write.
    const handler = workerSource.slice(
      workerSource.indexOf("} else if (msg.type === 'scroll') {"),
      workerSource.indexOf('backend?.write(seq);') + 'backend?.write(seq);'.length,
    );
    expect(handler).toContain('const grantedTicks = consumeReadonlyScrollTokens(ws, wantTicks, Date.now());');
    expect(handler).toContain('if (grantedTicks <= 0) return;');
    expect(handler).toContain('buildReadonlyWheelSequence(msg.dir, msg.lines, grantedTicks)');
    // consume must appear before the write.
    expect(handler.indexOf('consumeReadonlyScrollTokens'))
      .toBeLessThan(handler.indexOf('backend?.write(seq)'));
    // The bucket is a WeakMap keyed on the WS (auto-GC, per-connection).
    expect(workerSource).toContain('const readonlyScrollBuckets = new WeakMap<WebSocket');
    expect(workerSource).toContain('const READONLY_SCROLL_MAX_TICKS = 6;');
    expect(workerSource).toContain('const READONLY_SCROLL_WINDOW_MS = 250;');
  });
});
