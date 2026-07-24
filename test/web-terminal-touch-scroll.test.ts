import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

function scriptBlock(startMarker: string): string {
  const start = workerSource.indexOf(startMarker);
  const end = workerSource.indexOf('</script>', start);
  expect(start).toBeGreaterThan(-1);
  return workerSource.slice(start, end);
}

describe('web terminal touch scrolling', () => {
  it('uses snapshot replacement for every Herdr CLI, including normal-buffer Codex', () => {
    expect(workerSource).toContain('return backend instanceof HerdrBackend;');
    expect(workerSource).toContain('if (be instanceof HerdrBackend) {');
    expect(workerSource).toContain('wireHerdrWebTerminalRelays(herdrBe);');
    expect(workerSource).toContain(
      'if (backend instanceof HerdrBackend) {\n'
      + '    wireHerdrWebTerminalRelays(backend);\n'
      + '    restoreHerdrWebBindings();',
    );
  });

  it('restores the real Herdr attach cursor after snapshot rendering', () => {
    expect(workerSource).toContain('be.onWebTerminalCursor(relayHerdrWebCursor);');
    expect(workerSource).toContain('scrollback}${herdrWebCursorSequence()}');
    expect(workerSource).toContain('ws.send(seed + herdrWebCursorSequence());');
  });

  it('forces Herdr alternate-screen CLIs to remote-scroll after a snapshot-only refresh', () => {
    expect(workerSource).toContain("effectiveBackendType === 'herdr' && cliAdapter?.altScreen === true");
    expect(workerSource).toContain('var remoteScroll=${forceRemoteScroll};');

    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');
    expect(wheelBlock).toContain('if(_canScrollLocal(px)){');
    expect(wheelBlock.indexOf('if(_canScrollLocal(px)){'))
      .toBeLessThan(wheelBlock.indexOf('_fwdScroll(px,_cellAt'));
  });

  it('caps the burst on non-local backends, not on remoteScroll/altScreen', () => {
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');

    // Cap gated on localTerminalBackend (a positive allowlist of cheap, locally-
    // drivable backends), NOT on remoteScroll — which also encodes altScreen and
    // would leave a Herdr session running an altScreen:false CLI (Claude/Codex)
    // uncapped once it enters the alternate buffer at runtime. Herdr AND Riff
    // (no drivable terminal → remote task floods) must stay capped.
    expect(wheelBlock).toContain('var _SCROLL_BURST_MAX=localTerminalBackend?Infinity:6');
    expect(wheelBlock).not.toContain('_SCROLL_BURST_MAX=remoteScroll');
    expect(wheelBlock).not.toContain('_SCROLL_BURST_MAX=herdrBackend');
    expect(wheelBlock).toContain('_scrollBurstTicks<_SCROLL_BURST_MAX');
    expect(wheelBlock).toContain('setTimeout(_endScrollBurst,_SCROLL_BURST_IDLE_MS)');
    expect(wheelBlock).toContain('if(_scrollBurstTicks>=_SCROLL_BURST_MAX)_scrollAccum=0');
  });

  it('derives localTerminalBackend as a positive pty/tmux/zellij allowlist', () => {
    // forceRemoteScroll still requires altScreen; the cap gate must NOT — it has
    // to hold for a runtime alt-buffer under any non-local backend. Herdr and Riff
    // are deliberately EXCLUDED (expensive / no drivable terminal), so a new or
    // unknown backend defaults to safely capped.
    expect(workerSource).toContain(
      "const localTerminalBackend = effectiveBackendType === 'pty'\n"
      + "        || effectiveBackendType === 'tmux'\n"
      + "        || effectiveBackendType === 'zellij';",
    );
    expect(workerSource).toContain(
      'getTerminalHtml(hasWrite, platformReadonly, loginUrl, forceRemoteScroll, localTerminalBackend)',
    );
    expect(workerSource).toContain('var localTerminalBackend=${localTerminalBackend};');
    // Guard the exclusion explicitly: neither Herdr nor Riff may appear in the gate.
    const gate = workerSource.slice(
      workerSource.indexOf('const localTerminalBackend ='),
      workerSource.indexOf('res.writeHead', workerSource.indexOf('const localTerminalBackend =')),
    );
    expect(gate).not.toContain("=== 'herdr'");
    expect(gate).not.toContain("=== 'riff'");
  });

  it('forwards wheel ticks proportionally when uncapped, and caps non-local backends', () => {
    // Pull the cap EXPRESSION straight from the generated client JS so the test
    // fails if the gate changes, then evaluate it per backend rather than
    // re-hardcoding "6 : Infinity".
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');
    const capExpr = /_SCROLL_BURST_MAX=([^;]+);/.exec(wheelBlock)?.[1];
    expect(capExpr).toBe('localTerminalBackend?Infinity:6');
    const capFor = (localTerminalBackend: boolean): number =>
      // eslint-disable-next-line no-new-func
      Function('localTerminalBackend', `return ${capExpr}`)(localTerminalBackend);

    // Which backends count as local (cheap) is decided by the server-side gate.
    const localBackend: Record<string, boolean> = {
      pty: true, tmux: true, zellij: true, herdr: false, riff: false,
    };

    // Replays the same burst-accumulation loop the client runs, parameterised by
    // the cap the gate above yields for each backend.
    function runSpin(cap: number, notches: number, pxPerNotch: number) {
      const _SCROLL_STEP = 33;
      let _scrollAccum = 0;
      let _scrollBurstTicks = 0;
      let _scrollBurstDir = 0;
      let emitted = 0;
      for (let i = 0; i < notches; i++) {
        const px = pxPerNotch; // steady downward spin
        const dir = px < 0 ? -1 : 1;
        if (_scrollBurstDir && dir !== _scrollBurstDir) { _scrollAccum = 0; _scrollBurstTicks = 0; }
        _scrollBurstDir = dir;
        if (_scrollBurstTicks >= cap) continue;
        _scrollAccum += px;
        let n = 0;
        while (Math.abs(_scrollAccum) >= _SCROLL_STEP && n < 6 && _scrollBurstTicks < cap) {
          const up = _scrollAccum < 0;
          _scrollAccum += up ? _SCROLL_STEP : -_SCROLL_STEP;
          n++; _scrollBurstTicks++; emitted++;
        }
        if (_scrollBurstTicks >= cap) _scrollAccum = 0;
      }
      return emitted;
    }

    // Local pty/tmux/zellij: 40 notches @100px scale with distance, never freeze.
    // The old cap of 6 would have frozen them after ~2 notches.
    for (const be of ['pty', 'tmux', 'zellij']) {
      const emitted = runSpin(capFor(localBackend[be]), 40, 100);
      expect(emitted, `${be} should scroll proportionally`).toBe(Math.floor((40 * 100) / 33)); // 121
      expect(emitted).toBeGreaterThan(100);
    }

    // Herdr AND Riff: still capped at 6 no matter how long the spin — Riff would
    // otherwise flood remote task creation.
    for (const be of ['herdr', 'riff']) {
      expect(runSpin(capFor(localBackend[be]), 40, 100), `${be} must stay capped`).toBe(6);
      expect(runSpin(capFor(localBackend[be]), 2, 100)).toBe(6); // reaches cap within first notches
    }
  });

  it('uses local scrollback before requesting another remote history chunk', () => {
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');
    const touchBlock = scriptBlock('// Single-finger touch scrolling:');

    expect(wheelBlock).toContain('function _canScrollLocal(px){');
    expect(wheelBlock).toContain("if(b.type==='alternate'||!px)return false");
    expect(wheelBlock).toContain('return px>0||b.viewportY>0');
    expect(wheelBlock).toContain('if(_canScrollLocal(px)){');
    expect(touchBlock).toContain('if(_canScrollLocal(px)){');
  });

  it('replaces merged Herdr history and preserves the reader anchor', () => {
    expect(workerSource).toContain('1989;history;${merged.addedLines}');
    expect(workerSource).toContain("var _hh=data.match(/^\\x1b\\]1989;history;([0-9]+)\\x07/)");
    expect(workerSource).toContain('data=data.slice(_hh[0].length);_cancelInitialFollow();term.reset();term.clear()');
    expect(workerSource).toContain("data='\\\\x1b[2J\\\\x1b[H'+data");
    expect(workerSource).toContain('if(_ha>0)term.scrollToLine(_hy+_ha)');
  });

  it('drives normal-buffer scroll explicitly instead of relying on WebView defaults', () => {
    const touchBlock = scriptBlock('// Single-finger touch scrolling:');

    expect(touchBlock).toContain("var _tViewport=document.querySelector('#terminal .xterm-viewport')");
    expect(touchBlock).toContain('if(_canScrollLocal(px)){');
    expect(touchBlock).toContain('_tViewport.scrollTop-=y-_tLastY');
    expect(touchBlock.indexOf('if(_canScrollLocal(px)){'))
      .toBeLessThan(touchBlock.indexOf('_fwdScroll(px'));
  });

  it('prevents xterm from double-driving handled single-touch moves', () => {
    const touchBlock = scriptBlock('// Single-finger touch scrolling:');

    expect(touchBlock).toContain('e.preventDefault();e.stopPropagation();');
    expect(touchBlock).toContain("_tTerm.addEventListener('touchmove'");
    expect(touchBlock).toContain('{capture:true,passive:false}');
    expect(touchBlock).toContain("_tTerm.addEventListener('touchend',function(){_tLastY=null;_endScrollBurst()}");
  });
});
