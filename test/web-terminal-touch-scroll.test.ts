import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('web terminal touch scrolling', () => {
  it('drives normal-buffer scroll explicitly instead of relying on WebView defaults', () => {
    const start = workerSource.indexOf('// Single-finger touch scrolling:');
    const end = workerSource.indexOf('</script>', start);
    const touchBlock = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(touchBlock).toContain("var _tViewport=document.querySelector('#terminal .xterm-viewport')");
    expect(touchBlock).toContain("if(term.buffer.active.type!=='alternate'){");
    expect(touchBlock).toContain('_tViewport.scrollTop-=y-_tLastY');
    expect(touchBlock.indexOf("if(term.buffer.active.type!=='alternate'){"))
      .toBeLessThan(touchBlock.indexOf('_fwdScroll(_tLastY-y'));
  });

  it('prevents xterm from double-driving handled single-touch moves', () => {
    const start = workerSource.indexOf('// Single-finger touch scrolling:');
    const end = workerSource.indexOf('</script>', start);
    const touchBlock = workerSource.slice(start, end);

    expect(touchBlock).toContain('e.preventDefault();e.stopPropagation();');
    expect(touchBlock).toContain("_tTerm.addEventListener('touchmove'");
    expect(touchBlock).toContain('{capture:true,passive:false}');
  });
});
