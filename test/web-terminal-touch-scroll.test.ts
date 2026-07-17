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

  it('bounds remote scroll ticks per gesture instead of per browser event', () => {
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');

    expect(wheelBlock).toContain('var _SCROLL_BURST_MAX=6');
    expect(wheelBlock).toContain('_scrollBurstTicks<_SCROLL_BURST_MAX');
    expect(wheelBlock).toContain('setTimeout(_endScrollBurst,_SCROLL_BURST_IDLE_MS)');
    expect(wheelBlock).toContain('if(_scrollBurstTicks>=_SCROLL_BURST_MAX)_scrollAccum=0');
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
