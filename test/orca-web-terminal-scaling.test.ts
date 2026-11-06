import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Scaled-frame handling of the web terminal page for adopted Orca panes.
 *
 * The page script lives inside worker.ts's template string; cut out the real
 * scaled-frame branch and run it against a stubbed xterm. Order matters: fitting
 * the font before resizing to the source grid fits it to the pre-resize browser
 * grid and re-breaks wide source grids on phones.
 */
const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');

interface ScaledFrameScope {
  data: string;
  term: { resize(cols: number, rows: number): void };
  _setFixedGrid(on: boolean): void;
  _wbApplyAutoFontSize(): void;
  _lastC: number;
  _lastR: number;
}

function runScaledFrameBranch(scope: ScaledFrameScope): void {
  const start = workerSource.indexOf('var _sf=data.match(');
  const endMarker = "data=data.replace(_sf[0],'');";
  const end = workerSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('scaled-frame branch not found in the web terminal page');
  // The page sits in a template literal: `\\x1b` in worker.ts is `\x1b` in the served page.
  const branch = `${workerSource.slice(start, end + endMarker.length)}\n}`.replace(/\\\\/g, '\\');
  // eslint-disable-next-line no-new-func
  new Function('scope', `with (scope) { ${branch} }`)(scope);
}

function scope(data: string, calls: string[]): ScaledFrameScope {
  return {
    data,
    term: { resize: (cols, rows) => { calls.push(`resize ${cols}x${rows}`); } },
    _setFixedGrid: on => { calls.push(`fixed-grid ${on}`); },
    _wbApplyAutoFontSize: () => { calls.push('fit-font'); },
    _lastC: 0,
    _lastR: 0,
  };
}

describe('Orca web terminal scaled frame', () => {
  it('pins the fixed grid, resizes to the attested source grid, then fits the font', () => {
    const calls: string[] = [];
    const page = scope('before\x1b]1989;scaled;220;50\x07after', calls);
    runScaledFrameBranch(page);
    expect(calls).toEqual(['fixed-grid true', 'resize 220x50', 'fit-font']);
    expect([page._lastC, page._lastR]).toEqual([220, 50]);
    // The marker is control data for the page, never terminal output.
    expect(page.data).toBe('beforeafter');
  });

  it('leaves ordinary output alone', () => {
    const calls: string[] = [];
    const page = scope('plain output', calls);
    runScaledFrameBranch(page);
    expect(calls).toEqual([]);
    expect(page.data).toBe('plain output');
  });
});
