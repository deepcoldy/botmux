import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');

/** Extract the body of the scaled-frame handler so call order can be pinned.
 * Existence assertions alone stay green if someone reorders the handler back
 * to "fit font first, resize after", which fits the font to the pre-resize
 * browser grid and re-breaks wide source grids on phones. */
function scaledBranchSource(): string {
  const start = workerSource.indexOf('var _sf=data.match(');
  expect(start).toBeGreaterThan(0);
  const end = workerSource.indexOf("data=data.replace(_sf[0],'');", start);
  expect(end).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

describe('Orca Web Terminal scaling wiring', () => {
  it('uses a source-grid-aware font without resizing the adopted terminal', () => {
    expect(workerSource).toContain('backend.hasAuthoritativePaneSize()');
    expect(workerSource).toContain('1989;scaled;');
    expect(workerSource).toContain('backend.captureWebHistory()');
    expect(workerSource).toContain('refreshOrcaClaudeWebHistory()');
    expect(workerSource).toContain('target.inspectDraftSync()');
  });

  it('resizes the xterm to the attested source grid before fitting the font', () => {
    const branch = scaledBranchSource();
    const resizeAt = branch.indexOf('term.resize(_sc,_sr)');
    const fitAt = branch.indexOf('_wbApplyAutoFontSize()');
    expect(resizeAt).toBeGreaterThan(0);
    expect(fitAt).toBeGreaterThan(resizeAt);
  });

  it('shares the generic fixed-grid fitter instead of an Orca-specific one', () => {
    const branch = scaledBranchSource();
    expect(branch).toContain('_setFixedGrid(true)');
    expect(branch).not.toContain('scaled===true');
    // The old cols-width fitter and its private knobs are gone for good.
    expect(workerSource).not.toContain('_wbFixedFontSize');
    expect(workerSource).not.toContain('_wbScaledFixed');
    expect(workerSource).not.toContain('_WB_FIXED_FONT_MIN');
    expect(workerSource).toContain('var _WB_FIXED_FONT_MAX=24');
  });
});
