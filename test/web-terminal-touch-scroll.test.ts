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
  it('forces Herdr alternate-screen CLIs to remote-scroll after a snapshot-only refresh', () => {
    expect(workerSource).toContain("effectiveBackendType === 'herdr' && cliAdapter?.altScreen === true");
    expect(workerSource).toContain('var remoteScroll=${forceRemoteScroll};');

    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');
    expect(wheelBlock).toContain("if(!remoteScroll&&term.buffer.active.type!=='alternate'){");
    expect(wheelBlock.indexOf("if(!remoteScroll&&term.buffer.active.type!=='alternate'){"))
      .toBeLessThan(wheelBlock.indexOf('_fwdScroll(px,_cellAt'));
  });

  it('bounds remote scroll ticks per gesture instead of per browser event', () => {
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');

    expect(wheelBlock).toContain('var _SCROLL_BURST_MAX=6');
    expect(wheelBlock).toContain('_scrollBurstTicks<_SCROLL_BURST_MAX');
    expect(wheelBlock).toContain('setTimeout(_endScrollBurst,_SCROLL_BURST_IDLE_MS)');
    expect(wheelBlock).toContain('if(_scrollBurstTicks>=_SCROLL_BURST_MAX)_scrollAccum=0');
  });

  it('drives normal-buffer scroll explicitly instead of relying on WebView defaults', () => {
    const touchBlock = scriptBlock('// Single-finger touch scrolling:');

    expect(touchBlock).toContain("var _tViewport=document.querySelector('#terminal .xterm-viewport')");
    expect(touchBlock).toContain("if(!remoteScroll&&term.buffer.active.type!=='alternate'){");
    expect(touchBlock).toContain('_tViewport.scrollTop-=y-_tLastY');
    expect(touchBlock.indexOf("if(!remoteScroll&&term.buffer.active.type!=='alternate'){"))
      .toBeLessThan(touchBlock.indexOf('_fwdScroll(_tLastY-y'));
  });

  it('prevents xterm from double-driving handled single-touch moves', () => {
    const touchBlock = scriptBlock('// Single-finger touch scrolling:');

    expect(touchBlock).toContain('e.preventDefault();e.stopPropagation();');
    expect(touchBlock).toContain("_tTerm.addEventListener('touchmove'");
    expect(touchBlock).toContain('{capture:true,passive:false}');
    expect(touchBlock).toContain("_tTerm.addEventListener('touchend',function(){_tLastY=null;_endScrollBurst()}");
  });
});
