import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');

describe('Orca Web Terminal scaling wiring', () => {
  it('uses a source-grid-aware font without resizing the adopted terminal', () => {
    expect(workerSource).toContain('backend.hasAuthoritativePaneSize()');
    expect(workerSource).toContain('1989;scaled;');
    expect(workerSource).toContain('_wbFixedFontSize(_wbTerminalWidth(),_wbFixedCols)');
    expect(workerSource).toContain('_WB_FIXED_FONT_MAX=20');
    expect(workerSource).toContain('term.resize(_wbFixedCols,_wbFixedRows)');
    expect(workerSource).toContain('backend.captureWebHistory()');
    expect(workerSource).toContain('refreshOrcaClaudeWebHistory()');
    expect(workerSource).toContain('target.inspectDraftSync()');
  });
});
