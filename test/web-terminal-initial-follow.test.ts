import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('web terminal initial viewport follow', () => {
  it('settles the first asynchronous xterm write burst at the bottom', () => {
    expect(workerSource).toContain('term.write(data,_settleInitialBottom)');
    expect(workerSource).toMatch(
      /function _settleInitialBottom\(\)\{[\s\S]*?term\.scrollToBottom\(\)[\s\S]*?setTimeout\(function\(\)\{[\s\S]*?term\.scrollToBottom\(\)[\s\S]*?_initialFollow=false;/,
    );
  });

  it('stops following as soon as the reader deliberately scrolls', () => {
    expect(workerSource).toContain(
      "_initialTerminalRoot.addEventListener('wheel',_cancelInitialFollow,{capture:true,passive:true})",
    );
    expect(workerSource).toContain(
      "_initialTerminalRoot.addEventListener('touchstart',_cancelInitialFollow,{capture:true,passive:true})",
    );
    expect(workerSource).toContain("if(e.target===_initialViewport)_cancelInitialFollow()");
    expect(workerSource).toContain("if(e.key==='PageUp'||e.key==='PageDown'||e.key==='Home'||e.key==='End')_cancelInitialFollow()");
  });
});
