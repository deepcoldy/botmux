import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('worker pipe initial screen ordering', () => {
  it('captures pipe initial screen after idle detector is registered', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const captureIdx = source.indexOf('const initial = backend.captureCurrentScreen();');
    const idleIdx = source.indexOf('// Set up idle detection');
    expect(captureIdx).toBeGreaterThan(idleIdx);
  });
});
