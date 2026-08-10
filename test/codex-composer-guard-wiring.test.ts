import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Codex adopt composer collision guard wiring', () => {
  it('checks the adopted pane before bridge attribution and terminal input', () => {
    const worker = readFileSync(join(repoRoot, 'src/worker.ts'), 'utf8');
    const adoptBranch = worker.indexOf('const composerConflict = codexAdoptComposerConflict(submissionBackend);');
    const bridgePreparation = worker.indexOf('prepareAdoptWrite,', adoptBranch);
    const adapterWrite = worker.indexOf('cliAdapter!.writeInput(', adoptBranch);

    expect(adoptBranch).toBeGreaterThan(0);
    expect(bridgePreparation).toBeGreaterThan(adoptBranch);
    expect(adapterWrite).toBeGreaterThan(adoptBranch);
    expect(worker.slice(adoptBranch, bridgePreparation)).toContain('scheduleSubmitFailureNotify(');
    // The guard returns early — before any bridge attribution or terminal write.
    // writeAdoptMessage is a value-returning helper, so the early return is
    // `return 'completed';` (the old inline switch branch used a bare `return;`).
    expect(worker.slice(adoptBranch, bridgePreparation)).toContain("return 'completed';");
  });

  it('gets a plain viewport and real cursor from the adopted tmux pane', () => {
    const backend = readFileSync(join(repoRoot, 'src/adapters/backend/tmux-pipe-backend.ts'), 'utf8');
    const method = backend.indexOf('captureInputState():');
    const nextMethod = backend.indexOf('private captureWithBounds(', method);
    const body = backend.slice(method, nextMethod);

    expect(method).toBeGreaterThan(0);
    expect(body).toContain('this.getCursorPosition()');
    expect(body).toContain("'tmux', ['capture-pane', '-p', '-t', this.paneTarget]");
    expect(body).toContain('return { viewport, cursor };');
  });
});
